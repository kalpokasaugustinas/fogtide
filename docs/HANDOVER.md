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
- localStorage keys stay `frontlines.*` and the GoatCounter code stays `fogfront` (renames would wipe saves/stats).

## Tried and failed
- Map generation in a web worker: 3-4x slower in the exe than the main thread.
- CSS `pointer-events` rule on all HUD children while the tree is open: 70-100 ms restyle freeze (replaced with `inert`).
- CSS blur for tree node halos: 34 ms/frame (replaced with gradients).
- Number badges redrawn each frame: main cause of idle stage-change lag (now sprite-cached).

## Known issues
- `tools/idle_economy_test.py`: boss Mist check fails and the Mist veil click times out (stale since the right-side panel, build 130); later checks don't run.
- Skirmish bot sim seed 104 stalemated (>1200 game s) in the smoke test; check the quiet-end rule for skirmish.
- Idle: stage 20 is a wall (2-3 h in); capped specials max out by run ~3 (thin late game).
- Bots rarely choose barracks; walls/recruiters/march/masons perks ~50% (no effect for bots).
- Leftover phone code: build wheel in main.js, portrait rotation, pinch tutorial steps, compact HUD.

## How to verify
- `python tools/smoke_test.py`: page/console errors, portrait + landscape, bot battles end, frame times.
- `python tools/idle_test.py`: idle UI flow, purchase, stage change, save across reload.
- `python tools/balance.py` / `tools/idle_sim.py`: balance (see `/balance-check`).
- `python tools/desktop_check.py`: the exe (errors, fps, screenshot).
