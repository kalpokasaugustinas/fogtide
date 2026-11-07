// idle mode balance sim: a bot plays whole idle careers headless (tools/idle_sim.py drives it).
// the player side is the auto-battle bot (skill = its upgrade level, at least 2 as a stand-in for a
// human before auto is bought). every 5 game seconds it buys the cheapest affordable upgrade, which
// applies at once like in the game. a run ends on a lost stage; fogs and upgrades carry on.
// modules are imported with the game's own ?v= stamp so they share one copy of config.js
const src = await (await fetch(new URL('../js/battle.js', import.meta.url))).text();
const v = src.match(/config\.js\?v=(\d+)/)?.[1] ?? '';
const q = v ? `?v=${v}` : '';
const { Battle } = await import(`../js/battle.js${q}`);
const { generateMap } = await import(`../js/mapgen.js${q}`);
const { rules } = await import(`../js/config.js${q}`);
const { islandShape } = await import(`../js/expedition.js${q}`);
const idleMod = await import(`../js/idle.js${q}`);
const { Idle, upgrades, autoBrain, idleCfg } = idleMod;

// apply config overrides { display: 1.5, ... } to idleCfg (for tuning without editing the file)
export function tune(o) { Object.assign(idleCfg, o); return { ...idleCfg }; }

// player side: auto brain at max(2, level); a human stand-in builds sometimes even without auto-build
function brain(idle, f) {
  const b = autoBrain(Math.max(2, idle.lvl('auto')), idle.lvl('autobuild'));
  f.ai = true;
  f.think = b.think;
  f.personality = { ...b.personality, build: Math.max(0.35, b.personality.build) };
}

// cheapest affordable upgrade, bought repeatedly; returns how many were bought
function shop(idle) {
  let n = 0;
  for (;;) {
    const open = upgrades.filter((u) => idle.canBuy(u.id)).sort((a, b) => idle.cost(a.id) - idle.cost(b.id));
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
        idle.earn(f); fogs += f;
        if ((shopT -= rules.step) <= 0) {
          shopT = 5;
          if (shop(idle)) { b.factions[0].mods = idle.mods(); b.updateGrowth(); brain(idle, b.factions[0]); }
        }
      }
      const won = b.state === 'won';
      const real = t / rules.timeScale / idle.maxSpeed;   // real seconds at the best owned speed
      const row = { run, stage: idle.stage, won, timeout: b.state === 'running', game: Math.round(t), real1x: Math.round(t / rules.timeScale), real: Math.round(real), fogs: Math.round(fogs), levels: Object.values(idle.levels).reduce((a, c) => a + c, 0) };
      runReal += real;
      if (won) {
        row.bonus = Math.round(idle.win(t / rules.timeScale));
        stamp = islandShape(b);
        shop(idle);
      }
      row.bank = Math.round(idle.fogs);
      rows.push(row);
      if (!won || idle.stage > target) {
        const out = idle.endRun(0);
        runs.push({ run, reached: out.reached, fogs: Math.round(out.fogs), realMin: +(runReal / 60).toFixed(1), levels: { ...idle.levels } });
        break;
      }
    }
    if (runs.at(-1).reached > target) break;
  }
  return { rows, runs };
}
