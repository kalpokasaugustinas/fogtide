// map generation off the main thread: the conquest pre-builds the next stage's map in here while
// the perk card is up (main.js preloadMap), so the next stage starts without a pause
import { generateMap, spreadStarts, equalizeStarts, rng } from './mapgen.js?v=124';
import { mapOutlines } from './outline.js?v=124';
import { groundPixels, coastSteps, placeTrees, measureIsland } from './viewprep.js?v=124';
import { themes } from './config.js?v=124';

// one long-lived worker: jobs come as { key, opts, starts? } and go back as { key, map }.
// starts = { k, capital, seed }: also pick the k starting tiles and reshape them to the same size
// (fair start, ~150 ms) here, so new Battle() on the main thread can skip it (map.starts)
onmessage = (e) => {
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
  postMessage({ key, map, ms: performance.now() - t0 });
};
