// procedural map generator: a noisy island split into voronoi-like segments.
// works on a square raster grid; every cell holds a segment id (-1 = sea).
// used for both battle maps (segments) and the campaign world (regions).

// seeded random generator (mulberry32): same seed -> same map
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// smooth value noise on a size x size lattice; input u, v in [0, 1]
function noise2(rand, size) {
  const v = Array.from({ length: (size + 1) * (size + 1) }, rand);
  const s = (t) => t * t * (3 - 2 * t);
  return (u, w) => {
    const fx = u * size, fy = w * size;
    const ix = Math.min(size - 1, Math.max(0, Math.floor(fx)));
    const iy = Math.min(size - 1, Math.max(0, Math.floor(fy)));
    const tx = s(fx - ix), ty = s(fy - iy), i = iy * (size + 1) + ix;
    const a = v[i], b = v[i + 1], c = v[i + size + 1], d = v[i + size + 2];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
}

// island shapes as signed distance functions on x, y in [-0.5, 0.5] (negative = inside)
const shapes = {
  blob: (x, y) => Math.hypot(x, y) - 0.4,
  square: (x, y) => Math.max(Math.abs(x), Math.abs(y)) - 0.37,
  diamond: (x, y) => (Math.abs(x) + Math.abs(y) - 0.46) / Math.SQRT2,
  triangle: (x, y) => sdTriangle(x, -y + 0.127, 0.44),   // apex up, centred vertically
  peanut: (x, y) => Math.min(Math.hypot(x - 0.18, y + 0.06), Math.hypot(x + 0.18, y - 0.06)) - 0.26,
  ring: (x, y) => Math.abs(Math.hypot(x, y) - 0.3) - 0.14,
};
export const shapeNames = Object.keys(shapes);

// signed distance to an equilateral triangle with half-side r (inigo quilez), y up
function sdTriangle(px, py, r) {
  const k = Math.sqrt(3);
  px = Math.abs(px) - r;
  py = py + r / k;
  if (px + k * py > 0) [px, py] = [(px - k * py) / 2, (-k * px - py) / 2];
  px -= Math.min(Math.max(px, -2 * r), 0);
  return -Math.hypot(px, py) * Math.sign(py);
}

// terrain codes for cells that aren't land segments
export const terrainTypes = { sea: 0, lake: 1, mountain: 2 };

// shape: a key of shapes, 'random' (picked from the seed) or 'world' (noise continents with islands,
// linked by sea routes). obstacles: carve lakes + mountain ranges
// detail: feature scale (1 = close-up; smaller = seen from further away: smaller, more numerous
// lakes, ridges and trees). stamp: { n, data } outline (n x n, 0/1) placed as one ready-made segment,
// e.g. the previous expedition stage's island as the new capital
export function generateMap({ seed, cells: n, grid: g, shape = 'blob', obstacles = false, detail = 1, stamp = null }) {
  const world = shape === 'world';
  const rand = rng(seed);
  const na = noise2(rand, 3), nb = noise2(rand, 7);
  const wx = noise2(rand, 6), wy = noise2(rand, 6);
  const ids = new Int16Array(g * g).fill(-1);
  // separate generator for shape + obstacles, so the plain blob maps stay exactly as before
  const orand = rng(Math.imul(seed ^ 0x5bd1e995, 2654435761));   // hashed so neighbouring seeds differ
  if (shape === 'random') shape = shapeNames[Math.floor(orand() * shapeNames.length)];
  const sdf = shapes[shape] ?? shapes.blob;
  const sx = noise2(orand, 4), sy = noise2(orand, 4);
  // world: three octaves of noise, land where the noise beats a threshold that rises toward the edge
  const wn = world ? [noise2(orand, 3), noise2(orand, 7), noise2(orand, 15)] : null;
  const squiggle = shape === 'blob' ? 0 : 0.07;   // domain warp makes straight edges wavy

  // 1. island mask: shape with a noisy coastline
  const mask = new Uint8Array(g * g);
  for (let y = 0; y < g; y++) {
    for (let x = 0; x < g; x++) {
      const u = (x + 0.5) / g, w = (y + 0.5) / g;
      // non-blob shapes are scaled down a little so cliffs and foam fit inside the canvas
      const zoom = shape === 'blob' ? 1 : 1 / 0.9;
      const px = (u - 0.5) * zoom + (sx(u, w) - 0.5) * squiggle, py = (w - 0.5) * zoom + (sy(u, w) - 0.5) * squiggle;
      if (world) {
        const v = wn[0](u, w) * 0.55 + wn[1](u, w) * 0.3 + wn[2](u, w) * 0.15;
        const d = Math.hypot(u - 0.5, w - 0.5) * 2.15;   // > 2: keeps a margin at the map edge
        if (v > 0.31 + 0.4 * d ** 2.2) mask[y * g + x] = 1;
        continue;
      }
      const wobble = (na(u, w) - 0.5) * 0.16 + (nb(u, w) - 0.5) * 0.07;
      if (sdf(px, py) < wobble) mask[y * g + x] = 1;
    }
  }

  // 1b. obstacles carved out of the land:
  //   lakes = noise-warped irregular blobs (relief = depth, 0 at shore .. 1 deep)
  //   mountains = winding ridge lines with side spurs (relief = height, 0 foothill .. 1 peak)
  const terrain = new Uint8Array(g * g), relief = new Float32Array(g * g);
  if (obstacles) {
    const cellsIn = [];
    for (let c = 0; c < g * g; c++) if (mask[c]) cellsIn.push(c);
    const n1 = noise2(orand, 9), n2 = noise2(orand, 23), lw1 = noise2(orand, 5), lw2 = noise2(orand, 5);
    const more = Math.round((1 / detail - 1) * 2);   // zoomed out: more, smaller features
    let lakes = Math.floor(orand() * 3) + (world ? 3 : 0) + more, ranges = Math.floor(orand() * 3) + (world ? 4 : 0) + more;
    if (lakes + ranges === 0) lakes = 1;
    const pick = () => { const c = cellsIn[Math.floor(orand() * cellsIn.length)]; return [c % g, Math.floor(c / g)]; };

    // lakes: centre + radius, outline warped by two noise octaves (bays and peninsulas)
    const lakeList = [];
    for (let i = 0; i < lakes; i++) {
      const [x, y] = pick();
      lakeList.push({ x, y, r: g * (world ? 0.025 + orand() * 0.025 : 0.06 + orand() * 0.045) * Math.sqrt(detail) });
    }

    // mountain ridges: a meandering spine plus 1-2 short spurs; width tapers toward the ends
    const ridges = [];
    const walk = (x, y, ang, steps, width) => {
      const pts = [];
      for (let k = 0; k < steps; k++) {
        pts.push({ x, y, w: width * (0.35 + 0.65 * Math.sin(Math.PI * (k + 0.5) / steps)) });
        ang += (orand() - 0.5) * 0.7;
        x += Math.cos(ang) * g * 0.022 * Math.sqrt(detail);
        y += Math.sin(ang) * g * 0.022 * Math.sqrt(detail);
      }
      return pts;
    };
    for (let i = 0; i < ranges; i++) {
      const [x, y] = pick(), ang = orand() * Math.PI * 2, width = g * (0.038 + orand() * 0.02) * (world ? 0.55 : 1) * detail;
      const spine = walk(x, y, ang, 6 + Math.floor(orand() * 6), width);
      ridges.push(spine);
      const spurs = 1 + Math.floor(orand() * 2);
      for (let s = 0; s < spurs; s++) {
        const p = spine[1 + Math.floor(orand() * (spine.length - 2))];
        const side = orand() < 0.5 ? -1 : 1;
        ridges.push(walk(p.x, p.y, ang + side * (0.9 + orand() * 0.6), 3 + Math.floor(orand() * 3), p.w * 0.7));
      }
    }

    for (const c of cellsIn) {
      const x = c % g, y = Math.floor(c / g), u = x / g, w = y / g;
      // lake test on a warped position
      for (const l of lakeList) {
        const px = x + (lw1(u, w) - 0.5) * l.r * 1.6, py = y + (lw2(u, w) - 0.5) * l.r * 1.6;
        const d = Math.hypot(px - l.x, py - l.y) / l.r;
        if (d < 0.8 + (n1(u, w) - 0.5) * 1.1 + (n2(u, w) - 0.5) * 0.35) { terrain[c] = terrainTypes.lake; break; }
      }
      if (terrain[c]) continue;
      // mountain test: distance to the nearest ridge segment, compared to the local width
      let best = Infinity, bw = 0;
      for (const pts of ridges) {
        for (let k = 0; k < pts.length - 1; k++) {
          const a = pts[k], b = pts[k + 1];
          const vx = b.x - a.x, vy = b.y - a.y;
          const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / (vx * vx + vy * vy)));
          const d = Math.hypot(x - a.x - vx * t, y - a.y - vy * t);
          if (d < best) { best = d; bw = a.w + (b.w - a.w) * t; }
        }
      }
      const rough = 0.8 + (n1(u, w) - 0.5) * 0.9 + (n2(u, w) - 0.5) * 0.6;
      if (best < bw * rough) {
        terrain[c] = terrainTypes.mountain;
        // height: high on the spine, low at the foot, with small bumps
        relief[c] = Math.max(0.03, Math.min(1, (1 - best / (bw * rough)) ** 0.8 * (0.55 + 0.6 * n2(u, w))));
      }
    }
    for (const c of cellsIn) if (terrain[c]) mask[c] = 0;

    // land cut off by obstacles becomes mountain foothill, so the playable land stays one piece
    // (world: every island big enough stays)
    const keepSet = new Uint8Array(g * g);
    for (const c of world ? blobs(mask, g, g * g * 0.002).flat() : largestBlob(mask, g)) keepSet[c] = 1;
    for (const c of cellsIn) {
      if (keepSet[c] || terrain[c]) continue;
      mask[c] = 0;
      if (!world) { terrain[c] = terrainTypes.mountain; relief[c] = 0.1; }   // world: stays sea
    }
    // world: mountain or lake bits left without any land next to them are dropped too
    if (world) {
      const solidNear = (c) => { const x = c % g; return [x > 0 ? c - 1 : -1, x < g - 1 ? c + 1 : -1, c - g, c + g].some((m) => m >= 0 && m < g * g && keepSet[m]); };
      for (const b of blobs(terrain.map((v) => (v ? 1 : 0)), g, 1)) if (!b.some(solidNear)) for (const c of b) terrain[c] = 0;
    }

    // lake depth = steps from the shore (bfs), normalised
    const q = [], dist = new Int16Array(g * g).fill(-1);
    for (const c of cellsIn) {
      if (terrain[c] !== terrainTypes.lake) continue;
      const x = c % g;
      const nb4 = [x > 0 ? c - 1 : c, x < g - 1 ? c + 1 : c, c - g, c + g];
      if (nb4.some((m) => m >= 0 && m < g * g && terrain[m] !== terrainTypes.lake)) { dist[c] = 0; q.push(c); }
    }
    for (let k = 0; k < q.length; k++) {
      const c = q[k], x = c % g;
      for (const m of [x > 0 ? c - 1 : -1, x < g - 1 ? c + 1 : -1, c - g, c + g]) {
        if (m >= 0 && m < g * g && dist[m] < 0 && terrain[m] === terrainTypes.lake) { dist[m] = dist[c] + 1; q.push(m); }
      }
    }
    for (const c of q) relief[c] = Math.min(1, dist[c] / (g * 0.03));
  }
  // keep only the largest connected landmass, so every segment is reachable
  // (world: all islands above a minimum size; sea routes connect them later)
  const islands = world ? blobs(mask, g, g * g * 0.003) : [largestBlob(mask, g)];
  const land = islands.flat();
  const blobOf = new Int16Array(g * g).fill(-1);
  islands.forEach((b, i) => { for (const c of b) blobOf[c] = i; });

  // 1c. stamp: resample the given outline to about two segments wide and put it fully on land,
  //     as far from the land's centre as possible (coastal, like a fair start)
  const stampCells = new Uint8Array(g * g);
  let stampAt = null;
  if (stamp) {
    const S = Math.max(10, Math.round(Math.sqrt(land.length / n) * 1.5)), sm = [];
    for (let yy = 0; yy < S; yy++) for (let xx = 0; xx < S; xx++) {
      if (stamp.data[Math.floor((yy / S) * stamp.n) * stamp.n + Math.floor((xx / S) * stamp.n)]) sm.push([xx, yy]);
    }
    const inLand = new Uint8Array(g * g);
    for (const c of land) inLand[c] = 1;
    const lcx = land.reduce((v, c) => v + (c % g), 0) / land.length, lcy = land.reduce((v, c) => v + Math.floor(c / g), 0) / land.length;
    let best = null;
    for (let tries = 0; tries < 600; tries++) {
      const c = land[Math.floor(orand() * land.length)], ox = (c % g) - (S >> 1), oy = Math.floor(c / g) - (S >> 1);
      if (!sm.every(([a, b]) => { const x = ox + a, y = oy + b; return x >= 0 && y >= 0 && x < g && y < g && inLand[y * g + x]; })) continue;
      const score = Math.hypot(ox + S / 2 - lcx, oy + S / 2 - lcy) + orand() * 3;
      if (!best || score > best.score) best = { ox, oy, score };
    }
    if (best) {
      for (const [a, b] of sm) stampCells[(best.oy + b) * g + best.ox + a] = 1;
      stampAt = { x: best.ox + S / 2, y: best.oy + S / 2 };
    }
  }

  // 2. seed points spread out over the land (min distance rejection sampling), each island gets a
  //    share of the seeds by area (at least one)
  const minDist = Math.sqrt(land.length / n) * 0.8;
  const seeds = [];
  const quota = islands.map((b) => Math.max(1, Math.round((n * b.length) / land.length)));
  islands.forEach((b, bi) => {
    const mine = [];
    for (let tries = 0; mine.length < quota[bi] && tries < 20000; tries++) {
      const c = b[Math.floor(rand() * b.length)];
      const x = c % g, y = Math.floor(c / g);
      const d = tries < 15000 ? minDist : minDist * 0.6;   // relax if the island is crowded
      if (stampCells[c]) continue;
      if (seeds.every((s) => Math.hypot(s.x - x, s.y - y) >= d) && mine.every((s) => Math.hypot(s.x - x, s.y - y) >= d)) mine.push({ x, y, blob: bi });
    }
    if (!mine.length) { const c = b[0]; mine.push({ x: c % g, y: Math.floor(c / g), blob: bi }); }
    seeds.push(...mine);
  });
  const seedsOf = islands.map((_, bi) => seeds.map((s, i) => (s.blob === bi ? i : -1)).filter((i) => i >= 0));
  // the stamp is one extra segment that owns exactly its cells
  const stampSeed = stampAt ? seeds.push({ x: stampAt.x, y: stampAt.y, blob: -1 }) - 1 : -1;

  // 3. each land cell goes to its nearest seed, measured from a noise-warped
  //    position so borders wiggle instead of being straight lines
  const warp = minDist * 0.35;
  for (const c of land) {
    const x = c % g, y = Math.floor(c / g), u = x / g, w = y / g;
    const px = x + (wx(u, w) - 0.5) * 2 * warp, py = y + (wy(u, w) - 0.5) * 2 * warp;
    if (stampCells[c]) { ids[c] = stampSeed; continue; }
    // only seeds on the same island, so a segment never spans the sea
    let best = 0, bd = Infinity;
    for (const i of seedsOf[blobOf[c]]) {
      const d = (seeds[i].x - px) ** 2 + (seeds[i].y - py) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    ids[c] = best;
  }

  // 4. warping can split a segment into pieces: keep its largest piece,
  //    hand the stray pieces to whatever neighbour touches them
  const nbrs = (c) => {
    const x = c % g, out = [];
    if (x > 0) out.push(c - 1);
    if (x < g - 1) out.push(c + 1);
    if (c >= g) out.push(c - g);
    if (c < g * g - g) out.push(c + g);
    return out;
  };
  const seen = new Uint8Array(g * g), keep = new Uint8Array(g * g);
  const bestPiece = new Map();
  for (const c of land) {
    if (seen[c]) continue;
    const id = ids[c], piece = [c];
    seen[c] = 1;
    for (let k = 0; k < piece.length; k++) {
      for (const m of nbrs(piece[k])) if (!seen[m] && ids[m] === id) { seen[m] = 1; piece.push(m); }
    }
    const prev = bestPiece.get(id);
    if (!prev || piece.length > prev.length) bestPiece.set(id, piece);
  }
  for (const piece of bestPiece.values()) for (const c of piece) keep[c] = 1;
  let orphans = land.filter((c) => !keep[c]);
  for (const c of orphans) ids[c] = -2;
  while (orphans.length) {
    const left = [];
    for (const c of orphans) {
      const m = nbrs(c).find((m) => ids[m] >= 0);
      if (m !== undefined) ids[c] = ids[m]; else left.push(c);
    }
    if (left.length === orphans.length) { for (const c of left) ids[c] = -1; break; }
    orphans = left;
  }

  // 5. renumber segments 0..k-1 (drop any seed that ended up with no cells)
  const remap = new Map();
  for (const c of land) if (ids[c] >= 0 && !remap.has(ids[c])) remap.set(ids[c], remap.size);
  for (const c of land) if (ids[c] >= 0) ids[c] = remap.get(ids[c]);

  // 5b. every island must be playable: one made only of rock / lake (no tiles) sinks into the sea,
  //     and one with too little tile land (under ~60% of an average tile) turns its rock and lake
  //     into tile land, given to the nearest tile on that island
  {
    let tileCells = 0;
    for (const c of land) if (ids[c] >= 0) tileCells++;
    const minTiles = (tileCells / Math.max(1, remap.size)) * 0.6, seen = new Uint8Array(g * g);
    const solid = (c) => ids[c] >= 0 || terrain[c] === terrainTypes.mountain || terrain[c] === terrainTypes.lake;
    for (let c0 = 0; c0 < g * g; c0++) {
      if (seen[c0] || !solid(c0)) continue;
      const blob = [c0];
      seen[c0] = 1;
      for (let k = 0; k < blob.length; k++) for (const m of nbrs(blob[k])) if (!seen[m] && solid(m)) { seen[m] = 1; blob.push(m); }
      const tiles = blob.filter((c) => ids[c] >= 0);
      if (!tiles.length) {
        for (const c of blob) { ids[c] = -1; terrain[c] = terrainTypes.sea; relief[c] = 0; }
      } else if (tiles.length < minTiles && tiles.length < blob.length) {
        const q = [...tiles];
        for (let k = 0; k < q.length; k++) {
          for (const m of nbrs(q[k])) if (ids[m] < 0 && terrain[m] && seen[m]) { ids[m] = ids[q[k]]; terrain[m] = terrainTypes.sea; relief[m] = 0; q.push(m); }
        }
      }
    }
  }
  const segs = Array.from({ length: remap.size }, (_, id) => ({ id, area: 0, sx: 0, sy: 0, adj: new Set() }));

  // 6. area, adjacency and edge cells (edge = differs from any 4-neighbour, so borders are 2 cells wide)
  const edge = new Uint8Array(g * g);
  for (let c = 0; c < g * g; c++) {
    const id = ids[c], x = c % g;
    if (id >= 0) { const s = segs[id]; s.area++; s.sx += x; s.sy += Math.floor(c / g); }
    const r = x < g - 1 ? ids[c + 1] : -1, d = c < g * g - g ? ids[c + g] : -1;
    const l = x > 0 ? ids[c - 1] : -1, u = c >= g ? ids[c - g] : -1;
    // land next to a lake/mountain gets no hard border (it blends in via the 'near' shading instead)
    const same = (m, v) => v === id || (id >= 0 && m >= 0 && m < g * g && terrain[m]);
    if (!same(c + 1, r) || !same(c + g, d) || !same(c - 1, l) || !same(c - g, u)) edge[c] = 1;
    // coast: segment touches the open sea (outside the grid counts as sea)
    if (id >= 0 && [[c + 1, r, x < g - 1], [c + g, d, c < g * g - g], [c - 1, l, x > 0], [c - g, u, c >= g]].some(([m, v, ok]) => !ok || (v < 0 && !terrain[m]))) segs[id].coast = true;
    if (id >= 0 && r >= 0 && r !== id) { segs[id].adj.add(r); segs[r].adj.add(id); }
    if (id >= 0 && d >= 0 && d !== id) { segs[id].adj.add(d); segs[d].adj.add(id); }
  }

  // 6b. world: sea routes between islands. closest coast points per island pair, then a minimum
  //     spanning tree (every island reachable) plus any extra pair that is very close
  const bridges = [];
  if (world && islands.length > 1) {
    const coast = islands.map(() => []);
    for (const c of land) {
      if (ids[c] < 0 || c % 5) continue;
      if (nbrs(c).some((m) => ids[m] < 0 && !terrain[m])) coast[blobOf[c]].push(c);
    }
    const pairs = [];
    for (let a = 0; a < islands.length; a++) {
      for (let b = a + 1; b < islands.length; b++) {
        let best = null;
        for (const ca of coast[a]) {
          const ax = ca % g, ay = Math.floor(ca / g);
          for (const cb of coast[b]) {
            const d = Math.hypot(ax - (cb % g), ay - Math.floor(cb / g));
            if (!best || d < best.d) best = { d, ca, cb };
          }
        }
        if (best) pairs.push({ a, b, ...best });
      }
    }
    pairs.sort((p, q) => p.d - q.d);
    const root = islands.map((_, i) => i), find = (i) => (root[i] === i ? i : (root[i] = find(root[i])));
    for (const p of pairs) {
      const tree = find(p.a) !== find(p.b);
      if (!tree && p.d > g * 0.05) continue;
      root[find(p.a)] = find(p.b);
      const sa = ids[p.ca], sb = ids[p.cb];
      segs[sa].adj.add(sb);
      segs[sb].adj.add(sa);
      bridges.push({ a: sa, b: sb, ax: (p.ca % g) + 0.5, ay: Math.floor(p.ca / g) + 0.5, bx: (p.cb % g) + 0.5, by: Math.floor(p.cb / g) + 0.5 });
    }
  }

  // 6c. every map (not just 'world'): all segments must be reachable. land that ended up cut apart
  //     (a separate islet, the stamped capital off the coast, a mountain ridge splitting the island)
  //     gets sea routes between the closest border cells of its parts, joined as a spanning tree
  const comp = new Int32Array(segs.length).fill(-1);
  let parts = 0;
  for (const s0 of segs) {
    if (comp[s0.id] >= 0) continue;
    const q = [s0.id];
    comp[s0.id] = parts;
    for (let k = 0; k < q.length; k++) for (const m of segs[q[k]].adj) if (comp[m] < 0) { comp[m] = parts; q.push(m); }
    parts++;
  }
  if (parts > 1) {
    const rim = Array.from({ length: parts }, () => []);
    for (const c of land) {
      if (ids[c] < 0 || c % 3) continue;
      if (nbrs(c).length < 4 || nbrs(c).some((m) => ids[m] < 0)) rim[comp[ids[c]]].push(c);
    }
    const pairs = [];
    for (let a = 0; a < parts; a++) {
      for (let b = a + 1; b < parts; b++) {
        let best = null;
        for (const ca of rim[a]) {
          const ax = ca % g, ay = Math.floor(ca / g);
          for (const cb of rim[b]) {
            const d = (ax - (cb % g)) ** 2 + (ay - Math.floor(cb / g)) ** 2;
            if (!best || d < best.d) best = { d, ca, cb };
          }
        }
        if (best) pairs.push({ a, b, ...best });
      }
    }
    pairs.sort((p, q) => p.d - q.d);
    const root = Array.from({ length: parts }, (_, i) => i), find = (i) => (root[i] === i ? i : (root[i] = find(root[i])));
    for (const p of pairs) {
      if (find(p.a) === find(p.b)) continue;
      root[find(p.a)] = find(p.b);
      const sa = ids[p.ca], sb = ids[p.cb];
      segs[sa].adj.add(sb);
      segs[sb].adj.add(sa);
      bridges.push({ a: sa, b: sb, ax: (p.ca % g) + 0.5, ay: Math.floor(p.ca / g) + 0.5, bx: (p.cb % g) + 0.5, by: Math.floor(p.cb / g) + 0.5 });
    }
  }

  // 7. label position = the most "inner" cell (farthest from any border), via multi-source bfs
  const dist = new Int16Array(g * g).fill(-1), queue = [];
  for (const c of land) {
    if (ids[c] < 0) continue;
    if (nbrs(c).some((m) => ids[m] !== ids[c]) || nbrs(c).length < 4) { dist[c] = 0; queue.push(c); }
  }
  for (let k = 0; k < queue.length; k++) {
    const c = queue[k];
    for (const m of nbrs(c)) if (dist[m] < 0 && ids[m] === ids[c]) { dist[m] = dist[c] + 1; queue.push(m); }
  }
  for (const s of segs) { s.cx = s.sx / s.area; s.cy = s.sy / s.area; s.score = -1; }
  for (const c of land) {
    const id = ids[c];
    if (id < 0) continue;
    const s = segs[id], x = c % g, y = Math.floor(c / g);
    // prefer deep cells, small tie-break toward the centroid
    const score = dist[c] - Math.hypot(x - s.cx, y - s.cy) * 0.05;
    if (score > s.score) { s.score = score; s.x = x + 0.5; s.y = y + 0.5; }
  }

  const avgArea = segs.reduce((a, s) => a + s.area, 0) / segs.length;
  // 8. land near obstacles: steps to the nearest lake/mountain (1..10, 0 = far) and its type,
  //    so the renderer can tint shores sandy and foothills rocky
  const near = new Uint8Array(g * g), nearType = new Uint8Array(g * g), nq = [];
  for (let c = 0; c < g * g; c++) if (terrain[c]) nq.push(c);
  for (let k = 0; k < nq.length; k++) {
    const c = nq[k];
    if (near[c] >= 10) continue;
    for (const m of nbrs(c)) {
      if (ids[m] >= 0 && !near[m]) { near[m] = near[c] + 1; nearType[m] = terrain[c] || nearType[c]; nq.push(m); }
    }
  }
  // 9. terrain counts per tile: cells next to mountains / lakes (traits, and where rivers may go)
  const nearMtn = new Int32Array(segs.length), nearLake = new Int32Array(segs.length);
  for (const c of land) {
    const id = ids[c];
    if (id < 0 || !near[c] || near[c] > 2) continue;
    if (nearType[c] === terrainTypes.mountain) nearMtn[id]++;
    else if (nearType[c] === terrainTypes.lake) nearLake[id]++;
  }
  const highland = (s) => nearMtn[s.id] >= Math.max(4, s.area * 0.01);

  // 10. rivers: chains of 1-3 neighbouring tiles. a river starts at a spring deep in the innermost
  //     tile, bends through every tile of the chain (via 1-2 random waypoints well inside it),
  //     crosses into the next tile at their shared border and flows out into the sea or a lake
  //     from the last one. so every river tile carries a long winding stretch, never a clipped corner
  const rivers = [], riverTile = new Uint8Array(segs.length);
  if (obstacles) {
    const water = (m) => ids[m] < 0 && terrain[m] !== terrainTypes.mountain;   // sea or lake
    const cellsOf = segs.map(() => []);
    for (const c of land) if (ids[c] >= 0) cellsOf[ids[c]].push(c);
    const shore = segs.map((s) => cellsOf[s.id].filter((c) => nbrs(c).some(water)));
    const deep = segs.map((s) => cellsOf[s.id].filter((c) => dist[c] >= 4));
    // 8-connected neighbours inside the grid
    const n8 = (c) => {
      const x = c % g, out = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || x + dx < 0 || x + dx >= g) continue;
        const m = c + dy * g + dx;
        if (m >= 0 && m < g * g) out.push(m);
      }
      return out;
    };
    // shortest path from a to b through cells of tile id (8-connected bfs), as a list of cells
    const route = (a, b, id) => {
      const prev = new Map([[a, -1]]), q = [a];
      for (let k = 0; k < q.length && !prev.has(b); k++) for (const m of n8(q[k])) if (!prev.has(m) && (ids[m] === id || m === b)) { prev.set(m, q[k]); q.push(m); }
      if (!prev.has(b)) return [a, b];
      const path = [];
      for (let c = b; c >= 0; c = prev.get(c)) path.push(c);
      return path.reverse();
    };
    const want = Math.min(7, Math.round(2 + 2 * (1 / detail - 1))), maxTiles = Math.max(2, Math.round(segs.length * 0.22));
    const mouths = segs.filter((s) => shore[s.id].length && !highland(s)).map((s) => s.id);
    let used = 0;
    for (let r = 0, tries = 0; r < want && tries < want * 12 && used < maxTiles && mouths.length; tries++) {
      const m0 = mouths[Math.floor(orand() * mouths.length)];
      if (riverTile[m0]) continue;
      // chain inland: unused, non-highland neighbours that share a land border, inland ones first
      const chain = [m0], len = 1 + Math.floor(orand() * 3);
      while (chain.length < len && used + chain.length < maxTiles) {
        const cur = chain[chain.length - 1];
        const opts = [...segs[cur].adj].filter((n) => !riverTile[n] && !chain.includes(n) && !highland(segs[n])
          && cellsOf[cur].some((c) => nbrs(c).some((m) => ids[m] === n)));
        if (!opts.length) break;
        opts.sort((a, b) => shore[a].length - shore[b].length + (orand() - 0.5) * 30);
        chain.push(opts[0]);
      }
      // waypoints from the spring (innermost tile) down to the mouth
      const tiles = chain.slice().reverse(), cells = [];
      let from = cellsOf[tiles[0]].reduce((a, c) => (dist[c] > dist[a] ? c : a), cellsOf[tiles[0]][0]);   // spring: deepest cell
      for (let i = 0; i < tiles.length; i++) {
        const id = tiles[i], next = tiles[i + 1];
        let exit, after = -1;
        if (next !== undefined) {
          // crossing: border cell toward the next tile, nearest the midpoint of the two label spots
          const mx = (segs[id].x + segs[next].x) / 2, my = (segs[id].y + segs[next].y) / 2;
          const border = cellsOf[id].filter((c) => nbrs(c).some((m) => ids[m] === next));
          exit = border.reduce((a, c) => (Math.hypot((c % g) - mx, Math.floor(c / g) - my) < Math.hypot((a % g) - mx, Math.floor(a / g) - my) ? c : a), border[0]);
          after = nbrs(exit).find((m) => ids[m] === next);
        } else {
          // mouth: the shore cell farthest from where the river enters this tile
          const fx = from % g, fy = Math.floor(from / g);
          exit = shore[id].reduce((a, c) => (Math.hypot((c % g) - fx, Math.floor(c / g) - fy) > Math.hypot((a % g) - fx, Math.floor(a / g) - fy) ? c : a), shore[id][0]);
          after = nbrs(exit).find(water);
        }
        // 2-3 waypoints deep in the tile, spread along the way and on alternating sides of the
        // straight line from entry to exit, so the river swings left and right (s-bends)
        const pool = deep[id].length ? deep[id] : cellsOf[id];
        const ax = from % g, ay = Math.floor(from / g), bx = exit % g, by = Math.floor(exit / g);
        const span = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / span, uy = (by - ay) / span;
        const along = (c) => ((c % g) - ax) * ux + (Math.floor(c / g) - ay) * uy;    // distance along the line
        const across = (c) => ((c % g) - ax) * -uy + (Math.floor(c / g) - ay) * ux;  // signed distance off it
        const pickWays = () => {
          const n = 2 + Math.floor(orand() * 2), side = orand() < 0.5 ? 1 : -1, ways = [], swing = Math.sqrt(segs[id].area) * 0.25;   // max sideways reward: a quarter tile
          for (let j = 0; j < n; j++) {
            // best of 12 random cells: off the line on this side (up to swing), near its slot along the way
            const t = (span * (j + 1)) / (n + 1), sd = j % 2 ? -side : side;
            let w = -1, ws = -1e9;
            for (let q = 0; q < 12; q++) {
              const c = pool[Math.floor(orand() * pool.length)];
              const sc = Math.min(sd * across(c), swing) - Math.abs(along(c) - t) * 0.8;
              if (sc > ws) { ws = sc; w = c; }
            }
            ways.push(w);
          }
          return ways.sort((a, b) => along(a) - along(b));
        };
        // up to 4 tries; keep the longest course, stop once it is 1.5 tile-widths long
        let best = null;
        for (let k = 0; k < 4 && !(best && best.length >= 1.5 * Math.sqrt(segs[id].area)); k++) {
          const ways = pickWays();
          const course = [from];
          let at = from;
          for (const w of [...ways, exit]) { course.push(...route(at, w, id).slice(1)); at = w; }
          if (!best || course.length > best.length) best = course;
        }
        cells.push(...(cells.length ? best.slice(1) : best));
        if (after !== undefined && after >= 0) cells.push(after);
        from = after ?? exit;
        riverTile[id] = 1;
      }
      used += tiles.length;
      const pts = smoothCourse(cells, g, Math.sqrt(avgArea), (x, y) => ids[Math.floor(y) * g + Math.floor(x)] >= 0);
      if (pts.length > 8) { rivers.push(pts); r++; }
    }
  }
  // 11. terrain traits per segment (one each at most): highland > river > lakeside > forest
  const trait = segs.map((s) => {
    const need = Math.max(4, s.area * 0.01);
    if (nearMtn[s.id] >= need) return 'highland';
    if (riverTile[s.id]) return 'river';
    if (nearLake[s.id] >= need) return 'lakeside';
    return orand() < 0.3 ? 'forest' : null;
  });
  return {
    grid: g, ids, edge, avgArea, shape, terrain, near, nearType, bridges, islands: islands.length, detail, rivers,
    stampSeg: stampSeed >= 0 && remap.has(stampSeed) ? remap.get(stampSeed) : -1,
    bdist: dist,   // steps from each land cell to its segment's border
    relief,   // mountain height / lake depth, 0..1
    segs: segs.map((s) => ({ id: s.id, area: s.area, x: s.x, y: s.y, adj: [...s.adj], coast: !!s.coast, trait: trait[s.id] })),
  };
}

// all 4-connected blobs of a 0/1 mask with at least min cells, biggest first
function blobs(mask, g, min) {
  const seen = new Uint8Array(g * g), out = [];
  for (let c0 = 0; c0 < g * g; c0++) {
    if (!mask[c0] || seen[c0]) continue;
    const blob = [c0];
    seen[c0] = 1;
    for (let k = 0; k < blob.length; k++) {
      const c = blob[k], x = c % g;
      for (const m of [x > 0 ? c - 1 : -1, x < g - 1 ? c + 1 : -1, c - g, c + g]) {
        if (m >= 0 && m < g * g && mask[m] && !seen[m]) { seen[m] = 1; blob.push(m); }
      }
    }
    if (blob.length >= min) out.push(blob.sort((a, b) => a - b));
  }
  return out.sort((a, b) => b.length - a.length);
}

// cells of the largest 4-connected blob in a 0/1 mask
function largestBlob(mask, g) {
  const seen = new Uint8Array(g * g);
  let best = [];
  for (let c0 = 0; c0 < g * g; c0++) {
    if (!mask[c0] || seen[c0]) continue;
    const blob = [c0];
    seen[c0] = 1;
    for (let k = 0; k < blob.length; k++) {
      const c = blob[k], x = c % g;
      for (const m of [x > 0 ? c - 1 : -1, x < g - 1 ? c + 1 : -1, c - g, c + g]) {
        if (m >= 0 && m < g * g && mask[m] && !seen[m]) { seen[m] = 1; blob.push(m); }
      }
    }
    if (blob.length > best.length) best = blob;
  }
  return best.sort((a, b) => a - b);
}

// graph distance (in hops) from a set of start segments to every segment
export function hops(map, starts) {
  const d = new Array(map.segs.length).fill(Infinity), q = [...starts];
  for (const s of starts) d[s] = 0;
  for (let k = 0; k < q.length; k++) {
    for (const m of map.segs[q[k]].adj) if (d[m] === Infinity) { d[m] = d[q[k]] + 1; q.push(m); }
  }
  return d;
}

// fair starting segments (player first, then bots): all on the coast, spread evenly around the
// island by angle, then the layout whose hop distances between starts are largest and most even.
// every coast segment is tried as the anchor; a little randomness picks among near-equal layouts
export function spreadStarts(map, k, rand, first = -1) {
  const coast = map.segs.filter((s) => s.coast);
  if (coast.length >= k * 2) {
    const cx = map.segs.reduce((a, s) => a + s.x, 0) / map.segs.length, cy = map.segs.reduce((a, s) => a + s.y, 0) / map.segs.length;
    const ang = (s) => Math.atan2(s.y - cy, s.x - cx);
    const diff = (a, b) => Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
    let best = null;
    for (const s0 of first >= 0 ? [map.segs[first]] : coast) {
      const pick = [s0.id];
      for (let i = 1; i < k; i++) {
        const target = ang(s0) + (i * Math.PI * 2) / k;
        let cand = null, cd = Infinity;
        for (const s of coast) if (!pick.includes(s.id) && diff(ang(s), target) < cd) { cd = diff(ang(s), target); cand = s.id; }
        pick.push(cand);
      }
      const d = [];
      for (let i = 0; i < k; i++) { const h = hops(map, [pick[i]]); for (let j = i + 1; j < k; j++) d.push(h[pick[j]]); }
      const score = Math.min(...d) * 2 - (Math.max(...d) - Math.min(...d)) + rand() * 0.8;
      if (!best || score > best.score) best = { score, pick };
    }
    // shuffle who gets which spot, so the player isn't always on the same side (unless fixed)
    const pick = best.pick, r = first >= 0 ? 0 : Math.floor(rand() * k);
    return pick.slice(r).concat(pick.slice(0, r));
  }
  const starts = [Math.floor(rand() * map.segs.length)];
  while (starts.length < k) {
    const d = hops(map, starts);
    let best = -1, bd = -1;
    for (let i = 0; i < d.length; i++) {
      const v = d[i] + rand() * 0.5;   // random tie-break
      if (!starts.includes(i) && v > bd) { bd = v; best = i; }
    }
    starts.push(best);
  }
  return starts;
}

// fair start: reshape the starting segments to the same size (the average segment area).
// a small start grows into its non-start neighbours, nearest cells first (so it stays round);
// a big one hands its farthest cells to them. neighbours never drop below half their size.
// keep = a segment that keeps its shape (expedition capital = the previous island).
// edits map.ids in place, then recomputes areas, borders, adjacency and label spots
export function equalizeStarts(map, starts, keep = -1) {
  const { ids, grid: g, segs } = map;
  const target = Math.round(segs.reduce((a, s) => a + s.area, 0) / segs.length);
  const fixed = new Set(starts), area = segs.map((s) => s.area), floor = segs.map((s) => s.area * 0.5);
  const nb = (c) => { const x = c % g; return [x > 0 ? c - 1 : -1, x < g - 1 ? c + 1 : -1, c - g, c + g].filter((m) => m >= 0 && m < g * g); };
  const free = (c) => ids[c] >= 0 && !fixed.has(ids[c]) && area[ids[c]] > floor[ids[c]];
  for (const sid of starts) {
    if (sid === keep) continue;
    const s = segs[sid], d2 = (c) => ((c % g) + 0.5 - s.x) ** 2 + (Math.floor(c / g) + 0.5 - s.y) ** 2;
    const own = [];
    for (let c = 0; c < g * g; c++) if (ids[c] === sid) own.push(c);
    if (area[sid] < target) {
      // grow: min-heap of frontier cells by distance to the label spot
      const heap = [], seen = new Uint8Array(g * g);
      const push = (c) => {
        seen[c] = 1; heap.push(c);
        for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (d2(heap[p]) <= d2(heap[i])) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
      };
      const pop = () => {
        const top = heap[0], last = heap.pop();
        if (heap.length) {
          heap[0] = last;
          for (let i = 0; ;) {
            const l = i * 2 + 1, r = l + 1;
            let m = i;
            if (l < heap.length && d2(heap[l]) < d2(heap[m])) m = l;
            if (r < heap.length && d2(heap[r]) < d2(heap[m])) m = r;
            if (m === i) break;
            [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
          }
        }
        return top;
      };
      for (const c of own) for (const m of nb(c)) if (!seen[m] && free(m)) push(m);
      while (heap.length && area[sid] < target) {
        const c = pop();
        if (!free(c)) continue;
        area[ids[c]]--; area[sid]++; ids[c] = sid;
        for (const m of nb(c)) if (!seen[m] && free(m)) push(m);
      }
    } else if (area[sid] > target) {
      // shrink: peel the farthest cells that touch a non-start neighbour, ring by ring
      own.sort((a, b) => d2(b) - d2(a));
      for (let pass = 0; pass < g && area[sid] > target; pass++) {
        let moved = 0;
        for (const c of own) {
          if (ids[c] !== sid || area[sid] <= target) continue;
          const m = nb(c).find((m) => ids[m] >= 0 && ids[m] !== sid && !fixed.has(ids[m]));
          if (m === undefined) continue;
          area[sid]--; area[ids[m]]++; ids[c] = ids[m]; moved++;
        }
        if (!moved) break;
      }
    }
  }
  // pieces cut off from their segment join the neighbour they touch most
  for (let round = 0; round < 4; round++) {
    const comp = new Int32Array(g * g).fill(-1), main = new Map(), sizes = [];
    for (let c0 = 0; c0 < g * g; c0++) {
      if (ids[c0] < 0 || comp[c0] >= 0) continue;
      const k = sizes.length, q = [c0];
      comp[c0] = k;
      for (let i = 0; i < q.length; i++) for (const m of nb(q[i])) if (comp[m] < 0 && ids[m] === ids[c0]) { comp[m] = k; q.push(m); }
      sizes.push(q.length);
      if (!main.has(ids[c0]) || sizes[main.get(ids[c0])] < q.length) main.set(ids[c0], k);
    }
    let orphans = 0;
    for (let c = 0; c < g * g; c++) {
      if (ids[c] < 0 || comp[c] === main.get(ids[c])) continue;
      const m = nb(c).find((m) => ids[m] >= 0 && ids[m] !== ids[c] && comp[m] === main.get(ids[m]));
      if (m !== undefined) { ids[c] = ids[m]; orphans++; }
    }
    if (!orphans) break;
  }
  recount(map);
}

// recompute per-segment area, coast, adjacency (incl. sea routes), border distance, edge cells
// and label spots from map.ids (same rules as generateMap steps 6-7)
function recount(map) {
  const { ids, grid: g, segs, terrain } = map;
  const nb = (c) => { const x = c % g; return [x > 0 ? c - 1 : -1, x < g - 1 ? c + 1 : -1, c - g, c + g].filter((m) => m >= 0 && m < g * g); };
  for (const s of segs) { s.area = 0; s.sx = 0; s.sy = 0; s.coast = false; s.adjSet = new Set(); }
  const edge = new Uint8Array(g * g);
  for (let c = 0; c < g * g; c++) {
    const id = ids[c], x = c % g;
    if (id >= 0) { const s = segs[id]; s.area++; s.sx += x; s.sy += Math.floor(c / g); }
    const r = x < g - 1 ? ids[c + 1] : -1, d = c < g * g - g ? ids[c + g] : -1;
    const l = x > 0 ? ids[c - 1] : -1, u = c >= g ? ids[c - g] : -1;
    const same = (m, v) => v === id || (id >= 0 && m >= 0 && m < g * g && terrain[m]);
    if (!same(c + 1, r) || !same(c + g, d) || !same(c - 1, l) || !same(c - g, u)) edge[c] = 1;
    if (id >= 0 && [[c + 1, r, x < g - 1], [c + g, d, c < g * g - g], [c - 1, l, x > 0], [c - g, u, c >= g]].some(([m, v, ok]) => !ok || (v < 0 && !terrain[m]))) segs[id].coast = true;
    if (id >= 0 && r >= 0 && r !== id) { segs[id].adjSet.add(r); segs[r].adjSet.add(id); }
    if (id >= 0 && d >= 0 && d !== id) { segs[id].adjSet.add(d); segs[d].adjSet.add(id); }
  }
  for (const b of map.bridges) {
    // sea route ends follow whoever now owns the landing cell
    b.a = ids[Math.floor(b.ay) * g + Math.floor(b.ax)];
    b.b = ids[Math.floor(b.by) * g + Math.floor(b.bx)];
    segs[b.a].adjSet.add(b.b); segs[b.b].adjSet.add(b.a);
  }
  const dist = new Int16Array(g * g).fill(-1), queue = [];
  for (let c = 0; c < g * g; c++) {
    if (ids[c] < 0) continue;
    if (nb(c).some((m) => ids[m] !== ids[c]) || nb(c).length < 4) { dist[c] = 0; queue.push(c); }
  }
  for (let k = 0; k < queue.length; k++) for (const m of nb(queue[k])) if (dist[m] < 0 && ids[m] === ids[queue[k]]) { dist[m] = dist[queue[k]] + 1; queue.push(m); }
  const best = segs.map(() => -1e9);
  for (let c = 0; c < g * g; c++) {
    const id = ids[c];
    if (id < 0) continue;
    const s = segs[id], x = c % g, y = Math.floor(c / g);
    const score = dist[c] - Math.hypot(x - s.sx / s.area, y - s.sy / s.area) * 0.05;
    if (score > best[id]) { best[id] = score; s.x = x + 0.5; s.y = y + 0.5; }
  }
  for (const s of segs) { s.adj = [...s.adjSet]; delete s.adjSet; delete s.sx; delete s.sy; }
  map.edge = edge;
  map.bdist = dist;
  map.avgArea = segs.reduce((a, s) => a + s.area, 0) / segs.length;
}

// river course from grid cells to a smooth, winding line (grid units). tile = typical tile width
// in cells; everything scales with it so rivers look the same at any grid size. bfs paths are
// straight runs with 45 degree kinks, so: resample evenly, average away the kinks (rounded turns
// about a tenth of a tile wide), add an uneven meander across the flow (wavelength and amplitude
// drift, so bends differ in size) that fades out at the spring and the mouth, smooth again.
// onLand(x, y) keeps the meander off the water. the ends stay pinned, so the river still starts
// at its spring and ends in the water
function smoothCourse(cells, g, tile, onLand = () => true) {
  let p = cells.map((c) => [(c % g) + 0.5, Math.floor(c / g) + 0.5]);
  // even spacing along the line
  const resample = (pts, step) => {
    const out = [pts[0]];
    let carry = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], d = Math.hypot(bx - ax, by - ay);
      for (let s = step - carry; s < d; s += step) out.push([ax + ((bx - ax) * s) / d, ay + ((by - ay) * s) / d]);
      carry = (carry + d) % step;
    }
    out.push(pts[pts.length - 1]);
    return out;
  };
  // moving average; the window shrinks near the ends so they stay put
  const average = (pts, r) => pts.map((q, i) => {
    const w = Math.min(r, i, pts.length - 1 - i);
    let x = 0, y = 0;
    for (let j = i - w; j <= i + w; j++) { x += pts[j][0]; y += pts[j][1]; }
    return [x / (2 * w + 1), y / (2 * w + 1)];
  });
  const step = 0.5, win = Math.max(3, Math.round((tile * 0.05) / step));   // ~5% of a tile each side
  p = resample(p, step);
  p = average(average(p, win), win);
  // meander: wavelength drifts 0.3-0.6 tiles and amplitude 0.025-0.065 tiles along the river (slow
  // sine mixes), phase from the spring cell (no rng draw, so the rest of the map stays the same)
  const seed = cells[0] * 0.618, len = (p.length - 1) * step, fade = tile * 0.12;
  let phase = seed % (2 * Math.PI);
  p = p.map((q, i) => {
    const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1, s = i * step;
    const wave = tile * (0.45 + 0.15 * Math.sin((s / tile) * 2.1 + seed));
    const amp = tile * (0.045 + 0.02 * Math.sin((s / tile) * 3.3 + seed * 1.7));
    phase += (2 * Math.PI * step) / wave;
    let off = amp * Math.sin(phase) * Math.min(1, s / fade, (len - s) / fade);
    // pull the bend in where it would swing out over the sea or a lake
    const nx = -dy / d, ny = dx / d;
    for (let k = 0; k < 3 && off && !onLand(q[0] + nx * off, q[1] + ny * off); k++) off *= k < 1 ? 0.5 : 0;
    return [q[0] + nx * off, q[1] + ny * off];
  });
  return resample(average(p, Math.max(2, win >> 1)), 0.75);
}
