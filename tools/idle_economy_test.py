# idle economy ui test (headless): land depletion, the quiet (fog closes in) rule, boss Mist drop,
# Mist upgrades, the fog horn on the menu (real-time Fog, collect, puffs into the upgrade button).
# usage: python tools/idle_economy_test.py [screenshot_dir]
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
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        page.add_init_script("localStorage.setItem('frontlines.tutorial', '1')")
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.goto(f"http://localhost:{port}/index.html?test")
        page.evaluate("localStorage.removeItem('frontlines.idle')")
        page.reload()
        page.wait_for_timeout(1500)
        check(not page.is_visible("#idle-hub"), "hub hidden before idle was ever played")
        page.click("#btn-idle")
        page.wait_for_timeout(2500)
        page.evaluate("__fl.skipCountdown()")

        # land depletion: a tile that already raised (limit - 1) grows by 1 at most, then stops
        r = page.evaluate("""(() => { const b = __fl.battle, s = b.segs[b.factions[0].capitalSeg];
          s.troops = 0; s.raised = b.landLimit(s) - 1; const t0 = s.troops;
          for (let i = 0; i < 50; i++) b.step(0.1);
          return { grew: s.troops - t0, share: b.landShare(s), limit: b.landLimit(s), cap: s.cap }; })()""")
        check(r["grew"] <= 1.0001 and r["share"] == 0 and abs(r["limit"] - 5 * r["cap"]) < 1e-6, f"land runs dry at 5x cap ({r})")
        page.wait_for_timeout(400)
        page.screenshot(path=str(out / "eco-land.png"))

        # quiet rule: nobody marching for 30 game s -> decided by the bigger army
        r = page.evaluate("""(() => { const b = __fl.battle; for (const f of b.factions) if (f.ai) f.think = 1e9, f.timer = 1e9;
          b.armies = []; for (const s of b.segs) if (s.owner === 0) s.troops = 1e5;
          for (let i = 0; i < 320 && b.state === 'running'; i++) { b.armies = []; b.step(0.1); }
          return { state: b.state, closedIn: b.closedIn, t: Math.round(b.quiet) }; })()""")
        check(r["state"] == "won" and r["closedIn"], f"fog closes in after 30 s quiet, bigger army wins ({r})")
        page.wait_for_timeout(7500)   # stage card + zoom-out to stage 2

        # boss: jump to stage 10, win -> Mist
        page.evaluate("(() => { __fl.idle.stage = 10; })()")
        page.evaluate("__fl.startIdle()")
        page.wait_for_timeout(2500)
        badge = page.text_content("#stage")
        page.click("#test-win")
        page.wait_for_timeout(600)
        r = page.evaluate("({ mist: __fl.idle.mist, stage: __fl.idle.stage, toast: document.querySelector('#toast').textContent, puffs: document.querySelectorAll('.fog-puff').length })")
        check("👑" in badge and r["mist"] == 1 and r["stage"] == 11 and "Mist" in r["toast"], f"boss stage 10 drops 1 Mist ({badge} {r})")
        check(r["puffs"] > 0, f"fog puffs fly into the upgrade button ({r['puffs']})")
        page.screenshot(path=str(out / "eco-boss.png"))
        page.wait_for_timeout(6000)

        # Mist upgrade: open the requirements of mist blades, buy it with Mist, attack x1.1 more
        r = page.evaluate("""(() => { const id = __fl.idle; Object.assign(id.levels, { atk: 6, march: 2, conscription: 1, def: 2, walls: 1, archers: 2, plunder: 1 });
          id.mist = 5; id.mistTotal = 5; const before = id.mods().atk; const ok = id.buy('mistblades');
          return { ok, ratio: id.mods().atk / before, mist: id.mist }; })()""")
        check(r["ok"] and abs(r["ratio"] - 1.1) < 1e-9 and r["mist"] == 4, f"mist blades costs 1 Mist, attack x1.1 ({r})")
        page.click("#idle-shop-btn", force=True)
        page.wait_for_timeout(400)
        page.click(".node[data-id='mistveil']")
        page.screenshot(path=str(out / "eco-tree-mist.png"))
        check(page.is_visible(".node.mist") and "Mist" in page.text_content("#shop-fogs"), "mist nodes and Mist balance shown in the tree")
        page.click("#shop-close")

        # fog horn: bought an hour ago with best stage 11 -> it holds Fog on the menu; collect it
        page.evaluate("""(() => { const id = __fl.idle; id.levels.wells = 1; id.levels.horn = 1; id.hornStored = 0; id.hornAt = Date.now() - 3600e3; id.save(); })()""")
        page.click("#battle-quit")
        page.wait_for_timeout(300)
        if page.is_visible("#leave-go"):
            page.click("#leave-go")
        page.wait_for_timeout(1200)
        check(page.is_visible("#idle-hub") and page.is_visible("#hub-horn"), "menu shows the hub with the horn")
        amt = page.evaluate("__fl.idle.hornAmount()")
        expect = page.evaluate("__fl.idle.hornRate * 3600")
        check(abs(amt - expect) / expect < 0.01, f"horn gathered an hour of Fog ({amt:.0f} vs {expect:.0f})")
        page.screenshot(path=str(out / "eco-menu-horn.png"))
        before = page.evaluate("__fl.idle.fogs")
        page.click("#hub-horn")
        page.wait_for_timeout(350)
        page.screenshot(path=str(out / "eco-horn-flow.png"))
        puffs = page.evaluate("document.querySelectorAll('.fog-puff').length")
        page.wait_for_timeout(2500)
        r = page.evaluate("({ fogs: __fl.idle.fogs, horn: __fl.idle.hornAmount(), bank: document.querySelector('#hub-fog').textContent })")
        check(r["fogs"] - before > expect * 0.99 and r["horn"] < expect * 0.01 and puffs > 0, f"collect: Fog into the bank, horn empty, {puffs} puffs ({r})")
        page.screenshot(path=str(out / "eco-menu-after.png"))
        page.click("#hub-shop")
        page.wait_for_timeout(400)
        check(page.is_visible("#idle-shop"), "upgrade tree opens from the menu")
        page.screenshot(path=str(out / "eco-menu-tree.png"))
        page.close()
        # phone landscape menu layout with the hub
        ph = browser.new_page(viewport={"width": 844, "height": 390})
        ph.add_init_script("localStorage.setItem('frontlines.tutorial', '1'); localStorage.setItem('frontlines.idle', JSON.stringify({ fogs: 12345, total: 99999, mist: 3, mistTotal: 3, runs: 2, best: 12, levels: { horn: 2, wells: 1, fog: 2 }, hornAt: Date.now() - 600e3 }))")
        ph.on("pageerror", lambda e: errors.append(str(e)))
        ph.goto(f"http://localhost:{port}/index.html")
        ph.wait_for_timeout(4000)   # past the loading screen
        ph.screenshot(path=str(out / "eco-phone-menu.png"))
        ph.close()
        browser.close()
finally:
    server.terminate()

print("errors:", errors or "none")
print("FAILED:" if fails or errors else "all passed", fails or "")
