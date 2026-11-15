// map view preparation without dom: ground colours, segment cells + coast distance, tree placement,
// island box + water glints. MapView (render.js) runs them with its own `this`; the map worker runs
// them on a plain object for the next stage, so the main thread only builds canvases

// linear mix of two rgb colours, t in [0, 1]
export function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}


// deterministic hash + smooth value noise (ground patches, tree placement)
export function hash(x, y, s) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(s, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function vnoise(x, y, s) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, s), b = hash(ix + 1, iy, s), c = hash(ix, iy + 1, s), d = hash(ix + 1, iy + 1, s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}


// ground texture colours per grid cell (rgba bytes in this.groundPx), yielding every 40 rows
// (a 480 grid is ~50 ms of pixel work). sets this.seed (trees, glints use it)
export function* groundPixels() {
  const { ids, terrain, relief, near, nearType, grid: g, segs } = this.map, t = this.theme;
  const seed = (this.seed = (segs.length * 7919 + Math.round(segs[0].x * 31)) | 0);
  const gi = { data: (this.groundPx = new Uint8ClampedArray(g * g * 4)) };
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
    if (x === g - 1 && y % 40 === 39) yield;
  }
  yield;
}

// cells of every segment (this.segCells) and each cell's distance (grid units) to the nearest fog /
// lake cell (this.coastD), in slices
export function* coastSteps() {
  const { ids, terrain, grid: g, segs } = this.map;
  const mtn = (c) => terrain && terrain[c] === 2;
    const lists = segs.map(() => []);
    for (let c = 0; c < g * g; c++) if (ids[c] >= 0) lists[ids[c]].push(c);
    this.segCells = lists;
    yield;
    // distance (grid units) from each cell to the nearest fog / lake cell: buildings use it to
    // stand fully on the island instead of hanging over the coast. two-pass chamfer (1, 1.41)
    const cd = new Float32Array(g * g), big = 1e6, d2 = Math.SQRT2;
    for (let c = 0; c < g * g; c++) cd[c] = ids[c] >= 0 || mtn(c) ? big : 0;
    for (let y = 0; y < g; y++) for (let x = 0; x < g; x++) {
      const c = y * g + x;
      if (x === 0 && y % 80 === 79) yield;   // in slices
      if (!cd[c]) continue;
      let v = cd[c];
      // outside the grid counts as fog
      v = Math.min(v, x > 0 ? cd[c - 1] + 1 : 1, y > 0 ? cd[c - g] + 1 : 1);
      v = Math.min(v, x > 0 && y > 0 ? cd[c - g - 1] + d2 : d2, x < g - 1 && y > 0 ? cd[c - g + 1] + d2 : d2);
      cd[c] = v;
    }
    yield;
    for (let y = g - 1; y >= 0; y--) for (let x = g - 1; x >= 0; x--) {
      const c = y * g + x;
      if (x === g - 1 && y % 80 === 0) yield;
      if (!cd[c]) continue;
      let v = cd[c];
      v = Math.min(v, x < g - 1 ? cd[c + 1] + 1 : 1, y < g - 1 ? cd[c + g] + 1 : 1);
      v = Math.min(v, x < g - 1 && y < g - 1 ? cd[c + g + 1] + d2 : d2, x > 0 && y < g - 1 ? cd[c + g - 1] + d2 : d2);
      cd[c] = v;
    }
    this.coastD = cd;
    yield;
}

// tree clusters inside segments, away from borders and number labels (this.trees); needs
// this.map, theme, k, seed, coastD
export function placeTrees() {
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
    // most of the silhouette's width must stand on the island, not hang over the fog or a lake
    if (this.coastD[Math.floor(o.y) * g + Math.floor(o.x)] < w * 0.8) return false;
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

// island bounding box (grid cells, land + lakes + mountains) and sample points on the water
// (lakes, rivers) for the animated sparkles and the lake wave strokes
export function measureIsland() {
  const { ids, terrain, grid: g } = this.map;
  let x0 = g, y0 = g, x1 = 0, y1 = 0;
  const pts = [];
  // a lake sparkle is drawn every frame on top of the map, at its cell pushed down by the lake drop
  // (render.js drawAmbient: ch css px = 0.022 * size, i.e. 0.0275 * g grid rows at tilt 0.8). keep
  // only points whose drawn spot is open water: lake cells around it (not the near shore), and no
  // mountain just below it whose wall (0.0375 * g rows high, buildRocks) would hide it
  const at = (x, y) => (x >= 0 && y >= 0 && x < g && y < g ? terrain[(y | 0) * g + (x | 0)] : 0);
  const drop = 0.0275 * g, wall = 0.0375 * g, rx = Math.max(2, 0.009 * g);
  const openWater = (x, y) => {
    const Y = y + drop;
    for (const [dx, dy] of [[0, 0], [-rx, 0], [rx, 0], [0, -1.5], [0, 1.5], [-rx, -1], [rx, 1]]) if (at(x + dx, Y + dy) !== 1) return false;
    for (let yy = Y; yy <= Y + wall + 2; yy += 1) for (const dx of [-rx, 0, rx]) if (at(x + dx, yy) === 2) return false;
    return true;
  };
  for (let c = 0; c < g * g; c++) {
    if (ids[c] < 0 && !(terrain && terrain[c])) continue;
    const x = c % g, y = Math.floor(c / g);
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (terrain && terrain[c] === 1 && hash(x, y, this.seed + 40) < 0.012 && openWater(x + 0.5, y + 0.5)) pts.push([x + 0.5, y + 0.5, 1]);
  }
  this.isle = [x0, y0, x1 + 1, y1 + 1];
  // rivers: every few points along each course (rivers sit on the ground, no lake drop)
  for (const r of this.map.rivers ?? []) for (let j = 4; j < r.length; j += 9) if (hash(j, 41, r.length) < 0.5) pts.push([r[j][0], r[j][1], 0]);
  // at most ~70 sparkles; phase and speed fixed per point
  this.glints = pts.slice(0, 70).map(([x, y, lake], i) => ({ x, y, lake, ph: hash(i, 42, this.seed) * 6.28, w: 0.7 + hash(i, 43, this.seed) * 1.1 }));
}
