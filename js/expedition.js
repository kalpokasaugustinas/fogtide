// expedition: roguelite run that zooms out stage by stage (valley -> region -> country -> continent -> world).
// winning a stage collapses everything you hold into one capital on the next, bigger map:
//   - all your people come along (capital starts full, the rest is a reserve that flows in)
//   - buildings carry over as capital bonuses: effect x share of your segments that had it
//     (4 farms out of 10 segments -> +60% x 40% = +24% growth); the old capital's bonuses
//     count as 1 segment, so they dilute unless you build again
//   - pick 1 of 3 perks
// bots scale with you: base troops + 70% of your carried people, and capitals with the same
// total bonus strength in a random mix. losing a stage ends the run.
import { effects } from './config.js?v=105';
import { personalities } from './ai.js?v=105';
import { rng } from './mapgen.js?v=105';

export const stages = [
  { name: 'Valley', detail: 1, cells: 12, bots: 1, shape: 'random', neutral: [0.12, 0.3] },
  { name: 'Region', detail: 0.8, cells: 15, bots: 2, shape: 'random', neutral: [0.18, 0.38] },
  { name: 'Country', detail: 0.62, cells: 18, bots: 3, shape: 'random', neutral: [0.24, 0.46] },
  { name: 'Continent', detail: 0.42, cells: 22, bots: 3, shape: 'world', neutral: [0.3, 0.55] },
  { name: 'World', detail: 0.32, cells: 27, bots: 4, shape: 'world', neutral: [0.36, 0.64] },
];

// neutral scaling in stages 2-5: garrison x sqrt(carried troops / campBase), at most campMax;
// campShare of the neutral tiles (biggest first) are camps with a further x campBoost
export const campBase = 150, campMax = 4, campShare = 0.3, campBoost = 1.5;
export const botCarry = 0.7;   // share of the player's carried people each bot starts with

// perks: mods are multipliers unless noted (capitalDef, loot are added; fort replaces x1.75)
export const perks = [
  { id: 'march', icon: '🥾', name: 'Forced march', desc: 'Your armies move 30% faster', mods: { speed: 1.3 } },
  { id: 'veterans', icon: '🎖️', name: 'Veterans', desc: 'Your armies attack +12%', mods: { atk: 1.12 } },
  { id: 'granary', icon: '🌾', name: 'Granary', desc: 'Farms +50% stronger', mods: { farm: 1.5 } },
  { id: 'healers', icon: '➕', name: 'Healers', desc: 'Hospitals +30% stronger', mods: { hospital: 1.3 } },
  { id: 'scholars', icon: '🔬', name: 'Scholars', desc: 'Labs twice as strong', mods: { lab: 2 } },
  { id: 'fertile', icon: '🌱', name: 'Fertile land', desc: '+12% growth everywhere', mods: { growth: 1.12 } },
  { id: 'engineers', icon: '🛠️', name: 'Engineers', desc: 'Buildings cost 40% less', mods: { cost: 0.6 } },
  { id: 'conscription', icon: '📜', name: 'Conscription', desc: 'Neutral segments defend 25% weaker against you', mods: { neutralDef: 0.75 } },
  { id: 'walls', icon: '🧱', name: 'Great walls', desc: 'Your capital defends x2', mods: { capitalDef: 1 } },
  { id: 'recruiters', icon: '📯', name: 'Recruiters', desc: 'Your reserve flows into the capital 3x faster', mods: { reserve: 3 } },
  { id: 'plunder', icon: '💰', name: 'Plunder', desc: 'Taking an enemy segment adds 2% of its cap as foglets', mods: { loot: 0.02 } },
  { id: 'masons', icon: '🛡️', name: 'Stonemasons', desc: 'Forts defend x2 instead of x1.75', mods: { fort: 2 } },
];

// merge modifier sets: multipliers multiply, capitalDef/loot add, fort takes the best
export function combineMods(list) {
  const m = {};
  for (const mods of list) {
    for (const [k, v] of Object.entries(mods)) {
      if (k === 'capitalDef' || k === 'loot') m[k] = (m[k] ?? 0) + v;
      else if (k === 'fort') m[k] = Math.max(m[k] ?? 0, v);
      else m[k] = (m[k] ?? 1) * v;
    }
  }
  return m;
}

const best_key = 'frontlines.expedition.best';
const runs_key = 'frontlines.conquest.runs';
const save_key = 'frontlines.conquest.save';   // the run in progress (start of its current stage)

// conquest score, per stage; w = stage number (1-5), so later, harder stages count more:
//   clear   500 x w                       (stage won)
//   stars   150 x w per star              (win, no tile lost, under 6:00 -> up to 450 x w)
//   speed   400 x w x (1 - t / 600)       (t = real seconds of the stage; 0 after 10 min)
//   kills   15 x sqrt(troops killed)      (kill counts already grow stage by stage, sqrt keeps
//                                          them from swamping the rest)
// a lost stage scores only its kills. a perfect fast world run is ~20-25k points: roughly
// a third each from clears and stars, a quarter from speed, the rest from kills
export const scoring = { clear: 500, star: 150, speed: 400, speedSpan: 600, kill: 15, keep: 10 };
export function stageScore(stage, { won, stars, secs, killed }) {
  const w = stage + 1, s = scoring;
  const part = {
    clear: won ? s.clear * w : 0,
    stars: won ? s.star * w * stars : 0,
    speed: won ? Math.round(s.speed * w * Math.max(0, 1 - secs / s.speedSpan)) : 0,
    kills: Math.round(s.kill * Math.sqrt(Math.max(0, killed))),
  };
  return { ...part, total: part.clear + part.stars + part.speed + part.kills };
}

export class Expedition {
  constructor(seed) {
    this.seed = seed;
    this.rand = rng(seed);
    this.stage = 0;
    this.perks = [];
    this.capital = null;   // { troops, bonus } carried into the next stage
    this.time = 0;         // total battle time
    this.scores = [];      // stageScore() of every stage played
  }

  get points() { return this.scores.reduce((v, s) => v + s.total, 0); }

  // score the stage just played (before collapse); returns its stageScore
  record(result) { const s = stageScore(this.stage, result); this.scores.push(s); return s; }

  get current() { return stages[this.stage]; }
  done() { return this.stage >= stages.length; }

  // combined perk modifiers
  mods() { return combineMods(this.perks.map((id) => perks.find((p) => p.id === id).mods)); }

  // battle setup for the current stage
  setup() {
    const st = this.current, r = rng(this.seed + this.stage * 7919);
    // a season per stage: summer valley -> autumn region -> moor country -> desert continent -> winter world
    const types = Object.keys(personalities), themes = ['summer', 'autumn', 'moor', 'desert', 'winter'];
    const carried = this.capital?.troops ?? 0;
    const bots = [1, 2, 3, 4].slice(0, st.bots).map((color) => ({
      ai: true, color, think: Math.max(1.8, 3.2 - this.stage * 0.3),
      personality: personalities[types[Math.floor(r() * types.length)]],
      // from stage 2 on, bots get capitals scaled to the player
      capital: this.capital ? { troops: 10 + carried * botCarry, bonus: shuffleBonus(this.capital.bonus, r) } : undefined,
    }));
    return {
      seed: Math.floor(r() * 1e9),
      cells: st.cells,
      shape: st.shape,
      theme: themes[this.stage] ?? themes[0],
      neutral: st.neutral,
      detail: st.detail,
      stamp: this.shape,   // previous island outline -> shape of the new capital
      // from stage 2 on, neutrals scale with the troops the player carries (so every stage is a
      // similar fight), and the strongest neutral tiles become fortified camps (drawn as hamlets)
      camps: this.capital ? { mult: Math.min(campMax, Math.max(1, Math.sqrt(carried / campBase))), share: campShare, boost: campBoost } : undefined,
      factions: [{ ai: false, color: 0, mods: this.mods(), capital: this.capital ?? undefined }, ...bots],
    };
  }

  // stage won: collapse the player's holdings into the next capital. returns a summary for the ui
  collapse(battle) {
    this.time += battle.time;
    const mine = battle.segs.filter((s) => s.owner === 0), n = Math.max(1, mine.length);
    const count = (type) => mine.filter((s) => s.building === type).length;
    const old = mine.filter((s) => s.capital).map((s) => s.bonus);
    const oldSum = (k) => old.reduce((v, b) => v + b[k], 0) / n;   // old capitals dilute: each is 1 of n
    const m = this.mods();
    const farms = count('farm'), hosp = count('hospital'), labs = count('lab'), forts = count('fort'), barracks = count('barracks');
    const bonus = {
      growth: effects.farmGrowth * (m.farm ?? 1) * (farms / n) + oldSum('growth'),
      hosp: effects.hospitalGrowth * (m.hospital ?? 1) * (hosp / n) + oldSum('hosp'),
      lab: effects.labGrowth * (m.lab ?? 1) * labs * (labs / n) + oldSum('lab'),
      def: ((m.fort ?? effects.fortDefense) - 1) * (forts / n) + oldSum('def'),
      atk: (effects.barracksAttack - 1) * (barracks / n) + oldSum('atk'),
    };
    const troops = Math.round(mine.reduce((v, s) => v + s.troops, 0)
      + battle.armies.filter((a) => a.owner === 0).reduce((v, a) => v + a.n, 0) + battle.factions[0].reserve);
    this.capital = { troops, bonus };
    this.shape = islandShape(battle);
    this.stage++;
    return { segments: mine.length, farms, hosp, labs, forts, barracks, troops, bonus };
  }

  // 3 perks the player doesn't have yet
  choices() {
    const pool = perks.filter((p) => !this.perks.includes(p.id));
    const out = [];
    while (out.length < 3 && pool.length) out.push(pool.splice(Math.floor(this.rand() * pool.length), 1)[0]);
    return out;
  }

  // best run so far (stage reached, then total time)
  static best() {
    try { return JSON.parse(localStorage.getItem(best_key)); } catch { return null; }
  }

  // leaderboard: your best runs on this device, by points (top scoring.keep)
  static runs() {
    try { return JSON.parse(localStorage.getItem(runs_key)) ?? []; } catch { return []; }
  }

  // add this run; returns { rank (1-based, 0 = not in the top list), runs }
  saveRun(reached, won, secs) {
    const run = { points: this.points, reached, won, secs: Math.floor(secs), date: new Date().toISOString().slice(0, 10), id: Date.now() };
    const runs = [...Expedition.runs(), run].sort((a, b) => b.points - a.points || a.secs - b.secs).slice(0, scoring.keep);
    try { localStorage.setItem(runs_key, JSON.stringify(runs)); } catch { /* storage blocked */ }
    return { rank: runs.indexOf(run) + 1, runs, run };
  }

  // run in progress, saved at the start of every stage so a reload or a closed tab can pick it up
  // again (that stage restarts from its beginning, on the same map: setup() is seeded)
  save() {
    const run = { seed: this.seed, stage: this.stage, perks: this.perks, capital: this.capital, time: this.time, scores: this.scores,
      shape: this.shape ? { n: this.shape.n, data: Array.from(this.shape.data) } : null };
    try { localStorage.setItem(save_key, JSON.stringify(run)); } catch { /* storage blocked */ }
  }

  static saved() {
    try { return JSON.parse(localStorage.getItem(save_key)); } catch { return null; }
  }

  static clearSave() { try { localStorage.removeItem(save_key); } catch { /* storage blocked */ } }

  // rebuild a saved run (perk choices use a fresh generator, seeded by run and stage)
  static load(run) {
    const e = new Expedition(run.seed);
    Object.assign(e, { stage: run.stage, perks: run.perks ?? [], capital: run.capital, time: run.time ?? 0, scores: run.scores ?? [] });
    if (run.shape) e.shape = { n: run.shape.n, data: Uint8Array.from(run.shape.data) };
    e.rand = rng(run.seed + run.stage * 104729);
    return e;
  }

  saveBest(reached) {
    const b = Expedition.best(), cur = { stage: reached, time: Math.round(this.time) };
    if (!b || reached > b.stage || (reached === b.stage && cur.time < b.time)) {
      try { localStorage.setItem(best_key, JSON.stringify(cur)); } catch { /* storage blocked */ }
      return true;
    }
    return false;
  }
}

// the island's outline (land, mountains, lakes), downsampled to 64 x 64: the next capital's shape
// (conquest and idle zoom-outs)
export function islandShape(battle) {
  const g = battle.map.grid, N = 64, data = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const c = Math.floor(((y + 0.5) / N) * g) * g + Math.floor(((x + 0.5) / N) * g);
    data[y * N + x] = battle.map.ids[c] >= 0 || battle.map.terrain[c] ? 1 : 0;
  }
  return { n: N, data: cropShape(data, N) };
}

// crop an n x n outline to its bounding box and scale it back to n x n, so the stamp fills its square
function cropShape(d, n) {
  let x0 = n, y0 = n, x1 = -1, y1 = -1;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (d[y * n + x]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  if (x1 < 0) return d;
  const w = Math.max(x1 - x0 + 1, y1 - y0 + 1), out = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const sx = x0 + Math.floor(((x + 0.5) / n) * w), sy = y0 + Math.floor(((y + 0.5) / n) * w);
    out[y * n + x] = sx < n && sy < n ? d[sy * n + sx] : 0;
  }
  return out;
}

// same total bonus strength, values shuffled between types (bots get a different mix)
function shuffleBonus(bonus, r) {
  const keys = Object.keys(bonus), vals = keys.map((k) => bonus[k]);
  for (let i = vals.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [vals[i], vals[j]] = [vals[j], vals[i]]; }
  return Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
}
