# idle mode ui test (headless): menu button, hud, shop purchase applies live, stage win -> zoom-out to
# stage 2 with scaled numbers, auto-battle toggle, run end card, save across a reload.
# usage: python tools/idle_test.py [screenshot_dir]
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
root = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1] if len(sys.argv) > 1 else root / "tools" / "shots")
out.mkdir(parents=True, exist_ok=True)

with socket.socket() as s:
    s.bind(("localhost", 0))
    port = s.getsockname()[1]
server = subprocess.Popen([sys.executable, "-m", "http.server", str(port)], cwd=root,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
errors, fails = [], []


def check(ok, what):
    # collect failures instead of stopping at the first one
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        fails.append(what)


try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, vp in [("landscape", {"width": 1280, "height": 720}), ("phone", {"width": 844, "height": 390})]:
            page = browser.new_page(viewport=vp)
            page.add_init_script("localStorage.setItem('frontlines.tutorial', '1')")
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            page.goto(f"http://localhost:{port}/index.html?test")
            page.evaluate("localStorage.removeItem('frontlines.idle')")
            page.reload()
            page.wait_for_timeout(1500)
            check(page.is_visible("#btn-idle"), f"{name}: idle button on the menu")
            page.screenshot(path=str(out / f"idle-{name}-menu.png"))
            page.click("#btn-idle")
            page.wait_for_timeout(2500)
            check(page.evaluate("__fl.battle && document.querySelector('#stage').textContent") == "Stage 1", f"{name}: stage 1 badge")
            check(page.is_visible("#idle-fogs") and page.is_visible("#idle-shop-btn"), f"{name}: fog counter + shop button visible")
            # huts stay off tile lines, mountains and lakes: share of hut boxes (roof to base) that
            # cover a cell of anything but their own tile (was ~60% when only the coast counted)
            hut = page.evaluate("""() => { const v = __fl.view, m = v.map, g = m.grid; let bad = 0, n = 0;
              m.segs.forEach((s, id) => { for (const h of v.hutList(id)) { n++; const [x0, y0, x1, y1] = h.box; let hit = false;
                for (let py = y0; py <= y1 && !hit; py++) for (let px = x0; px <= x1; px++) {
                  const gx = Math.floor(px / v.scale), gy = Math.floor((py - v.oy) / (v.scale * v.tilt));
                  if (m.ids[gy * g + gx] !== id) { hit = true; break; } } if (hit) bad++; } });
              return { n, bad }; }""")
            check(hut["n"] > 0 and hut["bad"] / hut["n"] < 0.2, f"{name}: huts off tile lines / mountains ({hut})")
            page.evaluate("__fl.skipCountdown()")
            page.wait_for_timeout(4000)
            fogs = page.evaluate("__fl.idle.fogs")
            print(f"     fogs after ~4 s: {fogs:.1f}")
            # tree: march is veiled until blades reach 2; buy blades x2 (tap node, buy), march opens;
            # buy auto-attack; the battle gets the new mods at once
            page.evaluate("__fl.idle.fogs = 1e4")
            page.click("#idle-shop-btn", force=True)   # it pulses when affordable (never "stable")
            page.wait_for_timeout(300)
            check(page.evaluate("document.querySelector('.node[data-id=march]').classList.contains('veiled')"), f"{name}: forced march veiled at the start")
            page.screenshot(path=str(out / f"idle-{name}-shop.png"))
            page.click(".node[data-id='atk']")
            page.click("#shop-buy")
            page.click("#shop-buy")
            check(not page.evaluate("document.querySelector('.node[data-id=march]').classList.contains('veiled')"), f"{name}: blades 2 opens forced march")
            page.wait_for_timeout(300)
            page.screenshot(path=str(out / f"idle-{name}-shop-bought.png"))
            st = page.evaluate("({ atk: __fl.battle.factions[0].mods.atk, links: document.querySelectorAll('#shop-tree path').length, cols: document.querySelectorAll('#shop-tree .root-label').length })")
            check(abs(st["atk"] - 1.05 ** 2) < 1e-9 and st["links"] > 10 and st["cols"] == 4, f"{name}: purchases apply live, 4 columns ({st})")
            # war council tab (C): unlock the warlord (1 Mist) -> seated at once, auto on; then the
            # pathfinder (2 Mist) and the marksman (3 Mist): arrows in the battle mods
            page.evaluate("__fl.idle.mist = 6; __fl.idle.mistTotal = 6")
            # a real mouse click on the tab (the tree once covered the tab row, so only C worked)
            tb = page.locator(".shop-tabs button[data-tab='wc']").bounding_box()
            page.mouse.click(tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] / 2)
            page.wait_for_timeout(200)
            check(page.is_visible("#council"), f"{name}: mouse click on the War Council tab opens it")
            tb = page.locator(".shop-tabs button[data-tab='up']").bounding_box()
            page.mouse.click(tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] / 2)
            page.wait_for_timeout(200)
            page.keyboard.press("c")
            page.wait_for_timeout(300)
            check(page.is_visible("#council") and not page.is_visible("#shop-tree"), f"{name}: C opens the war council tab")
            for gid in ["warlord", "pathfinder", "marksman"]:
                page.click(f".rg[data-gen='{gid}']")
                page.click("#gen-unlock")
                page.wait_for_timeout(100)
            st = page.evaluate("({ seats: __fl.idle.seats, mist: __fl.idle.mist, auto: __fl.idle.autoOn, arch: __fl.battle.factions[0].mods.archers })")
            check(st["seats"][:3] == ["warlord", "pathfinder", "marksman"] and st["mist"] == 0 and st["auto"] and st["arch"] > 0, f"{name}: unlock with Mist seats generals, arrows on ({st})")
            # orders: the warlord's slider and pick are saved
            page.click(".seat[data-seat='0']")
            page.evaluate("(() => { const r = document.querySelector('input[data-ord=at]'); r.value = 60; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); })()")
            page.click(".chips button[data-ord='prefer'][data-v='1']")
            check(page.evaluate("JSON.stringify(__fl.idle.ord('warlord'))") == '{"at":60,"prefer":1}', f"{name}: warlord orders set")
            page.wait_for_timeout(300)
            page.screenshot(path=str(out / f"idle-{name}-council.png"))
            page.click("#shop-close")
            page.evaluate("document.querySelector('#idle-auto').click()")   # phone: the top bar can overflow 844 px
            check(not page.evaluate("__fl.idle.autoOn"), f"{name}: auto toggle off")
            page.evaluate("document.querySelector('#idle-auto').click()")   # phone: the top bar can overflow 844 px
            # auto-attack: fill the capital to 95% and let a few game seconds pass -> an army leaves
            page.evaluate("(() => { const b = __fl.battle, s = b.segs[b.factions[0].capitalSeg]; s.troops = s.cap * 0.95; })()")   # pathfinder: neutral neighbours count (an enemy may not touch the capital)
            page.wait_for_timeout(2500)
            sent = page.evaluate("__fl.battle.armies.some((a) => a.owner === 0) || __fl.battle.segs.filter((s) => s.owner === 0).length > 1")
            check(sent, f"{name}: generals send from a 95% full tile")
            # houndmaster, field surgeon, war drummer straight on the idle profile + battle
            gen = page.evaluate("""(() => { const id = __fl.idle, b = __fl.battle;
              Object.assign(id.gens, { houndmaster: 1, surgeon: 5, drummer: 1 }); id.seats = ['houndmaster', 'surgeon', 'drummer', null]; id.setOrder('drummer', 'when', 0);
              const mine = b.segs.find((s) => s.owner === 0), foe = b.segs.find((s) => s.owner > 0);
              b.armies.push({ owner: foe.owner, n: 100, atk: 1, from: foe.id, to: mine.id, t: 0.6, dur: 10, stopAt: 0.5, fight: null, done: false });
              const k0 = b.stats.killed, cap = b.segs.find((s) => s.capital && s.owner === 0) ?? mine, t0 = cap.troops;
              b.stats.deaths += 1000; b.councilT = {};
              const sp0 = b.mods(0).speed ?? 1;
              id.autoTick(b, 1.01);
              return { bite: b.stats.killed - k0, revived: cap.troops - t0, drum: id.drumOn, speed: (b.mods(0).speed ?? 1) / sp0 }; })()""")
            check(abs(gen["bite"] - 10) < 1e-6 and gen["revived"] >= 19 and gen["drum"] and gen["speed"] > 1.19, f"{name}: hounds bite 10%, surgeon revives 2%, drum speeds up ({gen})")
            # archers: give both sides archers and check enemy troops fall next to ours (no army needed)
            arch = page.evaluate("""(() => { const b = __fl.battle; b.factions[0].mods = { ...b.factions[0].mods, archers: 5 }; b.updateGrowth();
              const k0 = b.stats.killed; b.armies = []; for (let i = 0; i < 20; i++) b.shoot(0.5);
              return { killed: b.stats.killed - k0, pairs: b.segs.filter((s) => s.owner === 0).some((s) => s.adj.some((a) => b.segs[a].owner > 0)) }; })()""")
            check(arch["killed"] > 0 or not arch["pairs"], f"{name}: archers shoot ({arch})")
            page.wait_for_timeout(500)
            page.screenshot(path=str(out / f"idle-{name}-archers.png"))
            # win the stage -> zoom-out -> stage 2, numbers x display
            bank = page.evaluate("__fl.idle.fogs")
            page.evaluate("document.querySelector('#test-win').click()")
            page.wait_for_timeout(800)
            page.screenshot(path=str(out / f"idle-{name}-won.png"))
            page.wait_for_timeout(7000)
            st = page.evaluate("({ stage: __fl.idle.stage, badge: document.querySelector('#stage').textContent, fogs: __fl.idle.fogs, state: __fl.battle.state })")
            check(st["stage"] == 2 and st["badge"] == "Stage 2" and st["state"] == "running", f"{name}: zoomed out to stage 2 ({st})")
            check(st["fogs"] > bank, f"{name}: stage bonus paid ({bank:.0f} -> {st['fogs']:.0f})")
            page.wait_for_timeout(1500)
            page.screenshot(path=str(out / f"idle-{name}-stage2.png"))
            # save: reload resumes stage 2 with the upgrades
            page.evaluate("__fl.idle.save()")
            page.reload()
            page.wait_for_timeout(1500)
            menu = page.text_content("#m-idle")
            check("stage 2" in menu, f"{name}: menu shows the saved run ({menu})")
            page.click("#btn-idle")
            page.wait_for_timeout(2500)
            st = page.evaluate("({ stage: __fl.idle.stage, atk: __fl.idle.lvl('atk') })")
            check(st == {"stage": 2, "atk": 2}, f"{name}: resumed with upgrades ({st})")
            mig = page.evaluate("""(() => { const I = __fl.idle.constructor; const o = new I({ fogs: 0, mist: 0, levels: { atk: 3, auto: 2, archers: 1, sharpeye: 1, reinforce: 1 } });
              return { fogs: o.fogs, mist: o.mist, seats: o.seats, gens: o.gens, levels: o.levels }; })()""")
            check(mig["fogs"] == 40 + 104 + 1400 + 700 and mig["mist"] == 1 and mig["seats"][:2] == ["warlord", "marksman"] and "auto" not in mig["levels"], f"{name}: old command upgrades refunded, warlord + marksman seated ({mig})")
            # lose: hand every player tile to bot 1 -> run over card
            page.evaluate("""(() => { const b = __fl.battle; for (const s of b.segs) if (s.owner === 0) s.owner = 1;
              b.armies = b.armies.filter((a) => a.owner !== 0); b.version++; b.updateGrowth(); b.step(0.1); })()""")
            page.wait_for_timeout(1500)
            title = page.text_content("#end-title")
            check(title == "Run over" and page.evaluate("__fl.idle.stage") == 1, f"{name}: run over card, next run at stage 1 ({title})")
            page.screenshot(path=str(out / f"idle-{name}-runover.png"))
            check(page.query_selector("#end-shop") is None, f"{name}: no Spend Fog on the run-over card (spent during a run)")
            page.evaluate("document.querySelector('#end-retry').click()")
            page.wait_for_timeout(2500)
            check(page.evaluate("__fl.idle.stage") == 1 and page.evaluate("__fl.battle.state") == "running", f"{name}: new run starts")
            page.close()
        browser.close()
finally:
    server.terminate()

print("errors:", errors or "none")
print("FAILED:" if fails or errors else "all passed", fails or "")
