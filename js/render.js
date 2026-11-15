// map renderer in a soft "island diorama" style:
// misty sea, foam at the waterline, cliffs under the island edge, natural ground colours,
// owner colours as glowing segment borders, low-poly trees on top.
// all edges (coast, lakes, mountains, segment borders) are smooth vector outlines traced from the
// map grid with marching squares + chaikin smoothing, so nothing looks pixelated at any size.
// layers (display resolution, cached): under (shadow, lakes, cliff) -> top (ground, building scenes, owner
// overlays, borders, rocks, trees; repainted when owners, buildings or the selection change)
import { themes, fogTwirl } from './config.js?v=125';
import * as structures from './structures.js?v=125';
import { outline, loopsToPath, segBoxes } from './outline.js?v=125';
import { mix, hash, vnoise, groundPixels, coastSteps, placeTrees, measureIsland } from './viewprep.js?v=125';
export { mix };

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// mix colour toward white (k > 0) or black (k < 0)
export function shade([r, g, b], k) {
  const t = k > 0 ? 255 : 0, a = Math.abs(k);
  return [r + (t - r) * a, g + (t - g) * a, b + (t - b) * a];
}

const css = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
let shadowBlob = null;   // soft cloud-shadow sprite (MapView.drawAmbient), made once

// do two boxes [x0, y0, x1, y1] overlap? (terrain objects vs huts and buildings)
// the map worker (mapworker.js) imports this module too, to draw a view's static layers and
// sprites on OffscreenCanvases (paintInWorker); there is no page there
const hasDom = typeof document !== 'undefined';
// a canvas of w x h: a page canvas, or an OffscreenCanvas in the worker
function newCanvas(w, h) {
  const c = hasDom ? document.createElement('canvas') : new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}
// 2d context; cpu = drawn on the cpu (always in the worker: its results are read back as bitmaps)
const ctx2d = (c, cpu = false) => c.getContext('2d', cpu || !hasDom ? { willReadFrequently: true } : undefined);
// run a step generator to its end, return its value
const runSteps = (g) => { let r; do r = g.next(); while (!r.done); return r.value; };
// make the gpu run what was drawn into canvas c so far, in this frame, instead of all at once when
// c is first shown or copied: drawing c into a 1 px canvas submits its pending drawing. step
// generators yield 'gpu ...' right after, so the slice runner ends the frame's slice there
// cpu canvases record their drawing and rasterise it later, at the end of the task, where a "2 ms"
// step could leave 20-60 ms of hidden work; reading one pixel runs it now, inside the step's time
const cpuFlush = (x) => { x.getImageData(0, 0, 1, 1); };
let flushCtx = null;
const gpuFlush = (c) => { if (hasDom) (flushCtx ??= newCanvas(1, 1).getContext('2d')).drawImage(c, 0, 0, 1, 1); };
const boxHit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

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

// fog twirl timing from config (css vars on the page root); re-applied when the tune panel changes it
function applyFogTwirl() {
  const s = document.documentElement.style;
  s.setProperty('--twirl-a', fogTwirl.period + 's');
  s.setProperty('--twirl-b', fogTwirl.counterPeriod + 's');
  s.setProperty('--twirl-alpha', fogTwirl.counterAlpha);
  s.setProperty('--storm-dark', fogTwirl.stormDark);
  s.setProperty('--storm-in', fogTwirl.stormIn + 's');
  s.setProperty('--storm-out', fogTwirl.stormOut + 's');
}
if (hasDom) {
  applyFogTwirl();
  addEventListener('tune', applyFogTwirl);
}

// map scale: conquest stages 4-5 are bigger maps (feature scale detail < 0.62). everything drawn on
// them (buildings, trees, foglets, badges) shrinks by this, and the camera starts zoomed in by its
// inverse, so things look the same size as on stage 3 while the map holds more tiles
export const mapScale = (m) => Math.min(1, (m?.detail ?? 1) / 0.62);
// tile border thickness (owner band + glow, terrain dashes, plain lines), times mapScale on big maps
const borderW = 0.6;

export class MapView {
  // segThemes (optional): theme name per segment, e.g. campaign regions with their own climate
  // opts.headless: a view that only builds a map's layers (idle: the next stage's map, prepared in
  // small slices during the current stage on a hidden canvas); it never touches the page's fog and
  // starts empty (run setMapSteps yourself). the live view takes its work over with adopt()
  constructor(canvas, map, theme, segThemes, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    if (opts.headless) { this.headless = true; return; }
    this.setMap(map, theme, segThemes);
    // follow the container size (screen rotation, panel changes)
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  // take over a headless view's prepared map: outlines, trees, layers and sprites (nothing is
  // rebuilt), then size this canvas like it and switch the page's fog to its climate. a container
  // size that changed meanwhile still rebuilds, through resize()
  // returns the old map's canvases (layers, sprites), so the caller can free them a few at a time
  adopt(o) {
    const old = [this.under, this.base, this.rocks, this.layerGround, this.layerOwner, this.layerObjects, this.groundC, ...(this.sprites?.values() ?? [])].map((x) => x?.c ?? x).filter(Boolean);
    const own = new Set(['canvas', 'ctx', 'twirl', 'fogBase', 'storm', 'stormRaf', 'fogUrl', 'headless']);
    for (const k of Object.keys(o)) if (!own.has(k)) this[k] = o[k];
    const c = this.canvas, oc = o.canvas;
    c.width = oc.width; c.height = oc.height;
    for (const k of ['position', 'left', 'top', 'flex', 'width', 'height']) c.style[k] = oc.style[k];
    oc.width = oc.height = 0;   // the hidden canvas is done with
    this.applyFog();
    this.resize();
    return old;
  }

  // new map: all steps at once (setMapSteps yields between them for callers that spread the work
  // over frames, e.g. the idle zoom-out, so no single frame takes the whole ~0.3 s)
  setMap(map, theme = 'summer', segThemes = null) {
    for (const _ of this.setMapSteps(map, theme, segThemes));   // eslint-disable-line no-unused-vars
  }

  *setMapSteps(map, theme = 'summer', segThemes = null) {
    this.map = map;
    this.theme = themes[theme] ?? themes.summer;
    this.segTheme = segThemes ? segThemes.map((n) => themes[n] ?? this.theme) : null;
    this.k = map.grid / 480;   // feature sizes are tuned for a 480 grid
    this.prep = !segThemes && map.prep?.theme === theme ? map.prep : null;   // made in the map worker
    yield* this.buildGroundSteps();
    yield* this.buildOutlinesSteps();
    this.placeTrees();
    yield 'trees';
    this.measureIsland();
    this.prep = null;
    yield 'island';
    if (!this.headless) this.applyFog();
    this.styleOf = this.st = null;
    this.bkey = this.okey = this.order = null;
    this.dirtyB = this.dirtyO = null;
    this.size = 0;   // forces resize() to rebuild every cached layer for the new map
    this.rivIdx = null;   // river footprint (nearRiver) belongs to the old map
    yield 'fog';
    this.resize();
  }

  // the page's fog for this map's climate: texture on the container, the two turning cloud layers
  // and the storm layer (created once)
  applyFog() {
    // fog around the island lives on the container, so there's no square edge. two oversized cloud
    // layers on top of it slowly turn in opposite directions (css animation = gpu, no redraws);
    // the static texture stays underneath for zoomed-out views where the layers don't reach
    const el = this.canvas.parentElement, url = cloudTexture(this.theme);
    // static texture on its own compositor layer (fog-base): the idle zoom-out scales it with a
    // transform; animating the container's background-size repainted the whole screen every frame
    el.style.background = `rgb(${this.theme.fogB})`;
    if (!this.fogBase) {
      this.fogBase = document.createElement('div');
      this.fogBase.className = 'fog-base';
      this.fogBase.setAttribute('aria-hidden', 'true');
      el.prepend(this.fogBase);
    }
    this.fogBase.style.backgroundImage = `url(${url})`;
    if (!this.twirl) {
      this.twirl = ['a', 'b'].map((n) => {
        const d = document.createElement('div');
        d.className = `fog-twirl ${n}`;
        d.setAttribute('aria-hidden', 'true');
        el.prepend(d);   // before the canvas, so the map paints on top
        return d;
      });
    }
    if (el.firstChild !== this.fogBase) el.prepend(this.fogBase);   // under the twirl layers
    // new fog colour (climate change): copies of the old layers keep turning in step on top and fade
    // out, so the colour changes gradually instead of snapping
    if (this.fogUrl && this.fogUrl !== url && fogTwirl.colorFade > 0 && el.offsetParent) {
      for (const d of this.twirl) {
        const c = d.cloneNode();
        c.classList.add('fading');
        d.after(c);
        const [a] = d.getAnimations(), [b] = c.getAnimations();
        if (a && b) b.currentTime = a.currentTime;   // same rotation as the live layer
        c.style.opacity = getComputedStyle(d).opacity;
        c.style.transition = `opacity ${fogTwirl.colorFade}s ease-in-out`;
        requestAnimationFrame(() => requestAnimationFrame(() => { c.style.opacity = '0'; }));
        setTimeout(() => c.remove(), fogTwirl.colorFade * 1000 + 200);
      }
    }
    this.fogUrl = url;
    for (const d of this.twirl) d.style.backgroundImage = `url(${url})`;
    // boss storm: dark layer above the fog, below the map (opacity fades via css, see setStorm)
    if (!this.storm) {
      this.storm = document.createElement('div');
      this.storm.className = 'fog-storm';
      this.storm.setAttribute('aria-hidden', 'true');
      this.canvas.before(this.storm);   // after both twirl layers, right under the map
    }
  }

  // boss stage storm over the fog: on = darken gradually (stormIn), off = clear gradually (stormOut).
  // instant = jump there with no fade (a new non-boss battle must not show the old storm clearing)
  setStorm(on, instant = false) {
    const d = this.storm;
    if (!d) return;
    cancelAnimationFrame(this.stormRaf);
    if (instant) {
      d.style.transition = 'none';
      d.classList.toggle('on', on);
      void d.offsetWidth;
      d.style.transition = '';
      return;
    }
    // two frames later, so the fade also runs when the battle screen was only just shown
    this.stormRaf = requestAnimationFrame(() => { this.stormRaf = requestAnimationFrame(() => d.classList.toggle('on', on)); });
  }

  // island box + water glints, trees (viewprep.js; the worker's results when it made them)
  measureIsland() { if (this.prep) { this.isle = this.prep.isle; this.glints = this.prep.glints; } else measureIsland.call(this); }
  placeTrees() { if (this.prep) this.trees = this.prep.trees; else placeTrees.call(this); }

  // fit the canvas into the parent: width = map width, height = squashed map + room for cliffs
  // below and buildings/rocks above. cached layers are rebuilt lazily.
  // fitIsland (battle view): size so the island itself, not its square grid, fills the screen
  // (the grid's empty fog corners may run off-screen); the canvas shifts so the island is centred
  resize() {
    if (this.worker) return;   // the worker's view is sized by setSize
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
    this.setSize(size, dpr);
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.canvas.style.width = size + 'px';
    this.canvas.style.height = this.cssH + 'px';
  }

  // the view's geometry for css size `size` at density dpr (the worker gets both from the page);
  // every cached layer and sprite starts over
  setSize(size, dpr) {
    const pad = 0.12;
    this.tilt = 0.8;
    this.size = size;
    this.dpr = dpr;
    this.scale = size / this.map.grid;
    this.oy = size * pad * 0.5;
    const h = Math.round(size * (this.tilt + pad));
    this.W = Math.round(size * dpr);   // layer size in device px
    this.H = Math.round(h * dpr);
    this.cssH = h;
    this.under = this.base = this.rocks = this.layerGround = this.layerOwner = this.layerObjects = null;
    this.sprites = new Map();
    this.ofsX = this.ofsY = 0;
    // building scale unit in css px; bigger conquest maps (mapScale < 1) draw everything smaller
    this.u = Math.max(3.5, size / 92) * mapScale(this.map);
    this.spotCache = new Map();
    this.candCache = new Map();
  }

  // grid-res ground texture (grass/earth noise, shore and scree tints). it is only seen through the
  // smooth island outline, so its pixel edges never show
  buildGround() { for (const _ of this.buildGroundSteps());   /* eslint-disable-line no-unused-vars */ }

  // the same in slices (ground colours: viewprep.js groundPixels, or the worker's when it made them)
  *buildGroundSteps() {
    const g = this.map.grid, pre = this.prep;
    if (pre) { this.seed = pre.seed; this.groundPx = pre.ground; } else yield* groundPixels.call(this);
    this.groundC = newCanvas(g, g);
    ctx2d(this.groundC).putImageData(new ImageData(this.groundPx, g, g), 0, 0);
    this.groundPx = null;
    yield;
  }

  // smooth outlines: island (land + mountains, lakes as holes), outer (incl. lakes), lakes,
  // mountains and one per segment
  buildOutlines() { for (const _ of this.buildOutlinesSteps());   /* eslint-disable-line no-unused-vars */ }

  // the same in slices: island outlines, then a few segments at a time, then the coast distance
  *buildOutlinesSteps() {
    const { ids, terrain, grid: g, segs } = this.map;
    const lake = (c) => terrain && terrain[c] === 1, mtn = (c) => terrain && terrain[c] === 2;
    // cell label: segment id, or -1 sea / -2 lake / -3 mountain
    const lab = (c) => (ids[c] >= 0 ? ids[c] : -1 - (terrain ? terrain[c] : 0));
    // traced in the map worker already (map.outlines): only the paths are built here
    const pre = this.map.outlines;
    this.islandP = pre ? loopsToPath(pre.island) : outline((c) => ids[c] >= 0 || mtn(c), lab, g);
    if (!pre) yield;
    this.outerP = pre ? loopsToPath(pre.outer) : outline((c) => ids[c] >= 0 || mtn(c) || lake(c), lab, g);
    if (!pre) yield;
    this.lakesP = pre ? loopsToPath(pre.lakes) : outline(lake, lab, g);
    this.mtnP = pre ? loopsToPath(pre.mtn) : outline(mtn, lab, g, 0, 0, g - 1, g - 1, true);
    yield;
    // cracks on the rock tops: short kinked lines starting on random mountain cells
    const rockCells = [];
    for (let c = 0; c < g * g; c++) if (mtn(c)) rockCells.push(c);
    this.mtnBox = null;   // [x0, y0, x1, y1] cells: the rocks layer is drawn only there
    for (const c of rockCells) {
      const cx = c % g, cy = Math.floor(c / g), b = (this.mtnBox ??= [cx, cy, cx, cy]);
      if (cx < b[0]) b[0] = cx; if (cy < b[1]) b[1] = cy; if (cx > b[2]) b[2] = cx; if (cy > b[3]) b[3] = cy;
    }
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
    const box = pre?.box ?? segBoxes(this.map);
    yield;
    const segP = [];
    for (const s of segs) {
      segP.push(pre ? loopsToPath(pre.segs[s.id]) : outline((c) => ids[c] === s.id, lab, g, ...box[s.id]));
      if (!pre && s.id % 4 === 3) yield;
    }
    this.segP = segP;
    this.boxes = box;
    // cells per segment and distance to the coast (viewprep.js coastSteps, or the worker's)
    if (this.prep) { this.segCells = this.prep.segCells; this.coastD = this.prep.coastD; } else yield* coastSteps.call(this);
    yield;
  }

  // free land around a css px point: distance to the coast (or a lake) in css px, 0 off the island.
  // the screen squashes y by the tilt, so the result is the horizontal reach that stays on land
  clearAt(px, py) {
    const g = this.map.grid, gx = Math.floor(px / this.scale), gy = Math.floor((py - this.oy) / (this.scale * this.tilt));
    if (gx < 0 || gy < 0 || gx >= g || gy >= g) return 0;
    return this.coastD[gy * g + gx] * this.scale;
  }


  sx(gx) { return gx * this.scale; }
  sy(gy) { return gy * this.scale * this.tilt + this.oy; }
  px(v) { return v * this.scale; }   // grid length -> css px (sizes)

  // ctx transforms: grid units (with tilt) or css px. ofsX/ofsY shift the origin (device px) while
  // drawing into a small sprite canvas, so the same drawing code works for sprites and full layers
  gridT(x) { x.setTransform(this.dpr * this.scale, 0, 0, this.dpr * this.scale * this.tilt, -this.ofsX, this.dpr * this.oy - this.ofsY); }
  cssT(x) { x.setTransform(this.dpr, 0, 0, this.dpr, -this.ofsX, -this.ofsY); }

  // display-res canvas, ctx in grid units
  // cpu = drawn on the cpu right away (layers only blitted when a composite is rebuilt: their
  // drawing then happens inside the zoom-out's time slices instead of as one deferred gpu stall)
  newLayer(cpu = false) {
    const c = newCanvas(this.W, this.H);
    const x = ctx2d(c, cpu);
    this.gridT(x);
    x.imageSmoothingQuality = 'high';
    return [c, x];
  }

  // island shadow, lake water and cliff face (static per map and size)
  buildUnder() { for (const _ of this.buildUnderSteps());   /* eslint-disable-line no-unused-vars */ }

  // the same in steps: the gpu gets shadow, lakes and every cliff blit as separate batches
  // (as one job it was a ~60 ms gpu stall)
  *buildUnderSteps() {
    const [c, x] = this.newLayer(), t = this.theme, g = this.map.grid, px = 1 / this.scale, py = px / this.tilt;
    const ch = Math.max(4, this.size * 0.022) * py;   // cliff height (css px -> grid y units)
    // soft island shadow: blurred at 1/8 resolution and scaled up (looks the same, 64x fewer pixels
    // to blur; the full-size blur was a ~100 ms gpu job on every new map)
    const k = 8, sc = newCanvas(Math.ceil(c.width / k), Math.ceil(c.height / k));
    const sx = ctx2d(sc, true);
    sx.setTransform((this.dpr * this.scale) / k, 0, 0, (this.dpr * this.scale * this.tilt) / k, -this.ofsX / k, (this.dpr * this.oy - this.ofsY) / k);
    sx.filter = `blur(${(this.size * 0.035 * this.dpr) / k}px)`;
    sx.translate(g * 0.015, ch + g * 0.05);
    sx.fillStyle = css(t.shadow, 0.16);
    sx.fill(this.outerP);
    x.save();
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.imageSmoothingEnabled = true;
    x.drawImage(sc, 0, 0, sc.width * k, sc.height * k);
    x.restore();
    gpuFlush(c);
    yield 'gpu shadow';
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
    gpuFlush(c);
    yield 'gpu lakes';
    // cliff: island shape stacked downward, dark at the foot, lighter toward the top edge. the
    // shape is filled once per colour and smeared down by copying the canvas onto itself shifted by
    // 1, 2, 4 ... px (~7 blits instead of ~70 fills of the whole outline, a ~100 ms gpu job)
    const dy = this.dpr * this.scale * this.tilt;   // grid y units -> device px
    const T = newCanvas(c.width, c.height);
    const tx = ctx2d(T);
    const smear = function* (color, from, to) {   // offsets in grid y units, from < to
      tx.setTransform(1, 0, 0, 1, 0, 0);
      tx.clearRect(0, 0, T.width, T.height);
      this.gridT(tx);
      tx.fillStyle = css(color);
      tx.fill(this.islandP, 'evenodd');
      tx.setTransform(1, 0, 0, 1, 0, 0);
      const len = Math.round((to - from) * dy);
      for (let done = 0; done < len;) { const d = Math.min(done + 1, len - done); tx.drawImage(T, 0, d); done += d; gpuFlush(T); yield 'gpu cliff'; }
      x.save();
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.drawImage(T, 0, Math.round(from * dy));
      x.restore();
      gpuFlush(c);
      yield 'gpu cliff';
    };
    yield* smear.call(this, t.cliffDark, ch * 0.45, ch);
    yield* smear.call(this, t.cliffLight, py * 0.5, ch * 0.45);
    // no fog on the canvas: all fog around the island is the moving css layers behind it
    // (fog-twirl), so nothing static covers them in a square around the map
    this.under = c;
  }

  // ---------- layers ----------
  // static per map + size: under (shadow, lakes, cliffs), base (ground, all borders, lip), rocks.
  // per segment sprites (cached small canvases): building ground scene, owner overlay, trees,
  // building top scene. the three composite layers below are rebuilt from sprites with a few
  // drawImage calls when buildings or owners change, so no frame ever re-renders the scenes.

  // small canvas covering segment id's box plus a margin (css px); draw(x) renders into it
  sprite(id, margin, draw) {
    return runSteps(this.spriteSteps(null, id, margin, function* (x) { draw(x); }));   // eslint-disable-line require-yield
  }

  // the same in steps: draw is a generator (big forests are drawn a few dozen trees per step);
  // key = cache key (null: not cached). returns the sprite
  *spriteSteps(key, id, margin, draw) {
    const have = key && this.sprites.get(key);
    if (have) return have;
    const [bx0, by0, bx1, by1] = this.boxes[id], d = this.dpr;
    const left = Math.floor((this.sx(bx0) - margin) * d), top = Math.floor((this.sy(by0) - margin * 1.6) * d);
    const right = Math.ceil((this.sx(bx1 + 1) + margin) * d), bottom = Math.ceil((this.sy(by1 + 1) + margin * 0.6) * d);
    const c = newCanvas(right - left, bottom - top);
    // cpu canvas: the scene is drawn right here (inside the caller's time slice), not deferred to the
    // gpu process, where hundreds of fresh sprites (blurs, many paths) piled up into 100-300 ms
    // stalls when the layers were composed. composites only read it on a rebuild (one upload each)
    const x = ctx2d(c, true);
    x.imageSmoothingQuality = 'high';
    this.ofsX = left;
    this.ofsY = top;
    try { this.gridT(x); yield* draw.call(this, x); } finally { this.ofsX = this.ofsY = 0; }
    cpuFlush(x);
    const sp = { c, left, top };
    if (key) this.sprites.set(key, sp);
    return sp;
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
  topSprite(id, type, color, skin) { return runSteps(this.topSpriteSteps(id, type, color, skin)); }
  *topSpriteSteps(id, type, color, skin) {
    return yield* this.spriteSteps(`t${id}|${type}|${color}|${skin}`, id, this.u * 7, function* (x) {
      const keep = this.terrainKeep(id, type), split = this.spots(id, 1, 0)[0]?.[1] ?? this.sy(this.map.segs[id].y);
      yield* this.treesSteps(x, id, (tr, px, py) => py <= split && keep(tr, px, py));
      structures.top(this, x, id, type, color, skin);
      cpuFlush(x);
      yield 'top';
      yield* this.treesSteps(x, id, (tr, px, py) => py > split && keep(tr, px, py));
    });
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
    else if (type === 'obelisk') add(main, u * 5.6, u * 3.3);
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
  treeSprite(id, huts = false) { return runSteps(this.treeSpriteSteps(id, huts)); }
  *treeSpriteSteps(id, huts = false) {
    return yield* this.spriteSteps(`r${id}|${huts ? 1 : 0}`, id, this.u * 4, function* (x) {
      if (!huts) { yield* this.treesSteps(x, id); return; }
      const list = this.hutList(id), free = (b) => !list.some((h) => boxHit(b, h.box));
      let prev = -Infinity;
      for (const h of list) {
        const lo = prev;
        yield* this.treesSteps(x, id, (tr, px, py, b) => py > lo && py <= h.y && free(b));
        this.drawHut(x, h);
        prev = h.y;
      }
      yield* this.treesSteps(x, id, (tr, px, py, b) => py > prev && free(b));
    });
  }

  blit(x, sp) { x.drawImage(sp.c, sp.left, sp.top); }

  // the sprites a battle may need later (trees with and without huts, every side's owner overlay
  // on every tile), one job each; cached ones cost nothing (idle: made during the previous stage)
  warmJobs(colors, fill) {
    const jobs = [];
    for (let id = 0; id < this.segP.length; id++) jobs.push(() => this.treeSprite(id, true), () => this.treeSprite(id));
    for (const col of colors) for (let id = 0; id < this.segP.length; id++) jobs.push(() => this.overlaySprite(id, col, fill));
    return jobs;
  }

  // the same as steps (the idle prep runs them a few ms per frame)
  *warmSteps(colors, fill) {
    for (let id = 0; id < this.segP.length; id++) { yield* this.treeSpriteSteps(id, true); yield 'warm'; yield* this.treeSpriteSteps(id); yield 'warm'; }
    for (const col of colors) for (let id = 0; id < this.segP.length; id++) { this.overlaySprite(id, col, fill); yield 'warm'; }
  }

  // pre-render sprites in small idle-time chunks (trees for every segment, overlays for every
  // faction colour), so a first capture or build never costs a frame
  prewarm(colors, fill) {
    const jobs = this.warmJobs(colors, fill);
    const map = this.map, size = this.size;
    const step = () => {
      if (this.map !== map || this.size !== size) return;   // map or size changed: stop
      const t0 = performance.now();
      while (jobs.length && performance.now() - t0 < 4) jobs.shift()();
      if (jobs.length) setTimeout(step, 16);
    };
    setTimeout(step, 50);
  }

  // everything the next drawBase needs (after paint()), one piece per step: static layers, then the
  // sprite of every tile (building scene or trees, owner overlay), then the three composites (only
  // blits by then). the idle zoom-out runs it a few ms per frame behind its animation, so the new
  // map's first frame costs nothing. a resize midway just leaves the rest to drawBase, as before
  *prepSteps() {
    const size = this.size, dpr = this.dpr, same = () => this.size === size && this.dpr === dpr;
    if (!this.under) { yield* this.buildUnderSteps(); yield 'under'; }
    if (!this.base) { yield* this.buildBaseSteps(); yield 'base'; }
    if (!this.rocks) { yield* this.buildRocksSteps(); yield 'rocks'; }
    if (!this.st) return;
    for (let id = 0; id < this.st.length && same(); id++) { yield* this.spotCandSteps(id); yield 'cand'; }
    for (let id = 0; id < this.st.length && same(); id++) {
      const s = this.st[id];
      if (s.building) { this.groundSprite(id, s.building); yield 'ground ' + id; yield* this.topSpriteSteps(id, s.building, s.color, s.skin); }
      else yield* this.treeSpriteSteps(id, s.huts);
      yield 'sprite ' + id;
      if (s.color) { this.overlaySprite(id, s.color, s.fill); yield 'overlay ' + id; }
    }
    if (!same()) return;
    if (!this.layerGround) yield* this.groundLayerSteps();
    if (!this.layerOwner) yield* this.ownerLayerSteps();
    if (!this.layerObjects) yield* this.objectLayerSteps();
  }

  // static: ground texture, every segment border, light lip along the cliff edge
  buildBase() { for (const _ of this.buildBaseSteps());   /* eslint-disable-line no-unused-vars */ }

  // the same in slices (the ground details a band of rows at a time)
  *buildBaseSteps() {
    // drawn unclipped and cut to the island once at the end: a clip to the island outline made the
    // cpu canvas rebuild a full-size clip mask at every flush (5-10 ms per step)
    const [c, x] = this.newLayer(true), t = this.theme, g = this.map.grid, px = 1 / this.scale;
    x.save();
    x.imageSmoothingEnabled = true;
    yield* this.clipBands(x, c, 12, () => x.drawImage(this.groundC, 0, 0, g, g));
    yield* this.groundDetailSteps(x, px);
    x.lineJoin = 'round';
    x.lineWidth = Math.max(1, this.size * 0.0022) * px * borderW * mapScale(this.map);
    x.strokeStyle = css(t.lineNeutral, 0.45);
    for (const p of this.segP) { x.stroke(p); cpuFlush(x); yield 'border'; }
    x.lineWidth = Math.max(2, this.size * 0.006) * px;
    x.strokeStyle = css(t.lip, 0.7);
    yield* this.clipBands(x, c, 6, () => x.stroke(this.islandP));
    x.restore();
    x.save();
    x.globalCompositeOperation = 'destination-in';   // keep only the island
    yield* this.clipBands(x, c, 8, () => x.fill(this.islandP, 'evenodd'));
    x.restore();
    this.base = yield* this.toGpuSteps(c);
  }

  // one costly full-layer drawing (fn, on cpu canvas c with ctx x) done in n horizontal clip bands,
  // a step each: only the band's pixels are rasterised per step
  *clipBands(x, c, n, fn) {
    const bh = Math.ceil(c.height / n);
    for (let y = 0; y < c.height; y += bh) {
      x.save();
      const m = x.getTransform();
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.beginPath();
      x.rect(0, y, c.width, bh);
      x.clip();
      x.setTransform(m);
      fn();
      x.restore();
      cpuFlush(x);
      yield 'band';
    }
  }

  // the worker's drawing (paintInWorker) taken over: each static layer uploaded into a gpu canvas a
  // band (~1 M px) per step, the tile sprites and spot cache as they are (sprites stay bitmaps)
  *takePaintSteps(res) {
    const up = function* (L) {
      const g = newCanvas(L.W, L.H), gx = g.getContext('2d');
      let prev = null;
      for (const b of L.bands) {
        gx.drawImage(b.bmp, L.ox, L.oy + b.y);
        gpuFlush(g);
        prev?.close();   // the one before is uploaded by now
        prev = b.bmp;
        yield 'gpu upload';
      }
      prev?.close();
      return g;
    };
    this.under = yield* up(res.under);
    this.base = yield* up(res.base);
    this.rocks = yield* up(res.rocks);
    for (const [k, c, left, top] of res.sprites) if (!this.sprites.has(k)) this.sprites.set(k, { c, left, top });
    for (const [k, v] of res.spots) this.spotCache.set(k, v);
  }

  // a finished static layer (drawn on the cpu) moved to a gpu canvas in bands of ~1 M px, one per
  // frame, then freed: uploaded once, ~4 MB at a time. composites and patches then copy from it on
  // the gpu (a 16 MB cpu layer drawn into a gpu canvas was a 30-50 ms upload, again on many captures)
  // c may cover only part of the view: it goes to (ox, oy) of a W x H gpu canvas
  *toGpuSteps(c, ox = 0, oy = 0, W = c.width, H = c.height) {
    if (this.worker) return { cpu: c, ox, oy, W, H };   // the worker hands it over as bitmaps
    const g = newCanvas(W, H);
    // rows read straight out of the cpu canvas and written into the gpu one (no full-size snapshot)
    const gx = g.getContext('2d'), cx = c.getContext('2d', { willReadFrequently: true }), bh = Math.max(16, Math.ceil(1e6 / c.width));
    for (let y = 0; y < c.height; y += bh) {
      gx.putImageData(cx.getImageData(0, y, c.width, Math.min(bh, c.height - y)), ox, oy + y);
      gpuFlush(g);
      yield 'gpu upload';
    }
    c.width = c.height = 0;
    return g;
  }

  // small ground details, crisp at display resolution: grass tufts, flowers, pebbles, ferns on
  // forest floors, stones on highland, dry tufts in the desert, snow-dusted tufts in winter.
  // spacing is in css px, so the density on screen is the same at any map size; same-coloured
  // details are batched into one path each (a few strokes/fills for thousands of details)
  drawGroundDetail(x, px) { for (const _ of this.groundDetailSteps(x, px));   /* eslint-disable-line no-unused-vars */ }

  // the same in slices: every few rows of slots the batches are drawn and started anew
  *groundDetailSteps(x, px) {
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
    // draw what the batches hold so far (same order of colours as one big batch per colour)
    const flush = () => {
      x.save();
      x.lineCap = 'round';
      x.lineWidth = Math.max(0.8, this.size / 1400) * ms * px;
      for (const [key, pth] of batches) {
        const [kind, col] = key.split('|');
        if (kind === 'stroke') { x.strokeStyle = col; x.stroke(pth); } else { x.fillStyle = col; x.fill(pth); }
      }
      x.restore();
      batches.clear();
    };
    let i = 0, row = 0;
    for (let gy = step / 2; gy < g; gy += step) {
      if (++row % 4 === 0) { flush(); cpuFlush(x); yield 'detail'; }
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
    flush();
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
    // shadows fall on the island only: over the fog they'd darken the canvas rectangle, whose
    // edge then shows against the moving fog layers. clip to the island outline (grid units)
    const css0 = ctx.getTransform();
    ctx.transform(this.scale, 0, 0, this.scale * this.tilt, 0, this.oy);
    ctx.clip(this.outerP);
    ctx.setTransform(css0);
    ctx.globalAlpha = 0.085;
    for (let n = 0; n < 3; n++) {
      const span = w * 1.6, sw = w * (0.32 + 0.1 * n);
      const cx = ((time * w * 0.006 * (1 + n * 0.3) + (n * span) / 3) % span) - w * 0.3;
      const cy = h * (0.3 + 0.22 * n);
      ctx.drawImage(shadowBlob, cx - sw / 2, cy - sw * 0.3, sw, sw * 0.6);
    }
    ctx.restore();
  }

  // river footprint for placing details: every river point with the half-width of its drawn band
  // (water + foam + shore, same formula as drawRivers) in grid units at the current size, in a
  // coarse bucket grid. rebuilt when the size changes (rivers are drawn wider on small screens)
  riverIndex() {
    if (this.rivIdx && this.rivIdx.size === this.size) return this.rivIdx;
    const dt = this.map.detail ?? 1, f = Math.max(1, this.size / 700) / this.scale, bs = 8, b = new Map();
    let maxH = 0;
    for (const pts of this.map.rivers ?? []) {
      const len = pts.length;
      pts.forEach(([x, y], j) => {
        const piece = Math.min(5, Math.floor((j * 6) / len));   // drawRivers' 6 widening pieces
        const h = (((3.4 + 6.5 * ((piece + 1) / 6)) * (0.65 + 0.35 * dt) + 5) * f) / 2;
        if (h > maxH) maxH = h;
        const key = Math.floor(y / bs) * 4096 + Math.floor(x / bs);
        (b.get(key) ?? b.set(key, []).get(key)).push([x, y, h]);
      });
    }
    return (this.rivIdx = { size: this.size, b, bs, maxH });
  }

  // is grid point (x, y) on a river? true when it lies within the band's half-width * k + pad
  // (grid units). k < 1 allows the outer bank (reeds), pad > 0 keeps a margin (buildings, crowns)
  nearRiver(x, y, pad = 0, k = 1) {
    const { b, bs, maxH } = this.riverIndex();
    if (!b.size) return false;
    const reach = maxH * k + pad;
    if (reach <= 0) return false;
    for (let by = Math.floor((y - reach) / bs); by <= Math.floor((y + reach) / bs); by++) {
      for (let bx = Math.floor((x - reach) / bs); bx <= Math.floor((x + reach) / bs); bx++) {
        for (const [rx, ry, h] of b.get(by * 4096 + bx) ?? []) {
          const r = h * k + pad;
          if ((rx - x) ** 2 + (ry - y) ** 2 < r * r) return true;
        }
      }
    }
    return false;
  }

  // could any point of grid box [x0, y0, x1, y1] (cells, inclusive) be near a river with margin pad?
  // false = none is (nearRiver can be skipped for the whole box)
  riverInBox([x0, y0, x1, y1], pad = 0) {
    const { b, bs, maxH } = this.riverIndex();
    if (!b.size) return false;
    const r = maxH + pad;
    for (let by = Math.floor((y0 - r) / bs); by <= Math.floor((y1 + 1 + r) / bs); by++) {
      for (let bx = Math.floor((x0 - r) / bs); bx <= Math.floor((x1 + 1 + r) / bs); bx++) if (b.has(by * 4096 + bx)) return true;
    }
    return false;
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
  buildRocks() { runSteps(this.buildRocksSteps()); }
  // drawn on a cpu canvas covering only the mountains (plus shadow and wall height), in steps:
  // shadow, the side walls smeared up (~7 copies instead of ~70 fills of the whole outline), top
  // face, cracks, outline. then moved to a full-size gpu canvas
  *buildRocksSteps() {
    const W = this.W, H = this.H, mb = this.mtnBox, px = 1 / this.scale;
    if (!mb) { this.rocks = this.worker ? { cpu: newCanvas(1, 1), ox: 0, oy: 0, W, H } : newCanvas(W, H); return; }
    const hgt = (Math.max(4, this.size * 0.03) * px) / this.tilt, br = Math.max(1, this.size * 0.006) * this.dpr;
    const kx = this.dpr * this.scale, ky = kx * this.tilt, oy = this.dpr * this.oy, m = 3 * br + 6;
    const left = Math.max(0, Math.floor(kx * mb[0] - m)), right = Math.min(W, Math.ceil(kx * (mb[2] + 1 + hgt * 0.3) + m));
    const top = Math.max(0, Math.floor(ky * (mb[1] - hgt) + oy - m)), bottom = Math.min(H, Math.ceil(ky * (mb[3] + 1 + hgt * 0.15) + oy + m));
    const c = newCanvas(right - left, bottom - top);
    const x = ctx2d(c, true);
    x.imageSmoothingQuality = 'high';
    const T = (q) => q.setTransform(kx, 0, 0, ky, -left, oy - top);   // grid units, like gridT
    yield* this.rockSteps(x, c, T, px, hgt, br, ky);
    this.rocks = yield* this.toGpuSteps(c, left, top, W, H);
  }
  *rockSteps(x, c, T, px, hgt, br, ky) {
    const t = this.theme, g = this.map.grid;
    // soft contact shadow, blurred at 1/4 resolution and scaled up (16x fewer pixels to blur)
    const q = 4, sh = newCanvas(Math.ceil(c.width / q), Math.ceil(c.height / q));
    const hx = ctx2d(sh, true);
    hx.scale(1 / q, 1 / q);
    T({ setTransform: (a, b, cc, d, e, f) => hx.transform(a, b, cc, d, e, f) });
    hx.filter = `blur(${br / q}px)`;
    hx.fillStyle = 'rgba(25,30,35,0.3)';
    hx.translate(hgt * 0.3, hgt * 0.15);
    hx.fill(this.mtnP);
    x.save();
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.imageSmoothingEnabled = true;
    x.drawImage(sh, 0, 0, sh.width * q, sh.height * q);
    x.restore();
    sh.width = sh.height = 0;
    cpuFlush(x);
    yield 'rocks shadow';
    // side walls: the outline filled once and smeared upward by copying the canvas onto itself
    // shifted 1, 2, 4 ... px; dark lower part, then the lighter upper part on top
    const S = newCanvas(c.width, c.height);
    const sx = ctx2d(S, true);
    const wall = function* (color, from, to) {   // grid y units, from < to
      sx.setTransform(1, 0, 0, 1, 0, 0);
      sx.clearRect(0, 0, S.width, S.height);
      T(sx);
      sx.fillStyle = css(color);
      sx.fill(this.mtnP);
      sx.setTransform(1, 0, 0, 1, 0, 0);
      const len = Math.round((to - from) * ky);
      for (let done = 0; done < len;) { const d = Math.min(done + 1, len - done); sx.drawImage(S, 0, -d); done += d; cpuFlush(sx); yield 'rocks wall'; }
      x.save();
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.drawImage(S, 0, -Math.round(from * ky));
      x.restore();
      cpuFlush(x);
      yield 'rocks wall';
    };
    yield* wall.call(this, t.rockSideDark, 0, hgt * 0.55);
    yield* wall.call(this, t.rockSide, hgt * 0.55, hgt);
    S.width = S.height = 0;
    // top face with a gentle gradient
    T(x);
    x.save();
    x.translate(0, -hgt);
    const grad = x.createLinearGradient(0, 0, g, g);
    grad.addColorStop(0, css(shade(t.rockTop, 0.06)));
    grad.addColorStop(1, css(shade(t.rockTop, -0.1)));
    x.fillStyle = grad;
    x.fill(this.mtnP);
    cpuFlush(x);
    yield 'rocks top';
    // cracks
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
    cpuFlush(x);
    yield 'rocks cracks';
    // outline
    x.lineJoin = 'round';
    x.lineWidth = Math.max(1, this.size * 0.0025) * px;
    x.strokeStyle = css(t.rockSideDark, 0.85);
    x.stroke(this.mtnP);
    x.restore();
    cpuFlush(x);
    yield 'rocks outline';
  }

  // composite 1: base + flat building scenes
  buildGroundLayer() { runSteps(this.groundLayerSteps()); }

  // a composite built in pieces, each flushed to the gpu in its own frame: the static layer (a gpu
  // copy), then sprites (~1 M px of uploads per frame). kept only if the view kept its size meanwhile
  *compositeSteps(L, sprites, extra) {
    const [c, x] = this.newLayer(), size = this.size, dpr = this.dpr;
    x.save();
    x.setTransform(1, 0, 0, 1, 0, 0);
    if (L) x.drawImage(L, 0, 0);   // gpu to gpu
    let px = 0;
    for (const sp of sprites) {
      this.blit(x, sp);
      px += sp.c.width * sp.c.height;
      if (px > 1e6) { px = 0; gpuFlush(c); yield 'gpu sprites'; }
    }
    x.restore();
    if (extra) { x.save(); extra.call(this, x); x.restore(); }
    gpuFlush(c);
    yield 'gpu composite';
    return this.size === size && this.dpr === dpr ? c : null;
  }
  *groundLayerSteps() {
    if (!this.base) yield* this.buildBaseSteps();
    const sprites = [];
    this.st.forEach((s, id) => { if (s.building) sprites.push(this.groundSprite(id, s.building)); });
    const c = yield* this.compositeSteps(this.base, sprites, (x) => this.groundExtras(x, null));
    if (c) this.layerGround = c;
  }

  // start of a composite draw: device px; r = [x0, y0, x1, y1] limits it to that box (cleared first)
  clipTo(x, r) {
    x.setTransform(1, 0, 0, 1, 0, 0);
    if (!r) return;
    x.beginPath();
    x.rect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
    x.clip();
    x.clearRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
  }

  // box r of a static layer (gpu canvas, same size as the composites) into x
  copyIn(x, L, r) {
    const x0 = Math.max(0, r[0]), y0 = Math.max(0, r[1]), x1 = Math.min(L.width, r[2]), y1 = Math.min(L.height, r[3]);
    if (x1 > x0 && y1 > y0) x.drawImage(L, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  }

  // composite 1 inside box r (a patch)
  groundInto(x, r) {
    const hit = (sp) => sp.left < r[2] && sp.left + sp.c.width > r[0] && sp.top < r[3] && sp.top + sp.c.height > r[1];
    x.save();
    this.clipTo(x, r);
    this.copyIn(x, this.base, r);
    this.st.forEach((s, id) => { if (s.building) { const sp = this.groundSprite(id, s.building); if (hit(sp)) this.blit(x, sp); } });
    this.groundExtras(x, r);
    x.restore();
  }

  // composite 1's top: rivers and the trait tiles' dashed inner borders (all, or the tiles meeting box r)
  groundExtras(x, r) {
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
      if (!col || (r && !this.rectHits(id, r))) return;
      x.save();
      x.clip(this.segP[id]);
      // dashed, so it never reads as an owner's (solid) border
      x.lineWidth = (band + inner) * 2;
      x.setLineDash([7 * px * bw, 4 * px * bw]);
      x.strokeStyle = css(col, 0.85);
      x.stroke(this.segP[id]);
      x.restore();
    });
  }

  // tile id's sprite box meets device px box r
  rectHits(id, r) {
    const q = this.tileRect(id);
    return q[0] < r[2] && q[2] > r[0] && q[1] < r[3] && q[3] > r[1];
  }

  // composite 2: owner overlays
  buildOwnerLayer() { runSteps(this.ownerLayerSteps()); }
  *ownerLayerSteps() {
    const sprites = [];
    this.st.forEach((s, id) => { if (s.color) sprites.push(this.overlaySprite(id, s.color, s.fill)); });
    const c = yield* this.compositeSteps(null, sprites, null);
    if (c) this.layerOwner = c;
  }
  ownerInto(x, r) {
    x.save();
    this.clipTo(x, r);
    this.st.forEach((s, id) => { if (s.color && this.rectHits(id, r)) this.blit(x, this.overlaySprite(id, s.color, s.fill)); });
    x.restore();
  }

  // composite 3: rocks, then trees or building scenes per segment, back to front
  buildObjectLayer() { runSteps(this.objectLayerSteps()); }
  // tiles back to front (objects of a lower tile overlap the one behind it)
  depthOrder() { return (this.order ??= this.map.segs.map((s) => s.id).sort((a, b) => this.map.segs[a].y - this.map.segs[b].y)); }
  objSprite(id) { const s = this.st[id]; return s.building ? this.topSprite(id, s.building, s.color, s.skin) : this.treeSprite(id, s.huts); }
  *objectLayerSteps() {
    if (!this.rocks) yield* this.buildRocksSteps();
    const c = yield* this.compositeSteps(this.rocks, this.depthOrder().map((id) => this.objSprite(id)), null);
    if (c) this.layerObjects = c;
  }
  objectsInto(x, r) {
    x.save();
    this.clipTo(x, r);
    this.copyIn(x, this.rocks, r);
    for (const id of this.depthOrder()) if (this.rectHits(id, r)) this.blit(x, this.objSprite(id));
    x.restore();
  }

  // trees of one segment: round crowns or low-poly pines with trunk and shadow
  // keep(tree, px, py) -> false skips an object (building tiles leave their clearings empty)
  drawTreesOf(x, id, keep = null) { runSteps(this.treesSteps(x, id, keep)); }
  *treesSteps(x, id, keep = null) {
    const t = this.segTheme ? this.segTheme[id] : this.theme, sc = this.scale;
    x.save();
    this.cssT(x);
    let n = 0, rmax = 0;
    for (const tr of this.trees) if (tr.seg === id && tr.r > rmax) rmax = tr.r;
    const dry = !this.riverInBox(this.boxes[id], rmax * 0.8);
    for (const tr of this.trees) {
      if (tr.seg !== id) continue;
      if (++n % 20 === 0) { cpuFlush(x); yield 'trees'; }
      const px = this.sx(tr.x), py = this.sy(tr.y), r = Math.max(1.6, tr.r * sc);
      // nothing stands in a river: trees and boulders keep their crown off the band, reeds may
      // grow on the outer bank only
      if (!dry && (tr.kind === 'reed' ? this.nearRiver(tr.x, tr.y, 0, 0.6) : this.nearRiver(tr.x, tr.y, tr.r * 0.8))) continue;
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
  // just below it (buildings stand upward), at least sep css px apart. every spot must keep its
  // building on the island: the first spot (the main building: castle, hamlet, keep) wants
  // mainR of land around it, the others (tents, houses, beds) want secR. spots with less room
  // to the coast only come after all roomier ones, so nothing hangs over the fog unless the tile
  // is simply too small (then the scene shrinks to fit, see structures.js)
  spots(id, n, sep) {
    const key = `${id}:${n}:${Math.round(sep)}`;
    if (this.spotCache.has(key)) return this.spotCache.get(key);
    const { bdist, grid: g } = this.map, sc = this.scale, u = this.u / sc;
    const wet = (x, y) => this.nearRiver(x, y, u * 3);   // building footprint margin
    const cells = this.segCells[id], cd = this.coastD;
    const mainR = this.u * 6.2 / sc, secR = Math.max(this.u * 2.6, sep * 0.45) / sc;   // grid units
    // room score: how much of the wanted land radius r the cell has (capped, in 0.5 u steps so
    // the depth / label rules still decide among cells that all fit)
    // cells 1.5-3 u from a river count 1.5 u less room: a tile cut by a river may only have dry
    // cells at the coast, and a house close to the bank looks better than one on the fog
    // room is measured 0.5 u above the base point: scenes (hamlet rings, courtyards) centre there
    const up = Math.round((this.u * 0.5) / (sc * this.tilt)) * g;
    const room = (e, r) => Math.floor(Math.min(cd[Math.max(0, e[3] - up)], r) / (u * 0.5)) - (e[4] ? 3 : 0);
    const { cand, late } = this.spotCand(id);
    const order = (r) => [...cand.map((e) => [room(e, r), 1, e]), ...late.map((e) => [room(e, r), 0, e])]
      .sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2][0] - a[2][0]).map((o) => o[2]);
    const out = [];
    const take = (list, gap) => {
      for (const [, x, y] of list) {
        if (out.length >= n) break;
        if (out.every((p) => Math.hypot(this.sx(p[0]) - this.sx(x), this.sy(p[1]) - this.sy(y)) >= gap)) out.push([x, y]);
      }
    };
    take(order(mainR), Infinity);   // main building: the roomiest spot
    if (n > 1) take(order(secR), sep);
    // small segment: relax (closer together) so there is always at least one spot
    // (dry cells first; a river cell only as the very last resort)
    if (out.length < n) {
      const all = cells.map((c) => [Math.min(cd[c], secR) * 100 + bdist[c], (c % g) + 0.5, Math.floor(c / g) + 0.5]).sort((a, b) => b[0] - a[0]);
      take(all.filter(([, x, y]) => !wet(x, y)), sep * 0.4);
      if (out.length < n) take(all.filter(([, x, y]) => !this.nearRiver(x, y)), sep * 0.4);
      if (out.length < n) take(all, sep * 0.4);
    }
    const res = out.map((p) => [this.sx(p[0]), this.sy(p[1])]);
    this.spotCache.set(key, res);
    return res;
  }

  // the candidate cells for spots() on tile id (every 2nd cell, with its dry / damp state), cached
  // per tile: the river test per cell is the costly part. the idle prep makes them in steps
  spotCand(id) { return this.candCache.get(id) ?? runSteps(this.spotCandSteps(id)); }
  *spotCandSteps(id) {
    const have = this.candCache.get(id);
    if (have) return have;
    const { bdist, grid: g, segs } = this.map, s = segs[id], sc = this.scale, u = this.u / sc;
    const cells = this.segCells[id], dry = !this.riverInBox(this.boxes[id], u * 3);
    const cand = [], late = [];
    for (let i = 0; i < cells.length; i += 2) {
      if (i % 200 === 198) yield 'cand';
      const c = cells[i], x = (c % g) + 0.5, y = Math.floor(c / g) + 0.5, dx = x - s.x, dy = (y - s.y) * this.tilt;
      const damp = !dry && this.nearRiver(x, y, u * 3);   // building footprint margin
      if (damp && this.nearRiver(x, y, u * 1.5)) continue;   // no house on a river
      const e = [Math.min(bdist[c], 40 * this.k) + hash(c, 7, this.seed) * 3, x, y, c, damp];
      // the label area is allowed too, but only after every free cell with as much room
      if (Math.hypot(dx, dy) < u * 4.5 || (Math.abs(dx) < u * 4 && dy > 0 && dy < u * 7)) late.push(e); else cand.push(e);
    }
    const res = { cand, late };
    this.candCache.set(id, res);
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
      if (this.nearRiver((c % g) + 0.5, Math.floor(c / g) + 0.5, (this.u * 1.5) / this.scale)) continue;   // no tower in a river
      if (this.coastD[c] * this.scale < this.u * 1.3) continue;   // tower base must stay on the island
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
      if (this.nearRiver((c % g) + 0.5, Math.floor(c / g) + 0.5, (sp * 0.4) / this.scale)) continue;   // no figures in a river
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
    // per tile keys: a few changed tiles (a capture, a new building) are redrawn in place inside
    // their box (patchLayers); many at once (new map, first paint) rebuild the whole composite
    const bkey = this.st.map((s) => (s.building ? s.building + (s.color ?? '') + (s.skin ?? '') : s.huts ? 'h' : ''));
    const okey = this.st.map((s) => (s.color ? s.color.join(',') + ':' + s.fill : ''));
    const diff = (a, b) => (a && a.length === b.length ? b.reduce((d, k, i) => (k !== a[i] ? (d.push(i), d) : d), []) : null);
    const db = diff(this.bkey, bkey), dob = diff(this.okey, okey), most = Math.max(3, this.st.length * 0.3);
    this.bkey = bkey;
    this.okey = okey;
    if (!db || db.length > most) { this.layerGround = this.layerObjects = null; this.dirtyB = []; }
    else this.dirtyB = [...new Set([...(this.dirtyB ?? []), ...db])];
    if (!dob || dob.length > most) { this.layerOwner = null; this.dirtyO = []; }
    else this.dirtyO = [...new Set([...(this.dirtyO ?? []), ...dob])];
  }

  // device px box that every sprite of tile id fits in (the biggest margin: building top scenes)
  tileRect(id) {
    const [bx0, by0, bx1, by1] = this.boxes[id], d = this.dpr, m = this.u * 7;
    return [Math.floor((this.sx(bx0) - m) * d), Math.floor((this.sy(by0) - m * 1.6) * d), Math.ceil((this.sx(bx1 + 1) + m) * d), Math.ceil((this.sy(by1 + 1) + m * 0.6) * d)];
  }

  // redraw the changed tiles' boxes in the existing composites (a few sprite blits each), instead of
  // new full-screen canvases: those cost a 30-60 ms gpu frame on every capture
  patchLayers() {
    const run = (ids, L, into) => {
      if (!L) return;
      const x = L.getContext('2d');
      for (const id of ids) into.call(this, x, this.tileRect(id));
    };
    if (this.dirtyB?.length || this.dirtyO?.length) window.__mk?.('patch');   // tests: time marks
    if (this.dirtyB?.length) { const ids = this.dirtyB; this.dirtyB = []; run(ids, this.layerGround, this.groundInto); run(ids, this.layerObjects, this.objectsInto); }
    if (this.dirtyO?.length) { const ids = this.dirtyO; this.dirtyO = []; run(ids, this.layerOwner, this.ownerInto); }
  }

  // clear and draw all layers; returns ctx in css-pixel units
  drawBase() {
    if (!this.under) this.buildUnder();
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.under, 0, 0);
    if (this.st) {
      if (!this.layerGround) this.buildGroundLayer();
      if (!this.layerOwner) this.buildOwnerLayer();
      if (!this.layerObjects) this.buildObjectLayer();
      this.patchLayers();
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
// map worker: every static layer (under, base, rocks) and tile sprite of a view of `map` at css size
// `size` / density dpr, drawn on cpu OffscreenCanvases with the same code the page uses, plus the
// sprites a battle may need later (trees with / without huts, every side's overlay on every tile).
// returned as transferable ImageBitmaps (layers in ~1 M px bands) for MapView.takePaintSteps;
// st = the page's per-tile styles (MapView.paint)
export function paintInWorker(map, theme, size, dpr, st, colors, fill) {
  const v = Object.create(MapView.prototype);
  v.headless = v.worker = true;
  runSteps(v.setMapSteps(map, theme));
  v.setSize(size, dpr);
  v.st = st;
  runSteps(v.buildUnderSteps());
  runSteps(v.buildBaseSteps());
  runSteps(v.buildRocksSteps());
  for (let id = 0; id < st.length; id++) {
    const s = st[id];
    v.spots(id, 1, 0);
    if (s.building) { v.groundSprite(id, s.building); v.topSprite(id, s.building, s.color, s.skin); } else v.treeSprite(id, s.huts);
    if (s.color) v.overlaySprite(id, s.color, s.fill);
  }
  runSteps(v.warmSteps(colors, fill));
  const bands = (c) => {
    const out = [], bh = Math.max(16, Math.ceil(1e6 / c.width));
    for (let y = 0; y < c.height; y += bh) {
      const b = new OffscreenCanvas(c.width, Math.min(bh, c.height - y));
      b.getContext('2d').drawImage(c, 0, -y);
      out.push({ y, bmp: b.transferToImageBitmap() });
    }
    return out;
  };
  const layer = (L) => (L.cpu ? { W: L.W, H: L.H, ox: L.ox, oy: L.oy, bands: bands(L.cpu) } : { W: L.width, H: L.height, ox: 0, oy: 0, bands: bands(L) });
  const res = { size, dpr, under: layer(v.under), base: layer(v.base), rocks: layer(v.rocks), sprites: [], spots: [...v.spotCache] };
  for (const [k, sp] of v.sprites) res.sprites.push([k, sp.c.transferToImageBitmap(), sp.left, sp.top]);
  const transfer = [res.under, res.base, res.rocks].flatMap((L) => L.bands.map((b) => b.bmp)).concat(res.sprites.map((e) => e[1]));
  return { res, transfer };
}

const unitCache = new Map();
// one foglet (the troop figure), feet at (mx, my), sc = size (1 = the 5 x 8 map figure); also drawn
// big on the menu. body block in the team colour with a shaded side, square head, then a kit that
// changes the whole silhouette:
//   soldier: kettle helmet, belt, spear · knight: steel breastplate with a team stripe, plumed helm,
//   shield · viking: horned helmet, big beard, fur collar, round shield · archer: green hood and
//   cape, quiver, bow · wizard: long flared robe with gold hem, pointed hat with a star, white beard,
//   staff · pirate: striped shirt, eyepatch, tricorne, cutlass · barbarian: bare chest, fur kilt in
//   the team colour, fur hood with ears, big club
// figure looks (settings, setFigureStyle): polished (default: 3-tone shading, trims, dot eyes) ·
// faces (big eyes, brows and a mood per kit) · worn (battle-worn: more gear, muted colours, dirt,
// scratches). small details only show once a unit is a few pixels big, so the map stays clean
export const figureStyles = { polished: 'Classic', faces: 'Faces', worn: 'Battle-worn' };
let figLook = 'polished';
export function setFigureStyle(s) {
  figLook = figureStyles[s] ? s : 'polished';
  unitCache.clear();   // cached map sprites use the old look
}
export function drawFoglet(x, mx, my, sc, col, style = 'soldier', opts = {}) {
  const worn = figLook === 'worn';
  // pixels per figure unit on screen: decides how much detail is worth drawing
  const tf = x.getTransform(), ppu = sc * Math.hypot(tf.a, tf.b);
  const D = ppu < 2.6 ? 0 : worn ? 2 : 1;   // detail level
  const faceLv = opts.noFace || ppu < 2.2 ? 0 : figLook === 'faces' && ppu >= 4 ? 3 : 1;
  // colour helper: any colour (rgb array, #hex, css string) -> css, lighter (k > 0) or darker (k < 0);
  // battle-worn pulls colours toward grey
  const C = (c, k = 0, a = 1) => {
    if (typeof c === 'string') { if (c[0] !== '#') return c; c = hexToRgb(c); }
    let v = c;
    if (worn) { const m = (v[0] + v[1] + v[2]) / 3; v = mix(v, [m, m, m], 0.25); }
    return css(k ? shade(v, k) : v, a);
  };
  const skin = '#ecceb0', skinD = '#d4b496', steel = '#c4ccd4', steelD = '#8e98a2', wood = '#7a5230', woodD = '#5a3a20', gold = '#ffd76a', fur = '#8a6a48';
  const X = (px) => mx + px * sc, Y = (py) => my + py * sc;
  const R = (l, t, w, h, c) => { x.fillStyle = C(c); x.fillRect(X(l), Y(t), w * sc, h * sc); };
  const poly = (c, pts) => { x.fillStyle = C(c); x.beginPath(); pts.forEach(([px, py], i) => (i ? x.lineTo : x.moveTo).call(x, X(px), Y(py))); x.closePath(); x.fill(); };
  const disc = (c, px, py, r) => { x.fillStyle = C(c); x.beginPath(); x.arc(X(px), Y(py), r * sc, 0, Math.PI * 2); x.fill(); };
  const ell = (c, px, py, rx, ry) => { x.fillStyle = C(c); x.beginPath(); x.ellipse(X(px), Y(py), rx * sc, ry * sc, 0, 0, Math.PI * 2); x.fill(); };
  const line = (c, w, pts, cap = 'round') => { x.strokeStyle = C(c); x.lineCap = cap; x.lineJoin = 'round'; x.lineWidth = w * sc; x.beginPath(); pts.forEach(([px, py], i) => (i ? x.lineTo : x.moveTo).call(x, X(px), Y(py))); x.stroke(); };
  const dash = (on) => x.setLineDash(on ? [0.18 * sc, 0.14 * sc] : []);
  const body = col, side = C(col, -0.3), light = C(col, 0.3);

  // --- behind the body: capes, quivers, staffs ---
  if (style === 'archer') {
    poly('#2f6a35', [[-1.5, -4.1], [1.5, -4.1], [1.9, -0.2], [-1.9, -0.2]]);   // cape
    if (D) for (let i = 0; i < 4; i++) line('#24552a', 0.08, [[-1.3 + i * 0.85, -3.6], [-1.5 + i, -0.3]]);   // folds
    R(-1.9, -5.6, 0.7, 2.6, '#8a5a34');   // quiver
    if (D) { R(-1.9, -4.9, 0.7, 0.18, '#5e3b20'); R(-1.9, -3.6, 0.7, 0.18, '#5e3b20'); }
    for (const [ax, ay] of [[-1.75, -6.4], [-1.4, -6.5], [-1.58, -6.25]]) {   // arrows with team fletching
      line('#d8c8a0', 0.12, [[ax, -5.6], [ax, ay]]);
      if (D) poly(C(col, 0.1), [[ax - 0.16, ay + 0.35], [ax, ay - 0.05], [ax + 0.16, ay + 0.35], [ax, ay + 0.2]]);
    }
  }
  if (style === 'wizard') {
    line(wood, 0.32, [[-1.95, -0.2], [-1.95, -5.9]]);
    if (D) for (let y = -5.4; y < -4.4; y += 0.25) line(woodD, 0.1, [[-2.12, y], [-1.78, y + 0.12]]);   // grip wrap
    disc('#9fe6ff', -1.95, -6.2, 0.5); disc('rgba(255,255,255,0.9)', -2.08, -6.34, 0.17);
    if (D) line(gold, 0.12, [[-2.4, -6.0], [-1.95, -5.75], [-1.5, -6.0]]);   // gem claws
  }
  if (style === 'pirate' && D) line('#2a2a30', 0.18, [[0.5, -4.3], [1.5, -3]]);   // baldric

  // --- body ---
  if (style === 'wizard') {
    poly(body, [[-1.2, -4.1], [1.2, -4.1], [1.8, 0], [-1.8, 0]]);   // flared robe
    poly(side, [[0.25, -4.1], [1.2, -4.1], [1.8, 0], [0.45, 0]]);
    R(-1.8, -0.45, 3.6, 0.45, gold);
    if (D) {
      for (const [sx, sy] of [[-0.8, -2.8], [-0.2, -1.4], [-1.1, -1.0], [0.9, -2.1], [-0.4, -3.4]])   // stars
        poly(gold, [[sx, sy - 0.22], [sx + 0.07, sy - 0.07], [sx + 0.22, sy], [sx + 0.07, sy + 0.07], [sx, sy + 0.22], [sx - 0.07, sy + 0.07], [sx - 0.22, sy], [sx - 0.07, sy - 0.07]]);
      R(-1.3, -2.4, 2.6, 0.3, gold);   // sash
      for (let i = 0; i < 6; i++) disc('#e8b84a', -1.6 + i * 0.64, -0.23, 0.08);
    }
  } else if (style === 'barbarian') {
    R(-1.3, -4, 2.6, 2, skin); R(0.2, -4, 1.1, 2, skinD);   // bare chest
    if (D) { line('#c8a080', 0.07, [[-0.9, -3.5], [-0.15, -3.3]]); line('#c8a080', 0.07, [[-0.05, -3.3], [0.6, -3.5]]); line('#c8a080', 0.06, [[-0.3, -2.9], [-0.3, -2.2]]); }   // muscles
    if (D > 1 || faceLv === 3) { line('#3a6ad0', 0.14, [[-1.0, -3.0], [-0.55, -3.0]]); line('#3a6ad0', 0.14, [[-1.0, -2.65], [-0.55, -2.65]]); }   // war paint
    line('#6e4a2c', 0.3, [[-1.2, -3.9], [1.2, -2.2]]);   // strap
    if (D) {
      for (let i = 0; i < 4; i++) disc(steel, -0.85 + i * 0.6, -3.58 + i * 0.42, 0.07);   // strap studs
      line('#5e3b20', 0.06, [[-0.9, -4], [-0.5, -3.55], [0, -3.45], [0.5, -3.55], [0.9, -4]]);   // tooth necklace
      for (const tx of [-0.5, 0, 0.5]) poly('#f4ead2', [[tx - 0.09, -3.5], [tx + 0.09, -3.5], [tx, -3.18]]);
    }
    R(-1.3, -2, 2.6, 2, body); R(0.2, -2, 1.1, 2, side);   // fur kilt
    for (let i = 0; i < 4; i++) poly(side, [[-1.3 + i * 0.65, -0.05], [-1 + i * 0.65, 0.35], [-0.65 + i * 0.65, -0.05]]);
    if (D) for (let i = 0; i < 9; i++) line(C(col, -0.42), 0.06, [[-1.15 + i * 0.29, -1.8 + (i % 2) * 0.2], [-1.2 + i * 0.29, -1.3 + (i % 3) * 0.15]]);   // fur strands
  } else {
    R(-1.3, -4, 2.6, 4, body); R(0.2, -4, 1.1, 4, side);
    // 3-tone shading: lit strip on the left edge, darker hem
    R(-1.3, -4, 0.3, 4, light); R(-1.3, -0.35, 2.6, 0.35, C(col, -0.45));
  }
  if (style === 'pirate') {
    for (const y of [-3.4, -2.4, -1.4]) R(-1.3, y, 2.6, 0.45, 'rgba(255,255,255,0.88)');
    if (D) for (const y of [-3.4, -2.4, -1.4]) R(0.2, y, 1.1, 0.45, 'rgba(0,0,0,0.12)');
  }
  if (style === 'soldier' || style === 'pirate') {
    R(-1.3, -2, 2.6, 0.4, '#5e3b20');   // belt
    if (D) { R(-0.3, -2.07, 0.6, 0.54, style === 'pirate' ? gold : '#c9a23a'); R(-0.15, -1.93, 0.3, 0.26, '#5e3b20'); }   // buckle
  }
  if (style === 'soldier' && D) {
    line('#6e4a2c', 0.24, [[-1.2, -3.9], [1.2, -2.1]]);   // cross strap
    R(-1.15, -1.6, 0.75, 0.65, '#6e5030'); R(-1.15, -1.6, 0.75, 0.2, '#56391f');   // pouch
    if (D > 1) { R(0.45, -1.6, 0.7, 0.65, '#6e5030'); R(0.45, -1.6, 0.7, 0.2, '#56391f'); }
    for (const y of [-3.3, -2.7]) disc(C(col, -0.5), -0.05, y, 0.08);   // buttons
  }
  if (style === 'knight') {
    R(-1.3, -4, 2.6, 2.3, steel); R(0.2, -4, 1.1, 2.3, steelD); R(-0.3, -4, 0.6, 4, light);   // breastplate + stripe
    if (D) {
      line('#a8b2bc', 0.06, [[-1.25, -2.9], [1.25, -2.9]]); line('#a8b2bc', 0.06, [[-1.25, -2.3], [1.25, -2.3]]);   // plate segments
      for (const [rx, ry] of [[-1.05, -3.75], [1.05, -3.75], [-1.05, -1.95], [1.05, -1.95]]) disc('#eef2f5', rx, ry, 0.08);   // rivets
      R(-1.3, -1.7, 2.6, 0.3, '#5e3b20'); R(-0.2, -1.75, 0.4, 0.4, gold);   // belt
      R(-1.15, -4, 0.35, 2.3, 'rgba(255,255,255,0.35)');   // shine
    }
  }
  if (style === 'viking') {
    R(-1.45, -4.1, 2.9, 0.7, fur);   // fur collar
    if (D) {
      for (let i = 0; i < 8; i++) line('#6e5034', 0.07, [[-1.35 + i * 0.37, -4.1], [-1.3 + i * 0.37, -3.5]]);
      R(-1.3, -1.95, 2.6, 0.35, '#5e3b20'); R(-0.22, -2, 0.44, 0.45, '#b8c0c8');
    }
  }
  if (style === 'archer' && D) { line('#5e3b20', 0.22, [[1.2, -3.9], [-1.2, -1.9]]); R(-1.3, -1.9, 2.6, 0.32, '#5e3b20'); }
  if (D > 1 && style !== 'barbarian' && style !== 'knight') { dash(1); line(C(col, -0.5), 0.05, [[-0.25, -3.95], [-0.25, -0.5]], 'butt'); dash(0); }   // stitched seam

  // --- head: square with a soft shaded side and a chin shadow ---
  R(-1.15, -6.15, 2.3, 2.25, skin);
  R(0.45, -6.15, 0.7, 2.25, 'rgba(180,140,110,0.35)');
  R(-1.15, -4.12, 2.3, 0.22, 'rgba(160,120,95,0.35)');
  if (faceLv) drawFace(x, mx, my, sc, style, faceLv);

  // --- headgear + kit ---
  if (style === 'soldier') {
    line(wood, 0.35, [[1.8, -0.4], [1.8, -6.4]]);   // spear
    if (D) { line('#3a2414', 0.4, [[1.8, -6.1], [1.8, -6.5]], 'butt'); line(col, 0.22, [[1.8, -5.9], [2.4, -5.6]]); }   // binding + team tie
    poly(steel, [[1.8, -7.15], [1.4, -6.25], [2.2, -6.25]]);
    if (D) poly('#eef2f5', [[1.8, -7.0], [1.62, -6.35], [1.8, -6.35]]);
    ell('#9aa4ae', 0, -6.05, 1.75, 0.35);   // kettle helmet
    R(-0.95, -6.95, 1.9, 0.9, '#9aa4ae');
    if (D) { R(-0.95, -6.95, 0.35, 0.9, steel); ell('#b4bec8', 0, -6.1, 1.6, 0.18); for (const rx of [-0.6, 0, 0.6]) disc('#e2e8ee', rx, -6.3, 0.07); R(-0.95, -6.55, 1.9, 0.14, col); }
  } else if (style === 'knight') {
    R(-1.3, -6.5, 2.6, 1.15, steel); R(0.3, -6.5, 1, 1.15, steelD);   // helm over the brow
    R(-0.12, -5.5, 0.24, 0.8, steelD);   // nose guard
    if (D) { for (let i = 0; i < 3; i++) R(0.45, -5.95 + i * 0.22, 0.6, 0.08, '#5e6870'); disc('#eef2f5', -1.0, -6.2, 0.07); R(-1.3, -6.5, 2.6, 0.16, '#e2e8ee'); }   // vents, rivet, rim
    poly(body, [[-0.3, -6.5], [0.3, -6.5], [1.1, -7.2], [-0.5, -7.2]]);   // plume
    if (D) { line(light, 0.07, [[-0.2, -6.7], [0.6, -7.1]]); line(side, 0.07, [[0, -6.55], [0.9, -7.0]]); }
    R(-2.3, -3.8, 1.3, 2.6, side); R(-2.3, -3.8, 1.3, 0.35, steel);   // shield
    if (D) {   // team crest with a white cross
      poly(body, [[-2.15, -3.4], [-1.15, -3.4], [-1.15, -2.0], [-1.65, -1.45], [-2.15, -2.0]]);
      line('#f2f2f2', 0.2, [[-1.65, -3.25], [-1.65, -1.7]]); line('#f2f2f2', 0.2, [[-2.05, -2.65], [-1.25, -2.65]]);
      for (const sx of [-2.2, -1.1]) disc(steel, sx, -1.3, 0.07);
    } else R(-1.8, -3.5, 0.3, 1.9, '#f2f2f2');
  } else if (style === 'viking') {
    R(-1.25, -6.55, 2.5, 0.85, '#8a9096');
    if (D) { R(-0.12, -6.55, 0.24, 0.85, '#b4bac0'); for (const rx of [-0.8, 0.8]) disc('#c8ced4', rx, -6.15, 0.07); R(-0.1, -5.7, 0.2, 0.55, '#8a9096'); }
    line('#f4ead2', 0.5, [[-1.1, -6.3], [-1.9, -7.1]]); line('#f4ead2', 0.5, [[1.1, -6.3], [1.9, -7.1]]);   // horns
    if (D) { line('#c9b994', 0.52, [[-1.15, -6.3], [-1.32, -6.48]], 'butt'); line('#c9b994', 0.52, [[1.15, -6.3], [1.32, -6.48]], 'butt'); }   // horn rings
    poly('#c8782e', [[-1.15, -4.8], [1.15, -4.8], [0.9, -3.4], [0, -2.9], [-0.9, -3.4]]);   // beard
    if (D) {
      poly('#a85e20', [[0.15, -4.8], [1.15, -4.8], [0.9, -3.4], [0, -2.9]]);
      line('#e09a50', 0.08, [[-0.5, -4.6], [-0.4, -3.4]]); line('#e09a50', 0.08, [[0.35, -4.5], [0.3, -3.3]]);
      R(-0.18, -3.15, 0.36, 0.2, steel);   // braid bead
    }
    disc('#8a5a34', -1.55, -2.3, 1.2);   // round shield: planks, studs, team ring, boss
    if (D) {
      for (let a = 0; a < 4; a++) { const an = a * Math.PI / 4, cx = Math.cos(an) * 1.15, cy = Math.sin(an) * 1.15; line('#6e4426', 0.07, [[-1.55 + cx, -2.3 + cy], [-1.55 - cx, -2.3 - cy]]); }
      for (let a = 0; a < 10; a++) disc(steel, -1.55 + Math.cos(a * 0.628) * 1.05, -2.3 + Math.sin(a * 0.628) * 1.05, 0.07);
    }
    disc(body, -1.55, -2.3, 0.75); disc('#d8dde2', -1.55, -2.3, 0.25);
    if (D) disc('#ffffff', -1.62, -2.37, 0.08);
  } else if (style === 'archer') {
    poly('#3f7a3c', [[-1.35, -4.4], [-1.35, -6.4], [-0.6, -7.2], [1.35, -6.4], [1.35, -5.6], [-0.4, -5.9], [-0.7, -4.4]]);   // hood
    if (D) {
      line('#2f6a35', 0.08, [[-1.1, -6.3], [-0.55, -6.95], [1.1, -6.35]]);
      dash(1); line('#6aa860', 0.05, [[1.3, -5.65], [-0.38, -5.95], [-0.68, -4.5]], 'butt'); dash(0);   // hood stitching
      poly('#c03030', [[-0.6, -7.2], [-0.25, -7.6], [-0.15, -7.0]]);   // feather
    }
    line(wood, 0.4, [[1.4, -6.1], [2.2, -4.6], [2.2, -2.2], [1.4, -0.9]]);   // bow
    if (D) { line('#c9a23a', 0.44, [[2.2, -3.8], [2.2, -3.0]], 'butt'); line('#e8d8b0', 0.1, [[1.4, -6.1], [1.55, -5.85]]); }   // grip
    line('rgba(240,235,220,0.9)', 0.15, [[1.4, -6.1], [1.4, -0.9]]);
  } else if (style === 'wizard') {
    poly('#f4f4f6', [[-0.9, -4.6], [0.95, -4.6], [0.7, -3], [0, -2.4], [-0.6, -3]]);   // beard
    if (D) {
      for (const bx of [-0.4, 0.05, 0.45]) line('#d8d8e0', 0.06, [[bx, -4.5], [bx * 0.6, -2.9]]);
      line('#f4f4f6', 0.3, [[-0.3, -4.7], [-0.95, -4.4]]); line('#f4f4f6', 0.3, [[0.35, -4.7], [1.0, -4.4]]);   // moustache
    }
    poly(side, [[-1.7, -6], [1.7, -6], [0.7, -7.2]]);   // hat
    if (D) { poly(C(col, -0.45), [[0.2, -6], [1.7, -6], [0.7, -7.2]]); poly(side, [[0.7, -7.2], [1.3, -7.35], [1.1, -7.0]]); }   // bent tip
    R(-1.7, -6.15, 3.4, 0.35, side);
    if (D) R(-1.0, -6.15, 2.0, 0.22, gold);   // hat band
    disc(gold, 0.35, -6.55, 0.25);
  } else if (style === 'pirate') {
    R(-1.15, -5.65, 2.3, 0.22, '#1d1d22'); R(0.25, -5.6, 0.6, 0.5, '#1d1d22');   // eyepatch
    if (D) { disc(gold, -1.18, -4.75, 0.12); line('#3a2414', 0.25, [[-0.8, -4.3], [0, -4.15], [0.8, -4.3]]); }   // earring + moustache
    poly('#2a2a30', [[-1.9, -6.0], [0, -7.25], [1.9, -6.0], [0, -6.45]]);   // tricorne
    if (D) { line(gold, 0.1, [[-1.9, -6.0], [0, -6.45], [1.9, -6.0]]); poly('#1a1a1f', [[0, -7.25], [1.9, -6.0], [0, -6.45]]); }
    disc('#f2f2f2', 0, -6.75, 0.22);
    if (D) { disc('#1d1d22', -0.07, -6.78, 0.05); disc('#1d1d22', 0.07, -6.78, 0.05); line('#f2f2f2', 0.06, [[-0.2, -6.5], [0.2, -6.42]]); }   // tiny skull
    line('#d4dbe2', 0.38, [[1.3, -1.8], [2.3, -3.2], [2.1, -5.2]]);   // cutlass
    if (D) line('#ffffff', 0.1, [[1.45, -2.0], [2.32, -3.25], [2.17, -4.9]]);
    R(1.05, -2, 0.6, 0.35, '#c9a23a');
  } else if (style === 'barbarian') {
    poly(fur, [[-1.4, -5.1], [-1.4, -6.5], [1.4, -6.5], [1.4, -5.1], [1.05, -5.9], [-1.05, -5.9]]);   // fur hood
    if (D) for (let i = 0; i < 7; i++) line('#6e5034', 0.07, [[-1.25 + i * 0.42, -6.45], [-1.3 + i * 0.42, -6.0]]);
    disc(fur, -1.05, -6.75, 0.42); disc(fur, 1.05, -6.75, 0.42);
    if (D) { disc('#c89a7a', -1.05, -6.75, 0.2); disc('#c89a7a', 1.05, -6.75, 0.2); }
    poly('#6e4a2c', [[1.4, -1.4], [1.85, -1.5], [2.45, -5.1], [1.35, -5]]); disc('#6e4a2c', 1.9, -5.3, 0.65);   // club
    if (D) {
      line('#4e3218', 0.07, [[1.6, -1.6], [1.75, -4.6]]);
      for (const [nx, ny] of [[1.45, -5.5], [2.3, -5.6], [1.9, -5.9], [1.55, -4.85], [2.25, -4.95]]) poly(steel, [[nx - 0.1, ny], [nx + 0.1, ny], [nx, ny - 0.3]]);   // spikes
      line('#3a2414', 0.45, [[1.55, -1.9], [1.75, -1.85]], 'butt');
    }
  }
  // battle-worn: dirt rising from the hem, scuffs and scratches (fixed per kit, so units don't flicker)
  if (worn && ppu >= 2) {
    const g = x.createLinearGradient(0, Y(-2.2), 0, Y(0));
    g.addColorStop(0, 'rgba(70,50,30,0)'); g.addColorStop(1, 'rgba(70,50,30,0.5)');
    x.fillStyle = g; x.fillRect(X(-1.35), Y(-2.2), 2.7 * sc, 2.2 * sc);
    let seed = style.length * 7.3;
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
    for (let i = 0; i < 9; i++) {
      const sx = -1.2 + rnd() * 2.3, sy = -6.4 + rnd() * 6, dx = (rnd() - 0.5) * 0.7, dy = rnd() * 0.4;
      line(rnd() < 0.5 ? 'rgba(255,255,255,0.35)' : 'rgba(30,20,10,0.4)', 0.05, [[sx, sy], [sx + dx, sy + dy]]);
    }
    for (let i = 0; i < 16; i++) disc('rgba(60,45,30,0.25)', -1.25 + rnd() * 2.5, -3.5 + rnd() * 3.4, rnd() * 0.12);
  }
}

// face on the head (centre ~0, -5): lv 1 dot eyes · lv 3 big eyes, brows, mouth and a mood per kit
function drawFace(x, mx, my, sc, kit, lv) {
  const ink = '#2a1e18';
  const dot = (px, py, r, c = ink) => { x.fillStyle = c; x.beginPath(); x.arc(mx + px * sc, my + py * sc, r * sc, 0, Math.PI * 2); x.fill(); };
  const ln = (w, pts, c = ink) => { x.strokeStyle = c; x.lineWidth = w * sc; x.lineCap = 'round'; x.beginPath(); pts.forEach(([px, py], i) => (i ? x.lineTo : x.moveTo).call(x, mx + px * sc, my + py * sc)); x.stroke(); };
  const ox = kit === 'archer' ? 0.18 : 0.08, ey = kit === 'knight' ? -5.05 : -5.15;
  const eyes = kit === 'pirate' ? [-0.45 + ox] : [-0.45 + ox, 0.45 + ox];   // pirate: the other eye is patched
  for (const ex of eyes) {
    if (lv === 3) { dot(ex, ey, 0.28, '#ffffff'); dot(ex + 0.04, ey + 0.02, 0.2); dot(ex - 0.05, ey - 0.07, 0.06, '#ffffff'); }
    else dot(ex, ey, 0.13);
  }
  if (lv < 3) return;
  const beard = kit === 'viking' || kit === 'wizard';
  const mood = { soldier: 'grit', knight: 'proud', viking: 'angry', archer: 'sly', wizard: 'wise', pirate: 'grin', barbarian: 'roar' }[kit];
  const L = -0.45 + ox, Rr = 0.45 + ox, mx0 = mx + ox * sc;
  const brow = (ex, tilt) => ln(0.11, [[ex - 0.25, ey - 0.38 - tilt], [ex + 0.25, ey - 0.38 + tilt]]);
  // brows
  if (mood === 'angry' || mood === 'roar' || mood === 'grit') { brow(L, -0.12); brow(Rr, 0.12); }
  else if (mood === 'sly') { brow(L, 0.06); brow(Rr, -0.1); }
  else if (mood === 'wise') { ln(0.16, [[L - 0.3, ey - 0.4], [L + 0.25, ey - 0.36]], '#f4f4f6'); ln(0.16, [[Rr - 0.25, ey - 0.36], [Rr + 0.3, ey - 0.4]], '#f4f4f6'); }
  else if (mood === 'grin') brow(L, -0.08);
  // mouths (bearded kits keep theirs hidden)
  if (mood === 'grit') { x.fillStyle = '#ffffff'; x.fillRect(mx0 - 0.3 * sc, my - 4.6 * sc, 0.6 * sc, 0.2 * sc); x.strokeStyle = ink; x.lineWidth = 0.05 * sc; x.strokeRect(mx0 - 0.3 * sc, my - 4.6 * sc, 0.6 * sc, 0.2 * sc); }
  if (mood === 'proud') ln(0.08, [[-0.2 + ox, -4.5], [0.05 + ox, -4.4], [0.3 + ox, -4.55]]);
  if (mood === 'sly') ln(0.08, [[-0.2 + ox, -4.45], [0.3 + ox, -4.6]]);
  if (mood === 'grin') { x.fillStyle = ink; x.beginPath(); x.ellipse(mx0 + 0.05 * sc, my - 4.5 * sc, 0.38 * sc, 0.2 * sc, 0, 0, Math.PI); x.fill(); x.fillStyle = '#ffd76a'; x.fillRect(mx0 + 0.15 * sc, my - 4.5 * sc, 0.12 * sc, 0.1 * sc); }
  if (mood === 'roar') { x.fillStyle = '#7a2a20'; x.beginPath(); x.ellipse(mx0 + 0.05 * sc, my - 4.42 * sc, 0.3 * sc, 0.26 * sc, 0, 0, Math.PI * 2); x.fill(); x.fillStyle = '#fff'; x.fillRect(mx0 - 0.15 * sc, my - 4.66 * sc, 0.4 * sc, 0.08 * sc); }
  if (!beard && mood !== 'roar') { dot(-0.85 + ox, -4.7, 0.16, 'rgba(240,120,110,0.35)'); dot(0.85 + ox, -4.7, 0.16, 'rgba(240,120,110,0.35)'); }   // blush
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

// outlined text, readable on any colour. drawn once per look into a sprite (outlined emoji are
// slow to draw, and relic icons are drawn every frame), then stamped; same cache idea as pill
const labelCache = new Map();
export function label(ctx, text, x, y, size, color = '#fff', weight = 800) {
  const k = ctx.getTransform().a;
  const key = `${text}|${size.toFixed(2)}|${color}|${weight}|${k.toFixed(3)}`;
  let p = labelCache.get(key);
  if (!p) {
    if (labelCache.size > 600) labelCache.clear();
    const m = document.createElement('canvas').getContext('2d');
    m.font = `${weight} ${size}px system-ui, sans-serif`;
    const lw = Math.max(2, size / 4), w = m.measureText(text).width + lw * 2 + 4, h = size * 1.5 + lw * 2;
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * k); c.height = Math.ceil(h * k);
    const x2 = c.getContext('2d');
    x2.setTransform(k, 0, 0, k, 0, 0);
    x2.font = m.font;
    x2.textAlign = 'center';
    x2.textBaseline = 'middle';
    x2.lineWidth = lw;
    x2.strokeStyle = 'rgba(25,35,40,0.6)';
    x2.lineJoin = 'round';
    x2.strokeText(text, w / 2, h / 2);
    x2.fillStyle = color;
    x2.fillText(text, w / 2, h / 2);
    p = { c, w: c.width / k, h: c.height / k, ox: w / 2, oy: h / 2 };
    labelCache.set(key, p);
  }
  ctx.drawImage(p.c, x - p.ox, y - p.oy, p.w, p.h);
}

// troop count badge: white rounded pill with an owner-coloured rim and a soft drop shadow.
// every tile and army draws one each frame, so each look (text, size, colours, pixel density) is
// drawn once into a small sprite and stamped from then on (font setup + text drawing were the
// biggest cost of a frame on maps with many tiles). the cache is emptied when it grows large
const pillCache = new Map();
export function pill(ctx, text, x, y, size, rim, ink) {
  const k = ctx.getTransform().a;   // device px per css px of the current transform
  const key = `${text}|${size.toFixed(2)}|${rim}|${ink}|${k.toFixed(3)}`;
  let p = pillCache.get(key);
  if (!p) {
    if (pillCache.size > 1500) pillCache.clear();
    p = pillSprite(text, size, rim, ink, k);
    pillCache.set(key, p);
  }
  ctx.drawImage(p.c, x - p.ox, y - p.oy, p.w, p.h);
}
// one badge drawn at scale k; ox / oy = where the badge centre sits in the sprite (css px)
function pillSprite(text, size, rim, ink, k) {
  const m = document.createElement('canvas').getContext('2d');
  m.font = `800 ${size}px system-ui, sans-serif`;
  const w = Math.max(size * 1.6, m.measureText(text).width + size * 0.9), h = size * 1.4, pad = Math.max(3, size * 0.15);
  const W = w + pad * 2, H = h + pad * 2 + 2;
  const c = document.createElement('canvas');
  c.width = Math.ceil(W * k); c.height = Math.ceil(H * k);
  const x = c.getContext('2d');
  x.setTransform(k, 0, 0, k, 0, 0);
  const cx = W / 2, cy = pad + h / 2;
  x.font = m.font;
  x.fillStyle = 'rgba(20,30,35,0.22)';
  roundRect(x, cx - w / 2 + 1, cy - h / 2 + 2, w, h, h / 2);
  x.fill();
  x.fillStyle = 'rgba(255,255,255,0.93)';
  roundRect(x, cx - w / 2, cy - h / 2, w, h, h / 2);
  x.fill();
  x.lineWidth = Math.max(1.5, size * 0.14);
  x.strokeStyle = rim;
  x.stroke();
  x.fillStyle = ink;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillText(text, cx, cy + size * 0.04);
  return { c, w: c.width / k, h: c.height / k, ox: cx, oy: cy };
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
