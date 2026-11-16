# campaign balance sim: plays careers of campaigns headless (tools/idle_sim.js) and prints per
# campaign: highest stage cleared, push-backs, Mist earned / banked, Wisp, Legacy levels; with
# --stages also every stage (game s, result, Wisp). a campaign = the 60-year clock
# (1 year = 1 game minute). use it to see how far campaign 1, 2, 3... get and where the walls are.
# usage: python tools/idle_sim.py [--careers 2] [--campaigns 5] [--years 60] [--stages] [--set enemyAtk=1.08]
import argparse
import asyncio
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

from playwright.async_api import async_playwright

sys.stdout.reconfigure(encoding="utf-8")
root = Path(__file__).resolve().parent.parent

ap = argparse.ArgumentParser()
ap.add_argument("--careers", type=int, default=2, help="independent careers (parallel pages)")
ap.add_argument("--campaigns", type=int, default=5, help="campaigns per career")
ap.add_argument("--years", type=float, default=60, help="campaign clock in years (= game minutes)")
ap.add_argument("--stages", action="store_true", help="print every stage, not only the campaign summaries")
ap.add_argument("--cap", type=int, default=900, help="game seconds before a stage counts as a stalemate")
ap.add_argument("--set", nargs="*", default=[], help="idleCfg overrides, e.g. display=1.5")
ap.add_argument("--out", default=None, help="json results file")
args = ap.parse_args()
over = {k: float(v) for k, v in (kv.split("=") for kv in args.set)}


def fmt(v):
    # same short form as the game (1.2K, 3.4M ...)
    for unit, d in (("T", 1e12), ("B", 1e9), ("M", 1e6), ("K", 1e3)):
        if v >= d:
            return f"{v / d:.1f}{unit}"
    return str(int(v))


async def main():
    with socket.socket() as s:
        s.bind(("localhost", 0))
        port = s.getsockname()[1]
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(port)], cwd=root,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    t0 = time.time()
    results = []
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch()

            # pages load the modules one after another (parallel loads from the simple http server
            # sometimes fail), then the careers run in parallel
            pages = []
            for i in range(args.careers):
                page = await browser.new_page()
                page.on("pageerror", lambda e: print("page error:", e))
                await page.goto(f"http://localhost:{port}/tools/")
                await page.evaluate("async (o) => { window.sim = await import('/tools/idle_sim.js'); sim.tune(o); }", over)
                pages.append(page)

            async def one(i):
                r = await pages[i].evaluate("(o) => sim.career(o)", {"maxCampaigns": args.campaigns, "years": args.years, "stageCap": args.cap, "seed": 1000 + i * 7919})
                results.append(r)
                print(f"career {i + 1} done ({time.time() - t0:.0f}s)", flush=True)

            await asyncio.gather(*(one(i) for i in range(args.careers)))
            await browser.close()
    finally:
        server.terminate()

    for c, r in enumerate(results):
        print(f"\n=== career {c + 1} ===")
        if args.stages:
            print(f"{'cmp':>3} {'stg':>3} {'res':<5} {'game s':>6} {'clock':>6} {'wisp':>8} {'bank':>8} {'lvls':>4}")
            for row in r["rows"]:
                res = "win" if row["won"] else ("TIME" if row["timeUp"] else ("STALL" if row["timeout"] else "lost"))
                print(f"{row['campaign']:>3} {row['stage']:>3} {res:<5} {row['game']:>6} {row['clock']:>6} {fmt(row['fogs']):>8} {fmt(row['bank']):>8} {row['levels']:>4}")
        print(f"{'cmp':>3} {'cleared':>7} {'top':>3} {'push':>4} {'mist+':>5} {'bank':>4} {'gens':>4} {'wispLv':>6} {'min':>5} {'next':>4}  legacy")
        for k in r["camps"]:
            lv = " ".join(f"{a}{b}" for a, b in k["legacy"].items())
            print(f"{k['campaign']:>3} {k['cleared']:>7} {k['top']:>3} {k['pushes']:>4} {k['mistGot']:>5} {k['mistBank']:>4} {k['gens']:>4} {k['wispLv']:>6} {k['minutes']:>5} {k['startNext']:>4}  {lv}")
    if args.out:
        Path(args.out).write_text(json.dumps(results, indent=1), encoding="utf-8")


asyncio.run(main())
