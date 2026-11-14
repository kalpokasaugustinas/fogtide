// map generation off the main thread: the conquest pre-builds the next stage's map in here while
// the perk card is up (main.js preloadMap), so the next stage starts without a pause
import { generateMap } from './mapgen.js?v=111';

// one long-lived worker: jobs come as { key, opts } and go back as { key, map }
onmessage = (e) => { const t0 = performance.now(); const map = generateMap(e.data.opts); postMessage({ key: e.data.key, map, ms: performance.now() - t0 }); };
