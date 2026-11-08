// map generation off the main thread: the conquest pre-builds the next stage's map in here while
// the perk card is up (main.js preloadMap), so the next stage starts without a pause
import { generateMap } from './mapgen.js?v=101';

onmessage = (e) => postMessage(generateMap(e.data));
