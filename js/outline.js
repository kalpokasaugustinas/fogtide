// outline tracing (marching squares + smoothing) with no dom, so the map worker can run it too

// ---------- outline tracing ----------

// marching squares over a 0/1 test on grid cells (sampled at cell centres) inside a bounding box.
// returns all closed outlines (grid units) as flat point loops, smoothed; fill it with 'evenodd' for holes.
// lab(c) labels every cell (segment id, sea, lake, ...): each outline point remembers the pair of
// labels it separates, so a border shared by two outlines is smoothed the same way in both and
// points where 3 areas meet stay pinned (no gaps or overlaps between neighbours).
// angular = low-poly look (mountains): straight edges instead of smooth curves
export function outlineLoops(test, lab, g, x0 = 0, y0 = 0, x1 = g - 1, y1 = g - 1, angular = false) {
  const inside = (x, y) => x >= 0 && y >= 0 && x < g && y < g && test(y * g + x);
  const label = (x, y) => (x >= 0 && y >= 0 && x < g && y < g ? lab(y * g + x) : -1);
  // point keys use doubled coordinates so every edge midpoint is an integer
  const links = new Map(), pair = new Map();
  const link = (a, b) => {
    (links.get(a) ?? links.set(a, []).get(a)).push(b);
    (links.get(b) ?? links.set(b, []).get(b)).push(a);
  };
  const key = (x2, y2) => x2 * 4096 + y2;
  // remember which two cell labels a crossing point separates (unordered)
  const mark = (k, ax, ay, bx, by) => {
    const p = label(ax, ay), q = label(bx, by);
    pair.set(k, Math.min(p, q) * 100000 + Math.max(p, q));
  };
  for (let y = y0 - 1; y <= y1; y++) {
    for (let x = x0 - 1; x <= x1; x++) {
      const a = inside(x, y), b = inside(x + 1, y), c = inside(x + 1, y + 1), d = inside(x, y + 1);
      if (a === b && b === c && c === d) continue;
      // crossing midpoints of the square's edges (doubled coords)
      const top = key(2 * x + 2, 2 * y + 1), right = key(2 * x + 3, 2 * y + 2);
      const bottom = key(2 * x + 2, 2 * y + 3), left = key(2 * x + 1, 2 * y + 2);
      const cross = [];
      if (a !== b) { cross.push(top); mark(top, x, y, x + 1, y); }
      if (b !== c) { cross.push(right); mark(right, x + 1, y, x + 1, y + 1); }
      if (c !== d) { cross.push(bottom); mark(bottom, x, y + 1, x + 1, y + 1); }
      if (d !== a) { cross.push(left); mark(left, x, y, x, y + 1); }
      if (cross.length === 2) link(cross[0], cross[1]);
      else if (a) { link(top, left); link(right, bottom); }   // saddle: cut off the inside corners
      else { link(top, right); link(bottom, left); }
    }
  }
  const loops = [], seen = new Set();
  for (const start of links.keys()) {
    if (seen.has(start)) continue;
    // walk the loop
    const loop = [], codes = [];
    let prev = -1, cur = start;
    while (!seen.has(cur)) {
      seen.add(cur);
      loop.push([Math.floor(cur / 4096) / 2, (cur % 4096) / 2]);
      codes.push(pair.get(cur));
      const nb = links.get(cur);
      const next = nb[0] !== prev ? nb[0] : nb[1];
      prev = cur;
      cur = next;
    }
    if (loop.length < 3) continue;
    const pts = angular ? rdp(relax(loop, codes), 2.2 * g / 480) : chaikin(relax(relax(loop, codes), codes));
    if (pts.length < 3) continue;
    const f = new Float32Array(pts.length * 2);   // flat x, y pairs (cheap to send from the worker)
    pts.forEach((q, i) => { f[2 * i] = q[0]; f[2 * i + 1] = q[1]; });
    loops.push(f);
  }
  return loops;
}

// closed loops (outlineLoops) -> one Path2D
export function loopsToPath(loops) {
  const path = new Path2D();
  for (const f of loops) {
    path.moveTo(f[0], f[1]);
    for (let i = 2; i < f.length; i += 2) path.lineTo(f[i], f[i + 1]);
    path.closePath();
  }
  return path;
}

// marching squares -> Path2D (see outlineLoops)
export const outline = (...a) => loopsToPath(outlineLoops(...a));

// every outline a map view needs, as loops: island (land + mountains, lakes as holes), outer
// (incl. lakes), lakes, mountains (angular), one per segment, plus the segment bounding boxes.
// the map worker runs this after the fair-start reshaping, so MapView only builds the paths
export function mapOutlines(map) {
  const { ids, terrain, grid: g, segs } = map;
  const lake = (c) => terrain && terrain[c] === 1, mtn = (c) => terrain && terrain[c] === 2;
  const lab = (c) => (ids[c] >= 0 ? ids[c] : -1 - (terrain ? terrain[c] : 0));
  const box = segBoxes(map);
  return {
    island: outlineLoops((c) => ids[c] >= 0 || mtn(c), lab, g),
    outer: outlineLoops((c) => ids[c] >= 0 || mtn(c) || lake(c), lab, g),
    lakes: outlineLoops(lake, lab, g),
    mtn: outlineLoops(mtn, lab, g, 0, 0, g - 1, g - 1, true),
    segs: segs.map((s) => outlineLoops((c) => ids[c] === s.id, lab, g, ...box[s.id])),
    box,
  };
}

// per-segment bounding boxes [x0, y0, x1, y1] in grid cells (keep the tracing fast)
export function segBoxes(map) {
  const { ids, grid: g, segs } = map, box = segs.map(() => [g, g, -1, -1]);
  for (let c = 0; c < g * g; c++) {
    const id = ids[c];
    if (id < 0) continue;
    const b = box[id], x = c % g, y = Math.floor(c / g);
    if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
  }
  return box;
}

// moving-average smoothing along a closed loop, done separately on each run of points that
// separate the same two areas; the window shrinks toward the run ends, so junctions stay fixed
// and the result doesn't depend on loop direction or start point
const relax_window = 7;
function relax(p, codes) {
  const n = p.length, out = p.map((q) => [q[0], q[1]]);
  let start = codes.findIndex((c, i) => c !== codes[(i - 1 + n) % n]);
  if (start < 0) {
    // one run around the whole loop (e.g. a lake inside a single segment): plain cyclic average
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0;
      for (let j = -relax_window; j <= relax_window; j++) { const q = p[(((i + j) % n) + n) % n]; sx += q[0]; sy += q[1]; }
      out[i] = [sx / (2 * relax_window + 1), sy / (2 * relax_window + 1)];
    }
    return out;
  }
  for (let done = 0; done < n;) {
    // run = consecutive points with the same pair code
    let len = 1;
    while (len < n && codes[(start + len) % n] === codes[start]) len++;
    for (let j = 0; j < len; j++) {
      const w = Math.min(relax_window, j, len - 1 - j);
      let sx = 0, sy = 0;
      for (let k = -w; k <= w; k++) { const q = p[(start + j + k) % n]; sx += q[0]; sy += q[1]; }
      out[(start + j) % n] = [sx / (2 * w + 1), sy / (2 * w + 1)];
    }
    start = (start + len) % n;
    done += len;
  }
  return out;
}

// ramer-douglas-peucker simplification of a closed loop (eps in grid units)
function rdp(p, eps) {
  const simplify = (pts) => {
    if (pts.length < 3) return pts;
    const a = pts[0], b = pts[pts.length - 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    let far = 0, fi = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs((pts[i][0] - a[0]) * dy - (pts[i][1] - a[1]) * dx) / len;
      if (d > far) { far = d; fi = i; }
    }
    if (far <= eps) return [a, b];
    return [...simplify(pts.slice(0, fi + 1)).slice(0, -1), ...simplify(pts.slice(fi))];
  };
  // split the loop at its two farthest-apart points so both halves are open polylines
  let j = 0, best = 0;
  for (let i = 1; i < p.length; i++) { const d = Math.hypot(p[i][0] - p[0][0], p[i][1] - p[0][1]); if (d > best) { best = d; j = i; } }
  return [...simplify(p.slice(0, j + 1)).slice(0, -1), ...simplify([...p.slice(j), p[0]]).slice(0, -1)];
}

// one round of chaikin corner cutting on a closed loop (rounds the 45° marching-squares steps)
function chaikin(p) {
  const out = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
  }
  return out;
}
