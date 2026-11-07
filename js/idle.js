// idle mode: endless zoom-out on top of the conquest battle sim. no drawing and no dom here, so the
// same code runs in the game and in the headless balance sim (tools/idle_sim.py).
//
// loop: every stage is one battle. defeated enemy foglets give Fog (the points), a stage win gives a
// bonus, bosses drop Mist (the rare currency), and both buy permanent upgrades in a tree (open it any
// time, a purchase applies at once). losing a stage ends the run; Fog, Mist and upgrades are kept and
// the next run starts at stage 1 (later: further in, with the fog drift upgrade). the fog horn
// gathers Fog in real time, played or not, to collect from the menu.
//
// numbers: the sim itself never changes scale (a tile still holds ~400 sim foglets). what grows is
//   - the display scale: every number on screen = sim foglets x display^(stage-1), so troop counts
//     and Fog climb to K, M, B... while the battles stay the same size
//   - enemy strength: bots attack, defend and grow stronger every stage, so upgrades are needed to
//     keep going. upgrades never make enemies stronger
import { personalities, pickBuilding } from './ai.js?v=86';
import { rng, hops } from './mapgen.js?v=86';

export const idleCfg = {
  display: 1.45,      // shown numbers (troops, Fog) grow x1.45 per stage
  enemyBase: 0.75,    // stage 1 bots: attack / defense x0.75 (an easy first island)
  enemyAtk: 1.08,     // bot attack and defense x1.08 per stage
  enemyGrowth: 1.08,  // bot growth x1.08 per stage (growth decides attrition fights, so it must keep up)
  enemyGrowthBase: 0.85,   // stage 1 bots grow at x0.85
  neutralExp: 0.55,   // neutral garrisons x (enemy strength ^ 0.55), at most neutralMax
  neutralMax: 3,
  fogPerKill: 1,      // Fog per defeated sim foglet (then x display scale x fog upgrades)
  clearBonus: 20,     // stage win: 20 x stage x display scale Fog (boss x3)
  bossEvery: 10,      // stage 10, 20, 30...: boss stage (one rival much stronger, bonus x3, drops Mist)
  bossPower: 1.35,    // boss attack / defense on top of the stage's enemy strength
  mistExp: 1.5,       // Mist per boss = round((stage / 10) ^ 1.5): 1, 3, 5, 8, 11 ... deeper bosses pay more
  ghostEvery: 10, ghostAt: 5,   // stage 5, 15, 25...: one rival plays another player's profile
  startTroops: 10,    // capital troops at the start of a stage (+ the camp upgrade)
  archerRate: 0.15,   // archers: sim foglets killed per second per level, per enemy tile next door
  botArchersEvery: 6, // idle bots get one archer level every 6 stages (max 5)
  wellRate: 0.04,     // fog wells: sim-foglet Fog per owned tile per game second per level
  autoEvery: 1,       // auto-battle checks your tiles every game second
  deplete: 5,         // a tile's land raises at most 5 x its cap foglets in total, then it stops growing
  quietEnd: 30,       // nobody marching for 30 game s: the side with the most foglets wins the stage
  hornRate: 0.15,     // fog horn: sim Fog per real second per level (x display scale of your best stage); level 5 ~ 40% of active play
  hornHours: 8,       // the horn holds at most 8 hours of Fog
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
    archers: Math.min(5, Math.floor(n / idleCfg.botArchersEvery)),   // bots' archer level
  };
}
export const displayScale = (n) => idleCfg.display ** (n - 1);
export const enemyPower = (n) => idleCfg.enemyBase * idleCfg.enemyAtk ** (n - 1);
const enemyGrowthAt = (n) => idleCfg.enemyGrowthBase * idleCfg.enemyGrowth ** (n - 1);
export const bossMist = (n) => Math.max(1, Math.round((n / 10) ** idleCfg.mistExp));

// upgrade tree: 5 branches (rows), depth = column. needs = [[id, level], ...]: a node opens once
// every listed upgrade has that level (some need two branches). cost = base x grow^level in Fog, or
// in Mist for the advanced nodes at the end of each branch (cur: 'mist'). max = level cap (the root
// stats have none). value(l) = the effect at level l
const pctUp = (v) => `+${Math.round((v - 1) * 100)}%`;
const pctDown = (v) => `-${Math.round((1 - v) * 100)}%`;
export const branches = [
  { id: 'offense', icon: '⚔️', name: 'Offense' },
  { id: 'defense', icon: '🛡️', name: 'Defense' },
  { id: 'growth', icon: '🌱', name: 'Growth' },
  { id: 'fog', icon: '🌫️', name: 'Fog' },
  { id: 'command', icon: '🤖', name: 'Command' },
];
const autoTh = [1, 0.9, 0.8, 0.7, 0.6, 0.5];   // auto-attack: tile fullness that triggers an attack, by level
const margins = [1.25, 1.18, 1.12, 1.06];       // auto-attack safety margin, by sharp eye level
export const upgrades = [
  // offense: attack -> march -> conscription -> archers (+ great walls) -> plunder -> mist blades
  { id: 'atk', branch: 'offense', col: 0, icon: '🗡️', name: 'Sharper blades', base: 40, grow: 1.9, value: (l) => 1.05 ** l, text: (v) => `attack ${pctUp(v)}` },
  { id: 'march', branch: 'offense', col: 1, needs: [['atk', 2]], icon: '🥾', name: 'Forced march', base: 120, grow: 2.2, max: 5, value: (l) => 1 + 0.04 * l, text: (v) => `armies move ${pctUp(v)}` },
  { id: 'conscription', branch: 'offense', col: 2, needs: [['march', 2]], icon: '📜', name: 'Conscription', base: 300, grow: 2.2, max: 5, value: (l) => 0.97 ** l, text: (v) => `neutrals defend ${pctDown(v)}` },
  { id: 'archers', branch: 'offense', col: 3, needs: [['conscription', 1], ['walls', 1]], icon: '🏹', name: 'Archers', base: 900, grow: 2.4, max: 5, value: (l) => idleCfg.archerRate * l, text: (v, sc) => (v ? `shoot ${fmtRate(v * sc)}/s into each enemy neighbour` : 'your tiles shoot enemy neighbours') },
  { id: 'plunder', branch: 'offense', col: 4, needs: [['archers', 2]], icon: '💰', name: 'Plunder', base: 4000, grow: 2.5, max: 5, value: (l) => 0.005 * l, text: (v) => `taken enemy tiles add ${(v * 100).toFixed(1)}% of cap` },
  { id: 'mistblades', branch: 'offense', col: 5, cur: 'mist', needs: [['plunder', 1], ['atk', 6]], icon: '⚜️', name: 'Mist blades', base: 1, grow: 2, max: 5, value: (l) => 1.1 ** l, text: (v) => `attack x${v.toFixed(2)} (on top of blades)` },
  // defense: shield wall -> great walls -> bigger camp -> mist veil
  { id: 'def', branch: 'defense', col: 0, icon: '🛡️', name: 'Shield wall', base: 40, grow: 1.9, value: (l) => 1.05 ** l, text: (v) => `defense ${pctUp(v)}` },
  { id: 'walls', branch: 'defense', col: 1, needs: [['def', 2]], icon: '🧱', name: 'Great walls', base: 150, grow: 2.3, max: 4, value: (l) => 0.12 * l, text: (v) => `capital defense +${Math.round(v * 100)}%` },
  { id: 'start', branch: 'defense', col: 2, needs: [['walls', 2]], icon: '🏕️', name: 'Bigger camp', base: 400, grow: 2.2, value: (l) => idleCfg.startTroops + 8 * l, text: (v, sc) => `start with ${fmtBig(v * sc)} foglets` },
  { id: 'mistveil', branch: 'defense', col: 3, cur: 'mist', needs: [['start', 1], ['def', 6]], icon: '🌁', name: 'Mist veil', base: 1, grow: 2, max: 5, value: (l) => 1.1 ** l, text: (v) => `defense x${v.toFixed(2)} (on top of shields)` },
  // growth: fertile fog -> master builders -> engineers -> deep roots
  { id: 'growth', branch: 'growth', col: 0, icon: '🌱', name: 'Fertile fog', base: 50, grow: 2, value: (l) => 1.04 ** l, text: (v) => `growth ${pctUp(v)}` },
  { id: 'granary', branch: 'growth', col: 1, needs: [['growth', 2]], icon: '🌾', name: 'Master builders', base: 160, grow: 2.2, max: 5, value: (l) => 1 + 0.06 * l, text: (v) => `farms, hospitals, labs ${pctUp(v)}` },
  { id: 'engineers', branch: 'growth', col: 2, needs: [['granary', 2]], icon: '🛠️', name: 'Engineers', base: 450, grow: 2.2, max: 5, value: (l) => 0.96 ** l, text: (v) => `buildings cost ${pctDown(v)}` },
  { id: 'roots', branch: 'growth', col: 3, cur: 'mist', needs: [['engineers', 1]], icon: '🌳', name: 'Deep roots', base: 1, grow: 2, max: 5, value: (l) => 1 + 0.4 * l, text: (v) => `your land raises ${(idleCfg.deplete * v).toFixed(0)}x its cap before it runs dry` },
  // fog: harvest -> wells (Fog while you hold tiles) -> horn (Fog in real time) -> drift -> mistborn
  { id: 'fog', branch: 'fog', col: 0, icon: '🧺', name: 'Fog harvest', base: 80, grow: 2.3, value: (l) => 1.05 ** l, text: (v) => `Fog ${pctUp(v)}` },
  { id: 'wells', branch: 'fog', col: 1, needs: [['fog', 2]], icon: '⛲', name: 'Fog wells', base: 300, grow: 2.4, max: 5, value: (l) => idleCfg.wellRate * l, text: (v, sc) => (v ? `${fmtRate(v * sc)} Fog/s per tile held` : 'tiles you hold make Fog') },
  { id: 'horn', branch: 'fog', col: 2, needs: [['wells', 1]], icon: '📯', name: 'Fog horn', base: 600, grow: 2.5, max: 5, value: (l) => idleCfg.hornRate * l, text: (v, sc, id) => (v ? `gathers ${fmtRate(v * displayScale(Math.max(1, id?.best ?? 1)) * (id?.fogMult ?? 1))} Fog/s, played or away (holds ${idleCfg.hornHours} h)` : 'gathers Fog in real time, even while away') },
  { id: 'drift', branch: 'fog', col: 3, needs: [['horn', 1], ['wells', 2]], icon: '🌀', name: 'Fog drift', base: 1500, grow: 3, max: 5, value: (l) => 2 * l, text: (v) => (v ? `start runs at stage ${1 + v} (max half your best)` : 'start runs further in') },
  { id: 'mistborn', branch: 'fog', col: 4, cur: 'mist', needs: [['drift', 1]], icon: '💠', name: 'Mistborn', base: 2, grow: 2, max: 5, value: (l) => 1.2 ** l, text: (v) => `all Fog x${v.toFixed(2)}` },
  // command (auto-battle): attack -> neutrals -> reinforce -> build (+ master builders) -> sharp eye
  { id: 'auto', branch: 'command', col: 0, icon: '🤖', name: 'Auto-attack', base: 40, grow: 2.6, max: 5, value: (l) => l, text: (v) => `attack enemies from ${Math.round(autoTh[v || 1] * 100)}% full tiles` },
  { id: 'autoneutral', branch: 'command', col: 1, needs: [['auto', 2]], icon: '🧭', name: 'Auto-expand', base: 200, grow: 1, max: 1, value: (l) => l, text: () => 'auto-attack takes neutral tiles too' },
  { id: 'reinforce', branch: 'command', col: 2, needs: [['autoneutral', 1]], icon: '🔁', name: 'Auto-reinforce', base: 700, grow: 1, max: 1, value: (l) => l, text: () => 'full back tiles feed the front' },
  { id: 'autobuild', branch: 'command', col: 3, needs: [['reinforce', 1], ['granary', 1]], icon: '🏗️', name: 'Auto-build', base: 2500, grow: 1, max: 1, value: (l) => l, text: () => 'full tiles build what pays back fastest' },
  { id: 'sharpeye', branch: 'command', col: 4, cur: 'mist', needs: [['autobuild', 1]], icon: '👁️', name: 'Sharp eye', base: 1, grow: 2, max: 3, value: (l) => margins[l], text: (v) => `auto-attack sends +${Math.round((v - 1) * 100)}% over what it needs` },
];
export const upgradeById = Object.fromEntries(upgrades.map((u) => [u.id, u]));

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
// per-second rates: two decimals below 10 (0.15/s), else like fmtBig
const fmtRate = (v) => (v < 10 ? String(Math.round(v * 100) / 100) : fmtBig(v));

const save_key = 'frontlines.idle';
const fields = ['fogs', 'total', 'mist', 'mistTotal', 'levels', 'auto', 'stage', 'runFogs', 'runTime', 'best', 'fast10', 'runs', 'hornAt', 'hornStored'];
const blank = () => ({ fogs: 0, total: 0, mist: 0, mistTotal: 0, levels: {}, auto: true, stage: 1, runFogs: 0, runTime: 0, best: 0, fast10: 0, runs: 0, hornAt: 0, hornStored: 0 });

// the idle profile (kept between runs): Fog, Mist, upgrade levels, best stage, horn, the run in progress
export class Idle {
  constructor(data = {}) {
    Object.assign(this, blank(), data);
    // levels of upgrades that no longer exist (e.g. the old time warp) are dropped
    this.levels = Object.fromEntries(Object.entries(data.levels ?? {}).filter(([id]) => upgradeById[id]));
  }

  static load() {
    try { return new Idle(JSON.parse(localStorage.getItem(save_key)) ?? {}); } catch { return new Idle(); }
  }

  save() {
    try { localStorage.setItem(save_key, JSON.stringify(Object.fromEntries(fields.map((k) => [k, this[k]])))); } catch { /* storage blocked */ }
  }

  lvl(id) { return this.levels[id] ?? 0; }
  val(id) { return upgradeById[id].value(this.lvl(id)); }
  cur(id) { return upgradeById[id].cur ?? 'fog'; }
  cost(id) { const u = upgradeById[id]; return Math.ceil(u.base * u.grow ** this.lvl(id)); }
  wallet(id) { return this.cur(id) === 'mist' ? this.mist : this.fogs; }
  maxed(id) { const u = upgradeById[id]; return u.max !== undefined && this.lvl(id) >= u.max; }
  // the requirements still missing (empty = open)
  missing(id) { return (upgradeById[id].needs ?? []).filter(([n, l]) => this.lvl(n) < l); }
  locked(id) { return this.missing(id).length > 0; }
  canBuy(id) { return !this.maxed(id) && !this.locked(id) && this.wallet(id) >= this.cost(id); }

  buy(id, now = Date.now()) {
    if (!this.canBuy(id)) return false;
    if (id === 'horn') this.settleHorn(now);   // what it gathered so far counts at the old rate
    if (this.cur(id) === 'mist') this.mist -= this.cost(id); else this.fogs -= this.cost(id);
    this.levels[id] = this.lvl(id) + 1;
    return true;
  }

  // the player's sim modifiers from upgrades (same keys as battle.js / expedition perks)
  mods() {
    const g = this.val('granary');
    return {
      atk: this.val('atk') * this.val('mistblades'), def: this.val('def') * this.val('mistveil'), growth: this.val('growth'), speed: this.val('march'),
      cost: this.val('engineers'), neutralDef: this.val('conscription'), loot: this.val('plunder'),
      farm: g, hospital: g, lab: g, capitalDef: this.val('walls'), archers: this.val('archers'), land: this.val('roots'),
    };
  }

  get scale() { return displayScale(this.stage); }
  get fogMult() { return this.val('fog') * this.val('mistborn'); }
  get autoOn() { return this.auto && this.lvl('auto') > 0; }
  // first stage of a new run: fog drift skips ahead, at most to half the best stage reached
  get startStage() { return Math.max(1, Math.min(1 + this.val('drift'), Math.floor(this.best / 2))); }

  // Fog for sim foglets killed on the current stage (ghost stages pay double). divided by the
  // stage's enemy growth: stronger enemies field more foglets, each is worth less, so a stage pays
  // about the same share of its display scale however strong the rivals are
  fogsFor(killed) { return (killed * idleCfg.fogPerKill * this.scale * this.fogMult * (stageSpec(this.stage).ghost ? 2 : 1)) / enemyGrowthAt(this.stage); }
  // fog wells: Fog for holding tiles over dt game seconds
  wellFogs(tiles, dt) { return this.val('wells') * tiles * dt * this.scale * this.fogMult; }
  clearFogs() { return idleCfg.clearBonus * this.stage * this.scale * this.fogMult * (stageSpec(this.stage).boss ? 3 : 1); }

  earn(f) { this.fogs += f; this.total += f; this.runFogs += f; }

  // ---- fog horn: Fog in real time (ms timestamps), played or away, up to hornHours of it ----
  get hornRate() { return this.val('horn') * displayScale(Math.max(1, this.best)) * this.fogMult; }   // Fog per real second
  get hornCap() { return this.hornRate * idleCfg.hornHours * 3600; }
  hornAmount(now = Date.now()) {
    if (!this.lvl('horn')) return 0;
    if (!this.hornAt) this.hornAt = now;
    return Math.min(this.hornCap, this.hornStored + (this.hornRate * Math.max(0, now - this.hornAt)) / 1000);
  }
  // fix what the horn holds now (before its rate changes)
  settleHorn(now = Date.now()) { this.hornStored = this.hornAmount(now); this.hornAt = now; }
  // empty the horn into the bank; returns the amount
  collectHorn(now = Date.now()) {
    const a = this.hornAmount(now);
    this.fogs += a; this.total += a;
    this.hornStored = 0; this.hornAt = now;
    return a;
  }

  // auto-battle, run after every sim step while it is on. every autoEvery game seconds each of your
  // tiles that is full enough (90% at level 1 ... 50% at level 5) attacks the weakest enemy tile
  // next to it that it can beat (neutrals too with auto-expand); with auto-reinforce, full back
  // tiles push foglets one step toward the front; with auto-build, a full tile builds the building
  // that pays back fastest. the player can still give any order by hand
  autoTick(b, dt) {
    if (!this.autoOn || b.state !== 'running') return;
    b.autoT = (b.autoT ?? 0) + dt;
    if (b.autoT < idleCfg.autoEvery) return;
    b.autoT = 0;
    const th = autoTh[this.lvl('auto')], neutral = this.lvl('autoneutral') > 0, margin = this.val('sharpeye');
    const mine = b.segs.filter((s) => s.owner === 0);
    const busy = new Set(b.armies.filter((a) => a.owner === 0).map((a) => a.to));   // already under our attack
    const full = (s) => s.troops >= th * s.cap;
    for (const s of mine) {
      if (!full(s)) continue;
      let best = null;
      for (const id of s.adj) {
        const t = b.segs[id];
        if (t.owner === 0 || busy.has(id) || (t.owner < 0 && !neutral)) continue;
        const need = (t.troops * b.fightDef(t, 0) * margin) / b.atkMult(s) + 2;   // safety margin (sharp eye lowers it)
        if (need < s.troops - 1 && (!best || need < best.need)) best = { id, need };
      }
      if (best && b.send(0, s.id, best.id, Math.ceil(best.need), true)) busy.add(best.id);
      else if (this.lvl('autobuild') && !s.building && !s.capital) {
        const type = pickBuilding(b, s, 1, mine);
        if (type && s.troops >= b.costOf(0, type) + 0.3 * s.cap) b.build(0, s.id, type);
      }
    }
    if (!this.lvl('reinforce')) return;
    const front = hops(b.map, mine.filter((s) => s.adj.some((a) => b.segs[a].owner !== 0)).map((s) => s.id));
    for (const s of mine) {
      if (front[s.id] < 1 || !full(s)) continue;
      const next = s.adj.map((a) => b.segs[a]).filter((n) => n.owner === 0 && front[n.id] < front[s.id]).sort((x, y) => x.troops - y.troops)[0];
      if (next) b.send(0, s.id, next.id, s.troops * 0.7, true);
    }
  }

  // battle setup for the current stage. stamp = the previous island's outline (zoom-out), if any
  setup(stamp = null, seed = Math.floor(Math.random() * 1e9)) {
    const n = this.stage, st = stageSpec(n), r = rng(seed), types = Object.keys(personalities);
    const E = enemyPower(n), G = enemyGrowthAt(n);
    const ghostAt = st.ghost ? Math.floor(r() * st.bots) : -1, ghost = st.ghost ? sampleProfiles[Math.floor(r() * sampleProfiles.length)] : null;
    const bots = [];
    for (let i = 0; i < st.bots; i++) {
      const boss = st.boss && i === 0, lean = i === ghostAt ? ghost.lean : { atk: 1, def: 1, growth: 1 };
      const p = boss ? idleCfg.bossPower : 1;
      bots.push({
        ai: true, color: i + 1, think: Math.max(1.5, 3 - n * 0.05),
        personality: personalities[boss ? 'aggressive' : types[Math.floor(r() * types.length)]],
        mods: { atk: E * p * lean.atk, def: E * p * lean.def, growth: G * lean.growth, archers: idleCfg.archerRate * st.archers },
        capital: { troops: idleCfg.startTroops * (boss ? 3 : 1), bonus: {} },
        name: i === ghostAt ? ghost.name : boss ? 'Boss' : undefined,
        boss, ghost: i === ghostAt,
      });
    }
    const me = { ai: false, color: 0, mods: this.mods(), capital: { troops: this.val('start'), bonus: {} } };
    const nm = Math.min(idleCfg.neutralMax, E ** idleCfg.neutralExp);
    return {
      seed, cells: st.cells, shape: st.shape, theme: st.theme, neutral: st.neutral, detail: st.detail, stamp,
      camps: n > 1 ? { mult: Math.max(1, nm), share: 0.2, boost: 1.3 } : undefined,
      deplete: idleCfg.deplete, quietEnd: idleCfg.quietEnd,
      factions: [me, ...bots],
      ghost: ghost && { name: ghost.name }, boss: st.boss,
    };
  }

  // a stage was won: bonus Fog (and Mist from a boss), next stage. returns { bonus, mist }
  win(secs) {
    const bonus = this.clearFogs(), mist = stageSpec(this.stage).boss ? bossMist(this.stage) : 0;
    this.earn(bonus);
    this.mist += mist; this.mistTotal += mist;
    this.runTime += secs;
    if (this.stage === 10 && (!this.fast10 || this.runTime < this.fast10)) this.fast10 = Math.round(this.runTime);
    this.stage++;
    this.best = Math.max(this.best, this.stage);   // best = highest stage reached
    return { bonus, mist };
  }

  // the run ended (stage lost or withdrawn): reset the run, keep Fog, Mist and upgrades.
  // returns the run summary for the end card
  endRun(secs) {
    this.best = Math.max(this.best, this.stage);
    const out = { reached: this.stage, fogs: this.runFogs, secs: this.runTime + secs, best: this.best, fast10: this.fast10 };
    this.runs++;
    this.stage = this.startStage; this.runFogs = 0; this.runTime = 0;
    return out;
  }
}
