# Fogtide

A territory strategy game (formerly Frontlines) for Windows (Steam, planned) and the browser. PC first: the menus, HUD and cards are designed at 1280x720 and zoom up with the window (`--ui` = min(width/1280, height/720), 1–3; 1.5 at 1080p), map number labels grow with it. Phones still work (landscape, the first tap goes fullscreen). Conquer a world map region by region. Each region is a battle against computer opponents on a map split into segments. Grow troops, build, and do the math on which fights to pick. In the game the troops are called **foglets**.

Play: https://kalpokasaugustinas.github.io/fogtide/

Prototype stage.

## How it plays
- **Campaign:** a generated world of ~34 regions: a continent with bays, mountain ranges and lakes, plus islands linked by sea routes. 4 rival empires hold the regions. Each region has a climate by location (snowy north, autumn east, moor west, summer south) that its battle uses. Attack any region next to one you own (or across a sea route). Difficulty grows with distance from home: more segments, more enemies, stronger neutrals, faster bots. Progress is saved in the browser.
- **🧭 Conquest (roguelite):** 5 stages that zoom out: Valley → Region → Country → Continent → World. Win a stage and everything you hold collapses into one capital on the next, bigger map:
  - the new capital is one tile with the outline of the island you just won, placed on the coast of the bigger map
  - all your people come along: the capital starts full, the rest is a reserve that flows in when there's room
  - buildings become capital bonuses = effect × share of your segments that had them (4 farms of 10 segments → +60% × 40% = +24% growth); a capital's cap is 400 or 1.25x the strongest neutral garrison on the map, whichever is higher (growth 1% of that); nothing can be built in a capital, and old capital bonuses count as one segment, so they fade unless you build again
  - after a perk pick (0.75 s card animation) the new battle and map view are built behind the old island's snapshot, so the load counts as the zoom-out's hold; the new map renders once, straight at the resolution of the zoom its camera glides to (the fps guard and resolution changes wait until the glide is done)
  - the zoom-out tells it without words (~5 s): the won island (ground only, no cloud banks) shrinks while the fog behind recedes more slowly (parallax pull-back) to the size and place of the new capital tile (same outline), pulses gold, then the new map grows outward from it in a widening circle while the island fades into the capital
  - the run is saved on the device at the start of every stage (localStorage `frontlines.conquest.save`): after a reload or a closed tab, Conquest asks ▶ Continue (that stage starts over on the same map, with your perks, capital and points) or New conquest; the save is cleared when the run ends or you withdraw mid-battle; the menu shows "Continue: stage N/5"
  - pick 1 of 3 perks at every zoom-out (12 in the pool: faster armies, cheaper buildings, stronger farms, plunder, ...); the picked card jumps, glows gold and throws sparks while the others drop away
  - your perks sit in a column of gold chips on the left, under the clock (relic perks from tiles you hold get a sparkle); tap one to see what it does
  - Continent and World (stages 4–5) are physically bigger maps: everything drawn on them (buildings, camps, trees, foglets, number badges) is scaled by detail / 0.62 (×0.68 / ×0.52), and after the zoom-out the camera glides in on your capital by the inverse, so tiles look as big as on stage 3; pan around or pinch out (zoom goes to 5 / that scale); neutral tiles on battalion maps show a single battalion figure however big their garrison
  - bots scale with you: each starts with 10 + 70% of your carried people and its own capital with a shuffled bonus mix
  - neutrals scale with you too (stage 2 on): garrisons × √(carried people / 150), at most ×4; the biggest 30% of open neutral tiles are fortified camps (×1.5 more, drawn as 2–4 houses behind a palisade); building prices rise by the same factor as the garrisons (farm 30 → up to 120)
  - lose a stage and the run is over; best run (stage reached, time) is saved
  - score per stage (w = stage 1–5): clear 500·w · 150·w per ★ (win, no tile lost, under 6:00) · speed 400·w·(1 − real seconds / 600), 0 after 10 min · plus 15·√troops killed; a lost stage scores only its kills. A perfect fast world run is ~20–25k. Every stage card shows its points; a finished run is ranked in the 🏅 leaderboard (top 10 runs on this device, menu button 🏅)
  - each stage looks further away: lakes, mountain ridges and trees get smaller and more numerous
  - stage sizes (tiles): 12 · 15 · 18 · 22 · 27, one season each (summer valley, autumn region, moor country, desert continent, winter world), so tiles stay big enough to read; the next stage's map is generated in a background worker while you pick a perk, so it starts without a pause
- **🌫️ Idle (incremental, `js/idle.js`):** endless zoom-out on the conquest battles; a test for a possible PC/Steam version.
  - Every stage is one battle; a win zooms straight out to the next stage (same island-into-capital animation as Conquest, no perk card, no 3-2-1 after the first stage). Lose a stage and the run ends; the next run starts at stage 1 (or further in with Fog drift). The game runs at ×1 only.
  - **🌫️ Fog** (the points): every enemy or neutral foglet you defeat (in fights or by arrows) pays `1 × display scale × Fog upgrades ÷ enemy growth factor` Fog; a stage win pays `20 × stage × display scale` (boss stages ×3); Fog wells pay for every tile you hold. The Fog bonus flies as puffs from the stage banner into the ⬆️ button.
  - **💠 Mist** (the rare currency): only bosses drop it, round((stage / 10)^1.5): stage 10 → 1, 20 → 3, 30 → 5, 40 → 8, 50 → 11, so deeper bosses pay more (the milestone reward). It buys the advanced upgrades at the end of each branch.
  - Fog, Mist and upgrades are kept forever (localStorage `frontlines.idle`, saved every 5 s; a reload resumes at the start of the current stage).
  - **Land runs dry:** each tile can raise at most 5× its cap foglets in total (Deep roots raises that), then it stops growing; the count stays with the tile when it changes hands, neutral regrowth counts too. A thin bar under each owned tile's number shows the land left (green → amber → red dot when dry); the tile card says how much. **The fog closes in:** if nobody marches for 30 game seconds, the side with the most foglets (tiles + reserve) takes the stage. Together these end stalemates.
  - **Numbers only grow on screen:** the sim stays the same size (a tile still holds ~400 sim foglets); every troop number, price and rate is shown × 1.45^(stage − 1) (1.2K, 3.4M, 5.6B, 7T, then 1.2e15).
  - **Enemies** get stronger every stage: attack, defense and growth ×1.08 per stage (stage 1 at ×0.75 attack/defense, ×0.85 growth), and archers (one level every 6 stages, max 5). Neutral garrisons × (enemy strength^0.55), at most ×3; the biggest 20% of open neutral tiles are camps (×1.3). Upgrades never make enemies stronger.
  - **Stages:** tiles = 4 + stage (24 from stage 20); rivals 1 (stages 1–4), 2 (5–9), 3 (10–19), 4 (20+); a new climate every 10 stages. Stage 10, 20, 30…: 👑 boss (one rival ×1.35 attack/defense, 3× start troops, aggressive). Stage 5, 15, 25…: 👤 one rival plays another player's profile (v1: 4 made-up sample profiles with a different atk/def/growth lean; later from the online board), fogs ×2 that stage.
  - **🌫️ Upgrade tree** (⬆️ button in battle or in the menu hub; opens over the running battle, purchases apply at once). Branches are rows, deeper upgrades sit to the right; a node opens once its requirements have the listed level (some need two branches). Locked nodes are hidden under the battle's own drifting clouds with a 🔒 and clear with a pop when opened; tap a node for its card (now → next, requirements, buy). Effects are deliberately small, cost = base × grow^level (Fog; 💠 nodes cost Mist: base 1–2, ×2 per level):
    - ⚔️ Offense: 🗡️ Sharper blades attack +5%/lvl (40, ×1.9) → 🥾 Forced march +4% speed, 5 lvls (needs blades 2) → 📜 Conscription neutrals −3%, 5 (march 2) → 🏹 Archers 5 (conscription 1 + great walls 1) → 💰 Plunder +0.5% of cap per enemy tile taken, 5 (archers 2) → 💠 ⚜️ Mist blades attack ×1.1 per level, 5 (plunder 1 + blades 6)
    - 🛡️ Defense: 🛡️ Shield wall defense +5%/lvl (40, ×1.9) → 🧱 Great walls capital defense +12%, 4 (shield 2) → 🏕️ Bigger camp +8 sim start foglets/lvl (walls 2) → 💠 🌁 Mist veil defense ×1.1 per level, 5 (camp 1 + shield 6)
    - 🌱 Growth: 🌱 Fertile fog growth +4%/lvl (50, ×2) → 🌾 Master builders farms/hospitals/labs +6%, 5 (fertile 2) → 🛠️ Engineers buildings −4%, 5 (builders 2) → 💠 🌳 Deep roots land lasts +40% per level (5× → 13× cap), 5 (engineers 1)
    - 🌫️ Fog: 🧺 Fog harvest Fog +5%/lvl (80, ×2.3) → ⛲ Fog wells 0.04 × lvl sim Fog per tile held per second, 5 (harvest 2) → 📯 Fog horn, 5 (wells 1) → 🌀 Fog drift: runs start at stage 1 + 2 × lvl, at most half your best stage, 5 (horn 1 + wells 2) → 💠 💠 Mistborn all Fog ×1.2 per level, 5 (drift 1)
    - 🤖 Command: 🤖 Auto-attack 5 lvls (40, ×2.6) → 🧭 Auto-expand (auto-attack 2) → 🔁 Auto-reinforce (expand) → 🏗️ Auto-build (reinforce + master builders 1) → 💠 👁️ Sharp eye: auto-attack safety margin 25% → 18/12/6%, 3 (auto-build)
  - **🏹 Archers:** every tile of a side with archers shoots each enemy tile next to it: 0.15 × level sim foglets per second × own attack ÷ target defense, every 0.5 s. No losses for the shooter; arrows never take a tile (it can drop to 0) and don't hit neutrals. Drawn as one arrow at a time arcing into each enemy neighbour, head in the shooter's colour. Idle bots get archers too (above); other modes have none.
  - **🤖 Auto-battle** (rules, not the rival bot brain): every game second, each of your tiles at least 90% full (80/70/60/50% at levels 2–5) attacks the enemy tile next to it that needs the fewest foglets to beat (25% safety margin), skipping tiles it already attacks. Auto-expand adds neutral tiles as targets; Auto-reinforce makes full back tiles send 70% one step toward the front; Auto-build makes a full tile that found no target build the building that pays back fastest (if it keeps 30% of its cap). The 🤖 button toggles it; you can always give orders yourself.
  - **📯 Fog horn** (offline earnings): gathers Fog in real time, played or away: 0.15 × level sim Fog per real second × display scale of your best stage × Fog multipliers (level 5 ≈ 40% of active play), holding at most 8 hours. Collect it in the menu: the **idle hub** (top-left, shown once idle has been played) has the horn (ivory war horn with gold bands, a fog meter, a count badge; wisps drift from the bell while it holds Fog, it glows when full), the Fog / Mist bank and an ⬆️ upgrade button. Tap the horn: it blows (synth war-horn sound), Fog puffs fly on curved paths into the ⬆️ button, which gulps as each lands, and the bank counts up.
  - Run over card: stage reached, best, Fog this run, Fog / Mist to spend, ⬆️ Spend Fog, ▶ New run. The menu button shows the saved run or best stage and the Fog bank.
  - Analytics: `play-idle`, `idle-stage-N` (milestones 2, 3, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100…), `idle-run-stage-Nplus`, `idle-run-Nmin-plus`, `idle-buy-<upgrade>` (first level), `idle-boss-N`, `idle-horn-collect`.
  - Balance sim: `python tools/idle_sim.py` (see Test). With land depletion, the quiet rule and Mist (build 86), 2 careers of an active-human stand-in buying the cheapest open upgrade (horn not simulated): runs reach 4–7, then 9–10 (boss wall), 14–18 once Mist starts, 19–20 by run 10 (second boss wall) and 25 at run 12; runs of 5–55 min, no stalemates. At ×1.06 per stage the boss stages became hard walls; at ×1.04 one run went from stage 1 to 27. Needs a human playtest.
- **Game speed:** the sim runs at 0.8 game seconds per real second at ×1 (`rules.timeScale`); all rates below are per game second, clocks show real time.
- **Tutorial:** the first Quick battle or Conquest starts with a scripted tutorial battle on a fixed 9-tile map (you vs one sleeping red bot); its end card then starts the mode you picked. A coach card (right side) shows one move at a time; on ⏸ steps time is stopped and only that move works:
  1. welcome: your castle, neutral tiles, the rival's castle · 2. drag castle → glowing tile (finger animation; castle 40 vs 8 defenders) · 3. ▶ watch the march, fight and capture · 4. the new tile gets exactly a farm's price (30): tap it, the farm sector of the build wheel glows · 5. ▶ time runs: tiles grow, the clock and play/pause button pulse · 6. zoom in (pinch out / mouse wheel; two fingertips spread over the castle) · 7. zoom back out (steps 6–7 end when the camera zooms; Next after 8 s) · 8. drag castle → farm tile to set a route · 9. take every enemy tile; the rival wakes up (no colours named: you can pick any colour).
  Skippable; replay from the help (▶ Play tutorial).
- **Battle:** each segment you own grows 1% of its cap per second, up to the cap. Cap scales with segment size: the largest segment on the map holds 400 (+4/s).
  - Drag from your tile to a neighbour to send the chosen % (25/50/75/100): attack an enemy/neutral, or move troops to your own. Dragging anywhere else pans; pinch zooms. A 3-2-1 countdown runs before every battle; nothing moves until it ends. Pausing during it freezes the number on screen and stops the drum (it resumes where it was). Tap your tile to select it (thick outline, other tiles dimmed); if it has no structure a build wheel opens around it (icon + price per building; tap one to build). Tap it again or anywhere else to close. Mouse wheel / pinch zooms 1–5x; the map re-renders sharper as you zoom (render density = screen density × 1.5 / 2 / 3 / 4 from zoom 1.4 / 1.9 / 2.6 / 3.6, at most ~4 M px per layer; if frames slow down below ~42 fps the budget drops step by step, never below the screen's own density). Dragging from a tile back onto itself removes its route. On phones the game is always landscape (held upright, the page is drawn turned sideways) and goes fullscreen on the first tap. Tapping a tile shows its info card bottom-left, above the send box: owner, foglets / cap and growth, terrain effect, and the building with what it does for its owner (with perks, e.g. "🌾 Farm: +60% growth here"). The play/pause button sits at the right end of the send box; the back button is as big as the menu's round buttons. Building descriptions are written from the numbers in `config.js`, so they always match the rules. ❔ help starts with a ▶ Play tutorial button. Test buttons (top-left, only with `?test` in the URL or on localhost): 🧪 fills every tile you own to its cap; 🏆 wins the battle at once (bot tiles become yours, also while paused).
  - 🔁 Routes (always on): sending to your own neighbour also sets a standing route. Every second the source forwards all troops above its reserve (100% − send %, of its cap) to the target. Chain routes (drag A→B, then B→C) to pipe troops from the back to the front. Tap a tile and press ✕ to end its route; a route also ends when either tile is lost.
  - End card: a quick battle (won or lost) offers ▶ Play again or a red Withdraw (back to the menu); a finished conquest run offers ▶ New conquest or Withdraw.
  - One big play/pause button top-right (❚❚ while running, yellow ▶ while paused; space does the same). The game runs at x1 only.
  - ← asks before leaving a running battle ("Leave battle? … will not be saved", Keep fighting / Withdraw) and pauses meanwhile.
- Troops are shown as small soldiers (1 per 8 troops; battalions of 40 on zoomed-out conquest stages) in each tile and in marching armies.
  - Fight: attacking armies stop at the border and fight for 1–3 s (bigger fights last longer). Attack = troops × attack bonus, defense = defenders × defense bonus. The higher number wins and keeps the difference. Enemy armies on the same road in opposite directions meet halfway and fight there; the survivor marches on. Troops leaving a tile that is being attacked at its border run straight into the attackers, and a second army on the same road waits behind a running clash, so nothing slips past to take an emptied tile. A tile under attack doesn't grow, and an attack never takes longer than 3 s.
  - Neutral segments start with a garrison that is a share of their cap (bigger tiles hold more) and regrow back to it at 0.2% of cap per second (80% slower than owned tiles). Bots also fight each other, and gang up on the leader: the side (you or a bot) with the highest total troop growth. Its tiles are worth 2.5x to every other bot, bots move reserves toward its border; the target switches when another side grows 10% more. Bots pool several border tiles into one joint attack on any tile too strong for one of them alone (common in later conquest stages, where camps outgrow normal tile caps), and a full tile attacks with a thinner safety margin (×1.05) instead of wasting growth.
  - Fair starts: you and every bot start on the coast, spread evenly around the island at about the same distance from each other. Starting tiles are reshaped to the same size (the average tile), so everyone has the same cap and growth; each is marked with a single house in the owner's colour.
  - The island floats in fog, seen at a slight angle. Built segments show their building as a scene: farms turn into fields with farmhouses, forts get stone walls and towers, barracks a castle with tents and soldiers, hospitals an infirmary with medical tents, labs an observatory with crystals. Flags and soldiers take the owner's colour.
  - Each battle has a climate theme (summer, autumn, winter, moor, desert): ground, cliffs, rocks and trees change with it. Owner colours show as glowing borders around each segment (all tile borders drawn at 0.6x, and scaled with the bigger conquest maps).
  - Rivers (visual only) run from the mountains and inland to the coast or a lake.
  - Buildings keep the tile's terrain around them: trees, boulders and reeds stay outside each building's clearing (on any terrain tile a farm is a field patch about half the tile's size, so forest, scree or shore still shows around it; forts clear a band along their wall; farms on plain land fill the tile).
  - Terrain traits, visible in the ground itself and as a dashed inner border in the terrain's colour (green forest, grey highland, blue river, sand lakeside; the owner's border is the solid band outside it): Highland (stony scree and boulders, next to mountains): defenders +30% · Forest (whole tile wooded): defenders +15% · River (a river winds through the tile: rivers run in chains of 1–3 tiles from a spring to the sea or a lake, at least a tile-width of river in each, with smooth meandering bends): +25% growth · Lakeside (sandy shore, reeds): +15% growth.
  - ✨ Relic tiles: 1-3 neutral tiles per map (away from every start) hold a shrine (a softly glowing sandstone obelisk) with one of the 12 conquest perks and a 1.6x garrison. Whoever holds the tile gets the perk; lose it, lose the perk.
  - Maps vary: island shape (blob, squiggly square, triangle, diamond, peanut, ring) and 1–4 lakes or mountain ranges that nobody can occupy or cross.
  - You win when every enemy faction is gone.
- **Buildings** (one per segment, paid with that segment's troops; captured buildings switch sides):

| Building | Cost | Effect |
|---|---|---|
| 🌾 Farm | 30 | +60% growth in this segment |
| ⚔️ Barracks | 25 | troops sent from here attack x1.5 |
| 🛡️ Fort | 40 | defenders here count x1.75 |
| ➕ Hospital | 70 | +50% growth in your adjacent segments |
| 🔬 Lab | 60 | +10% growth in all your segments |

- **Bots** have personalities (aggressive, builder, turtle). They pick targets by value per troop needed, build what pays back fastest on that tile (foglets gained per second per foglet spent: farm on big tiles, hospital among owned neighbours, lab in a big empire, barracks on a front tile that attacks, fort on a threatened front tile), and push troops from the back to the front.

Keys: space = pause, 1–4 = send %, Esc = close the open card, else deselect, else the leave card; idle: U = upgrade tree, A = auto-attack; desktop app: F11 / Alt+Enter = fullscreen.

## Menu
Look: "sunset swell": FOGTIDE in Luckiest Guy (bundled in `fonts/` with Fredoka, so the desktop app and offline play keep the look; licences in `fonts/`) with a yellow → orange → pink gradient and a plum outline, a purple notched banner "Unstoppable, like the tide", and two ribbon buttons with gold lettering: Conquest (sky blue) and Quick battle (pink). The loading screen title uses the same lettering.

Loading screen (animated island badge, progress bar, a one-line tip): shown at once when a mode starts (the 3-2-1 countdown waits for it, at least 1.1 s so the tip can be read) and at boot, where it covers the page until the menu's background battle has drawn its first frame and the font is ready, so the menu appears in one go. A live 4-bot battle plays on a decorative island behind the menu (new island when it ends). The map is shown large (the island fills most of the screen, little fog). Two bands of foglets stand left and right of the mode buttons: the in-game troop figure (`drawFoglet` in render.js, the same drawing as on the map) drawn big with a small angry face. Your band on the left wears your Commander colour and kit; the rival band on the right is red (blue if you are red) in the other three kits. They sit above everything else on the menu, with room so hops, leans and bubbles are never cut off; each hops 1–1.5 times a second (the hop phase is advanced per frame, so the rhythm stays steady however long the menu is open), leans and steps toward the other band (hops 1.25–1.8 a second); 20 s after the menu opens, and every 20 s after (the two bands take turns), one foglet hops faster and faster ("Hmm…", then a launch cry like "Do a barrel roll!"), blasts off like a rocket diagonally up across the menu with a flame and a smoke trail (~1.5 s), and a new foglet hops in from the screen edge with the same hop rhythm as the rest; taunts are mostly plain war cries ("Grr!", "Bring it!", "You and what army?"), with a short nod to a game or film about 3 times in 10 ("Out of bubblegum!", "DONKEY!", "I'll make you cry like an onion!", "Wololo!", ...); shake when furious (red anger mark) and shout short taunts, one speech bubble per band at a time (`js/foglets.js`). Glossy logo; the mode buttons are shaped like the red ribbon under it (notched ends, hard dark bottom edge; Conquest purple, Quick battle green) with labels in the logo's gold, brown-outlined lettering, with progress (campaign regions, best conquest stage); large round corner buttons for profile, sound, music, leaderboard and help.

Commander panel (👤 on the menu): pick your colour (8), foglet kit (every foglet has a square head and a kit that changes its whole silhouette: soldiers with helmet, belt and spear, knights in a steel breastplate with plumed helm and shield, vikings with horns, big beard and round shield, archers in a green hood and cape with quiver and bow, wizards in a flared robe with pointed hat, white beard and staff, pirates in a striped shirt with eyepatch, tricorne and cutlass, barbarians bare-chested in a fur kilt with fur hood and club) and town style, each with its own house shape (classic gable, nordic turf roof, desert flat roof and dome, eastern two-tier pagoda, tudor timber frame, gothic pointed slate roof, tropical bamboo and straw); saved in the browser. Rivals get their own colours and random, distinct styles every battle. The campaign is hidden from the menu for now (code kept).

## Sound
Recorded audio files in `audio/` (free licences, credits in [audio/CREDITS.md](audio/CREDITS.md) and the How to play screen):
- Music: orchestral tracks streamed through two crossfading decks. Menus loop Scott Buckley's "Aphelion" (from 1:45). Battles rotate 4 war tracks ("Song Of The Forge" opening march, "Five Armies", "Heroic Demise", "Battle Theme A"), each battle starting on the next one, with 3 s crossfades. The end card plays a victory or defeat piece once.
- Effects: footsteps while armies walk, crowd war cries when fights start, 10 recorded sword clashes, war drums under the 3-2-1 countdown, hammer knocks when building. Synthesized: an alarm bell (two strikes, at most every 1.5 s) when one of your tiles is attacked, with red rings closing in on it; a rising chime when you capture a tile, which lights up: a warm glow, a band of light sweeping across it, a gold rim and a few twinkling stars; a bell run when a perk is picked. Capture horns are still synthesized.
- Sound and music toggles on the menu (music also in the battle bar), remembered per browser.
- Rebuild the files: `python tools/build_audio.py <music_dir> <sfx_dir>` (trims, loudness-matches and encodes to mp3; needs `pip install imageio-ffmpeg`).

## Code
Vanilla JS modules plus canvas 2D. No build step, no dependencies.

| File | Purpose |
|---|---|
| `js/config.js` | all balance numbers (growth, caps, buildings, colours) |
| `js/mapgen.js` | seeded map generator: island shapes (signed distance functions), lakes/mountains, voronoi-like segments, adjacency, label points |
| `js/battle.js` | battle simulation (fixed 0.1 s step, no drawing, runs headless) |
| `js/ai.js` | bot decisions and personalities |
| `js/campaign.js` | world map, empires, region difficulty, save/load |
| `js/render.js` | island-diorama renderer: smooth vector outlines (marching squares), tilted camera, static layers + cached per-segment sprites (overlays, trees, buildings), troop pills |
| `js/expedition.js` | conquest stages, perks, carry-over maths, bot scaling, best run |
| `js/idle.js` | idle mode: stage scaling, fogs, upgrades, auto-battle brain, sample profiles, save (no dom) |
| `js/audio.js` | sound effects (decoded clips + a few synthesized cues) and the crossfading music playlists |
| `audio/` | music + sfx mp3 files, `CREDITS.md` with authors and licences |
| `tools/build_audio.py` | turns the downloaded tracks/clips into the files in `audio/` |
| `js/structures.js` | building scenes that fill a segment: farmland, fort walls and towers, castle with soldiers, hospital, lab |
| `js/main.js` | screens, input, HUD, frame loop |
| `js/tune.js` | live tuning panel (`?tune=1`): sliders for the config.js numbers |
| `sw.js` | service worker: offline play (one cache per build) |
| `js/mapworker.js` | runs map generation in a background worker (the next conquest map is built while the perk card is up) |
| `js/analytics.js` | anonymous GoatCounter visit + event counter (off until a site code is set) |
| `manifest.webmanifest`, `img/` | install-as-app manifest (fullscreen, landscape), icons, link-preview image |

## Performance
Runs at the monitor's refresh rate (60, 144 Hz ...). The simulation steps at 10 Hz; armies and route arrows interpolate between steps. Terrain, borders and rocks are drawn once per map; each segment's overlay, trees and building scene is a cached sprite, so captures and new buildings only re-stack sprites (~1 ms). The smoke test prints frame times and the rebuild cost.

## Run locally
```
python -m http.server 8000
```
Open http://localhost:8000.

## Test
```
python tools/smoke_test.py [screenshot_dir]
```
Needs Python Playwright. The test runs 12 bot-only battles headless, plays a campaign battle in portrait and landscape (select, build, attack), checks for JS errors and saves screenshots.

Balance simulations (headless bot-vs-bot 1v1, ~0.15 s a game, 4 browser pages in parallel):
```
python tools/balance.py [buildings|perks|all] [--seeds N] [--maps N] [--set farm.cost=40 hospitalGrowth=0.4]
```
One side is a variant (no buildings, one building banned, only one building allowed, or a perk in a conquest-like start with 600-foglet capitals and camps), the other the normal bot. Every game is played both ways round, because faction 0 has a clear first-mover edge between equal bots. Output: the variant's win share with a 95% margin, average game length, buildings held at the end, and a price-vs-impact table (payback time of each building on the pool's median tile). `--set` changes a price or effect for both sides, to test a change before editing `js/config.js`. Bots only build through `personality.allow` (ai.js) in these tests.

Balance pass (build 64): bots used to put a barracks on every front tile and lost to bots that built nothing (68%); they now pick the building that pays back fastest and beat no-buildings 71%. Prices: hospital 50 → 70, barracks 40 → 25, forts x1.5 → x1.75. Perks, win share vs no perk: plunder 99% → 64% (15% → 2% loot), conscription 79% → 68%, veterans 70% → 55%, healers 59%, engineers 60%, fertile 64%; the rest 47–55%.

Idle mode:
```
python tools/idle_test.py [screenshot_dir]     # ui: menu, hud, tree (veiled nodes open, buys apply live), auto-attack, archers, win -> stage 2, save/resume, run over
python tools/idle_economy_test.py [dir]        # land runs dry, fog closes in, boss Mist, Mist upgrades, fog horn collect + puffs
python tools/idle_sim.py [--careers 2] [--runs 8] [--target 30] [--set enemyAtk=1.1 display=1.5]
```
`idle_sim.py` plays whole careers headless: the player side is a fixed bot standing in for an active human (auto-battle only saves a human's time, so it isn't simulated), buying the cheapest affordable open upgrade (not the command branch) every 5 game seconds. Prints per stage the game time, real time, fogs earned and banked, levels owned, and per run the stage reached. `--set` overrides `idleCfg` values in `js/idle.js`. A stage still running after 900 game seconds shows as TIME (stalemate).

## Tuning
Open the game with `?tune=1` (e.g. `http://localhost:8000/?tune=1`) for a collapsible panel with a slider and number box per balance value in `js/config.js` (rules, building costs, effects, terrain traits). Most values apply live; ones marked ↻ (start troops, caps, growth, capital margin) are set when a battle starts, so press "restart round". "copy changes" copies only the changed values as JSON (e.g. `{"rules.growthRate":0.012}`) to paste back into `config.js`; "reset" goes back to the file's values. Tuned values are kept in localStorage but only used while `?tune=1` is on. Building descriptions don't follow the sliders.

## itch.io build
```
python tools/make_itch_zip.py
```
Zips the committed game files (index.html at the zip root, no tools or docs) into `dist/fogtide-build<N>.zip` for itch.io (Kind: HTML, played in the browser). The sitelock already allows itch.io's hosting domains.

## Windows desktop build (Steam)
```
python tools/build_desktop.py          # dist/desktop/Fogtide/Fogtide.exe + dist/fogtide-windows-build<N>.zip
python tools/desktop_check.py          # run the app on this PC: errors, fps, screenshot
```
The same web files wrapped in [Electron](https://www.electronjs.org/) (prebuilt Windows zip, pinned version, checksum-verified; no Node/npm needed). `desktop/main.js` opens one window and serves the game from a private `app://` scheme (ES modules and module workers don't run on `file://`). Only committed files go in, like the itch zip. The web version on GitHub Pages is unchanged.

- Keys: F11 or Alt+Enter toggles fullscreen. Starts fullscreen on first run, then remembers window/fullscreen.
- Saves: the browser storage of the app, in `%APPDATA%ogtide`.
- Debug against the working tree without rebuilding: `Fogtide.exe --game-dir=<repo folder> --dev --windowed` (`--dev` enables F12 devtools and F5 reload). `desktop_check.py` does this by default.
- Testers: unzip `fogtide-windows-build<N>.zip`, run `Fogtide.exe` (Windows may warn about an unsigned app: More info > Run anyway).
- Launched from a VS Code terminal, Electron runs as plain Node because VS Code sets `ELECTRON_RUN_AS_NODE`; the check tool clears it.

## Build number
The menu shows `build N · date time`. A git pre-commit hook (`tools/pre-commit` → `.git/hooks/pre-commit`) runs `tools/stamp_version.py`, which stamps the label and adds `?v=N` to css/js files so browsers load the new version. After a fresh clone, install the hook with `cp tools/pre-commit .git/hooks/pre-commit`.

## Install, analytics, licence
- Phones: "Add to Home screen" installs it as an app (fullscreen, landscape) via `manifest.webmanifest`; shared links show a preview card (`img/og.png`).
- Sitelock (top of `js/main.js`): the game runs only on its own site (kalpokasaugustinas.github.io), itch.io hosting (itch.zone, hwcdn.net), CrazyGames, Poki, localhost and home-network addresses. Elsewhere, or framed inside a page on another domain, it shows a card linking to the original and counts a `sitelock-<host>` event. To publish on a new portal, add its domain to `hostOk`.
- Offline + install: `sw.js` (service worker, registered as `sw.js?v=N`, one cache per build) keeps the game on the device after the first online visit: the page network-first, our js/css/images/fonts/sound effects cache-first (the page sends the list of files it loaded, plus the map worker and all sound effects); music streams online only. Off on localhost unless the URL has `?sw`. 📲 in the menu installs the game as an app (Chrome/Android install prompt; on iPhone it explains Share → Add to Home Screen); hidden once installed.
- Feedback: ❔ help → 💬 Send feedback opens the Google Form (`feedbackUrl` in main.js) in a new tab (counted as the `feedback-open` event).
- Analytics: `js/analytics.js` loads GoatCounter (no cookies, no personal data; dashboard: fogfront.goatcounter.com), and counts page views plus game events (`play-*`, `tutorial-done`, `*-won/lost`, `conquest-stage-N-won/lost`) and JS errors players hit (`error-<file>:<line> <message>`, each once per visit, at most 5). Events before the script loads are queued. Never on localhost, and never in a browser that once opened the game with `?test` or `?nocount` (sets GoatCounter's `skipgc` flag, so your own testing isn't counted).
- Licence: all rights reserved (see [LICENSE](LICENSE)); the music and sound effects keep their own licences (audio/CREDITS.md).
