// idle mode: endless zoom-out on top of the conquest battle sim. no drawing and no dom here, so the
// same code runs in the game and in the headless balance sim (tools/idle_sim.py).
//
// loop: every stage is one battle. defeated enemy foglets give fogs (points), a stage win gives a
// bonus, and fogs buy permanent upgrades (open the shop at any time, a purchase applies at once).
// losing a stage ends the run; fogs and upgrades are kept and the next run starts at stage 1.
//
// numbers: the sim itself never changes scale (a tile still holds ~400 sim foglets). what grows is
//   - the display scale: every number on screen = sim foglets x display^(stage-1), so troop counts
//     and fogs climb to K, M, B... while the battles stay the same size
//   - enemy strength: bots attack, defend and grow stronger every stage (x enemy^(stage-1)), so
//     upgrades are needed to keep going. upgrades never make enemies stronger
import { personalities } from './ai.js?v=84';
import { rng } from './mapgen.js?v=84';

export const idleCfg = {
  display: 1.45,      // shown numbers (troops, fogs) grow x1.45 per stage
  enemyBase: 0.75,    // stage 1 bots: attack / defense x0.75 (an easy first island)
  enemyAtk: 1.1,      // bot attack and defense x1.1 per stage
  enemyGrowth: 1.1,   // bot growth x1.1 per stage (growth decides attrition fights, so it must keep up)
  neutralExp: 0.55,   // neutral garrisons x (enemy strength ^ 0.55), at most neutralMax
  neutralMax: 3,
  fogPerKill: 1,      // fogs per defeated sim foglet (then x display scale x fog upgrades)
  clearBonus: 20,     // stage win: 20 x stage x display scale fogs (boss x3)
  bossEvery: 10,      // stage 10, 20, 30...: boss stage (one rival much stronger, bonus x3)
  bossPower: 1.35,    // boss attack / defense on top of the stage's enemy strength
  ghostEvery: 10, ghostAt: 5,   // stage 5, 15, 25...: one rival plays another player's profile
  startTroops: 10,    // capital troops at the start of a stage (+ the camp upgrade)
};

// stage n (1-based): map size, rivals, climate. something new every 10 stages (climate, a rival)
const climates = ['summer', 'autumn', 'moor', 'desert', 'winter'];
export function stageSpec(n) {
  const cells = Math.min(24, 4 + n);                       // stage 1: 5 tiles ... stage 20+: 24
  const bots = n < 5 ? 1 : n < 10 ? 2 : n < 20 ? 3 : 4;
  return {
    cells, bots,
    detail: Math.max(0.42, Math.min(1, 1 - ((cells - 12) / 15) * 0.68)),   // big maps zoom out (battalions)
    shape: cells >= 20 ? 'world' : 'random',
    theme: climates[Math.floor((n - 1) / 10) % climates.length],
    neutral: n === 1 ? [0.05, 0.15] : [0.1, 0.3],
    boss: n % idleCfg.bossEvery === 0,
    ghost: n % idleCfg.ghostEvery === idleCfg.ghostAt,
  };
}
export const displayScale = (n) => idleCfg.display ** (n - 1);
export const enemyPower = (n) => idleCfg.enemyBase * idleCfg.enemyAtk ** (n - 1);

// upgrades: flat list with levels. cost = base x grow^level fogs. max = level cap (main stats have none).
// value(l) = the effect at level l (used for the mods and the shop text)
const pctUp = (v) => `+${Math.round((v - 1) * 100)}%`;
const pctDown = (v) => `-${Math.round((1 - v) * 100)}%`;
export const upgrades = [
  { id: 'atk', icon: '⚔️', name: 'Sharper blades', base: 40, grow: 2.0, value: (l) => 1.1 ** l, text: (v) => `attack ${pctUp(v)}` },
  { id: 'def', icon: '🛡️', name: 'Shield wall', base: 40, grow: 2.0, value: (l) => 1.1 ** l, text: (v) => `defense ${pctUp(v)}` },
  { id: 'growth', icon: '🌱', name: 'Fertile fog', base: 50, grow: 2.1, value: (l) => 1.08 ** l, text: (v) => `growth ${pctUp(v)}` },
  { id: 'start', icon: '🏕️', name: 'Bigger camp', base: 30, grow: 2.2, value: (l) => idleCfg.startTroops + 15 * l, text: (v, sc) => `start with ${fmtBig(v * sc)} foglets` },
  { id: 'fog', icon: '🧺', name: 'Fog harvest', base: 80, grow: 2.5, value: (l) => 1.1 ** l, text: (v) => `fogs ${pctUp(v)}` },
  { id: 'auto', icon: '🤖', name: 'Auto-battle', base: 60, grow: 3, max: 5, value: (l) => l, text: (v) => (v ? `bot plays your attacks (skill ${v}/5)` : 'a bot plays your attacks') },
  { id: 'autobuild', icon: '🏗️', name: 'Auto-build', base: 400, grow: 3, max: 3, needs: 'auto', value: (l) => [0, 0.25, 0.45, 0.7][l], text: (v) => (v ? `bot builds (${Math.round(v * 100)}% of its turns)` : 'the bot also builds') },
  { id: 'speed', icon: '⏩', name: 'Time warp', base: 300, grow: 3.5, max: 4, value: (l) => 1 + l, text: (v) => `game speed up to ${v}x` },
  { id: 'march', icon: '🥾', name: 'Forced march', base: 100, grow: 2.4, max: 5, value: (l) => 1 + 0.08 * l, text: (v) => `armies move ${pctUp(v)}` },
  { id: 'engineers', icon: '🛠️', name: 'Engineers', base: 120, grow: 2.4, max: 5, value: (l) => 0.92 ** l, text: (v) => `buildings cost ${pctDown(v)}` },
  { id: 'conscription', icon: '📜', name: 'Conscription', base: 120, grow: 2.4, max: 5, value: (l) => 0.94 ** l, text: (v) => `neutrals defend ${pctDown(v)}` },
  { id: 'plunder', icon: '💰', name: 'Plunder', base: 150, grow: 2.5, max: 5, value: (l) => 0.01 * l, text: (v) => `taking an enemy tile adds ${Math.round(v * 100)}% of its cap` },
  { id: 'granary', icon: '🌾', name: 'Master builders', base: 140, grow: 2.4, max: 5, value: (l) => 1 + 0.12 * l, text: (v) => `farms, hospitals, labs ${pctUp(v)}` },
  { id: 'walls', icon: '🧱', name: 'Great walls', base: 150, grow: 2.5, max: 4, value: (l) => 0.25 * l, text: (v) => `capital defense +${Math.round(v * 100)}%` },
];
export const upgradeById = Object.fromEntries(upgrades.map((u) => [u.id, u]));

// auto-battle bot by level: slow and careful at 1 (worse than a human), quick and sharp at 5
export function autoBrain(level, buildLevel) {
  const k = (Math.max(1, level) - 1) / 4;   // 0 at level 1 .. 1 at level 5
  return {
    think: 4.5 - 3 * k,
    personality: { build: upgradeById.autobuild.value(buildLevel), risk: 1.6 - 0.45 * k, actions: 1 + Math.round(2 * k), grudge: 0 },
  };
}

// sample "other player" profiles (v1: made up; later: real profiles from the online board)
// lean = how the profile's strength is split (atk / def / growth), total stays at the stage's level
export const sampleProfiles = [
  { name: 'Mistwalker', lean: { atk: 1.15, def: 0.95, growth: 0.95 } },
  { name: 'Tidecaller', lean: { atk: 0.95, def: 1.15, growth: 0.95 } },
  { name: 'Greyhaven', lean: { atk: 1, def: 1, growth: 1.12 } },
  { name: 'Hollowbrook', lean: { atk: 1.2, def: 0.9, growth: 0.95 } },
];

// big numbers: 999, 1.2K, 34K, 3.4M, 1.2B, 5T, then 1.2e15
export function fmtBig(v) {
  v = Math.floor(v);
  if (v < 1000) return String(Math.max(0, v));
  const units = ['K', 'M', 'B', 'T'];
  let i = -1;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  if (v >= 1000) { const e = Math.floor(Math.log10(v)) + (i + 1) * 3; return `${(v / 10 ** (e - (i + 1) * 3)).toFixed(1)}e${e}`; }
  return (v < 100 ? v.toFixed(1).replace(/\.0$/, '') : Math.floor(v)) + units[i];
}

const save_key = 'frontlines.idle';
const blank = () => ({ fogs: 0, total: 0, levels: {}, auto: true, stage: 1, runFogs: 0, runTime: 0, best: 0, fast10: 0, runs: 0 });

// the idle profile (kept between runs): fogs, upgrade levels, best stage, the run in progress
export class Idle {
  constructor(data = {}) { Object.assign(this, blank(), data); this.levels = { ...data.levels }; }

  static load() {
    try { return new Idle(JSON.parse(localStorage.getItem(save_key)) ?? {}); } catch { return new Idle(); }
  }

  save() {
    const { fogs, total, levels, auto, stage, runFogs, runTime, best, fast10, runs } = this;
    try { localStorage.setItem(save_key, JSON.stringify({ fogs, total, levels, auto, stage, runFogs, runTime, best, fast10, runs })); } catch { /* storage blocked */ }
  }

  lvl(id) { return this.levels[id] ?? 0; }
  val(id) { return upgradeById[id].value(this.lvl(id)); }
  cost(id) { const u = upgradeById[id]; return Math.ceil(u.base * u.grow ** this.lvl(id)); }
  maxed(id) { const u = upgradeById[id]; return u.max !== undefined && this.lvl(id) >= u.max; }
  locked(id) { const u = upgradeById[id]; return !!u.needs && this.lvl(u.needs) < 1; }
  canBuy(id) { return !this.maxed(id) && !this.locked(id) && this.fogs >= this.cost(id); }

  buy(id) {
    if (!this.canBuy(id)) return false;
    this.fogs -= this.cost(id);
    this.levels[id] = this.lvl(id) + 1;
    return true;
  }

  // the player's sim modifiers from upgrades (same keys as battle.js / expedition perks)
  mods() {
    const g = this.val('granary');
    return {
      atk: this.val('atk'), def: this.val('def'), growth: this.val('growth'), speed: this.val('march'),
      cost: this.val('engineers'), neutralDef: this.val('conscription'), loot: this.val('plunder'),
      farm: g, hospital: g, lab: g, capitalDef: this.val('walls'),
    };
  }

  get scale() { return displayScale(this.stage); }
  get maxSpeed() { return this.val('speed'); }
  get autoOn() { return this.auto && this.lvl('auto') > 0; }

  // fogs for sim foglets killed on the current stage (ghost stages pay double)
  // (per kill / the stage's enemy growth: stronger enemies field more foglets, each is worth less,
  // so a stage pays about the same share of its display scale however strong the rivals are)
  fogsFor(killed) { return (killed * idleCfg.fogPerKill * this.scale * this.val('fog') * (stageSpec(this.stage).ghost ? 2 : 1)) / idleCfg.enemyGrowth ** (this.stage - 1); }
  clearFogs() { return idleCfg.clearBonus * this.stage * this.scale * this.val('fog') * (stageSpec(this.stage).boss ? 3 : 1); }

  earn(f) { this.fogs += f; this.total += f; this.runFogs += f; }

  // apply auto-battle to the player's faction (live: toggling or buying works mid-battle)
  applyAuto(f) {
    f.ai = this.autoOn;
    if (!f.ai) return;
    const b = autoBrain(this.lvl('auto'), this.lvl('autobuild'));
    f.think = b.think;
    f.personality = b.personality;
    f.timer = Math.min(f.timer ?? b.think, b.think);
  }

  // battle setup for the current stage. stamp = the previous island's outline (zoom-out), if any
  setup(stamp = null, seed = Math.floor(Math.random() * 1e9)) {
    const n = this.stage, st = stageSpec(n), r = rng(seed), types = Object.keys(personalities);
    const E = enemyPower(n), G = idleCfg.enemyGrowth ** (n - 1);
    const ghostAt = st.ghost ? Math.floor(r() * st.bots) : -1, ghost = st.ghost ? sampleProfiles[Math.floor(r() * sampleProfiles.length)] : null;
    const bots = [];
    for (let i = 0; i < st.bots; i++) {
      const boss = st.boss && i === 0, lean = i === ghostAt ? ghost.lean : { atk: 1, def: 1, growth: 1 };
      const p = boss ? idleCfg.bossPower : 1;
      bots.push({
        ai: true, color: i + 1, think: Math.max(1.5, 3 - n * 0.05),
        personality: personalities[boss ? 'aggressive' : types[Math.floor(r() * types.length)]],
        mods: { atk: E * p * lean.atk, def: E * p * lean.def, growth: G * lean.growth },
        capital: { troops: idleCfg.startTroops * (boss ? 3 : 1), bonus: {} },
        name: i === ghostAt ? ghost.name : boss ? 'Boss' : undefined,
        boss, ghost: i === ghostAt,
      });
    }
    // auto-battle is applied by the caller once the battle exists (applyAuto), after the looks are set
    const me = { ai: false, color: 0, mods: this.mods(), capital: { troops: this.val('start'), bonus: {} } };
    const nm = Math.min(idleCfg.neutralMax, E ** idleCfg.neutralExp);
    return {
      seed, cells: st.cells, shape: st.shape, theme: st.theme, neutral: st.neutral, detail: st.detail, stamp,
      camps: n > 1 ? { mult: Math.max(1, nm), share: 0.2, boost: 1.3 } : undefined,
      factions: [me, ...bots],
      ghost: ghost && { name: ghost.name }, boss: st.boss,
    };
  }

  // a stage was won: bonus fogs, next stage. returns the bonus
  win(secs) {
    const bonus = this.clearFogs();
    this.earn(bonus);
    this.runTime += secs;
    if (this.stage === 10 && (!this.fast10 || this.runTime < this.fast10)) this.fast10 = Math.round(this.runTime);
    this.stage++;
    this.best = Math.max(this.best, this.stage);   // best = highest stage reached
    return bonus;
  }

  // the run ended (stage lost or withdrawn): reset the run, keep fogs and upgrades.
  // returns the run summary for the end card
  endRun(secs) {
    this.best = Math.max(this.best, this.stage);
    const out = { reached: this.stage, fogs: this.runFogs, secs: this.runTime + secs, best: this.best, fast10: this.fast10 };
    this.runs++;
    this.stage = 1; this.runFogs = 0; this.runTime = 0;
    return out;
  }
}
