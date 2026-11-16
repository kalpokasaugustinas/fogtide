# records a short bot-vs-bot battle as a gif for launch posts (reddit / itch devlog)
# usage: python tools/make_gif.py [seed] [seconds]
# output: dist/itch/battle.gif
# the player side is played by a bot (?autoplay), so the whole island fills up on its own;
# ?nocount keeps the recording out of goatcounter.
import io
import socket
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
out = root / "dist" / "itch" / "battle.gif"
seed = int(sys.argv[1]) if len(sys.argv) > 1 else 4242
seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 60   # game seconds shown in the gif
theme = sys.argv[3] if len(sys.argv) > 3 else "summer"           # summer | autumn | winter | desert | moor
gif_w, gif_h = 640, 360          # small enough for reddit/discord, still readable
skip = 25                        # game seconds fast-forwarded before recording (slow opening)
fps, game_per_frame = 12, 0.5    # 12 gif frames per second, each = 0.5 game s -> 6x real speed
zoom = 1.3                       # zoom in a bit so tiles and numbers read at gif size

# free port + local static server (same approach as smoke_test.py)
with socket.socket() as s:
    s.bind(("localhost", 0))
    port = s.getsockname()[1]
server = subprocess.Popen([sys.executable, "-m", "http.server", str(port)], cwd=root,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)

frames = []
try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 960, "height": 540})   # itch embed size
        page.add_init_script("localStorage.setItem('frontlines.tutorial', '1')")   # skip tutorial
        page.goto(f"http://localhost:{port}/index.html?autoplay&nocount")
        page.wait_for_timeout(800)
        # 4 factions on a fixed seed, same setup as a quick battle
        page.evaluate("""([seed, theme]) => __fl.startBattle({ seed, theme, cells: 22, neutral: [0.15, 0.35],
            factions: [0, 1, 2, 3].map((color) => ({ ai: color > 0, color, think: 3,
              personality: { build: 1, risk: 1, actions: 1, grudge: 0 } })) }, 'skirmish')""", [seed, theme])
        page.evaluate("__fl.skipCountdown()")
        page.evaluate("__fl.setSpeed(0)")                       # pause: we step the game ourselves
        page.evaluate(f"__fl.battle.simulate({skip})")          # jump past the slow opening
        # show the normal pause icon, so the gif doesn't look paused
        page.evaluate("(() => { const b = document.getElementById('speed'); b.textContent = '❚❚'; b.classList.remove('paused'); })()")
        # centre the zoomed camera
        page.evaluate(f"""(() => {{ const w = document.getElementById('battle-wrap').clientWidth,
            h = document.getElementById('battle-wrap').clientHeight;
            __fl.setCam({zoom}, -(w * {zoom} - w) / 2, -(h * {zoom} - h) / 2); }})()""")
        page.wait_for_timeout(600)                              # let the zoom re-render settle
        # fixed game time per frame -> smooth, even playback no matter how slow screenshots are
        for _ in range(int(seconds / game_per_frame)):
            state = page.evaluate(f"""() => new Promise((done) => {{
                const st = __fl.battle.simulate({game_per_frame});
                requestAnimationFrame(() => requestAnimationFrame(() => done(st)));   // wait for a redraw
            }})""")
            png = page.screenshot()
            frames.append(Image.open(io.BytesIO(png)).convert("RGB").resize((gif_w, gif_h), Image.LANCZOS))
            if state != "running":   # someone won: stop, the last frame is held below
                break
        browser.close()
finally:
    server.terminate()

# even frame times; last frame holds 2 s so the loop has a pause before restarting
durations = [int(1000 / fps)] * (len(frames) - 1) + [2000]
# one shared palette from a sample of frames -> no colour flicker between frames
sample = Image.new("RGB", (gif_w, gif_h * 4))
for i, f in enumerate(frames[:: max(1, len(frames) // 4)][:4]):
    sample.paste(f, (0, gif_h * i))
pal = sample.quantize(colors=128, method=Image.MEDIANCUT)
q = [f.quantize(palette=pal, dither=Image.NONE) for f in frames]
q[0].save(out, save_all=True, append_images=q[1:], duration=durations, loop=0, optimize=True)
print(f"saved {out} ({len(frames)} frames, {out.stat().st_size / 1e6:.1f} MB)")
