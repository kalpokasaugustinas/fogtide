// idle mode balance sim: a bot plays whole idle careers headless (tools/idle_sim.py drives it).
// the player side is a fixed bot standing in for an active human (the auto-battle upgrades only save
// the human's time, so they are not simulated). every 5 game seconds it buys the cheapest affordable
// open upgrade in the tree, which applies at once like in the game. a run ends on a lost stage;
// fogs and upgrades carry on.
// modules are imported with the game's own ?v= stamp so they share one copy of config.js
const src = await (await fetch(new URL('../js/battle.js', import.meta.url))).text();
const v = src.match(/config\.js\?v=(\d+)/)?.[1] ?? '';
const q = v ? `?v=${v}` : '';
const { Battle } = await import(`../js/battle.js${q}`);
const { generateMap } = await import(`../js/mapgen.js${q}`);
const { rules } = await import(`../js/config.js${q}`);
const { islandShape } = await import(`../js/expedition.js${q}`);
const idleMod = await import(`../js/idle.js${q}`);
const { Idle, upgrades, idleCfg } = idleMod;

// apply config overrides { display: 1.5, ... } to idleCfg (for tuning without editing the file)
export function tune(o) { Object.assign(idleCfg, o); return { ...idleCfg }; }

// player side: an active human stand-in (thinks every 2.5 s, 2 moves, builds sometimes)
function brain(idle, f) {
  f.ai = true;
  f.think = 2.5;
  f.personality = { build: 0.4, risk: 1.3, actions: 2, grudge: 0 };
}

// cheapest affordable upgrade, bought repeatedly (not the command branch: auto-play only saves a human's time); returns how many were bought
function shop(idle) {
  let n = 0;
  for (;;) {
    const open = upgrades.filter((u) => u.branch !== 'command' && idle.canBuy(u.id)).sort((a, b) => idle.cost(a.id) - idle.cost(b.id));
    if (!open.length) return n;
    idle.buy(open[0].id);
    n++;
  }
}

// one career: runs until maxRuns or a run reaches target. stageCap = game seconds before a stage
// counts as a stalemate (lost). returns per-stage rows and per-run summaries
export function career({ maxRuns = 8, target = 30, stageCap = 900, seed = 1 } = {}) {
  const idle = new Idle();
  const rows = [], runs = [];
  let s = seed;
  for (let run = 1; run <= maxRuns; run++) {
    let stamp = null, runReal = 0;
    for (;;) {
      const setup = idle.setup(stamp, (s = (s * 16807) % 2147483647));
      const map = generateMap({ seed: setup.seed, cells: setup.cells, grid: rules.grid, shape: setup.shape, obstacles: true, detail: setup.detail, stamp });
      const b = new Battle(map, setup);
      brain(idle, b.factions[0]);
      let killed = 0, fogs = 0, t = 0, shopT = 5;
      while (b.state === 'running' && t < stageCap) {
        b.step(rules.step);
        t += rules.step;
        const f = idle.fogsFor(b.stats.killed - killed);
        killed = b.stats.killed;
        const w = idle.wellFogs(b.segs.filter((x) => x.owner === 0).length, rules.step);   // fog wells
        idle.earn(f + w); fogs += f + w;
        if ((shopT -= rules.step) <= 0) {
          shopT = 5;
          if (shop(idle)) { b.factions[0].mods = idle.mods(); b.updateGrowth(); brain(idle, b.factions[0]); }
        }
      }
      const won = b.state === 'won';
      const real = t / rules.timeScale;   // real seconds (the game runs at x1 only)
      const row = { run, stage: idle.stage, won, timeout: b.state === 'running', game: Math.round(t), real1x: Math.round(t / rules.timeScale), real: Math.round(real), fogs: Math.round(fogs), levels: Object.values(idle.levels).reduce((a, c) => a + c, 0) };
      runReal += real;
      if (won) {
        const w = idle.win(t / rules.timeScale);
        row.bonus = Math.round(w.bonus);
        row.mist = w.mist;
        stamp = islandShape(b);
        shop(idle);
      }
      row.bank = Math.round(idle.fogs);
      rows.push(row);
      if (!won || idle.stage > target) {
        const out = idle.endRun(0);
        runs.push({ run, reached: out.reached, fogs: Math.round(out.fogs), realMin: +(runReal / 60).toFixed(1), mist: idle.mistTotal, levels: { ...idle.levels } });
        break;
      }
    }
    if (runs.at(-1).reached > target) break;
  }
  return { rows, runs };
}
