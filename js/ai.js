// bot brain. called every few seconds per bot faction (interval = faction.think).
// personality: { build: chance to build per think, risk: troop safety margin,
//                actions: max moves per think (build, attack or reinforce, shared budget
//                so a big empire doesn't act faster than a small one),
//                grudge: extra value for player segments,
//                allow: optional list of building types (balance tests) }
import { rules, buildings, effects } from './config.js?v=104';
import { hops } from './mapgen.js?v=104';

export const personalities = {
  aggressive: { build: 0.25, risk: 1.15, actions: 2, grudge: 0.3 },
  builder:    { build: 0.7,  risk: 1.35, actions: 1, grudge: 0 },
  turtle:     { build: 0.5,  risk: 1.6,  actions: 1, grudge: -0.2 },
};

// the leader = the side with the highest total troop growth per second. kept on the battle and
// only handed over when another side grows clearly more (no flip-flopping between near-equals)
export function leader(b) {
  const growth = b.factions.map(() => 0);
  for (const s of b.segs) if (s.owner >= 0) growth[s.owner] += s.growth;
  const top = growth.reduce((best, g, i) => (g > growth[best] ? i : best), 0);
  const cur = b.aiLeader ?? -1;
  if (cur < 0 || !b.alive(cur) || growth[top] > growth[cur] * rules.leaderSwitch) b.aiLeader = top;
  return b.aiLeader;
}

export function think(b, f) {
  const p = f.personality, me = f.id, segs = b.segs;
  const mine = segs.filter((s) => s.owner === me);
  if (!mine.length) return;
  const lead = leader(b), gang = lead !== me ? lead : -1;   // whom to gang up on (not yourself)

  // front distance: 0 = touches a non-own segment, 1 = one step behind the front, ...
  const front = hops(b.map, mine.filter((s) => s.adj.some((a) => segs[a].owner !== me)).map((s) => s.id));

  let budget = p.actions;

  // 1. build: at most one building per think
  if (b.rand() < p.build) {
    const reserve = 4;
    for (const s of shuffle(mine, b.rand)) {
      if (s.building) continue;
      const type = pickBuilding(b, s, front[s.id], mine, p.allow);
      if (!type) break;
      if (s.troops >= b.costOf(me, type) + reserve && b.build(me, s.id, type)) { budget--; break; }
    }
  }
  if (budget <= 0) return;

  // 2. attack: rank adjacent targets by value per troop needed
  const options = [];
  for (const s of mine) {
    if (s.troops < 3) continue;
    for (const tid of s.adj) {
      const t = segs[tid];
      if (t.owner === me) continue;
      const travel = Math.hypot(t.x - s.x, t.y - s.y) / rules.armySpeed;
      const def = (t.troops + t.growth * travel) * b.defMult(t);
      // count own armies already heading there
      const coming = b.armies.filter((a) => a.owner === me && a.to === tid).reduce((v, a) => v + a.n * a.atk, 0);
      const need = (def - coming) / b.atkMult(s);
      if (need <= 0) continue;
      // a full tile wastes its growth (and a capital blocks its reserve), so it takes thinner odds
      const risk = s.troops >= s.cap * 0.95 ? Math.min(p.risk, rules.fullRisk) : p.risk;
      const send = Math.ceil(need * risk + 2);
      if (send > s.troops - 1) continue;
      let value = t.cap / 50 + (t.building ? 0.6 : 0) + (t.relic ? 1.2 : 0) + (t.trait === 'river' || t.trait === 'lakeside' ? 0.4 : 0);
      if (t.owner === 0) value += p.grudge;
      if (t.owner === gang) value *= rules.gangUp;   // gang up on the leader
      if (t.owner < 0) value += 0.2;   // neutrals don't fight back
      options.push({ s, tid, send, score: value / send });
    }
  }
  // joint attack: a tile too strong for any one of my tiles, but not for several of my
  // neighbouring tiles together -> all of them send at once (one action). needed when garrisons
  // outgrow tile caps (expedition camps), and the main way to gang up on the leader
  {
    const seen = new Set();
    for (const s of mine) for (const tid of s.adj) {
      const t = segs[tid];
      if (t.owner === me || seen.has(tid)) continue;
      seen.add(tid);
      const from = t.adj.map((a) => segs[a]).filter((n) => n.owner === me && n.troops >= 3);
      if (from.length < 2) continue;
      const coming = b.armies.filter((a) => a.owner === me && a.to === tid).reduce((v, a) => v + a.n * a.atk, 0);
      const def = (t.troops + t.growth * 3) * b.defMult(t) * p.risk + 2 - coming, power = from.reduce((v, n) => v + (n.troops - 1) * b.atkMult(n), 0);
      if (def <= 0 || power < def) continue;
      let value = t.cap / 50 + (t.building ? 0.6 : 0) + (t.relic ? 1.2 : 0);
      if (t.owner === gang) value *= rules.gangUp;
      if (t.owner < 0) value += 0.2;
      options.push({ joint: from, tid, def, power, score: value / (def / 1.5) });
    }
  }
  options.sort((x, y) => y.score - x.score);
  const used = new Set();
  for (const o of options) {
    if (budget <= 0) return;
    if (o.joint) {
      // everyone chips in the same share of what they can spare
      if (used.has('t' + o.tid) || o.joint.some((n) => used.has(n.id))) continue;
      const share = Math.min(1, o.def / o.power);
      for (const n of o.joint) { b.send(me, n.id, o.tid, Math.ceil((n.troops - 1) * share)); used.add(n.id); }
      used.add('t' + o.tid);
      budget--;
      continue;
    }
    if (used.has(o.s.id) || used.has('t' + o.tid)) continue;
    if (b.send(me, o.s.id, o.tid, o.send)) { used.add(o.s.id); used.add('t' + o.tid); budget--; }
  }

  // 3. reinforce with what's left: the fullest interior segment pushes troops one step toward the
  //    front, toward the leader's border when there is one
  const onLeader = gang >= 0 ? mine.filter((s) => s.adj.some((a) => segs[a].owner === gang)).map((s) => s.id) : [];
  if (onLeader.length) {
    const d = hops(b.map, onLeader);
    for (const s of mine) front[s.id] = Math.min(front[s.id] + 2, d[s.id]);   // leader front counts as nearer
  }
  const back = mine.filter((s) => !used.has(s.id) && front[s.id] >= 1 && s.troops >= s.cap * 0.5)
    .sort((x, y) => y.troops - x.troops);
  for (const s of back) {
    if (budget <= 0) return;
    const next = s.adj.map((a) => segs[a]).filter((n) => n.owner === me && front[n.id] < front[s.id]);
    if (!next.length) continue;
    next.sort((x, y) => x.troops - y.troops);
    if (b.send(me, s.id, next[0].id, s.troops * 0.7)) budget--;
  }
}

// choose the building that pays back fastest on this tile: extra foglets per second (or the
// per-second worth of extra attack / defense) per foglet it costs. allow = optional list of
// building types (balance tests); null = all
export function pickBuilding(b, s, frontDist, mine, allow) {
  const me = s.owner, segs = b.segs, m = b.mods(me);
  const own = (a) => segs[a].owner === me;
  const value = {
    // own growth up
    farm: effects.farmGrowth * (m.farm ?? 1) * s.baseGrowth,
    // growth up on every owned neighbour
    hospital: effects.hospitalGrowth * (m.hospital ?? 1) * s.adj.filter(own).reduce((v, a) => v + segs[a].baseGrowth, 0),
    // growth up everywhere (labs stack)
    lab: effects.labGrowth * (m.lab ?? 1) * mine.reduce((v, x) => v + x.baseGrowth, 0),
    // front tiles only: the attack bonus on what flows out, halved (the front moves on, and a
    // tile left behind gets nothing from it; sims: full value made bots worse than no buildings)
    barracks: frontDist === 0 ? (effects.barracksAttack - 1) * s.growth * 0.5 : 0,
    // threatened front tiles only: extra defense on what sits there, spread over ~30 s
    fort: frontDist === 0 && s.adj.some((a) => segs[a].owner >= 0 && segs[a].owner !== me && segs[a].troops > s.troops * 0.8)
      ? ((m.fort ?? effects.fortDefense) - 1) * s.troops / 30 : 0,
  };
  let best = null, bestScore = 0;
  for (const type of allow ?? Object.keys(value)) {
    const score = value[type] / b.costOf(me, type);
    if (score > bestScore || (allow?.length === 1 && !best)) { best = type; bestScore = score; }
  }
  return best;
}

function shuffle(arr, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
