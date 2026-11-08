// all balance numbers live here, so tuning the game = editing this one file

export const rules = {
  grid: 480,          // battle map raster size (cells per side)
  step: 0.1,          // fixed simulation step in seconds
  timeScale: 0.8,     // game seconds per real second at speed x1 (all rates below are per game second)
  armySpeed: 90,      // army travel speed in grid cells per second (scale with grid)
  startTroops: 10,    // troops in each faction's starting segment
  overCapDecay: 1,    // troops/s lost while a segment is above its cap
  fightAt: 0.7,       // attacking armies stop at this share of the way (about the border) and fight there
  fightMin: 1, fightMax: 3, fightScale: 240,   // fight length: 1 s + 2 s x (smaller side's strength / 240), max 3 s
  troopsPerDot: 8,    // one soldier figure per 8 troops; zoomed-out maps show battalions (x5) instead
  routeEvery: 1,      // auto-send routes forward troops every N seconds
  routeMin: 2,        // ...when at least this many troops are above the route's reserve
  // cap scales with segment area: the largest segment on the map holds capMax
  capMax: 400,
  // capitals (expedition) hold at least this x the strongest neutral garrison on the map
  capitalMargin: 1.25,
  // growth: every tile produces this share of its cap per second (600-cap tile: +6/s).
  growthRate: 0.01,
  fullRisk: 1.05,   // bots: safety margin when the attacking tile is full (instead of 1.15-1.6)
  // bots gang up on the leader (side with the highest total troop growth): its tiles are worth
  // gangUp x more to every other bot (who also pools several border tiles into joint attacks on it); the leader only changes when another side grows leaderSwitch x more
  gangUp: 2.5,
  leaderSwitch: 1.1,
  // neutral tiles regrow at this share of that rate (0.2 = 80% slower), only back up to their garrison
  neutralRegrow: 0.2,
};

// one building per segment; building costs troops taken from that segment.
// a captured segment keeps its building (the new owner gets it).
export const buildings = {
  farm:     { name: 'Farm',     icon: '🌾', cost: 30 },
  barracks: { name: 'Barracks', icon: '⚔️', cost: 25 },
  fort:     { name: 'Fort',     icon: '🛡️', cost: 40 },
  hospital: { name: 'Hospital', icon: '➕', cost: 70 },
  lab:      { name: 'Lab',      icon: '🔬', cost: 60 },
};

export const effects = {
  farmGrowth: 0.6,      // +60% own growth
  hospitalGrowth: 0.5,  // +50% per adjacent own hospital
  labGrowth: 0.1,       // +10% per lab owned, everywhere
  barracksAttack: 1.5,  // attack multiplier of armies sent from barracks
  fortDefense: 1.75,    // defense multiplier of fort segments
};

// building descriptions, written from the numbers above (so they always match the rules)
const pct = (v) => `+${Math.round(v * 100)}%`;
buildings.farm.desc = `${pct(effects.farmGrowth)} growth in this tile`;
buildings.barracks.desc = `foglets sent from here attack x${effects.barracksAttack}`;
buildings.fort.desc = `defenders here count x${effects.fortDefense}`;
buildings.hospital.desc = `${pct(effects.hospitalGrowth)} growth in your tiles next to it`;
buildings.lab.desc = `${pct(effects.labGrowth)} growth in all your tiles`;

// terrain traits: each segment gets at most one, from what's on the map around it
//   highland = next to mountains, river = a river runs through, lakeside = next to a lake,
//   forest = picked at random among the rest (the renderer plants its woods there)
export const traits = {
  highland: { icon: '🏔️', name: 'Highland', def: 0.3, desc: 'defenders +30%' },
  forest:   { icon: '🌲', name: 'Forest',   def: 0.15, desc: 'defenders +15%' },
  river:    { icon: '🌊', name: 'River',    growth: 0.25, desc: '+25% growth' },
  lakeside: { icon: '💧', name: 'Lakeside', growth: 0.15, desc: '+15% growth' },
};
export const relicGarrison = 1.6;   // relic tiles: neutral garrison x1.6

// faction colours: index 0 = player
export const factionColors = ['#2f74d6', '#d1403a', '#e09a1a', '#8b55c9', '#23966a', '#d6528f', '#1c9db3', '#7cb32a'];
export const factionNames = ['You', 'Crimson', 'Amber', 'Violet', 'Jade', 'Rose', 'Teal', 'Lime'];
// display names of the colours (bots are named after theirs)
export const colorNames = ['Azure', 'Crimson', 'Amber', 'Violet', 'Jade', 'Rose', 'Teal', 'Lime'];

// looks a side can pick (commander panel for the player, random and distinct for bots)
export const troopStyles = { soldier: 'Soldiers', knight: 'Knights', viking: 'Vikings', archer: 'Archers', wizard: 'Wizards', pirate: 'Pirates', barbarian: 'Barbarians' };
export const buildingStyles = { classic: 'Classic', nordic: 'Nordic', desert: 'Desert', eastern: 'Eastern', tudor: 'Tudor', gothic: 'Gothic', tropical: 'Tropical' };
export const neutralColor = '#7d8580';

// fog around the island slowly twirls: two cloud layers turn in opposite directions (css, see
// render.js); the thin top layer drifting over the main one makes soft swirls
export const fogTwirl = {
  period: 480,          // seconds per full turn of the main fog layer (clockwise)
  counterPeriod: 340,   // seconds per turn of the thin top layer (counter-clockwise)
  counterAlpha: 0.35,   // opacity of the top layer (0 = no swirl, just a slow turn)
};

// island climates (picked per battle). colours are [r, g, b] except sea (css)
export const themes = {
  summer: {
    rockTop: [214, 210, 192], rockSide: [102, 106, 112], rockSideDark: [74, 78, 86], fogA: [236, 239, 237], fogB: [196, 205, 203],
    sea: '#9fb6b7', seaLight: [196, 214, 212], foam: [244, 249, 248], shadow: [52, 78, 84],
    groundA: [150, 172, 116], groundB: [184, 196, 140], shore: [222, 214, 176], scree: [150, 146, 126], lip: [232, 232, 210],
    cliffLight: [238, 236, 228], cliffDark: [190, 190, 182],
    rockDark: [118, 122, 116], rockLight: [182, 184, 176], cap: [246, 246, 242], capAt: 0.82,
    tree: 'round', trees: 1, treeDark: [62, 96, 70], treeLight: [96, 132, 92], lineNeutral: [70, 84, 64],
  },
  autumn: {
    rockTop: [228, 204, 182], rockSide: [86, 78, 92], rockSideDark: [62, 56, 70], fogA: [238, 233, 229], fogB: [204, 196, 194],
    sea: '#93aaa8', seaLight: [190, 206, 202], foam: [240, 244, 242], shadow: [48, 62, 70],
    groundA: [206, 140, 116], groundB: [226, 170, 140], shore: [232, 206, 176], scree: [132, 110, 112], lip: [240, 214, 192],
    cliffLight: [104, 94, 108], cliffDark: [72, 64, 78],
    rockDark: [84, 76, 90], rockLight: [132, 120, 134], cap: [214, 196, 186], capAt: 0.85,
    tree: 'pine', trees: 1.2, treeDark: [52, 40, 58], treeLight: [86, 66, 88], lineNeutral: [110, 70, 64],
  },
  winter: {
    rockTop: [242, 244, 247], rockSide: [72, 72, 82], rockSideDark: [52, 52, 62], fogA: [242, 244, 246], fogB: [208, 213, 218],
    sea: '#c4cbc8', seaLight: [222, 228, 226], foam: [252, 253, 253], shadow: [70, 80, 86],
    groundA: [226, 230, 234], groundB: [242, 244, 246], shore: [204, 214, 220], scree: [170, 172, 180], lip: [252, 252, 254],
    cliffLight: [84, 82, 92], cliffDark: [58, 56, 66],
    rockDark: [70, 70, 80], rockLight: [112, 112, 122], cap: [250, 250, 252], capAt: 0.7,
    tree: 'pine', trees: 0.9, treeDark: [64, 78, 76], treeLight: [96, 112, 108], treeSnow: [250, 251, 252], lineNeutral: [120, 128, 140],
  },
  desert: {
    rockTop: [232, 200, 158], rockSide: [156, 108, 74], rockSideDark: [122, 82, 56], fogA: [242, 234, 220], fogB: [214, 200, 180],
    sea: '#7fb7b2', seaLight: [170, 212, 204], foam: [240, 248, 244], shadow: [92, 72, 52],
    groundA: [222, 186, 126], groundB: [236, 206, 150], shore: [244, 226, 182], scree: [192, 158, 116], lip: [246, 230, 196],
    cliffLight: [236, 210, 172], cliffDark: [196, 160, 120],
    rockDark: [150, 108, 76], rockLight: [204, 160, 116], cap: [232, 204, 162], capAt: 0.97,
    tree: 'round', trees: 0.35, treeDark: [100, 112, 58], treeLight: [138, 146, 78], lineNeutral: [122, 96, 58],
  },
  moor: {
    rockTop: [226, 212, 172], rockSide: [72, 70, 86], rockSideDark: [52, 50, 66], fogA: [230, 232, 226], fogB: [190, 195, 189],
    sea: '#a2aca5', seaLight: [200, 208, 200], foam: [238, 242, 236], shadow: [50, 56, 60],
    groundA: [168, 170, 132], groundB: [190, 188, 148], shore: [210, 204, 170], scree: [118, 116, 112], lip: [214, 210, 180],
    cliffLight: [80, 78, 92], cliffDark: [56, 54, 66],
    rockDark: [66, 64, 78], rockLight: [96, 94, 108], cap: [214, 200, 156], capAt: 0.6,
    tree: 'round', trees: 1.3, treeDark: [84, 98, 74], treeLight: [116, 128, 96], lineNeutral: [84, 86, 64],
  },
};
export const themeNames = Object.keys(themes);
