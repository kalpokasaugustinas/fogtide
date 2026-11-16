# intro cutscene test (js/intro.js): overlay + begin card, every shot renders without errors,
# esc skips and remembers it, the menu button replays it, automated runs skip the first-launch intro.
# usage: python tools/intro_test.py [screenshot dir]
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
shots_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else None
with socket.socket() as s:
    s.bind(("localhost", 0))
    port = s.getsockname()[1]
server = subprocess.Popen([sys.executable, "-m", "http.server", str(port)], cwd=root,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2)
fails, errors = [], []


def check(name, ok, info=""):
    print(("PASS " if ok else "FAIL ") + name + (f" ({info})" if info else ""))
    if not ok:
        fails.append(name)


try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 900})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and errors.append(m.text))
        url = f"http://localhost:{port}/index.html?nocount"

        # automated browser (webdriver) on a fresh profile: no first-launch intro
        page.goto(url)
        page.wait_for_timeout(2500)
        check("tests skip the first-launch intro", page.locator(".intro").count() == 0)

        # ?intro forces it: overlay with the begin card
        page.goto(url + "&intro")
        page.wait_for_function("() => !!window.__intro", timeout=20000)
        check("intro overlay shown", page.locator(".intro").count() == 1)
        check("begin card shown (web)", page.locator(".intro-start").count() == 1)
        page.locator(".intro-start").click()
        page.wait_for_timeout(600)
        t = page.evaluate("window.__intro.t")
        check("plays after begin", t > 0.2, f"t={t:.2f}")

        # seek through every shot (middle of each), render a frame, collect errors
        n = page.evaluate("window.__intro.shots")
        end = page.evaluate("window.__intro.end")
        for k in range(n):
            # shot k middle: shots are evenly spread enough that sampling 2 points per shot covers them
            for frac in (0.3, 0.75):
                page.evaluate(f"window.__intro.seek({(k + frac) / n * end})")
                page.wait_for_timeout(60)
        check("every part renders without errors", not errors, "; ".join(errors[:3]))
        if shots_dir:
            for sec in (3, 16, 30, 47, 58):
                page.evaluate(f"window.__intro.seek({sec})")
                page.wait_for_timeout(250)
                page.screenshot(path=str(shots_dir / f"intro_{sec}.png"))

        # esc skips, overlay goes, the intro is remembered
        page.keyboard.press("Escape")
        page.wait_for_timeout(900)
        check("esc skips the intro", page.locator(".intro").count() == 0)
        check("settings did not open on that esc", page.locator("#settings:not(.hidden)").count() == 0)
        seen = page.evaluate("localStorage.getItem('fogtide.introSeen')")
        check("intro remembered as seen", seen == "1")

        # menu button replays it
        page.goto(url)
        page.wait_for_timeout(2500)
        page.locator("#m-intro").click()
        page.wait_for_function("() => !!window.__intro", timeout=20000)
        check("menu button opens the intro", page.locator(".intro").count() == 1)
        page.locator(".intro-skip").click()
        page.wait_for_timeout(900)
        check("skip button closes it", page.locator(".intro").count() == 0)
        browser.close()
finally:
    server.terminate()
print("ALL PASS" if not fails else f"{len(fails)} FAILED: {', '.join(fails)}")
sys.exit(1 if fails else 0)
