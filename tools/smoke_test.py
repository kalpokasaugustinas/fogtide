# headless smoke test: serves the game, checks for js errors, runs bot-only battles
# to see that they finish, plays a few player moves and saves screenshots.
# usage: python tools/smoke_test.py [screenshot_dir]
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")   # emoji in titles: windows console defaults to cp1257

root = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1] if len(sys.argv) > 1 else root / "tools" / "shots")
out.mkdir(parents=True, exist_ok=True)

# pick a free port (a fixed one may already be taken by another local server)
with socket.socket() as s:
    s.bind(("localhost", 0))
    port = s.getsockname()[1]

server = subprocess.Popen([sys.executable, "-m", "http.server", str(port)], cwd=root,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
errors = []

# bot-vs-bot battles: 4 ai factions on random maps, report how long each takes and who wins
sim_js = """async () => {
  const { generateMap } = await import('./js/mapgen.js');
  const { Battle } = await import('./js/battle.js');
  const { personalities } = await import('./js/ai.js');
  const types = Object.keys(personalities), res = [];
  for (let i = 0; i < 12; i++) {
    const map = generateMap({ seed: 100 + i, cells: 22, grid: 480, shape: 'random', obstacles: true });
    const factions = [0, 1, 2, 3].map((c) => ({ ai: true, color: c, think: 3, personality: personalities[types[(i + c) % 3]] }));
    const b = new Battle(map, { seed: i, factions, neutral: [0.15, 0.35] });
    const t0 = performance.now();
    b.simulate(1200);
    const owners = b.segs.map((s) => s.owner);
    res.push({ seed: 100 + i, segs: map.segs.length, state: b.state, time: Math.round(b.time),
      ms: Math.round(performance.now() - t0),
      buildings: b.segs.filter((s) => s.building).length,
      left: [0, 1, 2, 3].map((f) => owners.filter((o) => o === f).length) });
  }
  return res;
}"""

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, vp in [("pc", {"width": 1920, "height": 1080}), ("window", {"width": 1280, "height": 720})]:
            page = browser.new_page(viewport=vp, device_scale_factor=1)
            page.add_init_script("localStorage.setItem('frontlines.tutorial', '1')")   # the tutorial battle has its own check
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.goto(f"http://localhost:{port}/index.html")
            page.wait_for_timeout(500)
            page.screenshot(path=str(out / f"{name}-menu.png"))

            if name == "landscape":
                # audio: every file loads and decodes; a tap starts the menu music and the sfx buffers
                chk = page.evaluate("""async () => {
                  const { sfx, music } = __fl.audioFiles(), ac = new OfflineAudioContext(1, 44100, 44100), bad = [];
                  for (const u of [...sfx, ...music]) {
                    try { const r = await fetch(u); if (!r.ok) throw r.status; await ac.decodeAudioData(await r.arrayBuffer()); }
                    catch (e) { bad.push(u.split('/audio/')[1] + ': ' + e); }
                  }
                  return { files: sfx.length + music.length, bad };
                }""")
                print("audio files:", chk)
                page.mouse.click(5, 5)   # first gesture -> initAudio
                page.wait_for_timeout(2500)
                st = page.evaluate("__fl.audioState()")
                print("audio state:", st)
                if not st["playing"] or "menu-aphelion" not in st["src"] or chk["bad"]:
                    errors.append(f"audio: {st} {chk['bad']}")
                page.evaluate("__fl.startSkirmish()")
                page.wait_for_timeout(2500)
                st = page.evaluate("__fl.audioState()")
                print("audio in battle:", {k: st[k] for k in ("list", "src", "playing", "loaded")})
                if st["list"] != "battle" or not st["playing"] or "game-" not in st["src"]:
                    errors.append(f"battle audio: {st}")
                page.evaluate("__fl.skipCountdown()")
                # every shape: connected maps with enough segments, plus a screenshot each
                chk = page.evaluate("""async () => {
                  const { generateMap, hops, shapeNames } = await import('./js/mapgen.js');
                  const bad = [], sizes = {};
                  for (let i = 0; i < 60; i++) {
                    const m = generateMap({ seed: 500 + i, cells: 22, grid: 480, shape: 'random', obstacles: true });
                    const d = hops(m, [0]);
                    (sizes[m.shape] ??= []).push(m.segs.length);
                    if (d.some(v => v === Infinity) || m.segs.length < 18) bad.push({ seed: 500 + i, shape: m.shape, segs: m.segs.length });
                  }
                  return { bad, sizes, shapes: shapeNames };
                }""")
                print("map check:", {k: f"{min(v)}-{max(v)} segs x{len(v)}" for k, v in chk["sizes"].items()}, "bad:", chk["bad"])
                for i, shape in enumerate(chk["shapes"]):
                    page.evaluate("__fl.startBattle({ seed: %d, cells: 22, shape: '%s', neutral: [0.15, 0.35], factions: [{ ai: false, color: 0 }, { ai: true, color: 1, think: 3, personality: { build: 0, risk: 2, actions: 0, grudge: 0 } }] }, 'skirmish')" % (900 + i, shape))
                    page.wait_for_timeout(250)
                    page.locator("#battle-canvas").screenshot(path=str(out / f"shape-{shape}.png"))
                # every building type on one map
                page.evaluate("__fl.startBattle({ seed: 77, cells: 18, shape: 'blob', theme: 'summer', neutral: [0.15, 0.35], factions: [{ ai: false, color: 0 }, { ai: true, color: 1, think: 3, personality: { build: 0, risk: 2, actions: 0, grudge: 0 } }] }, 'skirmish')")
                page.evaluate("""(() => { const b = __fl.battle, types = ['farm', 'fort', 'barracks', 'hospital', 'lab'];
                  types.forEach((t, i) => { const s = b.segs[i * 3 + 1]; s.owner = i % 2 ? 1 : 0; s.building = t; }); b.version++; })()""")
                page.wait_for_timeout(300)
                page.locator("#battle-canvas").screenshot(path=str(out / "buildings.png"))
                page.evaluate("document.querySelectorAll('.screen').forEach(s => s.classList.toggle('hidden', s.id !== 'menu'))")

            if name == "landscape":
                # expedition: force-win every stage, pick perks, check carry-over and bot scaling
                page.click("#btn-expedition")
                page.wait_for_timeout(500)
                for stage in range(5):
                    # give the player a few buildings, then take every bot segment
                    page.evaluate("__fl.skipCountdown()")
                    page.evaluate("""(() => { const b = __fl.battle, types = ['farm', 'farm', 'lab', 'fort', 'barracks', 'hospital'];
                      const free = b.segs.filter(s => !s.capital).slice(0, 6);
                      free.forEach((s, i) => { s.owner = 0; s.building = types[i]; s.troops = 300; });
                      for (const s of b.segs) if (s.owner > 0) s.owner = 0;
                      b.armies = []; b.version++; b.updateGrowth(); })()""")
                    page.wait_for_timeout(400)
                    title = page.inner_text("#end-title")
                    perks = page.locator("#end-perks .perk").count()
                    print(f"expedition stage {stage + 1}: '{title}', perk choices: {perks}")
                    if stage == 4:
                        page.screenshot(path=str(out / "expedition-won.png"))
                        break
                    if stage == 0:
                        page.screenshot(path=str(out / "expedition-card.png"))
                    page.locator("#end-perks .perk").first.click()
                    if stage == 0:
                        # frames of the zoom-out: still frame, early, middle, late pull-back
                        for i, ms in enumerate([1200, 1500, 1000, 900]):
                            page.wait_for_timeout(ms)
                            page.screenshot(path=str(out / f"expedition-zoom{i}.png"))
                        page.wait_for_timeout(1000)
                    else:
                        page.wait_for_timeout(5400)
                    info = page.evaluate("""(() => { const b = __fl.battle, e = __fl.expedition, me = b.segs[b.factions[0].capitalSeg];
                      return { stage: e.stage + 1, segs: b.segs.length, capital_troops: Math.round(me.troops), reserve: Math.round(b.factions[0].reserve),
                        bonus: Object.fromEntries(Object.entries(me.bonus).map(([k, v]) => [k, +v.toFixed(3)])),
                        bot_capitals: b.factions.slice(1).map(f => Math.round(b.segs[f.capitalSeg].troops + f.reserve)), perks: e.perks }; })()""")
                    print(f"  -> {info}")
                    if stage == 3:
                        page.screenshot(path=str(out / "expedition-world.png"))
                page.evaluate("document.querySelectorAll('.screen').forEach(s => s.classList.toggle('hidden', s.id !== 'menu'))")
                page.evaluate("document.getElementById('end').classList.add('hidden')")

            if name == "pc":
                t0 = time.time()
                res = page.evaluate(sim_js)
                print(f"bot battles ({time.time() - t0:.1f}s):")
                for r in res:
                    print("  ", json.dumps(r))

            # campaign map
            page.evaluate("document.getElementById('btn-campaign').click()")   # hidden on the menu for now
            page.wait_for_timeout(300)
            home = page.evaluate("__fl.campaign.map.segs.find(s => __fl.campaign.attackable(s.id)).id")
            box = page.locator("#campaign-canvas").bounding_box()
            seg = page.evaluate(f"__fl.campaign.map.segs[{home}]")
            cx, cy = page.evaluate("([x, y]) => [__fl.cview.sx(x), __fl.cview.sy(y)]", [seg["x"], seg["y"]])
            page.mouse.click(box["x"] + cx, box["y"] + cy)
            page.wait_for_timeout(200)
            page.screenshot(path=str(out / f"{name}-campaign.png"))

            # start that region's battle, then play: select own segment, attack a neighbour
            page.click("#attack-btn")
            page.wait_for_timeout(1200)
            page.screenshot(path=str(out / f"{name}-countdown.png"))   # 3-2-1 overlay
            page.evaluate("__fl.skipCountdown()")
            page.wait_for_timeout(200)
            b = page.evaluate("""(() => { const b = __fl.battle; const me = b.segs.find(s => s.owner === 0);
                return { me: me.id, x: me.x, y: me.y, target: b.segs[me.adj[0]] }; })()""")
            box = page.locator("#battle-canvas").bounding_box()
            # grid -> screen through the view's tilted camera
            def to_px(x, y):
                sx, sy = page.evaluate("([x, y]) => [__fl.view.sx(x), __fl.view.sy(y)]", [x, y])
                return box["x"] + sx, box["y"] + sy
            page.wait_for_timeout(1000)
            page.evaluate("__fl.battle.segs[%d].troops = 200" % b["me"])   # enough for a farm + an attack
            def drag(a, z):
                # finger drag from grid point a to grid point z, in small steps
                (x0, y0), (x1, y1) = to_px(*a), to_px(*z)
                page.mouse.move(x0, y0)
                page.mouse.down()
                page.mouse.move(x1, y1, steps=8)
                page.mouse.up()
            page.mouse.click(*to_px(b["x"], b["y"]))   # click own tile: selects it, build bar goes live
            page.wait_for_timeout(150)
            bar_live = page.evaluate("!document.getElementById('buildbar').classList.contains('off')")
            print(f"{name}: build bar live after selecting own tile -> {bar_live}")
            page.hover("#buildbar .bslot[data-type=farm]")
            page.wait_for_timeout(250)
            page.screenshot(path=str(out / f"{name}-buildbar.png"))   # build bar + tooltip
            page.click("#buildbar .bslot[data-type=farm]")
            page.mouse.click(*to_px(b["target"]["x"], b["target"]["y"]))   # tap elsewhere: closes, sends nothing
            page.wait_for_timeout(100)
            tapped = page.evaluate("__fl.battle.stats.sent")
            drag((b["x"], b["y"]), (b["target"]["x"], b["target"]["y"]))   # drag = attack
            page.wait_for_timeout(300)
            state = page.evaluate("({ my_armies: __fl.battle.armies.filter(a => a.owner === 0).length, orders: __fl.battle.stats.sent, building: __fl.battle.segs[%d].building })" % b["me"])
            print(f"{name}: tap sends {tapped}; after drag attack + farm -> {state}")
            page.screenshot(path=str(out / f"{name}-battle.png"))
            # drag-to-move: give the player a 2nd neighbouring segment, then drag home -> it
            mv = page.evaluate("""(() => { const b = __fl.battle, me = b.segs[%d];
                const n = b.segs[me.adj[me.adj.length - 1]]; n.owner = 0; me.troops = 40; b.version++;
                return { id: n.id, x: n.x, y: n.y }; })()""" % b["me"])
            page.wait_for_timeout(100)
            drag((b["x"], b["y"]), (mv["x"], mv["y"]))
            moved = page.evaluate("__fl.battle.armies.some(a => a.owner === 0 && a.to === %d)" % mv["id"])
            print(f"{name}: drag to own neighbour moves troops -> {moved}")
            # that move also set a standing route (routes are always on)
            r = page.evaluate("""(() => { const b = __fl.battle, me = b.segs[%d];
                me.troops = me.cap; for (let i = 0; i < 25; i++) b.step(0.1);
                return { routes: b.routes.size, keep: b.routes.get(%d)?.keep, troops: Math.round(me.troops), cap: me.cap }; })()""" % (b["me"], b["me"]))
            print(f"{name}: route -> {r}")
            page.wait_for_timeout(200)
            page.screenshot(path=str(out / f"{name}-route.png"))
            # frame times: 3 s of real play at 3x speed (bots fighting, captures -> layer rebuilds)
            page.evaluate("__fl.setSpeed(3)")   # no x3 button any more; the test hook still fast-forwards
            perf = page.evaluate("""() => new Promise((done) => {
              const v = __fl.view, gaps = [];
              // owner-layer rebuild cost: cold (sprites rebuilt) and warm (sprites cached, the usual capture case)
              let cold = 0, warm = 0;
              for (let i = 0; i < 3; i++) { v.layerOwner = null; v.sprites.clear(); const a = performance.now(); v.drawBase(); cold += performance.now() - a; }
              for (let i = 0; i < 5; i++) { v.layerOwner = null; const a = performance.now(); v.drawBase(); warm += performance.now() - a; }
              const t0 = performance.now();
              let last = t0;
              const tick = (now) => {
                gaps.push(now - last); last = now;
                if (now - t0 < 3000) requestAnimationFrame(tick);
                else {
                  gaps.sort((a, b) => a - b);
                  done({ frames: gaps.length, avg: +(3000 / gaps.length).toFixed(1), p95: +gaps[Math.floor(gaps.length * 0.95)].toFixed(1),
                         worst: +gaps[gaps.length - 1].toFixed(1), owner_rebuild_cold_ms: +(cold / 3).toFixed(1), owner_rebuild_warm_ms: +(warm / 5).toFixed(1) });
                }
              };
              requestAnimationFrame(tick);
            })""")
            print(f"{name}: frame ms -> {perf}")

            # fast-forward to the end and show the result card
            page.evaluate("__fl.battle.simulate(1500)")
            page.wait_for_timeout(300)
            page.screenshot(path=str(out / f"{name}-end.png"))
            print(f"{name}: battle state after fast-forward = {page.evaluate('__fl.battle.state')}")
            page.close()
        browser.close()
finally:
    server.terminate()
    if errors: print('js errors so far:', errors[:5])

print("js errors:", errors or "none")
print("screenshots:", out)
