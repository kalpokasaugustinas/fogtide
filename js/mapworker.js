// map generation off the main thread: the conquest pre-builds the next stage's map in here while
// the perk card is up (main.js preloadMap), so the next stage starts without a pause
import { generateMap, spreadStarts, equalizeStarts, rng } from './mapgen.js?v=153';
import { mapOutlines } from './outline.js?v=153';
import { groundPixels, coastSteps, placeTrees, measureIsland } from './viewprep.js?v=153';
import { themes } from './config.js?v=153';
import { paintInWorker } from './render.js?v=153';

// the last few maps sent, by key: a paint job (below) draws the view of one of them
const maps = new Map();

// one long-lived worker: jobs come as { key, opts, starts? } and go back as { key, map }.
// starts = { k, capital, seed }: also pick the k starting tiles and reshape them to the same size
// (fair start, ~150 ms) here, so new Battle() on the main thread can skip it (map.starts)
onmessage = (e) => {
  if (e.data.paint) { paint(e.data); return; }
  const t0 = performance.now(), { key, opts, starts, theme } = e.data, map = generateMap(opts);
  if (starts) {
    const first = starts.capital && map.stampSeg >= 0 ? map.stampSeg : -1;
    map.starts = spreadStarts(map, starts.k, rng(starts.seed ^ 0x51a7), first);
    equalizeStarts(map, map.starts, first);
  }
  // every outline the map view needs, traced here (~0.2 s) so MapView only builds the paths. traced
  // after the reshaping above; a battle that reshapes this map again drops them (battle.js)
  map.outlines = mapOutlines(map);
  // the map view's dom-free preparation for this climate (ground colours, segment cells, coast
  // distance, trees, island box, glints): MapView.setMapSteps takes it when the climate matches
  if (theme) {
    const v = { map, theme: themes[theme] ?? themes.summer, segTheme: null, k: map.grid / 480 };
    for (const _ of groundPixels.call(v));   // eslint-disable-line no-unused-vars
    for (const _ of coastSteps.call(v));   // eslint-disable-line no-unused-vars
    placeTrees.call(v);
    measureIsland.call(v);
    map.prep = { theme, seed: v.seed, ground: v.groundPx, segCells: v.segCells, coastD: v.coastD, trees: v.trees, isle: v.isle, glints: v.glints };
  }
  maps.set(key, map);
  while (maps.size > 3) maps.delete(maps.keys().next().value);
  postMessage({ key, map, ms: performance.now() - t0 });
};

// paint job { paint: id, key, theme, size, dpr, st, colors, fill }: the idle prep's drawing of the
// next stage's map view (static layers + tile sprites, render.js paintInWorker) done here instead
// of on the page's main thread; answered with { paint: id, res } (bitmaps transferred) or an error
function paint({ paint: id, key, theme, size, dpr, st, colors, fill }) {
  const map = maps.get(key);
  if (!map) { postMessage({ paint: id, error: 'no map' }); return; }
  try {
    const t0 = performance.now(), { res, transfer } = paintInWorker(map, theme, size, dpr, st, colors, fill);
    res.ms = performance.now() - t0;
    postMessage({ paint: id, res }, transfer);
  } catch (err) { postMessage({ paint: id, error: String(err?.message ?? err) }); }
}
