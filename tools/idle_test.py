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
            page.click(".node[data-id='auto']")
            page.click("#shop-buy")
            page.wait_for_timeout(300)
            page.screenshot(path=str(out / f"idle-{name}-shop-bought.png"))
            st = page.evaluate("({ atk: __fl.battle.factions[0].mods.atk, auto: __fl.idle.autoOn, links: document.querySelectorAll('.shop-links path').length })")
            check(abs(st["atk"] - 1.05 ** 2) < 1e-9 and st["auto"] and st["links"] > 10, f"{name}: purchases apply live ({st})")
            page.click("#shop-close")
            page.click("#idle-auto")
            check(not page.evaluate("__fl.idle.autoOn"), f"{name}: auto toggle off")
            page.click("#idle-auto")
            # auto-attack: fill the capital to 95% and let a few game seconds pass -> an army leaves
            page.evaluate("(() => { __fl.idle.levels.autoneutral = 1; const b = __fl.battle, s = b.segs[b.factions[0].capitalSeg]; s.troops = s.cap * 0.95; })()")   # expand: neutral neighbours count (an enemy may not touch the capital)
            page.wait_for_timeout(2500)
            sent = page.evaluate("__fl.battle.armies.some((a) => a.owner === 0) || __fl.battle.segs.filter((s) => s.owner === 0).length > 1")
            check(sent, f"{name}: auto-attack sends from a 95% full tile")
            # archers: give both sides archers and check enemy troops fall next to ours (no army needed)
            arch = page.evaluate("""(() => { const b = __fl.battle; b.factions[0].mods = { ...b.factions[0].mods, archers: 5 }; b.updateGrowth();
              const k0 = b.stats.killed; b.armies = []; for (let i = 0; i < 20; i++) b.shoot(0.5);
              return { killed: b.stats.killed - k0, pairs: b.segs.filter((s) => s.owner === 0).some((s) => s.adj.some((a) => b.segs[a].owner > 0)) }; })()""")
            check(arch["killed"] > 0 or not arch["pairs"], f"{name}: archers shoot ({arch})")
            page.wait_for_timeout(500)
            page.screenshot(path=str(out / f"idle-{name}-archers.png"))
            # win the stage -> zoom-out -> stage 2, numbers x display
            bank = page.evaluate("__fl.idle.fogs")
            page.click("#test-win")
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
            # lose: hand every player tile to bot 1 -> run over card
            page.evaluate("""(() => { const b = __fl.battle; for (const s of b.segs) if (s.owner === 0) s.owner = 1;
              b.armies = b.armies.filter((a) => a.owner !== 0); b.version++; b.updateGrowth(); b.step(0.1); })()""")
            page.wait_for_timeout(1500)
            title = page.text_content("#end-title")
            check(title == "Run over" and page.evaluate("__fl.idle.stage") == 1, f"{name}: run over card, next run at stage 1 ({title})")
            page.screenshot(path=str(out / f"idle-{name}-runover.png"))
            page.click("#end-shop")
            page.wait_for_timeout(300)
            check(page.is_visible("#idle-shop"), f"{name}: shop opens from the run-over card")
            page.screenshot(path=str(out / f"idle-{name}-runover-shop.png"))
            page.click("#shop-close")
            page.click("#end-retry")
            page.wait_for_timeout(2500)
            check(page.evaluate("__fl.idle.stage") == 1 and page.evaluate("__fl.battle.state") == "running", f"{name}: new run starts")
            page.close()
        browser.close()
finally:
    server.terminate()

print("errors:", errors or "none")
print("FAILED:" if fails or errors else "all passed", fails or "")
