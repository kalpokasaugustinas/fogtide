// war council probe: does the council (no human) still play the later stages? a bot career (as in
// idle_sim.js) runs; at the first visit of each stage a copy of the profile replays that stage with
// the player side idle and only the council giving orders. per stage it reports the result, the
// council's sends, and how full your tiles get (the warlord waits for <at>% full or autoWait s).
// driven by tools/council_probe.py
const src = await (await fetch(new URL('../js/battle.js', import.meta.url))).text();
const v = src.match(/config\.js\?v=(\d+)/)?.[1] ?? '';
const q = v ? `?v=${v}` : '';
const { Battle } = await import(`../js/battle.js${q}`);
const { generateMap } = await import(`../js/mapgen.js${q}`);
const { rules, testing } = await import(`../js/config.js${q}`);
const { islandShape } = await import(`../js/expedition.js${q}`);
const { Idle, upgrades, idleCfg } = await import(`../js/idle.js${q}`);

export function tune(o) { Object.assign(idleCfg, o); return { ...idleCfg }; }

// same bot and shop as idle_sim.js
function brain(f) { f.ai = true; f.think = 2.5; f.personality = { build: 0.4, risk: 1.3, actions: 2, grudge: 0 }; }
function shop(idle) {
  let n = 0;
  idle.auto = false;
  if (!idle.genLvl('marksman') && idle.unlock('marksman')) { idle.seat(0, 'marksman'); n++; }
  for (;;) {
    const open = upgrades.filter((u) => idle.canBuy(u.id)).sort((a, b) => (a.cur === 'mist') - (b.cur === 'mist') || idle.cost(a.id) - idle.cost(b.id));
    if (!open.length) return n;
    idle.buy(open[0].id); n++;
  }
}
const fields = ['fogs', 'total', 'mist', 'mistTotal', 'levels', 'auto', 'stage', 'runFogs', 'runTime', 'best', 'fast10', 'runs', 'gens', 'seats', 'orders', 'campaign', 'cleared', 'clock', 'year0'];
const copy = (idle) => new Idle(JSON.parse(JSON.stringify(Object.fromEntries(fields.map((k) => [k, idle[k]])))));

// replay one stage with the council only: warlord, pathfinder, quartermaster, marshal at level lv
function councilRun(idle0, stamp, seed, lv, cap, orders, seats, trace = null) {
  const idle = copy(idle0);
  for (const id of seats) idle.gens[id] = lv;
  idle.seats = [...seats];
  idle.orders = JSON.parse(JSON.stringify(orders));
  idle.auto = true;
  const setup = idle.setup(stamp, seed);
  const map = generateMap({ seed: setup.seed, cells: setup.cells, grid: rules.grid, shape: setup.shape, obstacles: true, detail: setup.detail, stamp });
  const b = new Battle(map, setup);
  b.factions[0].ai = false;   // no human: only the council acts
  const sends = { atk: 0, own: 0 };
  const send = b.send.bind(b);
  b.send = (f, a, t, n, auto) => { const ok = send(f, a, t, n, auto); if (ok && f === 0 && auto) sends[b.segs[t].owner === 0 ? 'own' : 'atk']++; return ok; };
  let t = 0, samples = 0, fill = 0, full = 0, tick = 0;
  const at = idle.ord('warlord').at / 100;
  while (b.state === 'running' && t < cap) {
    b.step(rules.step); idle.autoTick(b, rules.step); t += rules.step;
    if (trace && Math.round(t / rules.step) % Math.round(10 / rules.step) === 0) {
      const own = (o) => b.segs.filter((x) => (o ? x.owner > 0 : x.owner === 0));
      trace.push({ t: Math.round(t), me: own(false).length, meT: Math.round(own(false).reduce((v, x) => v + x.troops, 0)), bots: own(true).length, botT: Math.round(own(true).reduce((v, x) => v + x.troops, 0)), neut: b.segs.filter((x) => x.owner < 0).length, armies: b.armies.filter((x) => !x.done && x.owner === 0).length });
    }
    if ((tick += rules.step) >= 1) {
      tick = 0;
      for (const s of b.segs) if (s.owner === 0) { samples++; fill += s.troops / s.cap; if (s.troops >= at * s.cap) full++; }
    }
  }
  const mine = b.segs.filter((s) => s.owner === 0);
  return { trace, res: b.state === 'running' ? 'stall' : b.state, t: Math.round(t), atk: sends.atk, own: sends.own, fill: samples ? +(fill / samples).toFixed(2) : 0, full: samples ? +(full / samples).toFixed(2) : 0, tiles: mine.length, of: b.segs.length };
}

export function probe({ campaigns = 4, cap = 600, lv = 3, seed = 1, orders = {}, seats = ['warlord', 'pathfinder', 'quartermaster', 'marshal'], growth = 1, traceStage = 0 } = {}) {
  const idle = new Idle(), out = [], seen = new Set();
  let s = seed;
  for (let c = 1; c <= campaigns; c++) {
    let stamp = null, clock = 0;
    while (clock < idleCfg.years * 60) {
      const sd = (s = (s * 16807) % 2147483647);
      const n = idle.stage;
      const probeRow = !seen.has(n) ? (seen.add(n), testing.growth = growth, councilRun(idle, stamp, sd, lv, cap, orders, seats, n === traceStage ? [] : null)) : null;
      testing.growth = 1;   // the bot career itself plays the normal game
      const setup = idle.setup(stamp, sd);
      const map = generateMap({ seed: setup.seed, cells: setup.cells, grid: rules.grid, shape: setup.shape, obstacles: true, detail: setup.detail, stamp });
      const b = new Battle(map, setup);
      brain(b.factions[0]);
      let killed = 0, t = 0, shopT = 5;
      while (b.state === 'running' && t < 900 && clock + t < idleCfg.years * 60) {
        b.step(rules.step); idle.autoTick(b, rules.step); t += rules.step;
        idle.earn(idle.fogsFor(b.stats.killed - killed)); killed = b.stats.killed;
        if ((shopT -= rules.step) <= 0) { shopT = 5; if (shop(idle)) { b.factions[0].mods = idle.mods(); b.updateGrowth(); brain(b.factions[0]); } }
      }
      clock += t;
      if (probeRow) out.push({ stage: n, campaign: c, bot: b.state === 'won' ? 'won' : 'lost', botT: Math.round(t), ...probeRow });
      if (b.state !== 'won') break;
      idle.win(t / rules.timeScale); stamp = islandShape(b); shop(idle);
    }
    idle.endCampaign();
  }
  return out.sort((a, b) => a.stage - b.stage);
}
