// map generation off the main thread: the conquest pre-builds the next stage's map in here while
// the perk card is up (main.js preloadMap), so the next stage starts without a pause
import { generateMap, spreadStarts, equalizeStarts, rng } from './mapgen.js?v=123';
import { mapOutlines } from './outline.js?v=123';

// one long-lived worker: jobs come as { key, opts, starts? } and go back as { key, map }.
// starts = { k, capital, seed }: also pick the k starting tiles and reshape them to the same size
// (fair start, ~150 ms) here, so new Battle() on the main thread can skip it (map.starts)
onmessage = (e) => {
  const t0 = performance.now(), { key, opts, starts } = e.data, map = generateMap(opts);
  if (starts) {
    const first = starts.capital && map.stampSeg >= 0 ? map.stampSeg : -1;
    map.starts = spreadStarts(map, starts.k, rng(starts.seed ^ 0x51a7), first);
    equalizeStarts(map, map.starts, first);
  }
  // every outline the map view needs, traced here (~0.2 s) so MapView only builds the paths. traced
  // after the reshaping above; a battle that reshapes this map again drops them (battle.js)
  map.outlines = mapOutlines(map);
  postMessage({ key, map, ms: performance.now() - t0 });
};
