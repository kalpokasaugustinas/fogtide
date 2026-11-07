// battle simulation: segments, troops, buildings, armies. no drawing here,
// so the same code runs in the browser and in headless tests.
import { rules, buildings, effects, traits, relicGarrison } from './config.js?v=85';
import { perks, combineMods } from './expedition.js?v=85';
import { hops } from './mapgen.js?v=85';
import { rng, spreadStarts, equalizeStarts } from './mapgen.js?v=85';
import { think } from './ai.js?v=85';

const round1 = (v) => Math.round(v * 10) / 10;

export class Battle {
  // map: from generateMap. opts: { seed, factions: [...], neutral: [min, max] share of each tile's cap }
  // faction: { ai, personality, think, mods?, capital? }
  //   mods    = perk modifiers (expedition): speed, atk, farm, hospital, lab, growth, cost, fort,
  //             neutralDef, capitalDef, reserve, loot (see expedition.js)
  //   capital = { troops, bonus }: the faction starts in a capital (no building allowed there) that
  //             holds up to max(capMax, capitalMargin x strongest neutral) troops; the rest is a reserve that flows in over time.
  //             bonus = { growth, hosp, lab, def, atk } carried over from the previous stage
  constructor(map, opts) {
    this.map = map;
    this.rand = rng(opts.seed ?? 1);
    this.factions = opts.factions.map((f, id) => ({ id, mods: {}, reserve: 0, capitalSeg: -1, ...f, timer: 1 + this.rand() * 2 }));
    this.time = 0;
    this.version = 0;          // bumps on ownership/building change (renderer repaints the map)
    this.state = 'running';    // running | won | lost
    this.armies = [];
    this.events = [];   // { type: 'fight' | 'capture', owner, prev, size } for sounds; the ui drains it
    // player stats for the end screen: troops killed / lost in fights, troops raised by growth,
    // tiles taken / lost, most tiles held at once
    this.stats = { sent: 0, captured: 0, built: 0, lost: 0, killed: 0, deaths: 0, made: 0, peak: 1 };
    // auto-send routes: source segment id -> { to, keep }; keep = fraction of the source cap held back
    this.routes = new Map();
    this.routeTimer = rules.routeEvery;

    // segments: cap from size (largest = capMax), growth = growthRate x cap,
    // neutral garrison = a random share of the cap (bigger tiles hold more)
    const [nmin, nmax] = opts.neutral ?? [0.15, 0.35];
    // fair start: pick the starting tiles first and reshape them to the same size, so every
    // side begins with the same cap and growth (the expedition capital keeps its stamped shape)
    const first = this.factions[0].capital && map.stampSeg >= 0 ? map.stampSeg : -1;
    const startIds = spreadStarts(map, this.factions.length, this.rand, first);
    if (opts.equalStarts !== false) equalizeStarts(map, startIds, first);
    const maxArea = Math.max(...map.segs.map((s) => s.area));
    this.segs = map.segs.map((s) => {
      const cap = Math.round((rules.capMax * s.area) / maxArea / 5) * 5;
      const garrison = Math.round(cap * (nmin + this.rand() * (nmax - nmin)));
      return { ...s, owner: -1, troops: garrison, garrison, cap, baseGrowth: round1(cap * rules.growthRate), building: null };
    });
    // expedition: the player's capital is the stamped segment (previous island's shape)
    startIds.forEach((sid, f) => {
      const s = this.segs[sid], fac = this.factions[f];
      s.owner = f;
      s.troops = rules.startTroops;
      s.home = true;   // starting tile: drawn with a single house until something is built
      if (fac.capital) {
        // capital: full at the start, the rest waits in the reserve
        s.capital = true;
        s.building = 'capital';
        s.cap = rules.capMax;
        s.baseGrowth = round1(s.cap * rules.growthRate);
        s.bonus = { growth: 0, hosp: 0, lab: 0, def: 0, atk: 0, ...fac.capital.bonus };
        s.troops = Math.min(s.cap, fac.capital.troops);
        fac.reserve = Math.max(0, fac.capital.troops - s.cap);
        fac.capitalSeg = sid;
      }
    });
    // relic tiles: neutral tiles away from every start hold a perk shrine; the holder gets the perk
    const starts = this.segs.filter((s) => s.owner >= 0).map((s) => s.id), far = hops(map, starts);
    const pool = this.segs.filter((s) => s.owner < 0 && far[s.id] >= 2 && !s.capital);
    const count = opts.relics ?? Math.max(1, Math.round(this.segs.length / 11));
    for (let i = 0; i < count && pool.length; i++) {
      const s = pool.splice(Math.floor(this.rand() * pool.length), 1)[0];
      s.relic = perks[Math.floor(this.rand() * perks.length)].id;
      s.garrison = s.troops = Math.min(s.cap, Math.round(s.troops * relicGarrison));
    }
    // expedition: stronger neutrals (scaled to the player) and fortified camps on the biggest
    // open tiles (not forest / highland, so their look stays); camp = number of houses 1-3
    this.costScale = opts.camps?.mult ?? 1;   // building prices grow with the neutrals
    if (opts.camps) {
      const { mult, share, boost } = opts.camps, neutrals = this.segs.filter((s) => s.owner < 0);
      for (const s of neutrals) s.garrison = s.troops = Math.round(s.troops * mult);
      const open = neutrals.filter((s) => !s.relic && s.trait !== 'forest' && s.trait !== 'highland').sort((a, b) => b.cap - a.cap);
      const want = Math.round(neutrals.length * share);
      open.slice(0, want).forEach((s, i) => {
        s.garrison = s.troops = Math.round(s.troops * boost);
        s.camp = 3 - Math.floor((i / Math.max(1, want)) * 3);
      });
    }
    // capitals: cap at least capitalMargin x the strongest neutral garrison (rounded up to 50),
    // so a capital can always out-hold any tile on the map; growth stays 1% of the cap
    const top = Math.max(0, ...this.segs.filter((s) => s.owner < 0).map((s) => s.garrison));
    const capCap = Math.max(rules.capMax, Math.ceil((top * rules.capitalMargin) / 50) * 50);
    for (const fac of this.factions) {
      const s = this.segs[fac.capitalSeg];
      if (!fac.capital || !s || capCap <= s.cap) continue;
      const total = s.troops + fac.reserve;
      s.cap = capCap;
      s.baseGrowth = round1(s.cap * rules.growthRate);
      s.troops = Math.min(s.cap, total);
      fac.reserve = total - s.troops;
    }
    this.updateGrowth();
  }

  // live modifiers: the faction's own perks plus the perks of every relic tile it holds
  mods(f) { return f >= 0 ? (this.modsCache?.[f] ?? this.factions[f].mods) : {}; }

  // growth multiplier per segment: farm (own), hospitals (adjacent own), labs (whole faction),
  // capital bonuses (own growth, hospital-like aura, faction-wide lab part), perk modifiers
  updateGrowth() {
    this.modsCache = this.factions.map((f) => combineMods([f.mods, ...this.segs.filter((s) => s.owner === f.id && s.relic).map((s) => perks.find((p) => p.id === s.relic).mods)]));
    const labBonus = this.factions.map((f) => {
      const labs = this.segs.filter((s) => s.owner === f.id && s.building === 'lab').length;
      const caps = this.segs.filter((s) => s.owner === f.id && s.capital).reduce((v, s) => v + s.bonus.lab, 0);
      return labs * effects.labGrowth * (this.mods(f.id).lab ?? 1) + caps;
    });
    for (const s of this.segs) {
      if (s.owner < 0) { s.growth = 0; continue; }
      const m = this.mods(s.owner);
      let mult = 1 + labBonus[s.owner];
      if (s.building === 'farm') mult += effects.farmGrowth * (m.farm ?? 1);
      if (s.capital) mult += s.bonus.growth;
      if (s.trait) mult += traits[s.trait].growth ?? 0;
      for (const a of s.adj) {
        const n = this.segs[a];
        if (n.owner !== s.owner) continue;
        if (n.building === 'hospital') mult += effects.hospitalGrowth * (m.hospital ?? 1);
        if (n.capital) mult += n.bonus.hosp;
      }
      s.growth = round1(s.baseGrowth * mult * (m.growth ?? 1));
    }
  }

  defMult(s) {
    const m = this.mods(s.owner);
    let d = s.building === 'fort' ? (m.fort ?? effects.fortDefense) : 1;
    if (s.capital) d += s.bonus.def + (m.capitalDef ?? 0);
    if (s.trait) d *= 1 + (traits[s.trait].def ?? 0);   // highland / forest
    return d * (m.def ?? 1);   // idle mode: defense upgrades / stage strength (no perk sets it)
  }

  atkMult(s) {
    let a = s.building === 'barracks' ? effects.barracksAttack : 1;
    if (s.capital) a += s.bonus.atk;
    return a * (this.mods(s.owner).atk ?? 1);
  }

  // building price for faction f (perk: engineers)
  // building price: base cost x perk modifier x stage scale (expedition: same x as the neutral
  // garrisons, so buildings stay as pricey relative to the fights), rounded to 5 when scaled
  costOf(f, type) {
    const c = buildings[type].cost * (this.mods(f).cost ?? 1) * this.costScale;
    return this.costScale > 1 ? Math.round(c / 5) * 5 : Math.round(c);
  }

  // faction f sends n troops from segment a to adjacent segment b
  send(f, a, b, n, auto = false) {
    const from = this.segs[a];
    n = Math.floor(Math.min(n, from.troops));
    if (this.state !== 'running' || from.owner !== f || !from.adj.includes(b) || n < 1) return false;
    from.troops -= n;
    const to = this.segs[b];
    const dur = Math.hypot(to.x - from.x, to.y - from.y) / (rules.armySpeed * (this.mods(f).speed ?? 1));
    // attacks stop near the border and fight there; moves to own tiles go all the way
    const stopAt = to.owner === f ? 1 : rules.fightAt;
    this.armies.push({ owner: f, n, atk: this.atkMult(from), from: a, to: b, t: 0, dur, stopAt, fight: null, done: false });
    if (f === 0 && !auto) this.stats.sent++;
    return true;
  }

  // faction f builds type in segment s, paid with troops from that segment
  build(f, sid, type) {
    const s = this.segs[sid], b = buildings[type];
    if (this.state !== 'running' || s.owner !== f || !b || s.capital || s.building === type) return false;
    const cost = this.costOf(f, type);
    if (s.troops < cost) return false;
    s.troops -= cost;
    s.building = type;
    this.version++;
    this.updateGrowth();
    if (f === 0) this.stats.built++;
    return true;
  }

  // defense multiplier of tile t against attacker f (perk: conscription weakens neutrals)
  fightDef(t, f) { return this.defMult(t) * (t.owner < 0 ? (this.mods(f).neutralDef ?? 1) : 1); }

  // army reached its stop point: reinforce an own tile, or start a fight at the border
  arrive(a) {
    const t = this.segs[a.to];
    if (t.owner === a.owner) {
      if (a.t < 1) { a.stopAt = 1; return; }   // became ours on the way: walk in
      t.troops += a.n;
      a.done = true;
      return;
    }
    // fight: both sides lose strength at the same rate k until one is gone, so the result equals
    // attack - defense like an instant fight, just spread over 1-3 s (bigger fights last longer)
    const A = a.n * a.atk, D = t.troops * this.fightDef(t, a.owner);
    const dur = Math.min(rules.fightMax, rules.fightMin + (rules.fightMax - rules.fightMin) * Math.min(1, Math.min(A, D) / rules.fightScale));
    a.fight = { k: Math.max(1, Math.min(A, D) / dur), k0: A, time: 0 };
    this.events.push({ type: 'fight', owner: a.owner, prev: t.owner, size: Math.min(A, D), id: a.to });
  }

  // enemy armies on the same road in opposite directions meet halfway and fight there
  // (instead of passing through each other and both taking a tile); fights at a border count too
  // an army fighting at a tile's border blocks that road at once: troops leaving the tile toward
  // it run straight into it. an army whose opponent is busy in another clash waits behind it
  // (no slipping past to take an emptied tile); it fights once that clash is over
  meet() {
    for (const a of this.armies) a.hold = false;
    for (const a of this.armies) {
      if (a.done || a.clash) continue;
      for (const b of this.armies) {
        if (b === a || b.done || b.owner === a.owner || b.from !== a.to || b.to !== a.from) continue;
        if (a.t + b.t < 1 && !a.fight && !b.fight) continue;
        if (b.clash) { a.hold = true; continue; }
        const A = a.n * a.atk, B = b.n * b.atk;
        const dur = Math.min(rules.fightMax, rules.fightMin + (rules.fightMax - rules.fightMin) * Math.min(1, Math.min(A, B) / rules.fightScale));
        const k = Math.max(1, Math.min(A, B) / dur);
        a.clash = { with: b, k };
        b.clash = { with: a, k };
        this.events.push({ type: 'fight', owner: a.owner, prev: b.owner, size: Math.min(A, B) });
        break;
      }
    }
  }

  // one step of a clash between two armies: equal strength loss on both sides, like fightStep;
  // the survivor marches on (or resumes its border fight)
  clashStep(a, dt) {
    const b = a.clash.with;
    if (a.done) return;
    if (b.done) { a.clash = null; return; }
    if (a.clash.stepped === this.time) return;   // the pair is resolved once per step
    a.clash.stepped = b.clash.stepped = this.time;
    const d = Math.min(a.clash.k * dt, a.n * a.atk, b.n * b.atk);
    a.n -= d / a.atk;
    b.n -= d / b.atk;
    for (const [me, foe] of [[a, b], [b, a]]) if (me.owner === 0) { this.stats.deaths += d / me.atk; this.stats.killed += d / foe.atk; }
    for (const [me, foe] of [[a, b], [b, a]]) {
      if (me.n <= 1e-6) { me.done = true; foe.clash = null; }
    }
  }

  // one step of a running fight
  fightStep(a, dt) {
    const t = this.segs[a.to];
    if (t.owner === a.owner) { a.fight = null; a.stopAt = 1; return; }   // someone else took it for us: walk in
    a.fight.time += dt;
    const dm = this.fightDef(t, a.owner);
    // the rate set on arrival can be tiny (tile had just emptied itself) and lose to the tile's
    // growth or incoming routes; at least a.k0 / fightMax, so every fight ends within fightMax
    const d = Math.min(Math.max(a.fight.k, a.fight.k0 / rules.fightMax) * dt, a.n * a.atk, t.troops * dm);
    a.n -= d / a.atk;
    t.troops -= d / dm;
    if (a.owner === 0) { this.stats.deaths += d / a.atk; this.stats.killed += d / dm; }
    else if (t.owner === 0) { this.stats.deaths += d / dm; this.stats.killed += d / a.atk; }
    if (t.troops <= 1e-6) {
      // defenders gone: capture with what's left of the army
      const prev = t.owner;
      t.owner = a.owner;
      t.troops = Math.max(0, a.n);
      // perk: plunder adds part of an enemy segment's cap when it's taken
      if (prev >= 0) t.troops += t.cap * (this.mods(a.owner).loot ?? 0);
      this.events.push({ type: 'capture', owner: a.owner, prev, size: t.cap, id: a.to });
      this.version++;
      this.updateGrowth();
      if (a.owner === 0) {
        this.stats.captured++;
        this.stats.peak = Math.max(this.stats.peak, this.segs.filter((s) => s.owner === 0).length);
      }
      if (prev === 0) this.stats.lost++;
      a.done = true;
    } else if (a.n <= 1e-6) {
      a.done = true;   // attack beaten back
    }
  }

  alive(f) { return this.segs.some((s) => s.owner === f) || this.armies.some((a) => a.owner === f); }

  // faction f sets a standing route a -> b between two adjacent own segments
  setRoute(f, a, b, keep) {
    const s = this.segs[a], t = this.segs[b];
    if (s.owner !== f || t.owner !== f || !s.adj.includes(b)) return false;
    if (this.routes.get(b)?.to === a) this.routes.delete(b);   // no ping-pong between two segments
    this.routes.set(a, { to: b, keep });
    return true;
  }

  clearRoute(a) { this.routes.delete(a); }

  // forward everything above the reserve; drop routes whose segments changed owner
  runRoutes() {
    for (const [a, r] of this.routes) {
      const s = this.segs[a], t = this.segs[r.to];
      if (s.owner < 0 || s.owner !== t.owner) { this.routes.delete(a); continue; }
      const extra = s.troops - r.keep * s.cap;
      if (extra >= rules.routeMin) this.send(s.owner, a, r.to, extra, true);
    }
  }

  step(dt) {
    if (this.state !== 'running') return;
    this.time += dt;
    // tiles under attack at their border don't grow (else a near-empty tile regrows faster than
    // a small army can kill it, and the fight drags on)
    const sieged = new Set(this.armies.filter((a) => a.fight && !a.done).map((a) => a.to));
    for (const s of this.segs) {
      if (sieged.has(s.id)) continue;
      if (s.owner < 0) {
        // neutrals regrow (slower than owned tiles) but only back to their starting garrison
        if (s.troops < s.garrison) s.troops = Math.min(s.garrison, s.troops + s.baseGrowth * rules.neutralRegrow * dt);
        continue;
      }
      if (s.troops < s.cap) {
        const add = Math.min(s.cap - s.troops, s.growth * dt);
        s.troops += add;
        if (s.owner === 0) this.stats.made += add;
      }
      else s.troops = Math.max(s.cap, s.troops - rules.overCapDecay * dt);
    }
    // reserves flow into each faction's capital while it has room (and is still theirs)
    for (const f of this.factions) {
      const s = this.segs[f.capitalSeg];
      if (!f.reserve || !s || s.owner !== f.id || s.troops >= s.cap) continue;
      const flow = Math.min(f.reserve, s.cap - s.troops, Math.max(5, f.reserve * 0.04) * (f.mods.reserve ?? 1) * dt);
      s.troops += flow;
      f.reserve -= flow;
    }
    this.meet();
    for (const a of this.armies) {
      if (a.clash) { this.clashStep(a, dt); continue; }
      if (a.fight) { this.fightStep(a, dt); continue; }
      if (a.hold) continue;   // waiting behind a clash on its road
      a.t = Math.min(a.stopAt, a.t + dt / a.dur);
      if (a.t >= a.stopAt) this.arrive(a);
    }
    this.armies = this.armies.filter((a) => !a.done);
    this.archerT = (this.archerT ?? 0) + dt;
    if (this.archerT >= 0.5) { this.shoot(this.archerT); this.archerT = 0; }
    this.routeTimer -= dt;
    if (this.routeTimer <= 0) { this.routeTimer += rules.routeEvery; this.runRoutes(); }
    for (const f of this.factions) {
      if (!f.ai || !this.alive(f.id)) continue;
      f.timer -= dt;
      if (f.timer <= 0) {
        think(this, f);
        f.timer = f.think * (0.8 + this.rand() * 0.4);
      }
    }
    // end check: player gone = lost, every bot gone = won (neutral segments may remain)
    if (!this.alive(0)) this.state = 'lost';
    else if (this.factions.every((f) => f.id === 0 || !this.alive(f.id))) this.state = 'won';
  }

  // archers (idle mode: upgrade for the player, by stage for bots; mods.archers = foglets per second):
  // every tile of a side with archers shoots each enemy tile next to it, killing archers x attack /
  // target defense foglets per second. nobody is lost on the shooting side, a tile is never taken by
  // arrows (it can drop to 0). neutrals are not shot. runs every 0.5 s (dt = time since the last volley)
  shoot(dt) {
    for (const s of this.segs) {
      if (s.owner < 0) continue;
      const m = this.mods(s.owner);
      if (!m.archers) continue;
      for (const id of s.adj) {
        const t = this.segs[id];
        if (t.owner < 0 || t.owner === s.owner || t.troops <= 0) continue;
        const k = Math.min(t.troops, (m.archers * dt * (m.atk ?? 1)) / this.defMult(t));
        t.troops -= k;
        if (s.owner === 0) this.stats.killed += k;
        else if (t.owner === 0) this.stats.deaths += k;
      }
    }
  }

  // run the sim without drawing (tests, fast-forward)
  simulate(seconds) {
    for (let t = 0; t < seconds && this.state === 'running'; t += rules.step) this.step(rules.step);
    return this.state;
  }
}
