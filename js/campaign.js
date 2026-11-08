// campaign: a world map of regions. each region is one battle.
// you start with a home region and can attack any region next to one you own.
// the world is a noise-generated continent with islands (sea routes link them), lakes and mountains.
// regions belong to 4 rival empires; difficulty grows with distance from home; each region has a
// climate by position (snowy north, autumn east, moor west, summer south) that its battle uses.
import { generateMap, hops, rng } from './mapgen.js?v=97';
import { personalities } from './ai.js?v=97';

const save_key = 'frontlines.campaign.v2';   // v2 = big world map (old saves don't fit)
const world_seed = 20332373;   // picked from a seed scan: 4 islands, 3 sea routes, ~35% land

export class Campaign {
  constructor() {
    this.map = generateMap({ seed: world_seed, cells: 34, grid: 520, shape: 'world', obstacles: true, detail: 0.6 });
    const rand = rng(world_seed);
    // home = the southern-most region
    this.home = this.map.segs.reduce((a, s) => (s.y > a.y ? s : a)).id;
    this.dist = hops(this.map, [this.home]);
    // 4 rival empires: capitals far from home and each other, regions join the nearest capital
    const caps = [];
    for (let k = 0; k < 4; k++) {
      let best = -1, bv = -1;
      for (const s of this.map.segs) {
        if (s.id === this.home || caps.includes(s.id)) continue;
        const dc = caps.length ? Math.min(...caps.map((c) => hops(this.map, [c])[s.id])) : 0;
        const v = this.dist[s.id] + dc * 2 + rand();
        if (v > bv) { bv = v; best = s.id; }
      }
      caps.push(best);
    }
    const capDist = caps.map((c) => hops(this.map, [c]));
    const used = new Set(), g = this.map.grid;
    this.regions = this.map.segs.map((s) => {
      const d = this.dist[s.id], lv = d * 0.6;   // difficulty grows a bit slower than distance
      let name;
      do name = regionName(rand); while (used.has(name));
      used.add(name);
      const u = s.x / g, v = s.y / g;
      const climate = v < 0.33 ? 'winter' : u > 0.63 ? 'autumn' : u < 0.36 ? 'moor' : 'summer';
      const empire = capDist.map((cd, i) => [cd[s.id], i]).sort((a, b) => a[0] - b[0])[0][1] + 1;
      return {
        id: s.id,
        name,
        climate,
        empire,                       // faction colour index 1..4
        capital: caps.includes(s.id),
        level: d,
        segments: Math.min(34, Math.round(10 + lv * 4)),
        bots: Math.min(4, 1 + Math.floor((lv + rand()) / 1.6)),
        think: Math.max(1.8, 3.5 - lv * 0.35),   // seconds between bot decisions
        neutral: [Math.min(0.6, 0.1 + lv * 0.03), Math.min(0.85, 0.25 + lv * 0.05)],   // share of tile cap
        seed: Math.floor(rand() * 1e9),
      };
    });
    this.load();
  }

  load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(save_key)); } catch { /* storage blocked: start fresh */ }
    this.owned = new Set(saved?.owned ?? [this.home]);
  }

  save() {
    try { localStorage.setItem(save_key, JSON.stringify({ owned: [...this.owned] })); } catch { /* ignore */ }
  }

  reset() { this.owned = new Set([this.home]); this.save(); }

  attackable(id) {
    return !this.owned.has(id) && this.map.segs[id].adj.some((a) => this.owned.has(a));
  }

  conquer(id) { this.owned.add(id); this.save(); }

  done() { return this.owned.size === this.regions.length; }

  // battle settings for a region: the owning empire's bot first, then others
  battleSetup(id) {
    const r = this.regions[id];
    const types = Object.keys(personalities);
    const r2 = rng(r.seed);
    const colors = [r.empire, ...[1, 2, 3, 4].filter((c) => c !== r.empire)].slice(0, r.bots);
    return {
      seed: r.seed,
      theme: r.climate,
      cells: r.segments,
      neutral: r.neutral,
      factions: [
        { ai: false, color: 0 },
        ...colors.map((color) => ({
          ai: true, color, think: r.think,
          personality: personalities[types[Math.floor(r2() * types.length)]],
        })),
      ],
    };
  }
}

// made-up region names from syllables
function regionName(rand) {
  const a = ['Vel', 'Kor', 'Ash', 'Bren', 'Mar', 'Tal', 'Dun', 'Sil', 'Rav', 'Or', 'Gal', 'Thal', 'Lum', 'Kest'];
  const b = ['dor', 'mere', 'wick', 'vale', 'hold', 'rin', 'moor', 'stead', 'gard', 'fell', 'more', 'ia'];
  return a[Math.floor(rand() * a.length)] + b[Math.floor(rand() * b.length)];
}
