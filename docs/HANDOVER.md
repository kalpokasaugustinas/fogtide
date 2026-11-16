# Fogtide handover
Read before changing code. Update in the same commit as the change. Full code map: README "Code" section.

## Systems
- `js/battle.js`: fixed-timestep battle sim (no DOM), troops grow per tile, armies march between adjacent tiles.
- `js/ai.js`: bot personalities; picks buildings by payback (barracks value halved).
- `js/mapgen.js` / `js/mapworker.js`: seeded island maps; idle prebuilds the next map on the main thread.
- `js/render.js`, `js/viewprep.js`, `js/structures.js`, `js/foglets.js`: canvas drawing with cached layers/sprites.
- `js/main.js`: screens, HUD, input (right click send, Q/E send %, 1-5 build, Esc, U upgrades, C war council, A generals on/off).
- `js/campaign.js`, `js/expedition.js`: conquest/campaign modes. `js/idle.js`: idle mode (own save key, upgrade tree, `idleCfg`). `js/generals.js`: War Council portraits (rules live in `idle.js`: `generals`, `council`, `autoTick`).
- `js/fogui.js` + `pc.css` (after `style.css`): fog & ink PC UI. `js/config.js`: balance numbers. `js/tune.js`: `?tune=1` panel.
- `desktop/`: Electron shell (app:// scheme); `tools/build_desktop.py` builds it, `tools/desktop_check.py` checks the exe.

## Decisions (don't "fix" back)
- PC first (Steam target): UI designed at 1280x720, zoomed by `--ui`; phones are second. Web version stays on Pages for testers.
- UI style: muted fog & ink (Northgard / Bad North feel), soft fog blobs, line icons, no glossy freemium buttons or emoji.
- Idle mode is a separate mode reusing conquest code without changing conquest; upgrades never buff enemies; enemies scale by stage only.
- Idle fog reward per kill is divided by the enemy growth factor (otherwise the player out-scaled enemies).
- Idle panel opens in battle on the right (tabs Upgrades / War Council): map canvas slides left + scales to 0.56, battle keeps running; panel hides the bottom HUD with `inert`; panel zoom `--pz` never exceeds the window.
- Upgrade tree has 4 branches (Offense, Defense, Growth, Fog); the old Command branch is the War Council. Archers come only from the Marksman general.
- War Council: 4 seats, generals unlocked with Mist only, in any order (price rises per unlock), promoted with Fog. Warlord attacks enemies only (neutrals are the Pathfinder's job). Rejected: Siegemaster (too strong), wizard / pirate generals, a barbarian look (same as viking). Field Surgeon = 1% revive chance per lost foglet at level 1. Council effects (hound dash + claws, drum rings + countdown, revive cross) are canvas fxs in main.js drawFx, fed by battle events 'hounds' / 'drum' / 'revive' from idle.js. Fogtide: rebuild the desktop exe after every change (user tests the exe).
- x1 speed only (no 2x/3x). No battle-start horn (user found it unnerving).
- No offline earnings: the idle Fog horn / Deep horn were removed (user's call, build 131); old levels are refunded via `retired` in idle.js. Fog drift now opens from wells 1 or bounty 1, Mist garden from harvest 1 or wells 2.
- Desktop window is created fullscreen (`fullscreen` in the BrowserWindow options), never switched after showing: switching made the page load at 1280x720 and jump to screen size ~4 s after launch.
- Zoom sharpness: pixel budget per layer 16 M on PC (`pointer: fine`), 4 M on phones (`pxCapDefault`, render.js). The boost re-render runs sliced on a copy of the view (`reboostSteps`, main.js `reboost`) and swaps in; drawBase draws only `viewRect` (visible box) when zoomed. Before: one 1.7 s freeze at the bigger budget.
- Idle island framing: `resize` always centres the island bbox (was only when scaled up) and lifts it 2.5% of the height for the taller bottom HUD; big islands may shrink to 0.7x so they clear the build bar.
- Building spots rank by min(coast distance, tile-edge distance `bdist`), measured at the roof: borders, mountains and lakes all count (huts used to land on border lines / mountain walls).
- Lake sparkles (`measureIsland`) only where the drawn spot (cell + lake drop) is open water and no mountain wall stands just below it.
- Shop tabs have z-index 3: the upgrade tree (640x480, pointer-events auto) covered the tab row, so War Council only opened with C.
- Campaign rework (2026-11-16, phases 1-6 in Context notes): Idle is shown as **Campaign**, its run currency as **Wisp** (internal names `idle`, `fogs`, save key `frontlines.idle` unchanged). Conquest + its leaderboard are hidden from the menu and its saves are cleared on load (expedition.js); its code stays because idle uses `islandShape` / `zoomOut`. Skirmish stays (future online multiplayer).
- Campaign obelisks: idle battles set `capObelisks` / `homeLit`; styleFor turns a capital into `capital-fog` (bot, grey shine) or `capital-lit` (yours after stage 1). `capitalObelisk` (structures.js) puts it beside the keep (>= 4.4 u sideways, on dry land of the tile, off the number badge, skipping houses it would touch); terrainKeep clears trees there. Relic tiles show a mausoleum (the old relic obelisk became `drawObelisk`).
- Campaign phase 2 (build 138): Mist keystones are the Legacy tab (branch 'legacy', `isLegacy`, no prerequisites, mostly uncapped, doubling price; Fog drift became Legacy 'headstart', old drift refunded). Mist = 1 per enemy obelisk + boss Mist, only when stage > `cleared` (first clear per campaign). Loss = `lose()`: back `pushBack` (3) stages, Wisp/tree kept. Withdraw keeps the stage (battle restarts until phase 4). `endCampaign()` at stage 30 (later also the clock): Wisp tree, Wisp and promotions reset; Legacy, Mist, unlocks stay. Quiet rule off in the campaign; `faithFade` 1%/s on Fogbound tiles with dry land. Debug: `__fl.finishCampaign()`. Sim: `tools/idle_sim.py --campaigns 5 --years 60`.
- localStorage keys stay `frontlines.*` and the GoatCounter code stays `fogfront` (renames would wipe saves/stats).

## Tried and failed
- Map generation in a web worker: 3-4x slower in the exe than the main thread.
- CSS `pointer-events` rule on all HUD children while the tree is open: 70-100 ms restyle freeze (replaced with `inert`).
- CSS blur for tree node halos: 34 ms/frame (replaced with gradients).
- Number badges redrawn each frame: main cause of idle stage-change lag (now sprite-cached).

## Known issues
- `idle_test.py` sometimes fails with one `ERR_CONNECTION_REFUSED` console error (the local server starts after a fixed 1 s sleep); a re-run passes.
- `tools/idle_economy_test.py`: boss Mist check fails and the Mist veil click times out (stale since the right-side panel, build 130); later checks don't run.
- Skirmish bot sim seed 104 stalemated (>1200 game s) in the smoke test; check the quiet-end rule for skirmish.
- Idle: stage 20 is a wall (2-3 h in); capped specials max out by run ~3 (thin late game).
- Bots rarely choose barracks; walls/recruiters/march/masons perks ~50% (no effect for bots).
- Leftover phone code: build wheel in main.js, portrait rotation, compact HUD (the tutorial zoom steps show a mouse wheel now; the step id/`pinch` field names stayed).
- Zoomed in to 5x the map renders at ~3.7x density on PC (16 M px/layer budget), not full 5x: real native sharpness would need a viewport-only renderer. Zoom-in settle still has one ~200 ms frame (one big step in the sliced rebuild).
- Tutorial: pressing Next on the zoom-in step without zooming auto-finishes the zoom-out step (camera is already at 1x).

## How to verify
- `python tools/smoke_test.py`: page/console errors, portrait + landscape, bot battles end, frame times.
- `python tools/idle_test.py`: idle UI flow, purchase, stage change, save across reload.
- `python tools/balance.py` / `tools/idle_sim.py`: balance (see `/balance-check`).
- `python tools/desktop_check.py`: the exe (errors, fps, screenshot).
