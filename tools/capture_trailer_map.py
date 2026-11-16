# captures a high-res still of a real battle map + every tile's outline, for the intro trailer's
# "the Fog takes every land" shot (mockups/intro-trailer.html). the mockup greys tiles out and fills
# them with fog one by one, so the map itself stays the game's own art.
# usage: python tools/capture_trailer_map.py [seed] [cells]
# output: mockups/img/trailer-map.jpg (2x css px, cropped to the island) + mockups/img/trailer-map.json (tile loops in 1280x720 css px)
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
seed = int(sys.argv[1]) if len(sys.argv) > 1 else 777
cells = int(sys.argv[2]) if len(sys.argv) > 2 else 30
out_img = root / "mockups" / "img" / "trailer-map.jpg"
tmp_png = root / "mockups" / "img" / "_trailer-map.png"
out_json = root / "mockups" / "img" / "trailer-map.json"

# free port + local static server (same approach as smoke_test.py)
with socket.socket() as s:
    s.bind(("localhost", 0))
    port = s.getsockname()[1]
server = subprocess.Popen([sys.executable, "-m", "http.server", str(port)], cwd=root,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2)

# page-side: start a battle with 6 sides (nobody acts: all human, so the map stays as dealt),
# skip the countdown, then read tile outlines in grid units and convert them to css px
start_js = """(o) => {
  const f = window.__fl;
  f.startBattle({ seed: o.seed, cells: o.cells, neutral: [0.15, 0.35], theme: 'summer',
    factions: [0, 1, 2, 3, 4, 5].map((color) => ({ ai: false, color })) }, 'skirmish');
  f.skipCountdown();
}"""
read_js = """async () => {
  const { mapOutlines } = await import('/js/outline.js');
  const v = window.__fl.view, b = window.__fl.battle, o = mapOutlines(v.map);
  const cvs = document.getElementById('battle-canvas').getBoundingClientRect();
  const tx = (gx) => +(gx * v.scale).toFixed(1), ty = (gy) => +(gy * v.scale * v.tilt + v.oy).toFixed(1);
  return {
    w: cvs.width, h: cvs.height,
    tiles: o.segs.map((loops, id) => ({
      id, owner: b.segs[id].owner,
      loops: loops.map((f) => { const pts = []; for (let i = 0; i < f.length; i += 2) pts.push(tx(f[i]), ty(f[i + 1])); return pts; }),
    })),
  };
}"""
try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1920, "height": 1080}, device_scale_factor=2)
        page.on("pageerror", lambda e: print("pageerror:", e))
        page.goto(f"http://localhost:{port}/index.html?nocount")
        page.wait_for_function("() => !!(window.__fl && window.__fl.startBattle)", timeout=20000)
        page.evaluate(start_js, {"seed": seed, "cells": cells})
        page.wait_for_timeout(3500)   # layers + sharp re-render settle
        # hide every dom element except the map canvas (hud, buttons, tooltips)
        page.add_style_tag(content="* { visibility: hidden !important; } #battle-canvas { visibility: visible !important; }")
        page.wait_for_timeout(300)
        data = page.evaluate(read_js)
        page.locator("#battle-canvas").screenshot(path=str(tmp_png), omit_background=True)
        # crop to the island bbox + margin (css px), jpg is ~10x smaller than the png
        xs = [v for t in data["tiles"] for l in t["loops"] for v in l[0::2]]
        ys = [v for t in data["tiles"] for l in t["loops"] for v in l[1::2]]
        m = 70
        x0, y0 = max(0, min(xs) - m), max(0, min(ys) - m)
        x1, y1 = min(data["w"], max(xs) + m), min(data["h"], max(ys) + m + 30)   # +30: island side wall
        Image.open(tmp_png).convert("RGB").crop((int(x0 * 2), int(y0 * 2), int(x1 * 2), int(y1 * 2))).save(out_img, quality=88)
        tmp_png.unlink()
        for t in data["tiles"]:
            t["loops"] = [[round(v - (x0 if i % 2 == 0 else y0), 1) for i, v in enumerate(l)] for l in t["loops"]]
        data["w"], data["h"] = round(x1 - x0, 1), round(y1 - y0, 1)
        out_json.write_text(json.dumps(data), encoding="utf-8")
        print(f"saved {out_img.name} ({data['w']}x{data['h']} css) and {len(data['tiles'])} tiles")
        browser.close()
finally:
    server.terminate()
