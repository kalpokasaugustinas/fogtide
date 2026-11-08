// map renderer in a soft "island diorama" style:
// misty sea, foam at the waterline, cliffs under the island edge, natural ground colours,
// owner colours as glowing segment borders, low-poly trees on top.
// all edges (coast, lakes, mountains, segment borders) are smooth vector outlines traced from the
// map grid with marching squares + chaikin smoothing, so nothing looks pixelated at any size.
// layers (display resolution, cached): under (fog, cliff) -> top (ground, building scenes, owner
// overlays, borders, rocks, trees; repainted when owners, buildings or the selection change)
import { themes } from './config.js?v=91';
import * as structures from './structures.js?v=91';

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// mix colour toward white (k > 0) or black (k < 0)
export function shade([r, g, b], k) {
  const t = k > 0 ? 255 : 0, a = Math.abs(k);
  return [r + (t - r) * a, g + (t - g) * a, b + (t - b) * a];
}

// linear mix of two rgb colours, t in [0, 1]
export function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const css = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
let shadowBlob = null;   // soft cloud-shadow sprite (MapView.drawAmbient), made once

// do two boxes [x0, y0, x1, y1] overlap? (terrain objects vs huts and buildings)
const boxHit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

// deterministic hash + smooth value noise (ground patches, tree placement)
function hash(x, y, s) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, s), b = hash(ix + 1, iy, s), c = hash(ix, iy + 1, s), d = hash(ix + 1, iy + 1, s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// ---------- clouds ----------

// fog palette per climate: blue-grey shadows, soft body, near-white lit tops
function cloudColors(t) {
  return { dark: mix(shade(t.fogB, -0.12), [150, 168, 190], 0.45), mid: mix(t.fogB, [196, 208, 222], 0.4), light: mix(t.fogA, [255, 255, 255], 0.7) };
}

// periodic value noise (wraps every p lattice cells), so the texture tiles seamlessly
function pnoise(x, y, p, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), w = (v) => ((v % p) + p) % p;
  const a = hash(w(ix), w(iy), s), b = hash(w(ix + 1), w(iy), s), c = hash(w(ix), w(iy + 1), s), d = hash(w(ix + 1), w(iy + 1), s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// tileable billowing cloud texture as a data url (cached per climate). density = fractal noise;
// lighting = density minus density a little to the top-left, so puffs get bright rims and
// shaded undersides
const cloudCache = new Map();
export function cloudTexture(t) {
  const key = `${t.fogA}|${t.fogB}`;
  if (cloudCache.has(key)) return cloudCache.get(key);
  const n = 256, c = document.createElement('canvas');
  c.width = c.height = n;
  const x = c.getContext('2d'), img = x.createImageData(n, n), cl = cloudColors(t);
  const fbm = (u, v) => {
    let s = 0, amp = 0.55, tot = 0;
    for (let o = 0, p = 4; o < 5; o++, p *= 2, amp *= 0.5) { s += pnoise((u / n) * p, (v / n) * p, p, 71 + o) * amp; tot += amp; }
    return s / tot;
  };
  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) {
      const d = fbm(u, v), lit = d - fbm(u - 3, v - 4);
      const dens = Math.min(1, Math.max(0, (d - 0.32) / 0.4));
      let col = mix(cl.dark, cl.mid, dens);
      col = lit > 0 ? mix(col, cl.light, Math.min(1, lit * 9) * dens) : mix(col, cl.dark, Math.min(1, -lit * 6) * 0.6);
      const o = (v * n + u) * 4;
      img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
    }
  }
  x.putImageData(img, 0, 0);
  const url = c.toDataURL();
  cloudCache.set(key, url);
  return url;
}

// ---------- outline tracing ----------

// marching squares over a 0/1 test on grid cells (sampled at cell centres) inside a bounding box.
// returns a Path2D (grid units) of all closed outlines, smoothed; fill it with 'evenodd' for holes.
// lab(c) labels every cell (segment id, sea, lake, ...): each outline point remembers the pair of
// labels it separates, so a border shared by two outlines is smoothed the same way in both and
// points where 3 areas meet stay pinned (no gaps or overlaps between neighbours).
// angular = low-poly look (mountains): straight edges instead of smooth curves
function outline(test, lab, g, x0 = 0, y0 = 0, x1 = g - 1, y1 = g - 1, angular = false) {
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
  const path = new Path2D(), seen = new Set();
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
    path.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) path.lineTo(pts[i][0], pts[i][1]);
    path.closePath();
  }
  return path;
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

// map scale: conquest stages 4-5 are bigger maps (feature scale detail < 0.62). everything drawn on
// them (buildings, trees, foglets, badges) shrinks by this, and the camera starts zoomed in by its
// inverse, so things look the same size as on stage 3 while the map holds more tiles
export const mapScale = (m) => Math.min(1, (m?.detail ?? 1) / 0.62);
// tile border thickness (owner band + glow, terrain dashes, plain lines), times mapScale on big maps
const borderW = 0.6;

export class MapView {
  // segThemes (optional): theme name per segment, e.g. campaign regions with their own climate
  constructor(canvas, map, theme, segThemes) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.setMap(map, theme, segThemes);
    // follow the container size (screen rotation, panel changes)
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  setMap(map, theme = 'summer', segThemes = null) {
    this.map = map;
    this.theme = themes[theme] ?? themes.summer;
    this.segTheme = segThemes ? segThemes.map((n) => themes[n] ?? this.theme) : null;
    this.k = map.grid / 480;   // feature sizes are tuned for a 480 grid
    this.buildGround();
    this.buildOutlines();
    this.placeTrees();
    this.measureIsland();
    // fog around the island lives on the container, so there's no square edge
    this.canvas.parentElement.style.background = `url(${cloudTexture(this.theme)}) center / 720px 720px repeat, rgb(${this.theme.fogB})`;
    this.styleOf = this.st = null;
    this.bkey = this.okey = null;
    this.size = 0;   // forces resize() to rebuild every cached layer for the new map
    this.resize();
  }

  // island bounding box (grid cells, land + lakes + mountains) and sample points on the water
  // (lakes, rivers) for the animated sparkles and the lake wave strokes
  measureIsland() {
    const { ids, terrain, grid: g } = this.map;
    let x0 = g, y0 = g, x1 = 0, y1 = 0;
    const pts = [];
    for (let c = 0; c < g * g; c++) {
      if (ids[c] < 0 && !(terrain && terrain[c])) continue;
      const x = c % g, y = Math.floor(c / g);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (terrain && terrain[c] === 1 && hash(x, y, this.seed + 40) < 0.012) pts.push([x + 0.5, y + 0.5, 1]);
    }
    this.isle = [x0, y0, x1 + 1, y1 + 1];
    // rivers: every few points along each course (rivers sit on the ground, no lake drop)
    for (const r of this.map.rivers ?? []) for (let j = 4; j < r.length; j += 9) if (hash(j, 41, r.length) < 0.5) pts.push([r[j][0], r[j][1], 0]);
    // at most ~70 sparkles; phase and speed fixed per point
    this.glints = pts.slice(0, 70).map(([x, y, lake], i) => ({ x, y, lake, ph: hash(i, 42, this.seed) * 6.28, w: 0.7 + hash(i, 43, this.seed) * 1.1 }));
  }

  // fit the canvas into the parent: width = map width, height = squashed map + room for cliffs
  // below and buildings/rocks above. cached layers are rebuilt lazily.
  // fitIsland (battle view): size so the island itself, not its square grid, fills the screen
  // (the grid's empty fog corners may run off-screen); the canvas shifts so the island is centred
  resize() {
    // layout size (clientWidth ignores the zoom transform on the parent)
    const el = this.canvas.parentElement, r = { width: el.clientWidth, height: el.clientHeight };
    this.tilt = 0.8;
    const pad = 0.12;   // extra height (as a share of width): cliffs + raised objects
    let size = Math.max(50, Math.floor(Math.min(r.width, r.height / (this.tilt + pad))));
    let shiftX = 0, shiftY = 0;
    if (this.fitIsland && this.isle) {
      const g = this.map.grid, [x0, y0, x1, y1] = this.isle;
      const bw = (x1 - x0) / g, bh = (y1 - y0) / g;
      // margins for the corner hud (top) and the send box / tile card (bottom)
      const fit = Math.floor(Math.min((r.width * 0.9) / bw, (r.height * 0.8) / (bh * this.tilt + pad * 0.6)));
      const grown = Math.min(Math.floor(size * 1.8), Math.max(size, fit));
      if (grown > size) {
        size = grown;
        // island centre -> container centre (the canvas centre is the grid centre)
        shiftX = (0.5 - (x0 + x1) / 2 / g) * size;
        shiftY = (0.5 - (y0 + y1) / 2 / g) * size * this.tilt + size * 0.015;
      }
      this.canvas.style.position = 'relative';
      this.canvas.style.left = Math.round(shiftX) + 'px';
      this.canvas.style.top = Math.round(shiftY) + 'px';
      this.canvas.style.flex = 'none';   // may be bigger than the container (centred overflow)
    }
    // zoomed in (boost > 1): render sharper, boost x the screen's own density, so a phone at 2x zoom
    // gets 2x its pixels too; capped at ~4 M px per layer (~6 cached layers, several drawn each frame)
    const base = window.devicePixelRatio || 1, css = size * size * (this.tilt + pad);
    const dpr = Math.max(base, Math.min(base * (this.boost ?? 1), Math.sqrt((this.pxCap ?? 4e6) / css)));
    if (size === this.size && dpr === this.dpr && this.under) return;
    this.size = size;
    this.dpr = dpr;
    this.scale = size / this.map.grid;
    this.oy = size * pad * 0.5;
    const h = Math.round(size * (this.tilt + pad));
    this.canvas.width = Math.round(size * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = size + 'px';
    this.canvas.style.height = h + 'px';
    this.cssH = h;
    this.under = this.base = this.rocks = this.layerGround = this.layerOwner = this.layerObjects = null;
    this.sprites = new Map();
    this.ofsX = this.ofsY = 0;
    // building scale unit in css px; bigger conquest maps (mapScale < 1) draw everything smaller
    this.u = Math.max(3.5, size / 92) * mapScale(this.map);
    this.spotCache = new Map();
  }

  // grid-res ground texture (grass/earth noise, shore and scree tints). it is only seen through the
  // smooth island outline, so its pixel edges never show
  buildGround() {
    const { ids, terrain, relief, near, nearType, grid: g, segs } = this.map, t = this.theme;
    const seed = (this.seed = (segs.length * 7919 + Math.round(segs[0].x * 31)) | 0);
    const mk = () => { const c = document.createElement('canvas'); c.width = c.height = g; return c; };
    this.groundC = mk();
    const gi = this.groundC.getContext('2d').createImageData(g, g);
    const isMtn = (c) => terrain && terrain[c] === 2;
    const h = (c) => (c >= 0 && c < g * g && isMtn(c) ? relief[c] : 0);
    for (let c = 0; c < g * g; c++) {
      const x = c % g, y = Math.floor(c / g), o = c * 4;
      // ground everywhere (also under mountains and a bit into the sea, so edges never fade out)
      const n = vnoise(x / (22 * this.k), y / (22 * this.k), seed) * 0.7 + vnoise(x / (6 * this.k), y / (6 * this.k), seed + 1) * 0.3;
      const tc = this.segTheme && ids[c] >= 0 ? this.segTheme[ids[c]] : t;   // this cell's climate
      let col = mix(tc.groundA, tc.groundB, n);
      if (near && near[c]) col = mix(col, nearType[c] === 1 ? tc.shore : tc.scree, 0.5 * (1 - (near[c] - 1) / 10) ** 1.5);
      // terrain traits are visible in the ground: forest floor is darker and mottled, highland is
      // stony scree with grass patches, lakeside has a wide sandy shore
      const tr = ids[c] >= 0 ? segs[ids[c]].trait : null;
      if (tr === 'forest') col = mix(col, tc.treeDark, 0.18 + 0.14 * vnoise(x / (5 * this.k), y / (5 * this.k), seed + 3));
      else if (tr === 'highland') {
        const patch = vnoise(x / (9 * this.k), y / (9 * this.k), seed + 4);
        col = mix(col, mix(tc.scree, tc.rockLight, vnoise(x / (3 * this.k), y / (3 * this.k), seed + 5) * 0.6), 0.25 + 0.4 * (patch > 0.45 ? 1 : patch / 0.45));
      } else if (tr === 'lakeside' && near[c] && nearType[c] === 1) col = mix(col, tc.shore, 0.35 * (1 - near[c] / 11));
      gi.data[o] = col[0]; gi.data[o + 1] = col[1]; gi.data[o + 2] = col[2]; gi.data[o + 3] = 255;
    }
    this.groundC.getContext('2d').putImageData(gi, 0, 0);
  }

  // smooth outlines: island (land + mountains, lakes as holes), outer (incl. lakes), lakes,
  // mountains and one per segment
  buildOutlines() {
    const { ids, terrain, grid: g, segs } = this.map;
    const lake = (c) => terrain && terrain[c] === 1, mtn = (c) => terrain && terrain[c] === 2;
    // cell label: segment id, or -1 sea / -2 lake / -3 mountain
    const lab = (c) => (ids[c] >= 0 ? ids[c] : -1 - (terrain ? terrain[c] : 0));
    this.islandP = outline((c) => ids[c] >= 0 || mtn(c), lab, g);
    this.outerP = outline((c) => ids[c] >= 0 || mtn(c) || lake(c), lab, g);
    this.lakesP = outline(lake, lab, g);
    this.mtnP = outline(mtn, lab, g, 0, 0, g - 1, g - 1, true);
    // cracks on the rock tops: short kinked lines starting on random mountain cells
    const rockCells = [];
    for (let c = 0; c < g * g; c++) if (mtn(c)) rockCells.push(c);
    this.cracks = [];
    const k = this.k, count = Math.round(rockCells.length / (450 * k * k));
    for (let i = 0; i < count; i++) {
      const c0 = rockCells[Math.floor(hash(i, 11, this.seed) * rockCells.length)];
      let x0 = c0 % g, y0 = Math.floor(c0 / g), a = hash(i, 12, this.seed) * Math.PI * 2;
      const line = [[x0, y0]];
      for (let s = 0; s < 2 + Math.floor(hash(i, 13, this.seed) * 2); s++) {
        a += (hash(i, 14 + s, this.seed) - 0.5) * 1.6;
        const len = (5 + hash(i, 20 + s, this.seed) * 8) * k;
        x0 += Math.cos(a) * len; y0 += Math.sin(a) * len;
        line.push([x0, y0]);
      }
      this.cracks.push(line);
    }
    // per-segment bounding boxes keep the tracing fast
    const box = segs.map(() => [g, g, -1, -1]);
    for (let c = 0; c < g * g; c++) {
      const id = ids[c];
      if (id < 0) continue;
      const b = box[id], x = c % g, y = Math.floor(c / g);
      if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
    }
    this.segP = segs.map((s) => outline((c) => ids[c] === s.id, lab, g, ...box[s.id]));
    this.boxes = box;
    this.segCells = segs.map(() => []);
    for (let c = 0; c < g * g; c++) if (ids[c] >= 0) this.segCells[ids[c]].push(c);
  }

  // tree clusters inside segments, away from borders and number labels
  placeTrees() {
    const { ids, bdist, grid: g, segs, near, nearType } = this.map, t = this.theme, k = this.k;
    this.trees = [];
    if (!bdist || !t.trees) return;
    const clear = 26 * k;   // keep label areas free
    const ok = (x, y) => {
      const c = Math.floor(y) * g + Math.floor(x);
      if (x < 0 || y < 0 || x >= g || y >= g || ids[c] < 0 || bdist[c] < 4 * k) return false;
      const s = segs[ids[c]];
      return Math.hypot(s.x - x, s.y - y) > clear;
    };
    let land = 0;
    for (let c = 0; c < g * g; c++) if (ids[c] >= 0) land++;
    const dt = this.map.detail ?? 1;   // zoomed-out maps: smaller trees, more woods
    const clusters = Math.round((land / (g * g)) * 60 * t.trees / Math.sqrt(dt));
    // no object may cover another: each one is approximated by its on-screen silhouette (an
    // upright ellipse above its base point, in grid units with the camera tilt applied) and a
    // new object is only added when its ellipse stays clear of every placed neighbour.
    // the ellipses sit in a coarse bucket grid so the check only looks at nearby objects.
    const tilt = 0.8, bucket = 16 * k, bw = Math.ceil(g / bucket), buckets = new Map();
    const shape = (o) => {
      if (o.kind === 'rock') return [o.r * (1 + o.a * 0.5) * 1.05, o.r * 0.6];
      if (o.kind === 'reed') return [o.r * 1.1, o.r * 0.95];
      return [o.r * 1.05, o.r * (t.tree === 'pine' ? 1.4 : 1.1)];   // crown + trunk
    };
    const place = (o) => {
      const [w, h] = shape(o), cy = o.y * tilt - h, bx = Math.floor(o.x / bucket), by = Math.floor(o.y / bucket);
      for (let yy = by - 1; yy <= by + 1; yy++) {
        for (let xx = bx - 1; xx <= bx + 1; xx++) {
          for (const p of buckets.get(yy * bw + xx) ?? []) {
            const dx = (p.x - o.x) / (p.w + w), dy = (p.cy - cy) / (p.h + h);
            if (dx * dx + dy * dy < 1) return false;   // silhouettes would overlap
          }
        }
      }
      const key = by * bw + bx;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({ x: o.x, cy, w, h });
      this.trees.push(o);
      return true;
    };
    let i = 0;
    for (let n = 0, tries = 0; n < clusters && tries < clusters * 30; tries++) {
      const cx = hash(i++, 1, this.seed) * g, cy = hash(i++, 2, this.seed) * g;
      if (!ok(cx, cy)) continue;
      // forest tiles are filled separately below; elsewhere only the odd copse
      if (segs[ids[Math.floor(cy) * g + Math.floor(cx)]].trait === 'forest' || hash(i++, 7, this.seed) < 0.965) continue;
      n++;
      // a cluster = a small wood: 5-11 trees side by side (a few tries each to find a free spot)
      const count = 5 + Math.floor(hash(i++, 3, this.seed) * 7);
      for (let j = 0, got = 0; j < count * 4 && got < count; j++) {
        const a = hash(i++, 4, this.seed) * Math.PI * 2, d = Math.sqrt(hash(i++, 5, this.seed)) * 16 * k * Math.max(0.25, dt);
        const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
        if (ok(x, y) && place({ x, y, r: (3 + hash(i++, 6, this.seed) * 1.8) * k * Math.max(0.22, dt), seg: ids[Math.floor(y) * g + Math.floor(x)] })) got++;
      }
    }
    // forest tiles: woodland over the whole tile (dense jittered candidates, the spacing check
    // keeps the ones that fit, a few clearings)
    const sp = 3.2 * k * Math.max(0.25, dt), rock = 12 * k * Math.max(0.25, dt);
    const segAt = (x, y) => segs[ids[Math.floor(y) * g + Math.floor(x)]];
    for (let gy = sp / 2; gy < g; gy += sp * 0.8) {
      for (let gx = sp / 2; gx < g; gx += sp) {
        const x = gx + (hash(i++, 8, this.seed) - 0.5) * sp, y = gy + (hash(i++, 9, this.seed) - 0.5) * sp * 0.8;
        if (!ok(x, y) || segAt(x, y).trait !== 'forest') continue;
        if (vnoise(x / (14 * k), y / (14 * k), this.seed + 6) < 0.28) continue;   // clearing
        place({ x, y, r: (3.2 + hash(i++, 6, this.seed) * 1.8) * k * Math.max(0.22, dt), seg: segAt(x, y).id });
      }
    }
    // highland tiles: scattered low-poly boulders
    for (let gy = rock / 2; gy < g; gy += rock * 0.8) {
      for (let gx = rock / 2; gx < g; gx += rock) {
        const x = gx + (hash(i++, 10, this.seed) - 0.5) * rock, y = gy + (hash(i++, 11, this.seed) - 0.5) * rock * 0.8;
        if (!ok(x, y) || segAt(x, y).trait !== 'highland' || hash(i++, 12, this.seed) < 0.35) continue;
        place({ kind: 'rock', x, y, r: (1.6 + hash(i++, 13, this.seed) * 2) * k * Math.max(0.25, dt), seg: segAt(x, y).id, a: hash(i++, 14, this.seed) });
      }
    }
    // reeds: lakeside tiles along the shore, river tiles along the banks
    const reedOk = (x, y) => { const c = Math.floor(y) * g + Math.floor(x); return x >= 0 && y >= 0 && x < g && y < g && ids[c] >= 0 && bdist[c] >= 2 * k; };
    const rr = 2 * k * Math.max(0.6, dt);
    if (near) for (let c = 0; c < g * g; c += 3) {
      if (ids[c] < 0 || segs[ids[c]].trait !== 'lakeside' || near[c] !== 1 || nearType[c] !== 1 || hash(c, 15, this.seed) < 0.75) continue;
      const x = (c % g) + 0.5, y = Math.floor(c / g) + 0.5;
      if (reedOk(x, y)) place({ kind: 'reed', x, y, r: rr, seg: ids[c] });
    }
    for (const pts of this.map.rivers ?? []) {
      for (const [j, [rx, ry]] of pts.entries()) {
        if (j % 3 || hash(j, 16, rx | 0) < 0.4) continue;   // points every 0.75 cells
        const side = hash(j, 17, ry | 0) < 0.5 ? -1 : 1, x = rx + side * 4.5 * k, y = ry + (hash(j, 18, rx | 0) - 0.5) * 3 * k;
        if (reedOk(x, y) && segAt(x, y).trait === 'river') place({ kind: 'reed', x, y, r: rr, seg: segAt(x, y).id });
      }
    }
    this.trees.sort((a, b) => a.y - b.y);   // draw back to front
  }

  // ---------- camera: slight tilt ----------
  // the ground plane is squashed vertically (tilt) so the map is seen at an angle; heights
  // (cliffs, rocks, buildings, trees) stay upright, which gives the 2.5d diorama look.
  // grid -> css: x * scale, y * scale * tilt + oy

  sx(gx) { return gx * this.scale; }
  sy(gy) { return gy * this.scale * this.tilt + this.oy; }
  px(v) { return v * this.scale; }   // grid length -> css px (sizes)

  // ctx transforms: grid units (with tilt) or css px. ofsX/ofsY shift the origin (device px) while
  // drawing into a small sprite canvas, so the same drawing code works for sprites and full layers
  gridT(x) { x.setTransform(this.dpr * this.scale, 0, 0, this.dpr * this.scale * this.tilt, -this.ofsX, this.dpr * this.oy - this.ofsY); }
  cssT(x) { x.setTransform(this.dpr, 0, 0, this.dpr, -this.ofsX, -this.ofsY); }

  // display-res canvas, ctx in grid units
  newLayer() {
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    const x = c.getContext('2d');
    this.gridT(x);
    x.imageSmoothingQuality = 'high';
    return [c, x];
  }

  // fog shadow, lake water, cliff face and mist (static per map and size)
  buildUnder() {
    const [c, x] = this.newLayer(), t = this.theme, g = this.map.grid, px = 1 / this.scale, py = px / this.tilt;
    const ch = Math.max(4, this.size * 0.022) * py;   // cliff height (css px -> grid y units)
    x.save();
    x.filter = `blur(${this.size * 0.035 * this.dpr}px)`;
    x.translate(g * 0.015, ch + g * 0.05);
    x.fillStyle = css(t.shadow, 0.16);
    x.fill(this.outerP);
    x.restore();
    x.save();
    x.translate(0, ch);
    // lakes: deeper water in the middle, a light shallow band along the shore (blurred stroke
    // inside the lake), faint wave strokes, then the foam rim
    const water = shade(hexToRgb(t.sea), -0.08);
    x.fillStyle = css(shade(water, -0.1));
    x.fill(this.lakesP);
    x.save();
    x.clip(this.lakesP);
    x.filter = `blur(${this.size * 0.008 * this.dpr}px)`;
    x.lineWidth = Math.max(6, this.size * 0.03) * px;
    x.strokeStyle = css(t.seaLight, 0.75);
    x.stroke(this.lakesP);
    x.lineWidth = Math.max(3, this.size * 0.012) * px;
    x.strokeStyle = css(shade(t.seaLight, 0.3), 0.7);
    x.stroke(this.lakesP);
    x.filter = 'none';
    // waves: short shallow arcs scattered over the water
    const wv = new Path2D(), wl = Math.max(3, this.size * 0.012) * px;
    for (const gl of this.glints ?? []) {
      if (!gl.lake) continue;
      if (hash(gl.x | 0, 46, gl.y | 0) < 0.4) continue;   // about 1 in 2 points gets one wave
      for (let j = 0; j < 1; j++) {
        const wx = gl.x + (hash(j, 44, gl.x | 0) - 0.5) * 22 * this.k, wy = gl.y + (hash(j, 45, gl.y | 0) - 0.5) * 16 * this.k;
        wv.moveTo(wx - wl, wy); wv.quadraticCurveTo(wx, wy - wl * 0.5, wx + wl, wy);
      }
    }
    x.lineCap = 'round';
    x.lineWidth = Math.max(1, this.size * 0.0016) * px;
    x.strokeStyle = css(t.foam, 0.35);
    x.stroke(wv);
    x.restore();
    x.lineWidth = Math.max(1.5, this.size * 0.004) * px;
    x.strokeStyle = css(t.foam, 0.8);
    x.stroke(this.lakesP);
    x.restore();
    // cliff: island shape stacked downward, dark at the foot, lighter toward the top edge
    for (let i = ch; i >= py * 0.5; i -= py * 0.5) {
      x.save();
      x.translate(0, i);
      x.fillStyle = css(i > ch * 0.45 ? t.cliffDark : t.cliffLight);
      x.fill(this.islandP, 'evenodd');
      x.restore();
    }
    // ground-only copy (shadow, lakes, cliffs, no fog): the conquest zoom-out shrinks just the land
    this.cliffs = document.createElement('canvas');
    this.cliffs.width = c.width; this.cliffs.height = c.height;
    this.cliffs.getContext('2d').drawImage(c, 0, 0);
    // cloud banks around the island: puffs with a blue-grey underside, a soft body and a bright
    // top-left rim (light from above), like the cloud texture behind them
    // (puffs go on a scratch layer without blur, which is then blurred once: a blur filter per
    // fill would cost hundreds of full-layer blurs)
    const [pc, pcx] = this.newLayer();
    const fogc = shade(t.fogA, 0.4), cl = cloudColors(t);
    for (let i = 0; i < 22; i++) {
      const a = hash(i, 31, this.seed) * Math.PI * 2, rr = g * (0.44 + hash(i, 32, this.seed) * 0.12);
      const fx = g / 2 + Math.cos(a) * rr, fy = g / 2 + Math.sin(a) * rr + ch;
      const puffs = [];
      for (let j = 0; j < 6; j++) {
        const pr = g * (0.025 + hash(i * 7 + j, 36, this.seed) * 0.03);
        puffs.push([fx + (hash(i * 7 + j, 37, this.seed) - 0.5) * g * 0.13, fy + (hash(i * 7 + j, 38, this.seed) - 0.5) * g * 0.04, pr]);
      }
      for (const [col, dx, dy, sc, al] of [[cl.dark, 0, 0.35, 1, 0.55], [cl.mid, 0, 0.1, 0.95, 0.85], [cl.light, -0.18, -0.22, 0.7, 0.9]]) {
        pcx.fillStyle = css(col, al);
        for (const [px0, py0, pr] of puffs) { pcx.beginPath(); pcx.ellipse(px0 + dx * pr, py0 + dy * pr, pr * sc, pr * sc * 0.62, 0, 0, Math.PI * 2); pcx.fill(); }
      }
    }
    x.save();
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.filter = `blur(${this.size * 0.014 * this.dpr}px)`;
    x.drawImage(pc, 0, 0);
    this.gridT(x);
    x.filter = `blur(${this.size * 0.012 * this.dpr}px)`;
    x.translate(0, ch * 1.4);
    x.lineWidth = g * 0.025;
    x.strokeStyle = css(fogc, 0.75);
    x.stroke(this.outerP);
    x.restore();
    // fade out toward the canvas edges (elliptical mask), so blurred fog never shows a hard edge
    x.save();
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.globalCompositeOperation = 'destination-in';
    x.translate(c.width / 2, c.height / 2);
    x.scale(1, c.height / c.width);
    const fadeR = c.width / 2, mask = x.createRadialGradient(0, 0, fadeR * 0.7, 0, 0, fadeR);
    mask.addColorStop(0, 'rgba(0,0,0,1)');
    mask.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = mask;
    x.fillRect(-fadeR, -fadeR, fadeR * 2, fadeR * 2);
    x.restore();
    this.under = c;
  }

  // ---------- layers ----------
  // static per map + size: under (fog, cliffs), base (ground, all borders, lip), rocks.
  // per segment sprites (cached small canvases): building ground scene, owner overlay, trees,
  // building top scene. the three composite layers below are rebuilt from sprites with a few
  // drawImage calls when buildings or owners change, so no frame ever re-renders the scenes.

  // small canvas covering segment id's box plus a margin (css px); draw(x) renders into it
  sprite(id, margin, draw) {
    const [bx0, by0, bx1, by1] = this.boxes[id], d = this.dpr;
    const left = Math.floor((this.sx(bx0) - margin) * d), top = Math.floor((this.sy(by0) - margin * 1.6) * d);
    const right = Math.ceil((this.sx(bx1 + 1) + margin) * d), bottom = Math.ceil((this.sy(by1 + 1) + margin * 0.6) * d);
    const c = document.createElement('canvas');
    c.width = Math.max(1, right - left);
    c.height = Math.max(1, bottom - top);
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    this.ofsX = left;
    this.ofsY = top;
    try { this.gridT(x); draw(x); } finally { this.ofsX = this.ofsY = 0; }
    return { c, left, top };
  }

  cached(key, make) {
    let s = this.sprites.get(key);
    if (!s) { s = make(); this.sprites.set(key, s); }
    return s;
  }

  // owner overlay: light fill, blurred inner glow, strong colour band at the edge
  overlaySprite(id, color, fill) {
    return this.cached(`o${id}|${color}|${fill}`, () => this.sprite(id, 2, (x) => {
      const p = this.segP[id], px = 1 / this.scale, bw = borderW * mapScale(this.map);
      const band = Math.max(2.2, this.size * 0.007) * px * bw, fade = 16 * this.k * bw;
      x.clip(p);
      x.fillStyle = css(color, fill);
      x.fill(p);
      x.filter = `blur(${fade * 0.45 * this.scale * this.dpr}px)`;
      x.strokeStyle = css(color, 0.55);
      x.lineWidth = fade * 1.3;
      x.stroke(p);
      x.filter = 'none';
      x.lineWidth = band * 2;
      x.strokeStyle = css(color, 0.9);
      x.stroke(p);
    }));
  }

  groundSprite(id, type) {
    return this.cached(`g${id}|${type}`, () => this.sprite(id, 2, (x) => structures.ground(this, x, id, type)));
  }

  // building scene + the tile's own terrain (trees, boulders, reeds) around it: objects inside
  // the building's clearings are left out, the rest is drawn behind / in front of the buildings
  topSprite(id, type, color, skin) {
    return this.cached(`t${id}|${type}|${color}|${skin}`, () => this.sprite(id, this.u * 7, (x) => {
      const keep = this.terrainKeep(id, type), split = this.spots(id, 1, 0)[0]?.[1] ?? this.sy(this.map.segs[id].y);
      this.drawTreesOf(x, id, (tr, px, py) => py <= split && keep(tr, px, py));
      structures.top(this, x, id, type, color, skin);
      this.drawTreesOf(x, id, (tr, px, py) => py > split && keep(tr, px, py));
    }));
  }

  // which terrain objects stay next to building type on tile id: clearings (ellipses, css px)
  // around the building spots; farms clear the scattered trees of open land (fields), on terrain
  // tiles only their field patch; forts clear a band along the wall
  terrainKeep(id, type) {
    const u = this.u, s = this.map.segs[id], holes = [];
    const add = (pts, rx, ry) => { for (const p of pts) holes.push([p[0], p[1], rx, ry]); };
    const main = this.spots(id, 1, 0);
    if (type === 'farm') {
      add(this.spots(id, 3, u * 6), u * 4, u * 2.6);
      if (s.trait) { const r = structures.fieldPatch(this, s); holes.push([this.sx(s.x), this.sy(s.y), r, r * this.tilt]); }   // field patch
    } else if (type === 'barracks') { add(this.spots(id, 3, u * 7), u * 4.5, u * 3); add(main, u * 7, u * 4.2); }
    else if (type === 'fort') add(main, u * 6.5, u * 4.2);
    else if (type === 'hospital') { add(this.spots(id, 3, u * 6), u * 4, u * 2.6); add(this.spots(id, 6, u * 4), u * 2.2, u * 1.6); }
    else if (type === 'lab') { add(this.spots(id, 3, u * 6), u * 4, u * 2.6); add(main, u * 6.5, u * 4); }
    else if (type === 'capital') { add(this.spots(id, 7, u * 3.2), u * 3.2, u * 2.2); add(main, u * 8, u * 4.8); }
    else if (type.startsWith('camp')) add(main, u * (4 + Number(type.slice(4)) * 1.3) * Math.max(0.62, this.map.detail ?? 1), u * 3.4);
    else if (type === 'home') add(main, u * 6.6, u * 3);   // house + fence + its own tree
    else add(main, u * 4.5, u * 2.8);   // relic
    const { bdist, grid: g } = this.map, wall = (u * 2.6) / this.scale;
    // buildings stand up from their spot: besides the ground clearing, a box over each building
    // keeps any tree, boulder or reed silhouette (b) from reaching into it (the field patch is flat)
    const tall = holes.slice(0, s.trait && type === 'farm' ? -1 : undefined).map(([hx, hy, rx, ry]) => [hx - rx * 0.75, hy - ry * 1.6, hx + rx * 0.75, hy + ry * 0.35]);
    return (tr, px, py, b) => {
      if (type === 'farm' && !tr.kind && !s.trait) return false;   // plain trees (no kind)
      if (type === 'fort' && bdist[Math.floor(tr.y) * g + Math.floor(tr.x)] < wall) return false;
      if (b && tall.some((h) => boxHit(b, h))) return false;
      return !holes.some(([hx, hy, rx, ry]) => ((px - hx) / rx) ** 2 + ((py - hy) / ry) ** 2 < 1);
    };
  }

  // trees (and boulders / reeds) of a segment; huts = a few small shacks (neutral tiles: people
  // live there). huts get a clearing (no object silhouette touches a hut) and are drawn in depth
  // order between the trees, so a tree behind a hut never pokes through it and none stands in front
  treeSprite(id, huts = false) {
    return this.cached(`r${id}|${huts ? 1 : 0}`, () => this.sprite(id, this.u * 4, (x) => {
      if (!huts) { this.drawTreesOf(x, id); return; }
      const list = this.hutList(id), free = (b) => !list.some((h) => boxHit(b, h.box));
      let prev = -Infinity;
      for (const h of list) {
        const lo = prev;
        this.drawTreesOf(x, id, (tr, px, py, b) => py > lo && py <= h.y && free(b));
        this.drawHut(x, h);
        prev = h.y;
      }
      this.drawTreesOf(x, id, (tr, px, py, b) => py > prev && free(b));
    }));
  }

  blit(x, sp) { x.drawImage(sp.c, sp.left, sp.top); }

  // pre-render sprites in small idle-time chunks (trees for every segment, overlays for every
  // faction colour), so a first capture or build never costs a frame
  prewarm(colors, fill) {
    const jobs = [];
    for (let id = 0; id < this.segP.length; id++) jobs.push(() => this.treeSprite(id, true), () => this.treeSprite(id));
    for (const col of colors) for (let id = 0; id < this.segP.length; id++) jobs.push(() => this.overlaySprite(id, col, fill));
    const map = this.map, size = this.size;
    const step = () => {
      if (this.map !== map || this.size !== size) return;   // map or size changed: stop
      const t0 = performance.now();
      while (jobs.length && performance.now() - t0 < 4) jobs.shift()();
      if (jobs.length) setTimeout(step, 16);
    };
    setTimeout(step, 50);
  }

  // static: ground texture, every segment border, light lip along the cliff edge
  buildBase() {
    const [c, x] = this.newLayer(), t = this.theme, g = this.map.grid, px = 1 / this.scale;
    x.save();
    x.clip(this.islandP, 'evenodd');
    x.imageSmoothingEnabled = true;
    x.drawImage(this.groundC, 0, 0, g, g);
    this.drawGroundDetail(x, px);
    x.lineJoin = 'round';
    x.lineWidth = Math.max(1, this.size * 0.0022) * px * borderW * mapScale(this.map);
    x.strokeStyle = css(t.lineNeutral, 0.45);
    for (const p of this.segP) x.stroke(p);
    x.lineWidth = Math.max(2, this.size * 0.006) * px;
    x.strokeStyle = css(t.lip, 0.7);
    x.stroke(this.islandP);
    x.restore();
    this.base = c;
  }

  // small ground details, crisp at display resolution: grass tufts, flowers, pebbles, ferns on
  // forest floors, stones on highland, dry tufts in the desert, snow-dusted tufts in winter.
  // spacing is in css px, so the density on screen is the same at any map size; same-coloured
  // details are batched into one path each (a few strokes/fills for thousands of details)
  drawGroundDetail(x, px) {
    const { ids, bdist, grid: g, segs } = this.map, k = this.k, ms = mapScale(this.map);
    if (!bdist) return;
    const step = (8.5 * ms) / this.scale;                 // grid units between detail slots (~8.5 css px)
    const L = Math.max(1.6, this.size / 520) * ms * px;   // tuft blade length (grid units)
    const batches = new Map();                             // 'stroke|rgba' / 'fill|rgba' -> Path2D
    const path = (kind, col, a) => {
      const key = `${kind}|${css(col, a)}`;
      if (!batches.has(key)) batches.set(key, new Path2D());
      return batches.get(key);
    };
    // ellipse as its own closed subpath in a batch path
    const dot = (pth, cx, cy, rx, ry) => { pth.moveTo(cx + rx, cy); pth.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); };
    let i = 0;
    for (let gy = step / 2; gy < g; gy += step) {
      for (let gx = step / 2; gx < g; gx += step) {
        i++;
        const xx = gx + (hash(i, 50, this.seed) - 0.5) * step, yy = gy + (hash(i, 51, this.seed) - 0.5) * step;
        const c = Math.floor(yy) * g + Math.floor(xx);
        if (xx < 0 || yy < 0 || xx >= g || yy >= g || ids[c] < 0 || bdist[c] < 2.5 * k) continue;
        const sg = segs[ids[c]];
        if (Math.hypot(sg.x - xx, sg.y - yy) < 20 * k) continue;   // keep the number label clear
        const tc = this.segTheme ? this.segTheme[ids[c]] : this.theme;
        const r = hash(i, 52, this.seed), sz = 0.7 + hash(i, 53, this.seed) * 0.6;
        const winter = tc === themes.winter, desert = tc === themes.desert, tr = sg.trait;
        // what goes in this slot (most slots stay empty, so the ground still reads calm)
        const pTuft = tr === 'forest' ? 0.42 : tr === 'highland' ? 0.12 : desert ? 0.1 : 0.3;
        const pFlower = winter || desert || tr === 'highland' ? 0 : tr === 'forest' ? 0.03 : 0.09;
        const pStone = tr === 'highland' ? 0.3 : desert ? 0.1 : 0.04;
        if (r < pTuft) {
          // tuft: 3 blades fanning up from one point, two dark + one light
          const dark = tr === 'forest' ? shade(tc.treeDark, 0.05) : desert ? [168, 146, 92] : shade(tc.groundA, winter ? -0.18 : -0.3);
          const light = winter ? [255, 255, 255] : shade(tc.groundB, 0.22);
          const pd = path('stroke', dark, winter ? 0.45 : 0.55), pl = path('stroke', light, 0.45);
          const len = L * sz * (tr === 'forest' ? 1.35 : 1);
          for (const [dx, lean, pp] of [[-0.35, -0.55, pd], [0, 0, pd], [0.35, 0.55, pl]]) {
            pp.moveTo(xx + dx * len * 0.4, yy);
            pp.quadraticCurveTo(xx + dx * len * 0.5, yy - len * 0.6, xx + (dx + lean) * len * 0.6, yy - len * 1.15);
          }
        } else if (r < pTuft + pFlower) {
          // flower: tiny coloured dot with a light centre
          const pal = tc === themes.autumn ? [[255, 206, 92], [236, 120, 70], [250, 240, 220]] : [[255, 255, 255], [255, 222, 96], [240, 146, 178], [190, 160, 240]];
          const col = pal[Math.floor(hash(i, 54, this.seed) * pal.length)], rr = L * 0.45 * sz;
          dot(path('fill', col, 0.95), xx, yy, rr, rr * 0.8);
          dot(path('fill', [255, 250, 220], 0.9), xx, yy, rr * 0.38, rr * 0.3);
        } else if (r < pTuft + pFlower + pStone) {
          // pebble: grey ellipse with a light top
          const rr = L * (0.35 + 0.35 * sz) * (tr === 'highland' ? 1.3 : 1);
          dot(path('fill', shade(tc.scree, -0.2), 0.75), xx, yy, rr, rr * 0.62);
          dot(path('fill', shade(tc.rockLight, 0.25), 0.8), xx - rr * 0.15, yy - rr * 0.18, rr * 0.6, rr * 0.34);
        }
      }
    }
    x.save();
    x.lineCap = 'round';
    x.lineWidth = Math.max(0.8, this.size / 1400) * ms * px;
    for (const [key, pth] of batches) {
      const [kind, col] = key.split('|');
      if (kind === 'stroke') { x.strokeStyle = col; x.stroke(pth); } else { x.fillStyle = col; x.fill(pth); }
    }
    x.restore();
  }

  // ambient life, drawn every frame between the map and the troops (ctx in css px): sparkles that
  // wink on lakes and rivers, and soft cloud shadows drifting slowly across the island
  drawAmbient(ctx, time) {
    const ch = Math.max(4, this.size * 0.022);   // lakes sit lower than the ground (cliff height)
    ctx.save();
    for (const gl of this.glints ?? []) {
      const a = Math.max(0, Math.sin(time * gl.w + gl.ph)) ** 6;
      if (a < 0.03) continue;
      const x = this.sx(gl.x), y = this.sy(gl.y) + (gl.lake ? ch : 0), r = Math.max(2, this.size * 0.0042) * (gl.lake ? 1 : 0.7);
      ctx.fillStyle = `rgba(255,255,255,${0.85 * a})`;
      ctx.beginPath(); ctx.ellipse(x, y, r * 1.8, r * 0.4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(x, y, r * 0.35, r * 0.9 * a, 0, 0, Math.PI * 2); ctx.fill();
    }
    // cloud shadows: one cached soft blob, three copies drifting left to right on loops
    if (!shadowBlob) {
      shadowBlob = document.createElement('canvas');
      shadowBlob.width = shadowBlob.height = 128;
      const b = shadowBlob.getContext('2d'), gr = b.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, 'rgba(20,34,44,1)'); gr.addColorStop(0.55, 'rgba(20,34,44,0.6)'); gr.addColorStop(1, 'rgba(20,34,44,0)');
      b.fillStyle = gr; b.fillRect(0, 0, 128, 128);
    }
    const w = this.size, h = this.cssH;
    ctx.globalAlpha = 0.085;
    for (let n = 0; n < 3; n++) {
      const span = w * 1.6, sw = w * (0.32 + 0.1 * n);
      const cx = ((time * w * 0.006 * (1 + n * 0.3) + (n * span) / 3) % span) - w * 0.3;
      const cy = h * (0.3 + 0.22 * n);
      ctx.drawImage(shadowBlob, cx - sw / 2, cy - sw * 0.3, sw, sw * 0.6);
    }
    ctx.restore();
  }

  // rivers (visual only): smoothed polylines, drawn in pieces so they widen toward the mouth
  drawRivers(x, px) {
    // same water as the lakes: lake colour, foam rim along the banks, light ripple in the middle
    const t = this.theme, water = shade(hexToRgb(t.sea), -0.08), dt = this.map.detail ?? 1;
    x.lineCap = 'round';
    x.lineJoin = 'round';
    for (const raw of this.map.rivers ?? []) {
      const pts = raw;   // already smooth and dense (mapgen smoothCourse)
      const pieces = 6, len = pts.length;
      for (const [col, extra, alpha, thin] of [[t.shore, 5, 0.6, 1], [t.foam, 2.6, 0.95, 1], [water, 0, 1, 1], [t.seaLight, 0, 0.6, 0.3]]) {
        x.strokeStyle = css(col, alpha);
        for (let k = 0; k < pieces; k++) {
          const a = Math.floor((k / pieces) * len), b = Math.min(len - 1, Math.floor(((k + 1) / pieces) * len) + 1);
          if (b - a < 2) continue;
          x.lineWidth = ((3.4 + 6.5 * ((k + 1) / pieces)) * (0.65 + 0.35 * dt) * thin + extra) * Math.max(1, this.size / 700) * px;
          x.beginPath();
          x.moveTo(pts[a][0], pts[a][1]);
          for (let i = a + 1; i <= b; i++) x.lineTo(pts[i][0], pts[i][1]);
          x.stroke();
        }
      }
    }
  }

  // static: rock plateaus
  buildRocks() {
    const [c, x] = this.newLayer();
    this.drawRocks(x, 1 / this.scale);
    this.rocks = c;
  }

  // composite 1: base + flat building scenes
  buildGroundLayer() {
    if (!this.base) this.buildBase();
    const [c, x] = this.newLayer();
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.drawImage(this.base, 0, 0);
    this.st.forEach((s, id) => { if (s.building) this.blit(x, this.groundSprite(id, s.building)); });
    // rivers above the building ground (farm fields never hide them), then the inner terrain
    // border of every trait tile: a band in the terrain's colour just inside the edge, so the tile
    // type stays readable under any building (dashed; the owner's solid colour band sits outside it)
    this.gridT(x);
    const px = 1 / this.scale;
    x.save();
    x.clip(this.islandP, 'evenodd');
    this.drawRivers(x, px);
    x.restore();
    const bw = borderW * mapScale(this.map);
    const band = Math.max(2.2, this.size * 0.007) * px * bw, inner = Math.max(2, this.size * 0.0055) * px * bw;
    const traitCol = { forest: [46, 104, 58], highland: [118, 114, 108], river: [58, 140, 200], lakeside: [226, 196, 120] };
    x.lineJoin = 'round';
    this.map.segs.forEach((s, id) => {
      const col = traitCol[s.trait];
      if (!col) return;
      x.save();
      x.clip(this.segP[id]);
      // dashed, so it never reads as an owner's (solid) border
      x.lineWidth = (band + inner) * 2;
      x.setLineDash([7 * px * bw, 4 * px * bw]);
      x.strokeStyle = css(col, 0.85);
      x.stroke(this.segP[id]);
      x.restore();
    });
    this.layerGround = c;
  }

  // composite 2: owner overlays
  buildOwnerLayer() {
    const [c, x] = this.newLayer();
    x.setTransform(1, 0, 0, 1, 0, 0);
    this.st.forEach((s, id) => { if (s.color) this.blit(x, this.overlaySprite(id, s.color, s.fill)); });
    this.layerOwner = c;
  }

  // composite 3: rocks, then trees or building scenes per segment, back to front
  buildObjectLayer() {
    if (!this.rocks) this.buildRocks();
    const [c, x] = this.newLayer();
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.drawImage(this.rocks, 0, 0);
    const order = this.map.segs.map((s) => s.id).sort((a, b) => this.map.segs[a].y - this.map.segs[b].y);
    for (const id of order) {
      const s = this.st[id];
      this.blit(x, s.building ? this.topSprite(id, s.building, s.color, s.skin) : this.treeSprite(id, s.huts));
    }
    this.layerObjects = c;
  }

  // mountains as flat low-poly rock plateaus: soft contact shadow, stacked slate side walls,
  // a light top face with a gentle gradient, dark cracks and outline
  drawRocks(x, px) {
    const t = this.theme, g = this.map.grid, hgt = (Math.max(4, this.size * 0.03) * px) / this.tilt;
    x.save();
    x.filter = `blur(${Math.max(1, this.size * 0.006) * this.dpr}px)`;
    x.fillStyle = 'rgba(25,30,35,0.3)';
    x.translate(hgt * 0.3, hgt * 0.15);
    x.fill(this.mtnP);
    x.restore();
    for (let i = 0; i <= hgt; i += (px * 0.5) / this.tilt) {
      x.save();
      x.translate(0, -i);
      x.fillStyle = css(i < hgt * 0.55 ? t.rockSideDark : t.rockSide);
      x.fill(this.mtnP);
      x.restore();
    }
    x.save();
    x.translate(0, -hgt);
    const grad = x.createLinearGradient(0, 0, g, g);
    grad.addColorStop(0, css(shade(t.rockTop, 0.06)));
    grad.addColorStop(1, css(shade(t.rockTop, -0.1)));
    x.fillStyle = grad;
    x.fill(this.mtnP);
    x.save();
    x.clip(this.mtnP);
    x.lineCap = 'round';
    x.lineJoin = 'round';
    x.strokeStyle = css(t.rockSideDark, 0.9);
    x.lineWidth = Math.max(1.2, this.size * 0.003) * px;
    for (const line of this.cracks) {
      x.beginPath();
      x.moveTo(line[0][0], line[0][1]);
      for (let i = 1; i < line.length; i++) x.lineTo(line[i][0], line[i][1]);
      x.stroke();
    }
    x.restore();
    x.lineJoin = 'round';
    x.lineWidth = Math.max(1, this.size * 0.0025) * px;
    x.strokeStyle = css(t.rockSideDark, 0.85);
    x.stroke(this.mtnP);
    x.restore();
  }

  // trees of one segment: round crowns or low-poly pines with trunk and shadow
  // keep(tree, px, py) -> false skips an object (building tiles leave their clearings empty)
  drawTreesOf(x, id, keep = null) {
    const t = this.segTheme ? this.segTheme[id] : this.theme, sc = this.scale;
    x.save();
    this.cssT(x);
    for (const tr of this.trees) {
      if (tr.seg !== id) continue;
      const px = this.sx(tr.x), py = this.sy(tr.y), r = Math.max(1.6, tr.r * sc);
      if (keep && !keep(tr, px, py, this.objBox(tr, px, py, r, t.tree === 'pine'))) continue;
      if (tr.kind === 'rock') {
        // low-poly boulder: lit top-left face, shaded right face, small shadow
        const w = r * (1 + tr.a * 0.5), h = r * 0.9;
        x.fillStyle = 'rgba(20,30,30,0.2)';
        x.beginPath(); x.ellipse(px + w * 0.25, py + h * 0.1, w * 1.05, h * 0.38, 0, 0, Math.PI * 2); x.fill();
        x.fillStyle = css(t.rockLight);
        x.beginPath(); x.moveTo(px - w, py); x.lineTo(px - w * 0.55, py - h); x.lineTo(px + w * (0.1 + tr.a * 0.3), py - h * 1.15); x.lineTo(px + w * 0.2, py); x.fill();
        x.fillStyle = css(t.rockDark);
        x.beginPath(); x.moveTo(px + w * 0.2, py); x.lineTo(px + w * (0.1 + tr.a * 0.3), py - h * 1.15); x.lineTo(px + w * 0.75, py - h * 0.55); x.lineTo(px + w * 0.9, py); x.fill();
        continue;
      }
      if (tr.kind === 'reed') {
        // reed clump: a few thin blades with dark seed heads
        x.lineCap = 'round';
        x.lineWidth = Math.max(0.6, r * 0.16);
        for (let j = -2; j <= 2; j++) {
          const tx = px + j * r * 0.44, ty = py - r * (1.3 + ((j + 3) % 3) * 0.3);
          x.strokeStyle = css(j % 2 ? t.treeLight : mix(t.treeLight, t.shore, 0.35));
          x.beginPath(); x.moveTo(px + j * r * 0.18, py); x.lineTo(tx, ty); x.stroke();
          if (j % 2 === 0) { x.fillStyle = css([110, 84, 58]); x.fillRect(tx - r * 0.1, ty - r * 0.15, r * 0.2, r * 0.45); }
        }
        continue;
      }
      x.fillStyle = 'rgba(20,30,30,0.22)';
      x.beginPath(); x.ellipse(px + r * 0.45, py + r * 0.3, r * 1.05, r * 0.5, 0, 0, Math.PI * 2); x.fill();
      const tw = Math.max(1, r * 0.28);
      x.fillStyle = css(t.trunk ?? [96, 72, 54]);
      x.fillRect(px - tw / 2, py - r * 0.6, tw, r * 0.95);
      if (t.tree === 'pine') {
        const top = py - r * 2.7, base = py - r * 0.05, hw = r * 0.95;
        x.fillStyle = css(t.treeLight);
        x.beginPath(); x.moveTo(px, top); x.lineTo(px - hw, base); x.lineTo(px, base); x.fill();
        x.fillStyle = css(t.treeDark);
        x.beginPath(); x.moveTo(px, top); x.lineTo(px + hw, base); x.lineTo(px, base); x.fill();
        if (t.treeSnow) {
          x.fillStyle = css(t.treeSnow);
          x.beginPath(); x.moveTo(px, top); x.lineTo(px - hw * 0.4, top + r); x.lineTo(px + hw * 0.4, top + r); x.fill();
        }
      } else {
        x.fillStyle = css(t.treeDark);
        x.beginPath(); x.arc(px, py - r * 1.1, r, 0, Math.PI * 2); x.fill();
        x.fillStyle = css(t.treeLight);
        x.beginPath(); x.arc(px - r * 0.3, py - r * 1.45, r * 0.55, 0, Math.PI * 2); x.fill();
      }
    }
    x.restore();
  }

  // on-screen box [x0, y0, x1, y1] (css px) of a terrain object drawn at base px, py, size r
  objBox(tr, px, py, r, pine) {
    if (tr.kind === 'rock') { const w = r * (1 + tr.a * 0.5); return [px - w, py - r * 1.05, px + w, py + r * 0.2]; }
    if (tr.kind === 'reed') return [px - r * 1.1, py - r * 1.9, px + r * 1.1, py];
    return [px - r, py - r * (pine ? 2.7 : 2.1), px + r, py + r * 0.3];
  }

  // 1-3 small shacks (more on bigger tiles), back to front: base spot, size, facing and the box
  // (roof, walls and a little margin, css px) that terrain objects must stay out of
  hutList(id) {
    const s = this.map.segs[id], n = 1 + (s.area > this.map.avgArea ? 1 : 0) + (s.area > this.map.avgArea * 1.6 ? 1 : 0);
    const u = this.u * Math.max(0.6, this.map.detail ?? 1) * 0.95, pad = u * 0.35;
    const spots = this.spots(id, n, this.u * 3.5).slice().sort((a, b) => a[1] - b[1]);
    return spots.map(([px, py], i) => ({
      x: px, y: py, u, flip: hash(id, i + 40, this.seed) < 0.5 ? -1 : 1,
      box: [px - u * 1.3 - pad, py - u * 2.5 - pad, px + u * 1.3 + pad, py + u * 0.5],
    }));
  }

  // one shack: plank walls, straw roof, a wisp of chimney smoke
  drawHut(x, { x: px, y: py, u, flip }) {
    const snow = this.theme.groundA[0] > 215;
    x.save();
    this.cssT(x);
    {
      const w = u * 2, h = u * 1.2;
      x.fillStyle = 'rgba(20,30,30,0.22)';
      x.beginPath(); x.ellipse(px + u * 0.4, py + u * 0.1, w * 0.75, u * 0.45, 0, 0, Math.PI * 2); x.fill();
      x.fillStyle = css([150, 112, 76]);
      x.fillRect(px - w / 2, py - h, w, h);
      x.fillStyle = css([118, 86, 58]);
      x.fillRect(px + (flip > 0 ? w * 0.15 : -w / 2), py - h, w * 0.35, h);
      x.fillStyle = css([70, 50, 36]);
      x.fillRect(px - u * 0.22, py - h * 0.65, u * 0.44, h * 0.65);   // door
      // straw roof (snow-capped in winter)
      x.fillStyle = css(snow ? [240, 242, 244] : [214, 178, 104]);
      x.beginPath(); x.moveTo(px - w / 2 - u * 0.3, py - h); x.lineTo(px, py - h - u * 1.3); x.lineTo(px + w / 2 + u * 0.3, py - h); x.fill();
      x.fillStyle = css(snow ? [206, 212, 218] : [176, 140, 76]);
      x.beginPath(); x.moveTo(px, py - h - u * 1.3); x.lineTo(px + flip * (w / 2 + u * 0.3), py - h); x.lineTo(px + flip * u * 0.2, py - h); x.fill();
      x.fillStyle = 'rgba(235,238,240,0.55)';
      x.beginPath(); x.arc(px - flip * u * 0.5, py - h - u * 1.6, u * 0.35, 0, Math.PI * 2); x.arc(px - flip * u * 0.2, py - h - u * 2.2, u * 0.45, 0, Math.PI * 2); x.fill();
    }
    x.restore();
  }

  // n building spots (css px) inside a segment: deep inside, away from the number label and not
  // just below it (buildings stand upward), at least sep css px apart
  spots(id, n, sep) {
    const key = `${id}:${n}:${Math.round(sep)}`;
    if (this.spotCache.has(key)) return this.spotCache.get(key);
    const { bdist, grid: g, segs } = this.map, s = segs[id], sc = this.scale, u = this.u / sc;
    const cand = [];
    const cells = this.segCells[id];
    for (let i = 0; i < cells.length; i += 2) {
      const c = cells[i], x = (c % g) + 0.5, y = Math.floor(c / g) + 0.5, dx = x - s.x, dy = (y - s.y) * this.tilt;
      if (Math.hypot(dx, dy) < u * 4.5 || (Math.abs(dx) < u * 4 && dy > 0 && dy < u * 7)) continue;
      cand.push([Math.min(bdist[c], 40 * this.k) + hash(c, 7, this.seed) * 3, x, y]);
    }
    cand.sort((a, b) => b[0] - a[0]);
    const out = [];
    const take = (list, gap) => {
      for (const [, x, y] of list) {
        if (out.length >= n) break;
        if (out.every((p) => Math.hypot(this.sx(p[0]) - this.sx(x), this.sy(p[1]) - this.sy(y)) >= gap)) out.push([x, y]);
      }
    };
    take(cand, sep);
    // small segment: relax (closer together, label area allowed) so there is always at least one spot
    if (out.length < n) {
      take(cells.map((c) => [bdist[c], (c % g) + 0.5, Math.floor(c / g) + 0.5]).sort((a, b) => b[0] - a[0]), sep * 0.4);
    }
    const res = out.map((p) => [this.sx(p[0]), this.sy(p[1])]);
    this.spotCache.set(key, res);
    return res;
  }

  // spots along the inside of a segment's border (fort towers), sep css px apart
  edgeSpots(id, sep) {
    const key = `e${id}:${Math.round(sep)}`;
    if (this.spotCache.has(key)) return this.spotCache.get(key);
    const { bdist, grid: g, segs } = this.map, s = segs[id], ring = Math.round(2 * this.k + 1);
    const out = [], clear = this.u * 4;
    for (const c of this.segCells[id]) {
      if (bdist[c] !== ring) continue;
      const x = this.sx((c % g) + 0.5), y = this.sy(Math.floor(c / g) + 0.5);
      if (Math.hypot(x - this.sx(s.x), y - this.sy(s.y)) < clear) continue;
      if (out.every((p) => Math.hypot(p[0] - x, p[1] - y) >= sep)) out.push([x, y]);
    }
    this.spotCache.set(key, out);
    return out;
  }

  // garrison figure positions (css px) inside a segment: clustered around the number label,
  // keeping the label itself clear and staying off the border; sp = spacing in css px
  troopSpots(id, sp) {
    const key = `u${id}:${sp.toFixed(1)}`;
    if (this.spotCache.has(key)) return this.spotCache.get(key);
    const { bdist, grid: g, segs } = this.map, s = segs[id], lx = this.sx(s.x), ly = this.sy(s.y);
    const cand = [];
    for (const c of this.segCells[id]) {
      if (bdist[c] < 3 * this.k || c % 2) continue;
      const x = this.sx((c % g) + 0.5), y = this.sy(Math.floor(c / g) + 0.5);
      // keep the number badge clear: figures stand upward from their spot, so the zone reaches further down
      if (Math.abs(x - lx) < sp * 3.4 && y - ly > -sp * 1.3 && y - ly < sp * 3.4) continue;
      cand.push([Math.hypot(x - lx, (y - ly) * 1.4) + hash(c, 9, this.seed) * sp * 0.6, x, y]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const [, x, y] of cand) {
      if (out.length >= 60) break;
      if (out.every((p) => Math.abs(p[0] - x) >= sp || Math.abs(p[1] - y) >= sp * 0.8)) out.push([x, y]);
    }
    this.spotCache.set(key, out);
    return out;
  }

  // selected segment: thick white outline with a soft pulsing glow plus the owner colour inside;
  // targets: moving dashed white outlines. drawn every frame on top of the cached layers
  highlight(ctx, id, color, targets, time, targetsOnly = false) {
    const px = 1 / this.scale, pulse = 0.5 + 0.5 * Math.sin(time * 4);
    ctx.save();
    this.gridT(ctx);
    ctx.lineJoin = 'round';
    ctx.setLineDash([5 * px, 4 * px]);
    ctx.lineDashOffset = -time * 12 * px;
    ctx.lineWidth = 1.8 * px;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    for (const t of targets) ctx.stroke(this.segP[t]);
    ctx.setLineDash([]);
    if (targetsOnly) { ctx.restore(); return; }
    // dim every other tile (neighbours you can send to a little less), so the selection pops:
    // island + selected + targets as one evenodd path = the island with those tiles cut out
    const dim = new Path2D();
    dim.addPath(this.islandP);
    dim.addPath(this.segP[id]);
    for (const t of targets) dim.addPath(this.segP[t]);
    ctx.fillStyle = 'rgba(14,24,30,0.24)';
    ctx.fill(dim, 'evenodd');
    ctx.fillStyle = 'rgba(14,24,30,0.08)';
    for (const t of targets) ctx.fill(this.segP[t]);
    // thick selected outline: pulsing glow, white band, owner colour core
    ctx.lineWidth = (12 + 5 * pulse) * px;
    ctx.strokeStyle = `rgba(255,255,255,${0.3 + 0.2 * pulse})`;
    ctx.stroke(this.segP[id]);
    ctx.lineWidth = 7 * px;
    ctx.strokeStyle = '#fff';
    ctx.stroke(this.segP[id]);
    ctx.lineWidth = 3.6 * px;
    ctx.strokeStyle = css(color);
    ctx.stroke(this.segP[id]);
    ctx.restore();
  }

  // mouse hover: the tile under the cursor lights up (soft white wash + outline). strong = the
  // tile a drag would send troops to: brighter wash and an outline in the given colour
  hoverTile(ctx, id, color, strong = false) {
    const px = 1 / this.scale;
    ctx.save();
    this.gridT(ctx);
    ctx.lineJoin = 'round';
    ctx.fillStyle = `rgba(255,255,255,${strong ? 0.24 : 0.17})`;
    ctx.fill(this.segP[id]);
    ctx.lineWidth = (strong ? 6 : 4.5) * px;
    ctx.strokeStyle = `rgba(255,255,255,${strong ? 0.95 : 0.8})`;
    ctx.stroke(this.segP[id]);
    if (strong) { ctx.lineWidth = 2.6 * px; ctx.strokeStyle = css(color); ctx.stroke(this.segP[id]); }
    ctx.restore();
  }

  // styleOf(segId) -> { color: [r,g,b] | null, fill: 0..1, building?: type }
  // only the layers whose inputs changed are rebuilt on the next draw
  paint(styleOf) {
    this.styleOf = styleOf;
    this.st = this.map.segs.map((s) => styleOf(s.id));
    const bkey = this.st.map((s) => (s.building ? s.building + (s.color ?? '') + (s.skin ?? '') : s.huts ? 'h' : '')).join('|');
    const okey = this.st.map((s) => (s.color ? s.color.join(',') + ':' + s.fill : '')).join('|');
    if (bkey !== this.bkey) { this.bkey = bkey; this.layerGround = this.layerObjects = null; }
    if (okey !== this.okey) { this.okey = okey; this.layerOwner = null; }
  }

  // clear and draw all layers; returns ctx in css-pixel units
  drawBase() {
    if (!this.under) this.buildUnder();
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.groundOnly && this.cliffs ? this.cliffs : this.under, 0, 0);   // groundOnly: no fog
    if (this.st) {
      if (!this.layerGround) this.buildGroundLayer();
      if (!this.layerOwner) this.buildOwnerLayer();
      if (!this.layerObjects) this.buildObjectLayer();
      ctx.drawImage(this.layerGround, 0, 0);
      ctx.drawImage(this.layerOwner, 0, 0);
      ctx.drawImage(this.layerObjects, 0, 0);
    }
    this.cssT(ctx);
    return ctx;
  }

  // segment under a screen point (-1 for sea)
  segAt(clientX, clientY) {
    // screen -> canvas css px (undoing any zoom transform), then -> grid
    const r = pageRect(this.canvas), p = pagePoint(clientX, clientY);
    const g = this.map.grid;
    const x = Math.floor(((p.x - r.left) * this.size) / r.width / this.scale);
    const y = Math.floor((((p.y - r.top) * this.cssH) / r.height - this.oy) / (this.scale * this.tilt));
    if (x < 0 || y < 0 || x >= g || y >= g) return -1;
    const id = this.map.ids[y * g + x];
    if (id >= 0) return id;
    // tapped just off the coast: take the nearest segment label within reach
    let best = -1, bd = (g * 0.06) ** 2;
    for (const s of this.map.segs) {
      const dd = (s.x - x) ** 2 + (s.y - y) ** 2;
      if (dd < bd) { bd = dd; best = s.id; }
    }
    return best;
  }
}

// troop figures, drawn from small cached sprites (fast enough for hundreds per frame).
// soldier = body + head; battalion = 2 x 3 tiny soldiers with a banner (zoomed-out maps)
const unitCache = new Map();
// one foglet (the troop figure), feet at (mx, my), sc = size (1 = the 5 x 8 map figure); also drawn
// big on the menu. body block in the team colour with a shaded side, square head, then a kit that
// changes the whole silhouette:
//   soldier: kettle helmet, belt, spear · knight: steel breastplate with a team stripe, plumed helm,
//   shield · viking: horned helmet, big beard, fur collar, round shield · archer: green hood and
//   cape, quiver, bow · wizard: long flared robe with gold hem, pointed hat with a star, white beard,
//   staff · pirate: striped shirt, eyepatch, tricorne, cutlass · barbarian: bare chest, fur kilt in
//   the team colour, fur hood with ears, big club
export function drawFoglet(x, mx, my, sc, col, style = 'soldier') {
  const body = css(col), side = css(shade(col, -0.3)), light = css(shade(col, 0.3)), skin = 'rgb(236,206,176)';
  const R = (l, t, w, h, c) => { x.fillStyle = c; x.fillRect(mx + l * sc, my + t * sc, w * sc, h * sc); };
  const poly = (c, pts) => { x.fillStyle = c; x.beginPath(); pts.forEach(([px, py], i) => (i ? x.lineTo : x.moveTo).call(x, mx + px * sc, my + py * sc)); x.fill(); };
  const disc = (c, px, py, r) => { x.fillStyle = c; x.beginPath(); x.arc(mx + px * sc, my + py * sc, r * sc, 0, Math.PI * 2); x.fill(); };
  const line = (c, w, pts) => { x.strokeStyle = c; x.lineWidth = w * sc; x.beginPath(); pts.forEach(([px, py], i) => (i ? x.lineTo : x.moveTo).call(x, mx + px * sc, my + py * sc)); x.stroke(); };
  const steel = '#c4ccd4', steelDark = '#8e98a2', wood = '#7a5230';
  // behind the body: capes, quivers, staffs
  if (style === 'archer') {
    poly('#2f6a35', [[-1.5, -4.1], [1.5, -4.1], [1.9, -0.2], [-1.9, -0.2]]);   // cape
    R(-1.9, -5.6, 0.7, 2.6, '#8a5a34'); line('#f2ead8', 0.18, [[-1.75, -5.6], [-1.75, -6.3]]); line('#f2ead8', 0.18, [[-1.4, -5.6], [-1.3, -6.4]]);
  }
  if (style === 'wizard') { line(wood, 0.32, [[-1.95, -0.2], [-1.95, -5.9]]); disc('#9fe6ff', -1.95, -6.2, 0.5); disc('rgba(255,255,255,0.85)', -2.05, -6.32, 0.17); }
  // body
  if (style === 'wizard') {
    poly(body, [[-1.2, -4.1], [1.2, -4.1], [1.8, 0], [-1.8, 0]]);   // flared robe
    poly(side, [[0.25, -4.1], [1.2, -4.1], [1.8, 0], [0.45, 0]]);
    R(-1.8, -0.45, 3.6, 0.45, '#ffd76a');
  } else if (style === 'barbarian') {
    R(-1.3, -4, 2.6, 2, skin); R(0.2, -4, 1.1, 2, 'rgb(212,180,150)');   // bare chest
    line('#6e4a2c', 0.3, [[-1.2, -3.9], [1.2, -2.2]]);   // strap
    R(-1.3, -2, 2.6, 2, body); R(0.2, -2, 1.1, 2, side);   // fur kilt
    for (let i = 0; i < 4; i++) poly(side, [[-1.3 + i * 0.65, -0.05], [-1 + i * 0.65, 0.35], [-0.65 + i * 0.65, -0.05]]);
  } else {
    R(-1.3, -4, 2.6, 4, body); R(0.2, -4, 1.1, 4, side);
  }
  if (style === 'pirate') for (const y of [-3.4, -2.4, -1.4]) R(-1.3, y, 2.6, 0.45, 'rgba(255,255,255,0.85)');
  if (style === 'soldier' || style === 'pirate') R(-1.3, -2, 2.6, 0.4, '#5e3b20');   // belt
  if (style === 'knight') { R(-1.3, -4, 2.6, 2.3, steel); R(0.2, -4, 1.1, 2.3, steelDark); R(-0.3, -4, 0.6, 4, light); }
  if (style === 'viking') R(-1.45, -4.1, 2.9, 0.7, '#8a6a48');   // fur collar
  // head: square with a slightly rounded look (map scale reads as a block)
  R(-1.15, -6.15, 2.3, 2.25, skin);
  R(0.45, -6.15, 0.7, 2.25, 'rgba(180,140,110,0.35)');
  // headgear + face kit
  if (style === 'soldier') {
    line(wood, 0.35, [[1.8, -0.4], [1.8, -6.4]]);
    poly(steel, [[1.8, -7.15], [1.4, -6.25], [2.2, -6.25]]);
    x.fillStyle = '#9aa4ae'; x.beginPath(); x.ellipse(mx, my - 6.05 * sc, 1.75 * sc, 0.35 * sc, 0, 0, Math.PI * 2); x.fill();
    R(-0.95, -6.95, 1.9, 0.9, '#9aa4ae');
  } else if (style === 'knight') {
    R(-1.3, -6.5, 2.6, 1.15, steel); R(0.3, -6.5, 1, 1.15, steelDark);   // helm over the brow
    R(-0.12, -5.5, 0.24, 0.8, steelDark);   // nose guard
    poly(body, [[-0.3, -6.5], [0.3, -6.5], [1.1, -7.2], [-0.5, -7.2]]);   // plume
    R(-2.3, -3.8, 1.3, 2.6, side); R(-2.3, -3.8, 1.3, 0.35, steel); R(-1.8, -3.5, 0.3, 1.9, '#f2f2f2');   // shield
  } else if (style === 'viking') {
    R(-1.25, -6.55, 2.5, 0.85, '#8a9096');
    line('#f4ead2', 0.5, [[-1.1, -6.3], [-1.9, -7.1]]); line('#f4ead2', 0.5, [[1.1, -6.3], [1.9, -7.1]]);
    poly('#c8782e', [[-1.15, -4.8], [1.15, -4.8], [0.9, -3.4], [0, -2.9], [-0.9, -3.4]]);   // beard
    disc('#8a5a34', -1.55, -2.3, 1.2); disc(body, -1.55, -2.3, 0.75); disc('#d8dde2', -1.55, -2.3, 0.25);
  } else if (style === 'archer') {
    poly('#3f7a3c', [[-1.35, -4.4], [-1.35, -6.4], [-0.6, -7.2], [1.35, -6.4], [1.35, -5.6], [-0.4, -5.9], [-0.7, -4.4]]);   // hood
    line(wood, 0.4, [[1.4, -6.1], [2.2, -4.6], [2.2, -2.2], [1.4, -0.9]]);   // bow
    line('rgba(240,235,220,0.9)', 0.15, [[1.4, -6.1], [1.4, -0.9]]);
  } else if (style === 'wizard') {
    poly('#f4f4f6', [[-0.9, -4.6], [0.95, -4.6], [0.7, -3], [0, -2.4], [-0.6, -3]]);   // beard
    poly(side, [[-1.7, -6], [1.7, -6], [0.7, -7.2]]);   // hat
    R(-1.7, -6.15, 3.4, 0.35, side);
    disc('#ffd76a', 0.35, -6.55, 0.25);
  } else if (style === 'pirate') {
    R(-1.15, -5.65, 2.3, 0.22, '#1d1d22'); R(0.25, -5.6, 0.6, 0.5, '#1d1d22');   // eyepatch
    poly('#2a2a30', [[-1.9, -6.0], [0, -7.25], [1.9, -6.0], [0, -6.45]]);   // tricorne
    disc('#f2f2f2', 0, -6.75, 0.22);
    line('#d4dbe2', 0.38, [[1.3, -1.8], [2.3, -3.2], [2.1, -5.2]]); R(1.05, -2, 0.6, 0.35, '#c9a23a');   // cutlass + guard
  } else if (style === 'barbarian') {
    poly('#8a6a48', [[-1.4, -5.1], [-1.4, -6.5], [1.4, -6.5], [1.4, -5.1], [1.05, -5.9], [-1.05, -5.9]]);   // fur hood
    disc('#8a6a48', -1.05, -6.75, 0.42); disc('#8a6a48', 1.05, -6.75, 0.42);
    poly('#6e4a2c', [[1.4, -1.4], [1.85, -1.5], [2.45, -5.1], [1.35, -5]]); disc('#6e4a2c', 1.9, -5.3, 0.65);   // club
  }
}

export function unitSprite(kind, color, z, dpr, style = 'soldier') {
  const key = `${kind}|${color}|${z.toFixed(2)}|${dpr}|${style}`;
  let s = unitCache.get(key);
  if (s) return s;
  const w = (kind === 'battalion' ? 13 : 5) * z, h = (kind === 'battalion' ? 11 : 8) * z;
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * dpr);
  c.height = Math.ceil(h * dpr);
  const x = c.getContext('2d');
  x.scale(dpr * z, dpr * z);
  const col = hexToRgb(color), body = css(col);   // body colour: the battalion flag
  const man = (mx, my, sc) => drawFoglet(x, mx, my, sc, col, style);
  x.fillStyle = 'rgba(20,30,30,0.25)';
  if (kind === 'battalion') {
    x.beginPath(); x.ellipse(6.5, 10, 6, 1.2, 0, 0, Math.PI * 2); x.fill();
    x.strokeStyle = 'rgba(70,55,40,0.9)'; x.lineWidth = 0.6;
    x.beginPath(); x.moveTo(11.6, 9.5); x.lineTo(11.6, 0.6); x.stroke();
    x.fillStyle = body; x.beginPath(); x.moveTo(11.6, 0.6); x.lineTo(8.6, 1.8); x.lineTo(11.6, 3); x.fill();
    for (const [mx, my] of [[2, 7], [5, 7], [8, 7], [3.5, 9.8], [6.5, 9.8], [9.5, 9.8]]) man(mx, my, 0.62);
  } else {
    x.beginPath(); x.ellipse(2.5, 7.4, 2.2, 0.7, 0, 0, Math.PI * 2); x.fill();
    man(2.5, 7.2, 1);
  }
  s = { c, w, h };
  unitCache.set(key, s);
  return s;
}

// ---------- page rotation ----------
// phones held upright: the whole page is rotated 90 degrees by css (html.rotated) so the game is
// always landscape. these helpers turn screen coordinates into page coordinates (and screen rects
// into page rects), so input works the same either way
const rotated = () => document.documentElement.classList.contains('rotated');
export function pagePoint(clientX, clientY) {
  return rotated() ? { x: clientY, y: window.innerWidth - clientX } : { x: clientX, y: clientY };
}
export function pageRect(el) {
  const r = el.getBoundingClientRect();
  return rotated() ? { left: r.top, top: window.innerWidth - r.right, width: r.height, height: r.width } : r;
}

// outlined text, readable on any colour
export function label(ctx, text, x, y, size, color = '#fff', weight = 800) {
  ctx.font = `${weight} ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(2, size / 4);
  ctx.strokeStyle = 'rgba(25,35,40,0.6)';
  ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

// troop count badge: white rounded pill with an owner-coloured rim and a soft drop shadow
export function pill(ctx, text, x, y, size, rim, ink) {
  ctx.font = `800 ${size}px system-ui, sans-serif`;
  const w = Math.max(size * 1.6, ctx.measureText(text).width + size * 0.9), h = size * 1.4;
  ctx.fillStyle = 'rgba(20,30,35,0.22)';
  roundRect(ctx, x - w / 2 + 1, y - h / 2 + 2, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.93)';
  roundRect(ctx, x - w / 2, y - h / 2, w, h, h / 2);
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, size * 0.14);
  ctx.strokeStyle = rim;
  ctx.stroke();
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + size * 0.04);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
