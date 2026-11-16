// idle mode: endless zoom-out on top of the conquest battle sim. no drawing and no dom here, so the
// same code runs in the game and in the headless balance sim (tools/idle_sim.py).
//
// loop: every stage is one battle. defeated enemy foglets give Fog (the points), a stage win gives a
// bonus, bosses drop Mist (the rare currency), and both buy permanent upgrades in a tree (open it any
// time, a purchase applies at once). losing a stage ends the run; Fog, Mist and upgrades are kept and
// the next run starts at stage 1 (later: further in, with the fog drift upgrade). nothing is
// earned while the game is closed.
//
// numbers: the sim itself never changes scale (a tile still holds ~400 sim foglets). what grows is
//   - the display scale: every number on screen = sim foglets x display^(stage-1), so troop counts
//     and Fog climb to K, M, B... while the battles stay the same size
//   - enemy strength: bots attack, defend and grow stronger every stage, so upgrades are needed to
//     keep going. upgrades never make enemies stronger
import { personalities, pickBuilding } from './ai.js?v=150';
import { rng, hops } from './mapgen.js?v=150';
import { effects, rules } from './config.js?v=150';

export const idleCfg = {
  display: 1.45,      // shown numbers (troops, Fog) grow x1.45 per stage
  enemyBase: 0.75,    // stage 1 bots: attack / defense x0.75 (an easy first island)
  enemyAtk: 1.14,     // bot attack and defense x1.14 per stage (sim 2026-11-16: campaigns end ~5, 7, 12, 14, 20, 23; 1.12 was too easy, 1.16 stalled)
  enemyGrowth: 1.14,  // bot growth x1.12 per stage (growth decides attrition fights, so it must keep up)
  enemyGrowthBase: 0.85,   // stage 1 bots grow at x0.85
  neutralExp: 0.55,   // neutral garrisons x (enemy strength ^ 0.55), at most neutralMax
  neutralMax: 3,
  fogPerKill: 1,      // Fog per defeated sim foglet (then x display scale x fog upgrades)
  clearBonus: 20,     // stage win: 20 x stage x display scale Fog (boss x3)
  bossEvery: 10,      // stage 10, 20, 30...: boss stage (one rival much stronger, bonus x3, drops Mist)
  bossPower: 1,       // boss attack / defense on top of the stage's enemy strength (1.15 still made stage 10 a wall once a loss ends the campaign)
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
  quietEnd: 0,        // (old quiet rule, off in the campaign: faith fade ends stalled stages instead)
  faithFade: 0.01,    // a Fogbound tile with dry land loses 1% of its foglets per game second
  years: 33,          // a campaign lasts 33 years before the Fog Tide; 1 year = 1 minute of game time
  firstYear: 1,       // the game starts in year 1; the year count never stops (the next campaign
                      // starts the year the last one ended), so it reads as total time played
  legacyGrow: 1.3,    // Legacy (Mist) prices x1.3 per level (x1.4 left campaigns 2+ barely ahead of campaign 1)
  vetStep: 0.015,     // veterans: your armies lose 1.5% fewer foglets in fights per level (sim 2026-11-16: 3% made campaigns 2-4 run ~5 stages long)
  thornStep: 0.015,   // stoneskin: attackers lose 1.5% more foglets at your tiles per level
  rainStep: 0.03,     // spring rains: tiles under half full grow 3% faster per level
  obeliskMist: 3,     // Mist per enemy obelisk lit (one per Fogbound chief), first clear of a stage only
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

// upgrade tree: 4 branches (columns in the right-side panel), each forks into two paths
// (passive-tree style); 3 bridge nodes on the bottom row join neighbouring branches. the old
// command branch (auto-battle) is now the War Council (generals, below).
// placement: ring = distance from the centre (0-4), off = degrees left (-) / right (+) of the
// branch's direction (bridges: ang = their own direction). needs = [[id, level], ...]: a node opens
// once every listed upgrade has that level; or: true = any one of them is enough (merge and bridge
// nodes, reachable from either side). cost = base x grow^level in Wisp. max = level cap (the root
// stats have none). value(l) = the effect at level l. the Wisp tree resets when a campaign ends.
// legacy (branch 'legacy', cur: 'mist', slot = place in the Legacy tab): bought with Mist, kept
// forever, no prerequisites; most have no cap (doubling price), so Mist always has a use
const pctUp = (v) => `+${Math.round((v - 1) * 100)}%`;
const pctDown = (v) => `-${Math.round((1 - v) * 100)}%`;
const pct1 = (x) => `${+(x * 100).toFixed(1)}%`;   // 1.5%, 3%, 4.5% ...
export const branches = [
  { id: 'offense', icon: '⚔️', name: 'Offense', ang: -90, color: '#e2483d' },
  { id: 'defense', icon: '🛡️', name: 'Defense', ang: -18, color: '#2f74d6' },
  { id: 'growth', icon: '🌱', name: 'Growth', ang: 54, color: '#33b366' },
  { id: 'fog', icon: '🌫️', name: 'Wisp', ang: 126, color: '#16a3b5' },
];
export const bridgeColor = '#e0961a';   // bridge nodes (between two branches) are gold
export const upgrades = [
  // offense: blades, then the blitz path (march -> conscription -> plunder) and the might path
  // (veterans -> volley: the Marksman's arrows); both lead to mist blades
  { id: 'atk', branch: 'offense', ring: 0, off: 0, icon: '🗡️', name: 'Sharper blades', base: 40, grow: 1.9, value: (l) => 1.05 ** l, text: (v) => `attack ${pctUp(v)}` },
  { id: 'march', branch: 'offense', ring: 1, off: -20, needs: [['atk', 2]], icon: '🥾', name: 'Forced march', base: 120, grow: 2.2, max: 5, value: (l) => 1 + 0.04 * l, text: (v) => `armies move ${pctUp(v)}` },
  { id: 'veterans', branch: 'offense', ring: 1, off: 20, needs: [['atk', 2]], icon: '🎖️', name: 'Veterans', base: 480, grow: 2, max: 10, value: (l) => (1 - idleCfg.vetStep) ** l, text: (v) => `your armies lose ${pct1(1 - v)} fewer foglets in fights` },
  { id: 'conscription', branch: 'offense', ring: 2, off: -22, needs: [['march', 2]], icon: '📜', name: 'Conscription', base: 300, grow: 2.2, max: 5, value: (l) => 0.97 ** l, text: (v) => `neutrals defend ${pctDown(v)}` },
  { id: 'plunder', branch: 'offense', ring: 3, off: -22, needs: [['conscription', 2]], icon: '💰', name: 'Plunder', base: 4000, grow: 2.5, max: 5, value: (l) => 0.005 * l, text: (v) => `taken enemy tiles add ${(v * 100).toFixed(1)}% of cap` },
  { id: 'volley', branch: 'offense', ring: 2, off: 22, needs: [['veterans', 4]], icon: '🎯', name: 'Volley', base: 8000, grow: 2.6, max: 4, value: (l) => 1 + 0.15 * l, text: (v) => `the Marksman's arrows ${pctUp(v)}` },
  { id: 'mistblades', branch: 'legacy', slot: 0, cur: 'mist', icon: '⚜️', name: 'Mist blades', base: 1, grow: 2, value: (l) => 1.1 ** l, text: (v) => `attack x${v.toFixed(2)} (on top of blades)` },
  // defense: shield wall, then the walls path (great walls -> bigger camp) and the forts path
  // (stonemasons -> field medics); they meet at stoneskin, then mist veil
  { id: 'def', branch: 'defense', ring: 0, off: 0, icon: '🛡️', name: 'Shield wall', base: 40, grow: 1.9, value: (l) => 1.05 ** l, text: (v) => `defense ${pctUp(v)}` },
  { id: 'walls', branch: 'defense', ring: 1, off: -20, needs: [['def', 2]], icon: '🧱', name: 'Great walls', base: 150, grow: 2.3, max: 4, value: (l) => 0.12 * l, text: (v) => `capital defense +${Math.round(v * 100)}%` },
  { id: 'masons', branch: 'defense', ring: 1, off: 20, needs: [['def', 2]], icon: '🏰', name: 'Stonemasons', base: 480, grow: 2.2, max: 5, value: (l) => effects.fortDefense + 0.05 * l, text: (v) => `forts defend x${v.toFixed(2)}` },
  { id: 'start', branch: 'defense', ring: 2, off: -22, needs: [['walls', 2]], icon: '🏕️', name: 'Bigger camp', base: 400, grow: 2.2, value: (l) => idleCfg.startTroops + 8 * l, text: (v, sc) => `start with ${fmtBig(v * sc)} foglets` },
  { id: 'medics', branch: 'defense', ring: 2, off: 22, needs: [['masons', 1]], icon: '⛑️', name: 'Field medics', base: 1350, grow: 2.2, max: 5, value: (l) => 1 + 0.04 * l, text: (v) => `hospitals ${pctUp(v)}` },
  { id: 'stoneskin', branch: 'defense', ring: 3, off: 0, or: true, needs: [['start', 1], ['medics', 1]], icon: '⛰️', name: 'Stoneskin', base: 7200, grow: 2.2, max: 10, value: (l) => 1 + idleCfg.thornStep * l, text: (v) => `attackers lose ${pct1(v - 1)} more foglets at your tiles` },
  { id: 'mistveil', branch: 'legacy', slot: 1, cur: 'mist', icon: '🌁', name: 'Mist veil', base: 1, grow: 2, value: (l) => 1.1 ** l, text: (v) => `defense x${v.toFixed(2)} (on top of shields)` },
  // growth: fertile fog, then the builders path (master builders -> engineers -> deep roots) and the
  // fields path (spring rains -> scholars -> harvest moon); both lead to evergreen
  { id: 'growth', branch: 'growth', ring: 0, off: 0, icon: '🌱', name: 'Fertile fog', base: 50, grow: 2, value: (l) => 1.04 ** l, text: (v) => `growth ${pctUp(v)}` },
  { id: 'granary', branch: 'growth', ring: 1, off: -20, needs: [['growth', 2]], icon: '🌾', name: 'Master builders', base: 160, grow: 2.2, max: 5, value: (l) => 1 + 0.06 * l, text: (v) => `farms, hospitals, labs ${pctUp(v)}` },
  { id: 'rains', branch: 'growth', ring: 1, off: 20, needs: [['growth', 2]], icon: '🌧️', name: 'Spring rains', base: 540, grow: 2, max: 10, value: (l) => 1 + idleCfg.rainStep * l, text: (v) => `tiles under half full grow +${pct1(v - 1)}` },
  { id: 'engineers', branch: 'growth', ring: 2, off: -22, needs: [['granary', 2]], icon: '🛠️', name: 'Engineers', base: 450, grow: 2.2, max: 5, value: (l) => 0.96 ** l, text: (v) => `buildings cost ${pctDown(v)}` },
  { id: 'scholars', branch: 'growth', ring: 2, off: 22, needs: [['rains', 2]], icon: '🔬', name: 'Scholars', base: 1500, grow: 2.2, max: 4, value: (l) => 1 + 0.06 * l, text: (v) => `labs ${pctUp(v)}` },
  { id: 'roots', branch: 'legacy', slot: 3, cur: 'mist', icon: '🌳', name: 'Deep roots', base: 1, grow: 2, max: 5, value: (l) => 1 + 0.4 * l, text: (v) => `your land raises ${(idleCfg.deplete * v).toFixed(0)}x its cap before it runs dry` },
  { id: 'harvest', branch: 'growth', ring: 3, off: 22, needs: [['scholars', 1]], icon: '🌕', name: 'Harvest moon', base: 6000, grow: 2.3, max: 5, value: (l) => 1 + 0.04 * l, text: (v) => `farms ${pctUp(v)}` },
  { id: 'evergreen', branch: 'legacy', slot: 2, cur: 'mist', icon: '🌲', name: 'Evergreen', base: 2, grow: 2, value: (l) => 1.05 ** l, text: (v) => `growth x${v.toFixed(2)} (on top of fertile fog)` },
  // fog: harvest, then the wells path and the hunters path
  // (scavengers -> bounty -> mist seeker); fog drift sits between them, then mistborn
  { id: 'fog', branch: 'fog', ring: 0, off: 0, icon: '🧺', name: 'Wisp harvest', base: 80, grow: 2.3, value: (l) => 1.05 ** l, text: (v) => `Wisp ${pctUp(v)}` },
  { id: 'wells', branch: 'fog', ring: 1, off: -20, needs: [['fog', 2]], icon: '⛲', name: 'Wisp wells', base: 300, grow: 2.4, max: 5, value: (l) => idleCfg.wellRate * l, text: (v, sc) => (v ? `${fmtRate(v * sc)} Wisp/s per tile held` : 'tiles you hold make Wisp') },
  { id: 'scavengers', branch: 'fog', ring: 1, off: 20, needs: [['fog', 2]], icon: '🦅', name: 'Scavengers', base: 900, grow: 2.3, max: 5, value: (l) => 1 + 0.02 * l, text: (v) => `Wisp from beaten foglets ${pctUp(v)}` },
  { id: 'bounty', branch: 'fog', ring: 2, off: 22, needs: [['scavengers', 2]], icon: '🏆', name: 'Bounty', base: 2700, grow: 2.5, max: 4, value: (l) => 1 + 0.05 * l, text: (v) => `stage clear bonus ${pctUp(v)}` },
  { id: 'mistseeker', branch: 'fog', ring: 3, off: 26, needs: [['bounty', 1]], icon: '🔮', name: 'Mist seeker', base: 9000, grow: 2.8, max: 3, value: (l) => 1 + 0.25 * l, text: (v) => `bosses drop ${pctUp(v)} Mist` },
  { id: 'mistborn', branch: 'legacy', slot: 4, cur: 'mist', icon: '💠', name: 'Mistborn', base: 2, grow: 2, value: (l) => 1.2 ** l, text: (v) => `all Wisp x${v.toFixed(2)}` },
  // bridges: outer ring between two branches, open from the end of either neighbouring path
  { id: 'warlord', branch: 'bridge', ring: 4, ang: -54, or: true, needs: [['volley', 1], ['start', 1]], icon: '👑', name: 'Warlord', base: 27000, grow: 2.6, max: 5, value: (l) => 1.015 ** l, text: (v) => `attack and defense ${pctUp(v)}` },
  { id: 'sanctuary', branch: 'bridge', ring: 4, ang: 18, or: true, needs: [['medics', 1], ['engineers', 1]], icon: '⛪', name: 'Sanctuary', base: 27000, grow: 2.6, max: 5, value: (l) => 1.01 ** l, text: (v) => `growth and defense ${pctUp(v)}` },
  { id: 'mistgarden', branch: 'bridge', ring: 4, ang: 90, or: true, needs: [['harvest', 1], ['wells', 2]], icon: '🌸', name: 'Mist garden', base: 27000, grow: 2.6, max: 4, value: (l) => 1 + 0.08 * l, text: (v) => `wisp wells ${pctUp(v)}` },
];
export const upgradeById = Object.fromEntries(upgrades.map((u) => [u.id, u]));
export const isLegacy = (id) => upgradeById[id]?.cur === 'mist';

// ---------- war council: 4 seats, generals give the orders (the old command branch) ----------
// generals are unlocked with Mist only, in any order; every unlock raises the next price. a
// seated general works every game second or faster (promote with Fog: level 1-5); the player sets
// each one's orders (sliders / picks, saved). the A key / auto button pauses the generals that
// give orders (warlord, pathfinder, warden, quartermaster, marshal); the others always work
export const council = {
  seatStage: [0, 0, 0, 15],   // best stage needed before each seat opens
  mistCosts: [1, 2, 3, 4, 5, 6, 8, 10, 12],   // unlock price by how many generals are unlocked already
  maxLv: 5,
  promoteBase: 500, promoteGrow: 3,   // promote to level l+1: 500 x 3^(l-1) Fog
  margin: 1.2,          // attacks send 20% over what they need
  rallyAt: 0.3,         // warlord rally: back tiles at least 30% full send troops toward its next target
  drumEvery: 30, drumFor: 8,   // war drummer: a roll every 30 game s, lasting 8 s
};
// game seconds between a general's actions at level l (1 s ... 0.5 s)
const actEvery = (l) => 1 / (1 + 0.25 * (Math.max(1, l) - 1));
const waitAt = (l) => idleCfg.autoWait[Math.max(1, l)];
const pct = (v) => `${Math.round(v * 100)}%`;
// orders: { key, label, type: 'range' (min/max/step, unit) | 'pick' (opts), def }
// text(l, o) = what the general does at level l with orders o; sum(o) = one line under the seat
export const generals = [
  { id: 'warlord', name: 'Warlord', role: 'Auto-attack', quote: 'Full is ready. Ready is now.',
    orders: [{ key: 'at', label: 'Attack at', type: 'range', min: 50, max: 95, step: 5, def: 80, unit: '% full' },
      { key: 'prefer', label: 'Go for', type: 'pick', opts: ['Cheapest', 'Buildings', 'Capitals'], def: 0 }],
    text: (l, o) => `Your tiles attack enemy neighbours on their own once they are ${o.at}% full, or after waiting ${waitAt(l)} s. A target too strong for them: tiles behind send troops forward first. Never neutral land.`,
    sum: (o) => `attacks at ${o.at}% full` },
  { id: 'warden', name: 'Warden', role: 'Auto-defend', quote: 'No tile falls alone.',
    orders: [{ key: 'keep', label: 'Helpers keep at least', type: 'range', min: 10, max: 60, step: 5, def: 30, unit: '%' },
      { key: 'guard', label: 'Guard', type: 'pick', opts: ['All tiles', 'Buildings', 'Capital'], def: 0 }],
    text: (l, o) => `When a tile is attacked and can't hold, its neighbours send what it needs (+25%), each keeping ${o.keep}% of its cap.`,
    sum: (o) => `helpers keep ${o.keep}%` },
  { id: 'marksman', name: 'Marksman', role: 'Arrows', quote: 'I never miss twice.',
    orders: [],
    text: (l, o, sc = 1, vol = 1) => `Your tiles shoot ${fmtRate(idleCfg.archerRate * l * vol * sc)} foglets/s into each enemy neighbour. No Marksman, no arrows.`,
    sum: () => 'arrows on' },
  { id: 'pathfinder', name: 'Pathfinder', role: 'Auto-expand', quote: 'Beyond the fog is just more land.',
    orders: [{ key: 'spend', label: 'Spend at most', type: 'range', min: 10, max: 80, step: 5, def: 40, unit: '% of a tile' },
      { key: 'prefer', label: 'Prefer', type: 'pick', opts: ['Closest', 'Highland', 'Forest', 'Rivers'], def: 0 }],
    text: (l, o) => `Takes neutral tiles as soon as each helper spends at most ${o.spend}% of its foglets.`,
    sum: (o) => `spends up to ${o.spend}%` },
  { id: 'quartermaster', name: 'Quartermaster', role: 'Auto-build', quote: 'A farm today, a fort tomorrow.',
    orders: [{ key: 'first', label: 'Build', type: 'pick', opts: ['Best payback', 'Farms', 'Hospitals', 'Labs', 'Forts'], def: 0 }, { key: 'at', label: 'Build when', type: 'range', min: 60, max: 100, step: 5, def: 90, unit: '% full' }],
    text: (l, o) => `A tile ${o.at}% full without a building builds ${['what pays back fastest', 'a farm', 'a hospital', 'a lab', 'a fort'][o.first]} (it keeps 30% of its cap).`,
    sum: (o) => (o.first ? `${['', 'farms', 'hospitals', 'labs', 'forts'][o.first]} first` : 'best payback') },
  { id: 'marshal', name: 'Marshal', role: 'Supply lines', quote: 'The front eats. The back cooks.',
    orders: [{ key: 'at', label: 'Feed when a back tile is', type: 'range', min: 50, max: 100, step: 5, def: 70, unit: '% full' }],
    text: (l, o) => `Back tiles ${o.at}% full pass all but 5% of their foglets one step toward the front, to the emptiest tile.`,
    sum: (o) => `feeds at ${o.at}%` },
  { id: 'drummer', name: 'War Drummer', role: 'Rally drums', quote: 'Feet follow the beat.',
    orders: [{ key: 'when', label: 'Drum', type: 'pick', opts: ['On cooldown', 'When I attack', 'When attacked'], def: 1 }],
    text: (l) => `A drum roll every ${council.drumEvery} s: for ${council.drumFor} s your armies march and your tiles grow ${pct(0.15 + 0.05 * l)} faster.`,
    sum: (o) => ['every 30 s', 'with attacks', 'when attacked'][o.when] },
  { id: 'houndmaster', name: 'Houndmaster', role: 'War hounds', quote: 'They smell an army before I see it.',
    orders: [{ key: 'range', label: 'Hunt armies marching at', type: 'pick', opts: ['Your tiles', '+1 tile out', '+2 tiles out'], def: 0 }],
    text: (l) => `Hounds run at enemy armies halfway to your border and bite off ${pct(0.08 + 0.02 * l)} of them.`,
    sum: (o) => ['at your tiles', '1 tile out', '2 tiles out'][o.range] },
  { id: 'surgeon', name: 'Field Surgeon', role: 'Revive', quote: 'Not dead. Just resting.',
    orders: [{ key: 'to', label: 'Send them back to', type: 'pick', opts: ['Capital', 'Front line'], def: 0 }],
    text: (l) => `Every foglet you lose has a ${(0.75 + 0.25 * l).toFixed(2).replace(/0$/, '')}% chance to get back up and return.`,
    sum: (o) => (o.to ? 'to the front' : 'to the capital') },
];
export const generalById = Object.fromEntries(generals.map((g) => [g.id, g]));
// the generals that give orders (paused with the auto toggle)
const commanders = ['warlord', 'pathfinder', 'warden', 'quartermaster', 'marshal'];
// upgrades that left the tree (command branch, archers, patrols, blitz): what one level cost, to
// refund old saves. [base, grow, currency]
const retired = { auto: [40, 2.6], autoneutral: [200, 1], signals: [300, 2.5], reinforce: [700, 1], autobuild: [2500, 1], sharpeye: [1, 2, 'mist'], archers: [1400, 2.4], patrols: [27000, 2.6], blitz: [27000, 2.6], horn: [600, 2.5], deephorn: [7500, 2.6], drift: [1500, 3], headstart: [2, 1.4, 'mist'] };   // head start: removed 2026-11-16 (a loss ends the campaign, a late start was a trap)

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
const fields = ['fogs', 'total', 'mist', 'mistTotal', 'levels', 'auto', 'stage', 'runFogs', 'runTime', 'best', 'fast10', 'runs', 'gens', 'seats', 'orders', 'campaign', 'cleared', 'clock', 'year0'];
// gens = general id -> level (unlocked = 1+), seats = 4 x general id | null, orders = id -> { key: value }
// campaign = campaigns started (1 = the first), cleared = highest stage won in this campaign (Mist is
// paid only for stages above it); runFogs / runTime = this campaign's Wisp and time. clock = game
// seconds this campaign has used (33 years x 60 s), year0 = the year it started in
const blank = () => ({ fogs: 0, total: 0, mist: 0, mistTotal: 0, levels: {}, auto: true, stage: 1, runFogs: 0, runTime: 0, best: 0, fast10: 0, runs: 0, gens: {}, seats: [null, null, null, null], orders: {}, campaign: 1, cleared: 0, clock: 0, year0: idleCfg.firstYear });

// the idle profile (kept between runs): Fog, Mist, upgrade levels, best stage, the run in progress
export class Idle {
  constructor(data = {}) {
    Object.assign(this, blank(), data);
    // upgrades that moved to the war council are refunded (Fog / Mist back); owning the old
    // auto-attack / archers seats the Warlord / Marksman for free
    const old = data.levels ?? {};
    for (const [id, [base, grow, cur]] of Object.entries(retired)) {
      let paid = 0;
      for (let i = 0; i < (old[id] ?? 0); i++) paid += Math.ceil(base * grow ** i);
      if (cur === 'mist') this.mist += paid; else this.fogs += paid;
    }
    this.gens = { ...this.gens }; this.orders = { ...this.orders };
    this.seats = [0, 1, 2, 3].map((i) => (generalById[this.seats?.[i]] ? this.seats[i] : null));
    for (const [oldId, gen] of [['auto', 'warlord'], ['archers', 'marksman']]) {
      if (!old[oldId] || this.gens[gen]) continue;
      this.gens[gen] = 1;
      const free = this.seats.findIndex((x, i) => !x && this.seatOpen(i));
      if (free >= 0) this.seats[free] = gen;
    }
    // levels of upgrades that no longer exist (e.g. the old time warp) are dropped
    this.levels = Object.fromEntries(Object.entries(old).filter(([id]) => upgradeById[id]));
    // older saves (endless idle): stages already reached count as cleared (no second Mist for them)
    if (data.cleared === undefined) this.cleared = Math.max(0, (this.best || 1) - 1);
    // older saves counted from year 1147 with 82-133 year gaps between campaigns: restart the count
    // at year 1 (the play time before can't be rebuilt from the save)
    if (this.year0 >= 1000) this.year0 = idleCfg.firstYear;
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
  // legacy nodes share one price growth (idleCfg.legacyGrow), so it can be tuned in one place
  cost(id) { const u = upgradeById[id]; return Math.ceil(u.base * (u.cur === 'mist' ? idleCfg.legacyGrow : u.grow) ** this.lvl(id)); }
  wallet(id) { return this.cur(id) === 'mist' ? this.mist : this.fogs; }
  maxed(id) { const u = upgradeById[id]; return u.max !== undefined && this.lvl(id) >= u.max; }
  // the requirements still missing (empty = open)
  missing(id) {
    const u = upgradeById[id], miss = (u.needs ?? []).filter(([n, l]) => this.lvl(n) < l);   // legacy nodes have no needs
    if (this.lvl(id) > 0) return [];   // owned (e.g. bought before the tree changed): stays open
    return u.or && miss.length < (u.needs ?? []).length ? [] : miss;
  }
  locked(id) { return this.missing(id).length > 0; }
  canBuy(id) { return !this.maxed(id) && !this.locked(id) && this.wallet(id) >= this.cost(id); }

  buy(id) {
    if (!this.canBuy(id)) return false;
    if (this.cur(id) === 'mist') this.mist -= this.cost(id); else this.fogs -= this.cost(id);
    this.levels[id] = this.lvl(id) + 1;
    return true;
  }

  // ---- war council ----
  seatOpen(i) { return (this.best || 1) >= council.seatStage[i]; }
  genLvl(id) { return this.gens[id] ?? 0; }
  seated(id) { return this.seats.includes(id); }
  // the level of a seated general (0 = not in the council)
  on(id) { return this.seated(id) ? this.genLvl(id) : 0; }
  unlockCost() { return council.mistCosts[Math.min(council.mistCosts.length - 1, Object.keys(this.gens).length)]; }
  canUnlock(id) { return !this.genLvl(id) && this.mist >= this.unlockCost(); }
  unlock(id) {
    if (!generalById[id] || !this.canUnlock(id)) return false;
    this.mist -= this.unlockCost();
    this.gens[id] = 1;
    return true;
  }
  promoteCost(id) { return Math.ceil(council.promoteBase * council.promoteGrow ** (this.genLvl(id) - 1)); }
  canPromote(id) { const l = this.genLvl(id); return l > 0 && l < council.maxLv && this.fogs >= this.promoteCost(id); }
  promote(id) {
    if (!this.canPromote(id)) return false;
    this.fogs -= this.promoteCost(id);
    this.gens[id]++;
    return true;
  }
  // put general id on seat i (from another seat it moves; null empties the seat)
  seat(i, id) {
    if (!this.seatOpen(i) || (id && !this.genLvl(id))) return false;
    const was = this.seats.indexOf(id);
    if (id && was >= 0) this.seats[was] = null;
    this.seats[i] = id;
    return true;
  }
  // a general's orders with the defaults filled in
  ord(id) {
    const o = {};
    for (const d of generalById[id].orders) o[d.key] = this.orders[id]?.[d.key] ?? d.def;
    return o;
  }
  setOrder(id, key, v) { (this.orders[id] ??= {})[key] = v; }

  // the player's sim modifiers from upgrades (same keys as battle.js / expedition perks)
  // the campaign clock: game seconds left, years left, the current year and the tide's year
  get secsLeft() { return Math.max(0, idleCfg.years * 60 - this.clock); }
  get yearsLeft() { return Math.ceil(this.secsLeft / 60); }
  get year() { return this.year0 + Math.floor(this.clock / 60); }
  get tideYear() { return this.year0 + idleCfg.years; }

  mods() {
    const g = this.val('granary'), war = this.val('warlord'), sanc = this.val('sanctuary');
    const drum = this.drumOn ? 1.15 + 0.05 * this.on('drummer') : 1;   // war drummer's roll (runtime only)
    const m = {
      atk: this.val('atk') * this.val('mistblades') * war,
      def: this.val('def') * this.val('mistveil') * war * sanc,
      growth: this.val('growth') * this.val('evergreen') * sanc * drum,
      losses: this.val('veterans'), thorns: this.val('stoneskin'), lowGrowth: this.val('rains'),   // own mechanics, not copies of blades / shields / fertile fog
      speed: this.val('march') * drum,
      cost: this.val('engineers'), neutralDef: this.val('conscription'), loot: this.val('plunder'),
      farm: g * this.val('harvest'), hospital: g * this.val('medics'), lab: g * this.val('scholars'),
      capitalDef: this.val('walls'), archers: idleCfg.archerRate * this.on('marksman') * this.val('volley'), land: this.val('roots'),
    };
    if (this.lvl('masons')) m.fort = this.val('masons');   // forts: x1.75 unless stonemasons
    // desktop tune panel: your foglets' strength x cheatPower (runtime only, never saved)
    if (this.cheatPower > 1) for (const k of ['atk', 'def', 'growth']) m[k] *= this.cheatPower;
    return m;
  }

  get scale() { return displayScale(this.stage); }
  get fogMult() { return this.val('fog') * this.val('mistborn'); }
  // the order-giving generals work (council switched on and one of them seated)
  get autoOn() { return this.auto && commanders.some((id) => this.on(id)); }
  // first stage of a new campaign: head start (legacy) skips ahead, at most to half the best stage
  get startStage() { return 1; }   // every campaign starts at stage 1

  // Fog for sim foglets killed on the current stage (ghost stages pay double). divided by the
  // stage's enemy growth: stronger enemies field more foglets, each is worth less, so a stage pays
  // about the same share of its display scale however strong the rivals are
  fogsFor(killed) { return (killed * idleCfg.fogPerKill * this.scale * this.fogMult * this.killMult * (stageSpec(this.stage).ghost ? 2 : 1)) / enemyGrowthAt(this.stage); }
  // scavengers: more Fog per beaten foglet
  get killMult() { return this.val('scavengers'); }
  // fog wells: Fog for holding tiles over dt game seconds
  wellFogs(tiles, dt) { return this.val('wells') * this.val('mistgarden') * tiles * dt * this.scale * this.fogMult; }
  clearFogs() { return idleCfg.clearBonus * this.stage * this.scale * this.fogMult * this.val('bounty') * (stageSpec(this.stage).boss ? 3 : 1); }

  earn(f) { this.fogs += f; this.total += f; this.runFogs += f; }

  // war council, run after every sim step. each seated general acts on its own clock (every
  // game second at level 1 ... 0.5 s at level 5):
  //   - warlord: enemy tiles next to ready tiles (at least <at>% full, or waited autoWait s since
  //     taken / last sent) are attacked. need = the defenders when the army arrives (now + their
  //     growth on the way + armies marching in to help) x their defense x 1.2, minus what already
  //     marches at them; every ready neighbour sends the same share of its spare foglets, or none
  //     do. targets ranked by worth (size, building, relic, + the "go for" pick) per strength
  //   - pathfinder: the same for neutral tiles, only if no helper spends more than <spend>%
  //   - warden: a tile under attack that can't hold gets the difference +25% from neighbours
  //     that aren't attacked, each keeping <keep>% of its cap
  //   - quartermaster: a tile <at>% full without a building builds (keeps 30% of its cap)
  //   - marshal: back tiles <at>% full pass all but 5% one step toward the front
  //   - drummer, houndmaster, surgeon: see generals[]. marksman: arrows via mods()
  // orders by hand still work; the A key pauses the order-giving generals
  autoTick(b, dt) {
    if (b.state !== 'running') return;
    const clock = (b.councilT ??= {});
    const due = (id) => {
      const l = this.on(id);
      if (!l) return false;
      clock[id] = (clock[id] ?? 0) + dt;
      if (clock[id] < actEvery(l)) return false;
      clock[id] = 0;
      return true;
    };
    const mine = b.segs.filter((s) => s.owner === 0);
    const since = (b.autoSince ??= new Map());
    for (const id of since.keys()) if (b.segs[id].owner !== 0) since.delete(id);
    for (const s of mine) if (!since.has(s.id)) since.set(s.id, b.time);
    const used = new Set();   // tiles that already sent / built this step
    // passive generals (always on)
    this.drumTick(b);
    if (this.on('houndmaster')) this.hounds(b);   // every step: armies only spend a moment in range
    this.revive(b, mine);
    if (!this.auto) return;
    // already on the way: our strength (foglets x attack) per target, foglets marching in to help it
    const sent = new Map(), help = new Map();
    for (const a of b.armies) {
      if (a.done) continue;
      if (a.owner === 0) sent.set(a.to, (sent.get(a.to) ?? 0) + a.n * a.atk);
      else if (b.segs[a.to].owner === a.owner) help.set(a.to, (help.get(a.to) ?? 0) + a.n);
    }
    if (due('warlord')) {
      const o = this.ord('warlord'), wait = waitAt(this.on('warlord'));
      const bonus = (t) => (o.prefer === 1 && t.building ? 1 : 0) + (o.prefer === 2 && t.capital ? 2 : 0);
      const short = this.attack(b, { sent, help, used, enemies: true, ready: (s) => s.troops >= (o.at / 100) * s.cap || (s.troops >= 2 && b.time - since.get(s.id) >= wait), bonus });
      if (short) this.rally(b, short, used);   // too strong for the border tiles: gather troops behind them
    }
    if (due('pathfinder')) {
      const o = this.ord('pathfinder'), trait = [null, 'highland', 'forest', 'river'][o.prefer];
      // no readiness wait (a fresh capital took ~20 s to expand while the bots grabbed the land):
      // the spend limit alone keeps a tile from emptying itself
      this.attack(b, { sent, help, used, enemies: false, maxShare: o.spend / 100, ready: (s) => s.troops >= 3, bonus: (t) => (trait && t.trait === trait ? 1.5 : 0) });
    }
    if (due('quartermaster')) {
      const o = this.ord('quartermaster'), allow = [null, ['farm'], ['hospital'], ['lab'], ['fort']][o.first] ?? undefined;
      for (const s of mine) {
        if (used.has(s.id) || s.building || s.capital || s.obelisk || s.troops < (o.at / 100) * s.cap) continue;
        const type = pickBuilding(b, s, 1, mine, allow);
        if (type && s.troops >= b.costOf(0, type) + 0.3 * s.cap && b.build(0, s.id, type)) used.add(s.id);
      }
    }
    if (due('warden')) {
      const o = this.ord('warden');
      const threat = new Map();
      for (const a of b.armies) if (!a.done && a.owner > 0 && b.segs[a.to].owner === 0) threat.set(a.to, (threat.get(a.to) ?? 0) + a.n * a.atk);
      for (const [id, str] of threat) {
        const t = b.segs[id];
        if ((o.guard === 1 && !t.building && !t.capital) || (o.guard === 2 && !t.capital)) continue;
        const hold = (t.troops + (sent.get(id) ?? 0)) * b.defMult(t);
        if (str <= hold) continue;
        const keep = (s) => Math.max(1, (o.keep / 100) * s.cap);
        const pool = t.adj.map((a) => b.segs[a]).filter((s) => s.owner === 0 && !used.has(s.id) && !threat.has(s.id) && s.troops > keep(s) + 1);
        const spare = pool.reduce((v, s) => v + s.troops - keep(s), 0), want = ((str - hold) / b.defMult(t)) * 1.25;
        if (!spare) continue;
        const share = Math.min(1, want / spare);
        for (const s of pool) if (b.send(0, s.id, id, Math.ceil((s.troops - keep(s)) * share), true)) used.add(s.id);
      }
    }
    if (due('marshal')) {
      const at = this.ord('marshal').at / 100;
      const front = hops(b.map, mine.filter((s) => s.adj.some((a) => b.segs[a].owner !== 0)).map((s) => s.id));
      for (const s of mine) {
        if (used.has(s.id) || front[s.id] < 1 || s.troops < at * s.cap) continue;
        const next = s.adj.map((a) => b.segs[a]).filter((n) => n.owner === 0 && front[n.id] < front[s.id]).sort((x, y) => x.troops / x.cap - y.troops / y.cap)[0];
        if (next && b.send(0, s.id, next.id, s.troops - Math.max(1, 0.05 * s.cap), true)) used.add(s.id);
      }
    }
    for (const id of used) since.set(id, b.time);
  }

  // warlord rally: the best enemy target was too strong for the tiles next to it. our tiles behind
  // them (not on any border, at least council.rallyAt full) pass all but 10% one step toward those
  // tiles, through our own land, so the next attack pass can afford it (as the bot gathers troops)
  rally(b, { from }, used) {
    const d = new Map(from.map((s) => [s.id, 0])), q = from.map((s) => s.id);
    for (let k = 0; k < q.length; k++) {
      for (const a of b.segs[q[k]].adj) if (!d.has(a) && b.segs[a].owner === 0) { d.set(a, d.get(q[k]) + 1); q.push(a); }
    }
    for (const [id, dist] of d) {
      const s = b.segs[id];
      if (!dist || used.has(id) || s.troops < Math.max(5, council.rallyAt * s.cap)) continue;
      if (s.adj.some((a) => b.segs[a].owner > 0)) continue;   // border tiles facing a rival keep their troops
      const next = s.adj.filter((a) => d.get(a) === dist - 1).map((a) => b.segs[a]).sort((x, y) => x.troops / x.cap - y.troops / y.cap)[0];
      if (next && b.send(0, id, next.id, s.troops - Math.max(1, 0.1 * s.cap), true)) used.add(id);
    }
  }

  // one attack pass (warlord: enemy tiles, pathfinder: neutrals); see autoTick. returns the best
  // target it could not afford ({ t, from, need }) or null
  attack(b, { sent, help, used, enemies, ready, bonus, maxShare = 1 }) {
    const speed = rules.armySpeed * (b.mods(0).speed ?? 1), targets = [];
    for (const t of b.segs) {
      if (t.owner === 0 || (enemies ? t.owner < 0 : t.owner >= 0)) continue;
      // border = our free tiles next to it, from = those ready to attack (the rally gathers behind
      // the border even while none is ready)
      const border = t.adj.map((id) => b.segs[id]).filter((s) => s.owner === 0 && !used.has(s.id));
      if (!border.length) continue;
      const from = border.filter(ready);
      // march time of the farthest helper to the fight point at the border (game s)
      const eta = Math.max(...border.map((s) => Math.hypot(t.x - s.x, t.y - s.y))) / speed * rules.fightAt;
      // what the tile grows meanwhile: owned tiles up to their cap (while their land lasts),
      // neutrals back toward their garrison
      const grow = t.owner < 0 ? (t.troops < t.garrison ? t.baseGrowth * rules.neutralRegrow : 0)
        : t.troops < t.cap && b.landShare(t) > 0 ? t.growth : 0;
      const defenders = t.troops + grow * eta + (help.get(t.id) ?? 0);
      const need = defenders * b.fightDef(t, 0) * council.margin + 2 - (sent.get(t.id) ?? 0);   // in strength (foglets x attack)
      const worth = t.cap / 50 + (t.building ? 0.6 : 0) + (t.relic ? 1.2 : 0) + bonus(t);
      if (need > 0) targets.push({ t, from, border, need, score: worth / need });
    }
    targets.sort((x, y) => y.score - x.score);
    let short = null;
    for (const { t, from, border, need } of targets) {
      const pool = from.filter((s) => !used.has(s.id));
      // all helpers together must reach the need (each keeps one foglet), else wait. each sends the
      // same share of what it can spare, so no border tile is emptied while others stay full
      const power = pool.reduce((v, s) => v + Math.max(0, s.troops - 1) * b.atkMult(s), 0);
      if (!pool.length || power < need || need / power > maxShare) { short ??= { t, from: border, need }; continue; }
      const share = need / power;
      for (const s of pool) {
        const n = Math.ceil(Math.max(0, s.troops - 1) * share);
        if (n >= 1 && b.send(0, s.id, t.id, n, true)) used.add(s.id);
      }
    }
    return short;
  }

  // war drummer: a roll every drumEvery s (on cooldown / once we attack / once we are attacked)
  // gives faster marches and growth for drumFor s, through mods()
  drumTick(b) {
    const l = this.on('drummer');
    if (!l && !this.drumOn) return;
    b.drumNext ??= 0;
    const refresh = () => { b.factions[0].mods = this.mods(); b.updateGrowth(); };
    if (this.drumOn && (b.time >= b.drumEnd || !l)) { this.drumOn = false; refresh(); }
    if (!l || this.drumOn || b.time < b.drumNext) return;
    const when = this.ord('drummer').when;
    const go = when === 0
      || (when === 1 && b.armies.some((a) => !a.done && a.owner === 0 && b.segs[a.to].owner !== 0))
      || (when === 2 && b.armies.some((a) => !a.done && a.owner > 0 && b.segs[a.to].owner === 0));
    if (!go) return;
    this.drumOn = true; b.drumEnd = b.time + council.drumFor; b.drumNext = b.time + council.drumEvery;
    b.events.push({ type: 'drum' });
    refresh();
  }

  // houndmaster: enemy armies halfway to the border of one of our tiles (or a tile 1-2 steps out) lose a
  // share of their foglets once (counts as killed: Fog)
  hounds(b) {
    const l = this.on('houndmaster'), reach = this.ord('houndmaster').range, bite = 0.08 + 0.02 * l;
    const dist = reach ? hops(b.map, b.segs.filter((s) => s.owner === 0).map((s) => s.id)) : null;
    for (const a of b.armies) {
      if (a.done || a.owner <= 0 || a.hounded || a.t < 0.35 || a.fight || a.clash) continue;
      const t = b.segs[a.to];
      if (!(t.owner === 0 || (dist && dist[t.id] <= reach))) continue;
      const k = a.n * bite;
      a.n -= k; a.hounded = true;
      b.stats.killed += k;
      b.events.push({ type: 'hounds', from: a.from, to: a.to, t: a.t, n: k });
    }
  }

  // field surgeon: each foglet we lose has a small chance to get up again (expected value, kept
  // as a running fraction) and walks back into the capital or the emptiest front tile
  revive(b, mine) {
    const l = this.on('surgeon'), lost = b.stats.deaths - (b.revDeaths ?? 0);
    b.revDeaths = b.stats.deaths;
    if (!l || lost <= 0 || !mine.length) return;
    b.revCarry = (b.revCarry ?? 0) + lost * (0.0075 + 0.0025 * l);
    if (b.revCarry < 1) return;
    const n = Math.floor(b.revCarry);
    b.revCarry -= n;
    const front = mine.filter((s) => s.adj.some((a) => b.segs[a].owner !== 0));
    const to = this.ord('surgeon').to === 1 && front.length ? front.sort((x, y) => x.troops / x.cap - y.troops / y.cap)[0] : mine.find((s) => s.capital) ?? mine[0];
    to.troops += n;
    b.stats.revived = (b.stats.revived ?? 0) + n;
    b.events.push({ type: 'revive', id: to.id, n });
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
    this.drumOn = false;   // a drum roll never carries over into the next stage
    const me = { ai: false, color: 0, mods: this.mods(), capital: { troops: this.val('start'), bonus: {} } };
    const nm = Math.min(idleCfg.neutralMax, E ** idleCfg.neutralExp);
    return {
      seed, cells: st.cells, shape: st.shape, theme: st.theme, neutral: st.neutral, detail: st.detail, stamp,
      camps: n > 1 ? { mult: Math.max(1, nm), share: 0.2, boost: 1.3 } : undefined,
      deplete: idleCfg.deplete, quietEnd: idleCfg.quietEnd, faithFade: idleCfg.faithFade,
      capObelisks: true, homeLit: n > 1,   // obelisks by the keeps: grey on bot capitals, lit on yours after stage 1
      factions: [me, ...bots],
      ghost: ghost && { name: ghost.name }, boss: st.boss,
      obelisks: Math.min(3, bossMist(n)),   // boss obelisks: one per Mist up to 3 (stage 10 drops 1)
    };
  }

  // a stage was won: bonus Wisp; Mist for its obelisks (one per Fogbound chief) and its boss, but
  // only the first time this campaign clears it. there is no last stage: the campaign runs until its
  // clock (33 years) runs out. returns { bonus, mist, obelisks, boss }
  win(secs) {
    const n = this.stage, st = stageSpec(n), first = n > this.cleared;
    const bonus = this.clearFogs();
    const obelisks = first ? st.bots : 0;   // obelisks lit (Mist only on the first clear)
    const boss = first && st.boss ? Math.round(bossMist(n) * this.val('mistseeker')) : 0;
    const mist = obelisks * idleCfg.obeliskMist + boss;
    this.earn(bonus);
    this.mist += mist; this.mistTotal += mist;
    this.runTime += secs;
    if (n === 10 && (!this.fast10 || this.runTime < this.fast10)) this.fast10 = Math.round(this.runTime);
    this.cleared = Math.max(this.cleared, n);
    this.stage++;
    this.best = Math.max(this.best, this.stage);   // best = highest stage reached
    return { bonus, mist, obelisks, boss };
  }

  // the campaign is over (its 33-year clock ran out, a stage was lost, or the player abandoned it): what Wisp bought resets
  // (Wisp, the Wisp tree, general promotions back to level 1), what Mist bought stays (Legacy tree,
  // unlocked generals and their seats). the next campaign starts at the head start stage.
  // returns the summary for the end card
  endCampaign() {
    // the year count goes on: the next campaign starts in the year this one ended (time played)
    const next = this.year;
    const out = { campaign: this.campaign, reached: this.stage, cleared: this.cleared, fogs: this.runFogs, secs: this.runTime, mist: this.mist, tide: this.tideYear, next };
    this.levels = Object.fromEntries(Object.entries(this.levels).filter(([id]) => isLegacy(id)));
    for (const id of Object.keys(this.gens)) this.gens[id] = 1;
    this.fogs = 0; this.runFogs = 0; this.runTime = 0; this.clock = 0; this.year0 = next;
    this.campaign++; this.cleared = 0; this.runs++;
    this.stage = this.startStage;
    return out;
  }
}
