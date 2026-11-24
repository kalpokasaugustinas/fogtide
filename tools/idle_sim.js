// campaign balance sim: a bot plays whole careers of campaigns headless (tools/idle_sim.py drives it).
// rules as in the game (campaign rework, phase 2): a won stage zooms out (Wisp bonus, obelisk + boss
// Mist on the first clear), a lost stage loses the campaign, else a campaign
// ends when its clock runs out (idleCfg.years: 33 years = 33 game minutes; no last stage); then Wisp, the Wisp tree and general promotions reset, Mist and the Legacy tree stay.
// the player side is a fixed bot standing in for an active human (the order-giving generals only
// save the human's time, so they are off). every 5 game seconds it buys the cheapest affordable Wisp
// upgrade (applies at once). Mist: first the Marksman (arrows), then the cheapest Legacy node.
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

// Mist: marksman first, then the cheapest Legacy node; Wisp: the cheapest open tree node, bought
// repeatedly. returns how many were bought
function shop(idle) {
  let n = 0;
  idle.auto = false;   // order-giving generals stay off (they stand in for the human)
  if (!idle.genLvl('marksman') && idle.unlock('marksman')) { idle.seat(0, 'marksman'); n++; }
  for (;;) {
    const open = upgrades.filter((u) => idle.canBuy(u.id)).sort((a, b) => (a.cur === 'mist') - (b.cur === 'mist') || idle.cost(a.id) - idle.cost(b.id));
    if (!open.length) return n;
    idle.buy(open[0].id);
    n++;
  }
}

// one career: maxCampaigns campaigns of `years` game minutes each. stageCap = game seconds before a
// stage counts as a stalemate (lost). returns per-stage rows and per-campaign summaries
export function career({ maxCampaigns = 5, years = null, stageCap = 900, seed = 1 } = {}) {
  years ??= idleCfg.years;   // default: the game's own campaign length
  const idle = new Idle();
  const rows = [], camps = [];
  let s = seed;
  for (let c = 1; c <= maxCampaigns; c++) {
    let stamp = null, clock = 0, pushes = 0, top = idle.stage;
    const mist0 = idle.mistTotal;
    while (clock < years * 60) {
      const setup = idle.setup(stamp, (s = (s * 16807) % 2147483647));
      const map = generateMap({ seed: setup.seed, cells: setup.cells, grid: rules.grid, shape: setup.shape, obstacles: true, detail: setup.detail, stamp });
      const b = new Battle(map, setup);
      brain(idle, b.factions[0]);
      let killed = 0, fogs = 0, t = 0, shopT = 5;
      while (b.state === 'running' && t < stageCap && clock + t < years * 60) {
        b.step(rules.step);
        idle.autoTick(b, rules.step);
        t += rules.step;
        const f = idle.fogsFor(b.stats.killed - killed);
        killed = b.stats.killed;
        const w = idle.wellFogs(b.segs.filter((x) => x.owner === 0).length, rules.step);   // wisp wells
        idle.earn(f + w); fogs += f + w;
        if ((shopT -= rules.step) <= 0) {
          shopT = 5;
          if (shop(idle)) { b.factions[0].mods = idle.mods(); b.updateGrowth(); brain(idle, b.factions[0]); }
        }
      }
      clock += t;
      const won = b.state === 'won', timeUp = clock >= years * 60 && b.state === 'running';
      const row = { campaign: c, stage: idle.stage, won, timeout: b.state === 'running' && !timeUp, timeUp, game: Math.round(t), clock: Math.round(clock), fogs: Math.round(fogs), levels: Object.values(idle.levels).reduce((a, x) => a + x, 0) };
      if (won) {
        const w = idle.win(t / rules.timeScale);
        row.bonus = Math.round(w.bonus);
        row.mist = w.mist;
        stamp = islandShape(b);
        shop(idle);
      } else if (!timeUp) {
        pushes++;   // a lost stage loses the campaign
      }
      top = Math.max(top, idle.stage);
      row.bank = Math.round(idle.fogs);
      rows.push(row);
      if (timeUp || !won) break;
    }
    const cleared = idle.cleared, mistGot = idle.mistTotal - mist0, wisp = idle.runFogs;
    const legacy = Object.fromEntries(Object.entries(idle.levels).filter(([id]) => upgrades.find((u) => u.id === id)?.cur === 'mist'));
    const wispLv = Object.entries(idle.levels).filter(([id]) => upgrades.find((u) => u.id === id)?.cur !== 'mist').reduce((a, [, x]) => a + x, 0);
    idle.endCampaign();
    camps.push({ campaign: c, cleared, top, pushes, mistGot, mistBank: idle.mist, wisp: Math.round(wisp), wispLv, minutes: +(clock / 60).toFixed(1), legacy, gens: Object.keys(idle.gens).length, startNext: idle.stage });
    console.log(`campaign ${c}/${maxCampaigns} done: top stage ${top}, ${(clock / 60).toFixed(1)} game min`);   // progress line (idle_sim.py prints it)
  }
  return { rows, camps };
}
