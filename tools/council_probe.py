# war council probe: per stage, can the council alone (no human) play it? runs tools/council_probe.js
# headless and prints: stage, the bot's result, the council-only result, council attacks / moves,
# average tile fill and the share of time a tile is at the warlord's "attack at" level.
# usage: python tools/council_probe.py [--campaigns 4] [--lv 3] [--set key=val ...]
import argparse
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
root = Path(__file__).resolve().parent.parent
ap = argparse.ArgumentParser()
ap.add_argument("--campaigns", type=int, default=4)
ap.add_argument("--lv", type=int, default=3, help="general level")
ap.add_argument("--cap", type=int, default=600, help="game seconds before a stage is a stall")
ap.add_argument("--orders", default="{}", help='json, e.g. {"warlord": {"at": 50}}')
ap.add_argument("--seats", default="warlord,pathfinder,quartermaster,marshal")
ap.add_argument("--growth", type=float, default=1, help="player growth x (council runs only)")
ap.add_argument("--set", nargs="*", default=[], help="idleCfg overrides")
args = ap.parse_args()
over = {k: float(v) for k, v in (kv.split("=") for kv in args.set)}

with socket.socket() as s:
    s.bind(("localhost", 0))
    port = s.getsockname()[1]
server = subprocess.Popen([sys.executable, "-m", "http.server", str(port)], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
try:
    with sync_playwright() as p:
        page = p.chromium.launch().new_page()
        page.on("pageerror", lambda e: print("page error:", e))
        page.goto(f"http://localhost:{port}/tools/")
        page.evaluate("async (o) => { window.cp = await import('/tools/council_probe.js'); cp.tune(o); }", over)
        rows = page.evaluate("(o) => cp.probe(o)", {"campaigns": args.campaigns, "cap": args.cap, "lv": args.lv, "orders": json.loads(args.orders), "seats": args.seats.split(","), "growth": args.growth})
finally:
    server.terminate()
print(f"{'stg':>3} {'bot':<9} {'council':<10} {'atk':>4} {'own':>4} {'fill':>5} {'full':>5} {'tiles':>6}")
for r in rows:
    print(f"{r['stage']:>3} {r['bot']:<4}{r['botT']:>5} {r['res']:<5}{r['t']:>5} {r['atk']:>4} {r['own']:>4} {r['fill']:>5} {r['full']:>5} {r['tiles']:>3}/{r['of']:<3}")
