# debug the windows desktop build on this pc: starts dist/desktop/Fogtide/Fogtide.exe with a
# chromium debug port, connects playwright to it, then prints page/console errors, fps (average +
# worst frame) measured in the real app window, an optional js result, and saves a screenshot.
# by default it serves the git working tree (--game-dir), so uncommitted changes are tested
# without a rebuild; --bundled tests the files packed into the exe folder instead.
#
# usage: python tools/desktop_check.py [--out shot.png] [--seconds 4] [--eval "js"] [--click x,y ...]
#                                      [--bundled] [--fullscreen] [--keep]
# needs: python tools/build_desktop.py run once (creates the exe)
import argparse
import json
import os
import socket
import subprocess
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
exe = root / "dist" / "desktop" / "Fogtide" / "Fogtide.exe"

ap = argparse.ArgumentParser()
ap.add_argument("--out", default=str(root / "tools" / "shots" / "desktop.png"), help="screenshot path")
ap.add_argument("--seconds", type=float, default=4, help="how long to measure fps / collect console")
ap.add_argument("--eval", default="", help="js expression to evaluate and print (e.g. window.__fogtide)")
ap.add_argument("--setup", default="", help="js to run before measuring fps (e.g. __fl.startSkirmish())")
ap.add_argument("--click", action="append", default=[], help="click x,y in the window before measuring (repeatable)")
ap.add_argument("--bundled", action="store_true", help="use the files packed into the build, not the working tree")
ap.add_argument("--fullscreen", action="store_true", help="run fullscreen (default: 1280x720 window)")
ap.add_argument("--keep", action="store_true", help="leave the app open afterwards")
a = ap.parse_args()

if not exe.exists():
    raise SystemExit("no desktop build yet: run python tools/build_desktop.py --no-zip")

# free local port for the chromium debug protocol
with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]

cmd = [str(exe), f"--remote-debugging-port={port}", "--dev"]
if not a.bundled:
    cmd.append(f"--game-dir={root}")
if not a.fullscreen:
    cmd.append("--windowed")
# vs code terminals set ELECTRON_RUN_AS_NODE, which turns any electron exe into plain node: drop it
env = {k: v for k, v in os.environ.items() if k != "ELECTRON_RUN_AS_NODE"}
proc = subprocess.Popen(cmd, env=env)

errors = []
try:
    with sync_playwright() as p:
        # the app needs a moment to open its debug port
        for _ in range(50):
            try:
                browser = p.chromium.connect_over_cdp(f"http://127.0.0.1:{port}")
                break
            except Exception:
                time.sleep(0.2)
        else:
            raise SystemExit("app did not open its debug port")
        # wait for the game page (app://fogtide/...)
        page = None
        for _ in range(50):
            pages = [pg for ctx in browser.contexts for pg in ctx.pages if pg.url.startswith("app://")]
            if pages:
                page = pages[0]
                break
            time.sleep(0.2)
        if page is None:
            raise SystemExit("game page not found")
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: m.type in ("error", "warning") and errors.append(f"console.{m.type}: {m.text}"))
        page.reload()                      # reload so errors from the very first run are caught too
        page.wait_for_load_state("load")
        page.wait_for_timeout(1500)        # loading screen -> menu

        for c in a.click:
            x, y = (float(v) for v in c.split(","))
            page.mouse.click(x, y)
            page.wait_for_timeout(700)
        if a.setup:                        # e.g. start a battle, so the fps below are measured in it
            page.evaluate(a.setup)
            page.wait_for_timeout(1500)

        # fps inside the app window: count rAF frames and track the slowest frame
        fps = page.evaluate("""(ms) => new Promise(res => {
            let n = 0, worst = 0, last = performance.now(); const start = last;
            function f(t) { n++; worst = Math.max(worst, t - last); last = t;
                if (t - start < ms) requestAnimationFrame(f);
                else res({ fps: +(n * 1000 / (t - start)).toFixed(1), worst_ms: +worst.toFixed(1), frames: n }); }
            requestAnimationFrame(f);
        })""", int(a.seconds * 1000))
        print("url:", page.url)
        print("build:", page.evaluate("document.getElementById('version')?.textContent"))
        print("window:", page.evaluate("[innerWidth, innerHeight, devicePixelRatio]"))
        print("fps:", json.dumps(fps))
        if a.eval:
            print("eval:", json.dumps(page.evaluate(a.eval), default=str)[:4000])
        Path(a.out).parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=a.out)
        print("screenshot:", a.out)
        print("errors:", len(errors))
        for e in errors:
            print(" ", e)
finally:
    if not a.keep:
        proc.terminate()
