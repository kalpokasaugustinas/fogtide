# idle mode balance sim: plays whole idle careers headless (tools/idle_sim.js) and prints, per stage,
# game time, real time at the owned speed, fogs earned and bank, plus a summary per run.
# use it to check pacing (stage 1 ~30 s, stage 20 ~3 min real at x1) and a smooth fog curve.
# usage: python tools/idle_sim.py [--careers 2] [--runs 8] [--target 30] [--set display=1.5 enemyAtk=1.08]
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
ap.add_argument("--runs", type=int, default=8, help="max runs per career")
ap.add_argument("--target", type=int, default=30, help="stop a career once a run passes this stage")
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

            async def one(i):
                page = await browser.new_page()
                page.on("pageerror", lambda e: print("page error:", e))
                await page.goto(f"http://localhost:{port}/tools/")
                await page.evaluate("async (o) => { window.sim = await import('/tools/idle_sim.js'); sim.tune(o); }", over)
                r = await page.evaluate("(o) => sim.career(o)", {"maxRuns": args.runs, "target": args.target, "stageCap": args.cap, "seed": 1000 + i * 7919})
                results.append(r)
                print(f"career {i + 1} done ({time.time() - t0:.0f}s)", flush=True)

            await asyncio.gather(*(one(i) for i in range(args.careers)))
            await browser.close()
    finally:
        server.terminate()

    for c, r in enumerate(results):
        print(f"\n=== career {c + 1} ===")
        print(f"{'run':>3} {'stg':>3} {'res':<4} {'game s':>6} {'real@1x':>7} {'real':>5} {'fogs':>8} {'bank':>8} {'lvls':>4}")
        for row in r["rows"]:
            res = "win" if row["won"] else ("TIME" if row["timeout"] else "lost")
            print(f"{row['run']:>3} {row['stage']:>3} {res:<4} {row['game']:>6} {row['real1x']:>7} {row['real']:>5} {fmt(row['fogs']):>8} {fmt(row['bank']):>8} {row['levels']:>4}")
        print("runs:")
        for run in r["runs"]:
            lv = " ".join(f"{k}{v}" for k, v in run["levels"].items())
            print(f"  run {run['run']}: reached stage {run['reached']}, {fmt(run['fogs'])} fogs, {run['realMin']} min real · {lv}")
    if args.out:
        Path(args.out).write_text(json.dumps(results, indent=1), encoding="utf-8")


asyncio.run(main())
