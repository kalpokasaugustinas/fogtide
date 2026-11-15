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
import { personalities, pickBuilding } from './ai.js?v=126';
import { rng, hops } from './mapgen.js?v=126';
import { effects, rules } from './config.js?v=126';

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
  bossPower: 1.15,    // boss attack / defense on top of the stage's enemy strength (sim 2026-11-14: 1.35 made stage 10 a 6-run wall)
  rival2: 5, rival3: 11, rival4: 21,   // stage where the 2nd / 3rd / 4th rival joins (the stage after a boss, not on it)
  bossTroops: 2,      // the boss capital starts with 2x the normal troops
  mistExp: 1.5,       // Mist per boss = round((stage / 10) ^ 1.5): 1, 3, 5, 8, 11 ... deeper bosses pay more
  ghostEvery: 10, ghostAt: 5,   // stage 5, 15, 25...: one rival plays another player's profile
  startTroops: 10,    // capital troops at the start of a stage (+ the camp upgrade)
  archerRate: 0.15,   // archers: sim foglets killed per second per level, per enemy tile next door
  botArchersEvery: 6, // idle bots get one archer level every 6 stages (max 5)
  wellRate: 0.04,     // fog wells: sim-foglet Fog per owned tile per game second per level
  autoEvery: 1,       // auto-battle checks your tiles every game second
  // auto-attack: a tile is also ready after waiting this long (game s, by level 1-5) without being
  // full. tiles fill in 50-90 s at x1 growth (stages 1-9), longer than a whole stage, so a fullness
  // rule alone left the auto-battle idle early on (sim 2026-11-15, see README)
  autoWait: [30, 30, 25, 20, 15, 10],
  deplete: 5,         // a tile's land raises at most 5 x its cap foglets in total, then it stops growing
  quietEnd: 30,       // nobody marching for 30 game s: the side with the most foglets wins the stage
  hornRate: 0.15,     // fog horn: sim Fog per real second per level (x display scale of your best stage); level 5 ~ 40% of active play
  hornHours: 8,       // the horn holds at most 8 hours of Fog
};

// stage n (1-based): map size, rivals, climate. something new every 10 stages (climate, a rival)
const climates = ['summer', 'autumn', 'moor', 'desert', 'winter'];
export function stageSpec(n) {
  const cells = Math.min(24, 4 + n);                       // stage 1: 5 tiles ... stage 20+: 24
  const bots = n < idleCfg.rival2 ? 1 : n < idleCfg.rival3 ? 2 : n < idleCfg.rival4 ? 3 : 4;
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

// upgrade tree (compass): your base in the middle, 5 branches go out like spokes and each one forks
// into two paths (passive-tree style); 5 bridge nodes on the outer ring join neighbouring branches.
// placement: ring = distance from the centre (0-4), off = degrees left (-) / right (+) of the
// branch's direction (bridges: ang = their own direction). needs = [[id, level], ...]: a node opens
// once every listed upgrade has that level; or: true = any one of them is enough (merge and bridge
// nodes, reachable from either side). cost = base x grow^level in Fog, or in Mist for the keystones
// (cur: 'mist'). max = level cap (the root stats have none). value(l) = the effect at level l
const pctUp = (v) => `+${Math.round((v - 1) * 100)}%`;
const pctDown = (v) => `-${Math.round((1 - v) * 100)}%`;
export const branches = [
  { id: 'offense', icon: '⚔️', name: 'Offense', ang: -90, color: '#e2483d' },
  { id: 'defense', icon: '🛡️', name: 'Defense', ang: -18, color: '#2f74d6' },
  { id: 'growth', icon: '🌱', name: 'Growth', ang: 54, color: '#33b366' },
  { id: 'fog', icon: '🌫️', name: 'Fog', ang: 126, color: '#16a3b5' },
  { id: 'command', icon: '🤖', name: 'Command', ang: 198, color: '#8b55c9' },
];
export const bridgeColor = '#e0961a';   // bridge nodes (between two branches) are gold
const autoTh = [1, 0.9, 0.8, 0.7, 0.6, 0.5];   // auto-attack: tile fullness that triggers an attack, by level
const margins = [1.25, 1.18, 1.12, 1.06];       // auto-attack safety margin, by sharp eye level
export const upgrades = [
  // offense: blades, then the blitz path (march -> conscription -> plunder) and the might path
  // (veterans -> archers -> volley); both lead to mist blades
  { id: 'atk', branch: 'offense', ring: 0, off: 0, icon: '🗡️', name: 'Sharper blades', base: 40, grow: 1.9, value: (l) => 1.05 ** l, text: (v) => `attack ${pctUp(v)}` },
  { id: 'march', branch: 'offense', ring: 1, off: -20, needs: [['atk', 2]], icon: '🥾', name: 'Forced march', base: 120, grow: 2.2, max: 5, value: (l) => 1 + 0.04 * l, text: (v) => `armies move ${pctUp(v)}` },
  { id: 'veterans', branch: 'offense', ring: 1, off: 20, needs: [['atk', 2]], icon: '🎖️', name: 'Veterans', base: 480, grow: 2, max: 10, value: (l) => 1.01 ** l, text: (v) => `attack ${pctUp(v)} more` },
  { id: 'conscription', branch: 'offense', ring: 2, off: -22, needs: [['march', 2]], icon: '📜', name: 'Conscription', base: 300, grow: 2.2, max: 5, value: (l) => 0.97 ** l, text: (v) => `neutrals defend ${pctDown(v)}` },
  { id: 'archers', branch: 'offense', ring: 2, off: 22, needs: [['veterans', 4]], icon: '🏹', name: 'Archers', base: 1400, grow: 2.4, max: 5, value: (l) => idleCfg.archerRate * l, text: (v, sc) => (v ? `shoot ${fmtRate(v * sc)}/s into each enemy neighbour` : 'your tiles shoot enemy neighbours') },
  { id: 'plunder', branch: 'offense', ring: 3, off: -22, needs: [['conscription', 2]], icon: '💰', name: 'Plunder', base: 4000, grow: 2.5, max: 5, value: (l) => 0.005 * l, text: (v) => `taken enemy tiles add ${(v * 100).toFixed(1)}% of cap` },
  { id: 'volley', branch: 'offense', ring: 3, off: 22, needs: [['archers', 2]], icon: '🎯', name: 'Volley', base: 15000, grow: 2.6, max: 4, value: (l) => 1 + 0.15 * l, text: (v) => `archers shoot ${pctUp(v)}` },
  { id: 'mistblades', branch: 'offense', ring: 4, off: 0, cur: 'mist', or: true, needs: [['plunder', 1], ['volley', 1]], icon: '⚜️', name: 'Mist blades', base: 1, grow: 2, max: 5, value: (l) => 1.1 ** l, text: (v) => `attack x${v.toFixed(2)} (on top of blades)` },
  // defense: shield wall, then the walls path (great walls -> bigger camp) and the forts path
  // (stonemasons -> field medics); they meet at stoneskin, then mist veil
  { id: 'def', branch: 'defense', ring: 0, off: 0, icon: '🛡️', name: 'Shield wall', base: 40, grow: 1.9, value: (l) => 1.05 ** l, text: (v) => `defense ${pctUp(v)}` },
  { id: 'walls', branch: 'defense', ring: 1, off: -20, needs: [['def', 2]], icon: '🧱', name: 'Great walls', base: 150, grow: 2.3, max: 4, value: (l) => 0.12 * l, text: (v) => `capital defense +${Math.round(v * 100)}%` },
  { id: 'masons', branch: 'defense', ring: 1, off: 20, needs: [['def', 2]], icon: '🏰', name: 'Stonemasons', base: 480, grow: 2.2, max: 5, value: (l) => effects.fortDefense + 0.05 * l, text: (v) => `forts defend x${v.toFixed(2)}` },
  { id: 'start', branch: 'defense', ring: 2, off: -22, needs: [['walls', 2]], icon: '🏕️', name: 'Bigger camp', base: 400, grow: 2.2, value: (l) => idleCfg.startTroops + 8 * l, text: (v, sc) => `start with ${fmtBig(v * sc)} foglets` },
  { id: 'medics', branch: 'defense', ring: 2, off: 22, needs: [['masons', 1]], icon: '⛑️', name: 'Field medics', base: 1350, grow: 2.2, max: 5, value: (l) => 1 + 0.04 * l, text: (v) => `hospitals ${pctUp(v)}` },
  { id: 'stoneskin', branch: 'defense', ring: 3, off: 0, or: true, needs: [['start', 1], ['medics', 1]], icon: '⛰️', name: 'Stoneskin', base: 7200, grow: 2.2, max: 10, value: (l) => 1.01 ** l, text: (v) => `defense ${pctUp(v)} more` },
  { id: 'mistveil', branch: 'defense', ring: 4, off: 0, cur: 'mist', needs: [['stoneskin', 1]], icon: '🌁', name: 'Mist veil', base: 1, grow: 2, max: 5, value: (l) => 1.1 ** l, text: (v) => `defense x${v.toFixed(2)} (on top of shields)` },
  // growth: fertile fog, then the builders path (master builders -> engineers -> deep roots) and the
  // fields path (spring rains -> scholars -> harvest moon); both lead to evergreen
  { id: 'growth', branch: 'growth', ring: 0, off: 0, icon: '🌱', name: 'Fertile fog', base: 50, grow: 2, value: (l) => 1.04 ** l, text: (v) => `growth ${pctUp(v)}` },
  { id: 'granary', branch: 'growth', ring: 1, off: -20, needs: [['growth', 2]], icon: '🌾', name: 'Master builders', base: 160, grow: 2.2, max: 5, value: (l) => 1 + 0.06 * l, text: (v) => `farms, hospitals, labs ${pctUp(v)}` },
  { id: 'rains', branch: 'growth', ring: 1, off: 20, needs: [['growth', 2]], icon: '🌧️', name: 'Spring rains', base: 540, grow: 2, max: 10, value: (l) => 1.01 ** l, text: (v) => `growth ${pctUp(v)} more` },
  { id: 'engineers', branch: 'growth', ring: 2, off: -22, needs: [['granary', 2]], icon: '🛠️', name: 'Engineers', base: 450, grow: 2.2, max: 5, value: (l) => 0.96 ** l, text: (v) => `buildings cost ${pctDown(v)}` },
  { id: 'scholars', branch: 'growth', ring: 2, off: 22, needs: [['rains', 2]], icon: '🔬', name: 'Scholars', base: 1500, grow: 2.2, max: 4, value: (l) => 1 + 0.06 * l, text: (v) => `labs ${pctUp(v)}` },
  { id: 'roots', branch: 'growth', ring: 3, off: -22, cur: 'mist', needs: [['engineers', 1]], icon: '🌳', name: 'Deep roots', base: 1, grow: 2, max: 5, value: (l) => 1 + 0.4 * l, text: (v) => `your land raises ${(idleCfg.deplete * v).toFixed(0)}x its cap before it runs dry` },
  { id: 'harvest', branch: 'growth', ring: 3, off: 22, needs: [['scholars', 1]], icon: '🌕', name: 'Harvest moon', base: 6000, grow: 2.3, max: 5, value: (l) => 1 + 0.04 * l, text: (v) => `farms ${pctUp(v)}` },
  { id: 'evergreen', branch: 'growth', ring: 4, off: 0, cur: 'mist', or: true, needs: [['roots', 1], ['harvest', 1]], icon: '🌲', name: 'Evergreen', base: 2, grow: 2, max: 5, value: (l) => 1.05 ** l, text: (v) => `growth x${v.toFixed(2)} (on top of fertile fog)` },
  // fog: harvest, then the wells path (wells -> horn -> deep horn) and the hunters path
  // (scavengers -> bounty -> mist seeker); fog drift sits between them, then mistborn
  { id: 'fog', branch: 'fog', ring: 0, off: 0, icon: '🧺', name: 'Fog harvest', base: 80, grow: 2.3, value: (l) => 1.05 ** l, text: (v) => `Fog ${pctUp(v)}` },
  { id: 'wells', branch: 'fog', ring: 1, off: -20, needs: [['fog', 2]], icon: '⛲', name: 'Fog wells', base: 300, grow: 2.4, max: 5, value: (l) => idleCfg.wellRate * l, text: (v, sc) => (v ? `${fmtRate(v * sc)} Fog/s per tile held` : 'tiles you hold make Fog') },
  { id: 'scavengers', branch: 'fog', ring: 1, off: 20, needs: [['fog', 2]], icon: '🦅', name: 'Scavengers', base: 900, grow: 2.3, max: 5, value: (l) => 1 + 0.02 * l, text: (v) => `Fog from beaten foglets ${pctUp(v)}` },
  { id: 'horn', branch: 'fog', ring: 2, off: -22, needs: [['wells', 1]], icon: '📯', name: 'Fog horn', base: 600, grow: 2.5, max: 5, value: (l) => idleCfg.hornRate * l, text: (v, sc, id) => (v ? `gathers ${fmtRate(v * displayScale(Math.max(1, id?.best ?? 1)) * (id?.fogMult ?? 1))} Fog/s, played or away (holds ${id?.hornHours ?? idleCfg.hornHours} h)` : 'gathers Fog in real time, even while away') },
  { id: 'bounty', branch: 'fog', ring: 2, off: 22, needs: [['scavengers', 2]], icon: '🏆', name: 'Bounty', base: 2700, grow: 2.5, max: 4, value: (l) => 1 + 0.05 * l, text: (v) => `stage clear bonus ${pctUp(v)}` },
  { id: 'deephorn', branch: 'fog', ring: 3, off: -26, needs: [['horn', 2]], icon: '🐚', name: 'Deep horn', base: 7500, grow: 2.6, max: 3, value: (l) => 2 * l, text: (v) => `the horn holds ${idleCfg.hornHours + v} h` },
  { id: 'drift', branch: 'fog', ring: 3, off: 0, or: true, needs: [['horn', 1], ['bounty', 1]], icon: '🌀', name: 'Fog drift', base: 1500, grow: 3, max: 5, value: (l) => 2 * l, text: (v) => (v ? `start runs at stage ${1 + v} (max half your best)` : 'start runs further in') },
  { id: 'mistseeker', branch: 'fog', ring: 3, off: 26, needs: [['bounty', 1]], icon: '🔮', name: 'Mist seeker', base: 9000, grow: 2.8, max: 3, value: (l) => 1 + 0.25 * l, text: (v) => `bosses drop ${pctUp(v)} Mist` },
  { id: 'mistborn', branch: 'fog', ring: 4, off: 0, cur: 'mist', needs: [['drift', 1]], icon: '💠', name: 'Mistborn', base: 2, grow: 2, max: 5, value: (l) => 1.2 ** l, text: (v) => `all Fog x${v.toFixed(2)}` },
  // command (auto-battle): auto-attack, then the expand path (auto-expand -> auto-reinforce) and the
  // signals path (signal fires -> auto-build); they meet at sharp eye
  { id: 'auto', branch: 'command', ring: 0, off: 0, icon: '🤖', name: 'Auto-attack', base: 40, grow: 2.6, max: 5, value: (l) => l, text: (v) => `attack from ${Math.round(autoTh[v || 1] * 100)}% full tiles, or after ${idleCfg.autoWait[v || 1]} s` },
  { id: 'autoneutral', branch: 'command', ring: 1, off: -20, needs: [['auto', 2]], icon: '🧭', name: 'Auto-expand', base: 200, grow: 1, max: 1, value: (l) => l, text: () => 'auto-attack takes neutral tiles too' },
  { id: 'signals', branch: 'command', ring: 1, off: 20, needs: [['auto', 2]], icon: '🔥', name: 'Signal fires', base: 300, grow: 2.5, max: 2, value: (l) => 1 + 0.5 * l, text: (v) => `auto-battle acts ${v === 1 ? 'every second' : `${v.toFixed(1)}x as often`}` },
  { id: 'reinforce', branch: 'command', ring: 2, off: -22, needs: [['autoneutral', 1]], icon: '🔁', name: 'Auto-reinforce', base: 700, grow: 1, max: 1, value: (l) => l, text: () => 'full back tiles feed the front, tiles under attack get help' },
  { id: 'autobuild', branch: 'command', ring: 2, off: 22, needs: [['signals', 1]], icon: '🏗️', name: 'Auto-build', base: 2500, grow: 1, max: 1, value: (l) => l, text: () => 'full tiles build what pays back fastest' },
  { id: 'sharpeye', branch: 'command', ring: 3, off: 0, cur: 'mist', or: true, needs: [['reinforce', 1], ['autobuild', 1]], icon: '👁️', name: 'Sharp eye', base: 1, grow: 2, max: 3, value: (l) => margins[l], text: (v) => `auto-attack sends +${Math.round((v - 1) * 100)}% over what it needs` },
  // bridges: outer ring between two branches, open from the end of either neighbouring path
  { id: 'warlord', branch: 'bridge', ring: 4, ang: -54, or: true, needs: [['volley', 1], ['start', 1]], icon: '👑', name: 'Warlord', base: 27000, grow: 2.6, max: 5, value: (l) => 1.015 ** l, text: (v) => `attack and defense ${pctUp(v)}` },
  { id: 'sanctuary', branch: 'bridge', ring: 4, ang: 18, or: true, needs: [['medics', 1], ['engineers', 1]], icon: '⛪', name: 'Sanctuary', base: 27000, grow: 2.6, max: 5, value: (l) => 1.01 ** l, text: (v) => `growth and defense ${pctUp(v)}` },
  { id: 'mistgarden', branch: 'bridge', ring: 4, ang: 90, or: true, needs: [['harvest', 1], ['deephorn', 1]], icon: '🌸', name: 'Mist garden', base: 27000, grow: 2.6, max: 4, value: (l) => 1 + 0.08 * l, text: (v) => `fog wells ${pctUp(v)}` },
  { id: 'patrols', branch: 'bridge', ring: 4, ang: 162, or: true, needs: [['mistseeker', 1], ['reinforce', 1]], icon: '🐎', name: 'Patrols', base: 27000, grow: 2.6, max: 5, value: (l) => l, text: (v) => `armies move +${2 * v}%, Fog from beaten foglets +${3 * v}%` },
  { id: 'blitz', branch: 'bridge', ring: 4, ang: 234, or: true, needs: [['autobuild', 1], ['plunder', 1]], icon: '⚡', name: 'Blitz', base: 27000, grow: 2.6, max: 5, value: (l) => l, text: (v) => `armies move +${2 * v}%, neutrals defend -${(1.5 * v).toFixed(1).replace('.0', '')}%` },
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
  missing(id) {
    const u = upgradeById[id], miss = (u.needs ?? []).filter(([n, l]) => this.lvl(n) < l);
    if (this.lvl(id) > 0) return [];   // owned (e.g. bought before the tree changed): stays open
    return u.or && miss.length < (u.needs ?? []).length ? [] : miss;
  }
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
    const g = this.val('granary'), war = this.val('warlord'), sanc = this.val('sanctuary');
    const patrols = this.lvl('patrols'), blitz = this.lvl('blitz');
    const m = {
      atk: this.val('atk') * this.val('veterans') * this.val('mistblades') * war,
      def: this.val('def') * this.val('stoneskin') * this.val('mistveil') * war * sanc,
      growth: this.val('growth') * this.val('rains') * this.val('evergreen') * sanc,
      speed: this.val('march') * (1 + 0.02 * patrols) * (1 + 0.02 * blitz),
      cost: this.val('engineers'), neutralDef: this.val('conscription') * (1 - 0.015 * blitz), loot: this.val('plunder'),
      farm: g * this.val('harvest'), hospital: g * this.val('medics'), lab: g * this.val('scholars'),
      capitalDef: this.val('walls'), archers: this.val('archers') * this.val('volley'), land: this.val('roots'),
    };
    if (this.lvl('masons')) m.fort = this.val('masons');   // forts: x1.75 unless stonemasons
    return m;
  }

  get scale() { return displayScale(this.stage); }
  get fogMult() { return this.val('fog') * this.val('mistborn'); }
  get autoOn() { return this.auto && this.lvl('auto') > 0; }
  // first stage of a new run: fog drift skips ahead, at most to half the best stage reached
  get startStage() { return Math.max(1, Math.min(1 + this.val('drift'), Math.floor(this.best / 2))); }

  // Fog for sim foglets killed on the current stage (ghost stages pay double). divided by the
  // stage's enemy growth: stronger enemies field more foglets, each is worth less, so a stage pays
  // about the same share of its display scale however strong the rivals are
  fogsFor(killed) { return (killed * idleCfg.fogPerKill * this.scale * this.fogMult * this.killMult * (stageSpec(this.stage).ghost ? 2 : 1)) / enemyGrowthAt(this.stage); }
  // scavengers and patrols: more Fog per beaten foglet
  get killMult() { return this.val('scavengers') * (1 + 0.03 * this.lvl('patrols')); }
  // fog wells: Fog for holding tiles over dt game seconds
  wellFogs(tiles, dt) { return this.val('wells') * this.val('mistgarden') * tiles * dt * this.scale * this.fogMult; }
  clearFogs() { return idleCfg.clearBonus * this.stage * this.scale * this.fogMult * this.val('bounty') * (stageSpec(this.stage).boss ? 3 : 1); }

  earn(f) { this.fogs += f; this.total += f; this.runFogs += f; }

  // ---- fog horn: Fog in real time (ms timestamps), played or away, up to hornHours of it ----
  get hornRate() { return this.val('horn') * displayScale(Math.max(1, this.best)) * this.fogMult; }   // Fog per real second
  get hornHours() { return idleCfg.hornHours + this.val('deephorn'); }   // deep horn adds hours
  get hornCap() { return this.hornRate * this.hornHours * 3600; }
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

  // auto-battle, run after every sim step while it is on. every autoEvery game seconds (signal fires:
  // more often) your tiles that are full enough (90% at level 1 ... 50% at level 5), or have waited
  // autoWait seconds since they were taken or last sent (30 s ... 10 s), attack:
  //   - targets: enemy tiles next to a ready tile (neutrals too with auto-expand), cheapest first
  //   - need: the defenders when the army gets there (now + their growth on the way + armies marching
  //     in to help them) x their defense x the safety margin (sharp eye lowers it), minus what is
  //     already marching at them, so a running attack is topped up instead of left alone or doubled
  //   - every ready tile next to the target chips in the same share of its spare foglets; if all of
  //     them together are not enough, nothing is sent and they keep growing
  //   - targets are ranked by worth (size, building, relic) per strength needed
  // with auto-build, a ready tile that sent nothing builds what pays back fastest; with
  // auto-reinforce, a tile under attack that can't hold gets help from its neighbours, and ready back
  // tiles pass their foglets one step toward the front, to the emptiest tile (a full tile stops
  // growing, so they are never left sitting full). orders by hand still work
  autoTick(b, dt) {
    if (!this.autoOn || b.state !== 'running') return;
    b.autoT = (b.autoT ?? 0) + dt;
    if (b.autoT < idleCfg.autoEvery / this.val('signals')) return;   // signal fires: more often
    b.autoT = 0;
    const th = autoTh[this.lvl('auto')], neutral = this.lvl('autoneutral') > 0, margin = this.val('sharpeye');
    const mine = b.segs.filter((s) => s.owner === 0);
    // ready = full enough, or waited autoWait since it was taken / last sent (b.autoSince: id -> time)
    const since = (b.autoSince ??= new Map()), wait = idleCfg.autoWait[this.lvl('auto')];
    for (const id of since.keys()) if (b.segs[id].owner !== 0) since.delete(id);
    for (const s of mine) if (!since.has(s.id)) since.set(s.id, b.time);
    const ready = (s) => s.troops >= th * s.cap || (s.troops >= 2 && b.time - since.get(s.id) >= wait);
    const used = new Set();   // tiles that already sent this round
    // already on the way: our strength (foglets x attack) per target, foglets marching in to help it
    const sent = new Map(), help = new Map();
    for (const a of b.armies) {
      if (a.done) continue;
      if (a.owner === 0) sent.set(a.to, (sent.get(a.to) ?? 0) + a.n * a.atk);
      else if (b.segs[a.to].owner === a.owner) help.set(a.to, (help.get(a.to) ?? 0) + a.n);
    }
    const speed = rules.armySpeed * (b.mods(0).speed ?? 1);
    const targets = [];
    for (const t of b.segs) {
      if (t.owner === 0 || (t.owner < 0 && !neutral)) continue;
      const from = t.adj.map((id) => b.segs[id]).filter((s) => s.owner === 0 && ready(s));
      if (!from.length) continue;
      // march time of the farthest helper to the fight point at the border (game s)
      const eta = Math.max(...from.map((s) => Math.hypot(t.x - s.x, t.y - s.y))) / speed * rules.fightAt;
      // what the tile grows meanwhile: owned tiles up to their cap (while their land lasts),
      // neutrals back toward their garrison
      const grow = t.owner < 0 ? (t.troops < t.garrison ? t.baseGrowth * rules.neutralRegrow : 0)
        : t.troops < t.cap && b.landShare(t) > 0 ? t.growth : 0;
      const defenders = t.troops + grow * eta + (help.get(t.id) ?? 0);
      const need = defenders * b.fightDef(t, 0) * margin + 2 - (sent.get(t.id) ?? 0);   // in strength (foglets x attack)
      // worth: bigger tiles, buildings and relics first (like the bots), per strength it costs
      const worth = t.cap / 50 + (t.building ? 0.6 : 0) + (t.relic ? 1.2 : 0) + (t.owner < 0 ? 0.2 : 0);
      if (need > 0) targets.push({ t, from, need, score: worth / need });
    }
    targets.sort((x, y) => y.score - x.score);
    for (const { t, from, need } of targets) {
      const pool = from.filter((s) => !used.has(s.id));
      // all helpers together must reach the need (each keeps one foglet), else wait. each sends the
      // same share of what it can spare, so no border tile is emptied while others stay full
      const power = pool.reduce((v, s) => v + Math.max(0, s.troops - 1) * b.atkMult(s), 0);
      if (power < need) continue;
      const share = need / power;
      for (const s of pool) {
        const n = Math.ceil(Math.max(0, s.troops - 1) * share);
        if (n >= 1 && b.send(0, s.id, t.id, n, true)) used.add(s.id);
      }
    }
    if (this.lvl('autobuild')) {
      for (const s of mine) {
        if (used.has(s.id) || !ready(s) || s.building || s.capital) continue;
        const type = pickBuilding(b, s, 1, mine);
        if (type && s.troops >= b.costOf(0, type) + 0.3 * s.cap) { b.build(0, s.id, type); used.add(s.id); }
      }
    }
    for (const id of used) since.set(id, b.time);
    if (!this.lvl('reinforce')) return;
    // tiles under attack: enemy strength marching at them above what they can hold -> neighbours
    // that are not attacked themselves send the difference (+25%), each the same share of its spare
    const threat = new Map();
    for (const a of b.armies) if (!a.done && a.owner > 0 && b.segs[a.to].owner === 0) threat.set(a.to, (threat.get(a.to) ?? 0) + a.n * a.atk);
    for (const [id, str] of threat) {
      const t = b.segs[id], hold = (t.troops + (sent.get(id) ?? 0)) * b.defMult(t);
      if (str <= hold) continue;
      const pool = t.adj.map((a) => b.segs[a]).filter((s) => s.owner === 0 && !used.has(s.id) && !threat.has(s.id) && s.troops > 2);
      const spare = pool.reduce((v, s) => v + s.troops - 1, 0), want = ((str - hold) / b.defMult(t)) * 1.25;
      if (!spare) continue;
      const share = Math.min(1, want / spare);
      for (const s of pool) if (b.send(0, s.id, id, Math.ceil((s.troops - 1) * share), true)) used.add(s.id);
    }
    const front = hops(b.map, mine.filter((s) => s.adj.some((a) => b.segs[a].owner !== 0)).map((s) => s.id));
    for (const s of mine) {
      if (used.has(s.id) || front[s.id] < 1 || !ready(s)) continue;
      const next = s.adj.map((a) => b.segs[a]).filter((n) => n.owner === 0 && front[n.id] < front[s.id]).sort((x, y) => x.troops / x.cap - y.troops / y.cap)[0];
      if (next && b.send(0, s.id, next.id, s.troops - Math.max(1, 0.05 * s.cap), true)) since.set(s.id, b.time);   // keeps 5% of its cap
    }
    for (const id of used) since.set(id, b.time);
  }

  // battle setup for the current stage (or stage n: main.js pre-builds the next stage's map).
  // stamp = the previous island's outline (zoom-out), if any
  setup(stamp = null, seed = Math.floor(Math.random() * 1e9), n = this.stage) {
    const st = stageSpec(n), r = rng(seed), types = Object.keys(personalities);
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
        capital: { troops: idleCfg.startTroops * (boss ? idleCfg.bossTroops : 1), bonus: {} },
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
      obelisks: Math.min(3, bossMist(n)),   // boss obelisks: one per Mist up to 3 (stage 10 drops 1)
    };
  }

  // a stage was won: bonus Fog (and Mist from a boss), next stage. returns { bonus, mist }
  win(secs) {
    const bonus = this.clearFogs(), mist = stageSpec(this.stage).boss ? Math.round(bossMist(this.stage) * this.val('mistseeker')) : 0;
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
