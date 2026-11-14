// online party mode: up to 8 phones on one island, all players, no bots.
// transport: peerjs (webrtc data channels, free public broker, no server of ours).
// the host phone runs the real battle; every other phone sends its taps as commands and mirrors
// the host's state (snapshots ~10 per second; between them it steps its own copy so armies move smoothly).
// faction indices: on the host they are global (host = 0). each client swaps its own index with 0,
// so the rest of the game keeps treating faction 0 as "me" (swap(g) = g === me ? 0 : g === 0 ? me : g).

const prefix = 'fogtide-party-';
const snapEvery = 0.1;   // seconds between host snapshots
const dropAfter = 15;    // seconds without a word from a player before their land turns neutral

export const net = {
  on: false,        // in a party room
  host: false,
  me: 0,            // my global faction index
  code: '',
  players: [],      // [{ name, left }], index = global faction index
  started: false,
  winner: -1,       // global index of the winner once the game is over (-2 = host left)
  out: false,       // i have been eliminated, watching
  peer: null,
  conns: [],        // host: one connection per player index (null for the host itself / leavers)
  conn: null,       // client: connection to the host
  battle: null,
  snapT: 0,
  ui: {},           // callbacks from main.js: lobby(), start(setup), status(text), over(), flash(text)
};

const swap = (g) => (g === net.me ? 0 : g === 0 ? net.me : g);
const randomCode = () => Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join('');

// load peerjs from a cdn once
let peerLib = null;
function loadPeer() {
  if (peerLib) return peerLib;
  peerLib = new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
    s.onload = () => ok(window.Peer);
    s.onerror = () => { peerLib = null; fail(new Error('Could not load the network library')); };
    document.head.appendChild(s);
  });
  return peerLib;
}

// ---------- host ----------
export async function hostRoom(name) {
  leave();
  const Peer = await loadPeer();
  net.code = randomCode();
  Object.assign(net, { on: true, host: true, me: 0, players: [{ name, left: false }], conns: [null], started: false, winner: -1, out: false });
  net.ui.status?.('Opening room...');
  return new Promise((ok, fail) => {
    const peer = new Peer(prefix + net.code);
    net.peer = peer;
    peer.on('open', () => { net.ui.status?.(''); net.ui.lobby?.(); ok(net.code); });
    peer.on('error', (e) => {
      // code taken: try another one
      if (e.type === 'unavailable-id') { peer.destroy(); hostRoom(name).then(ok, fail); return; }
      net.ui.status?.(`Network error: ${e.type}`);
      fail(e);
    });
    peer.on('disconnected', () => { try { peer.reconnect(); } catch { /* gone */ } });
    peer.on('connection', (c) => {
      c.seen = performance.now();
      c.on('data', (m) => hostData(c, m));
      c.on('close', () => hostClose(c));
      c.on('error', () => hostClose(c));
    });
  });
}

function hostData(c, m) {
  c.seen = performance.now();
  if (m.t === 'ping') return;
  if (m.t === 'hello') {
    if (net.started || net.players.length >= 8) { c.send({ t: 'full', why: net.started ? 'The game has already started' : 'The room is full' }); setTimeout(() => c.close(), 500); return; }
    c.idx = net.players.length;
    net.players.push({ name: String(m.name || 'Player').slice(0, 14), left: false });
    net.conns.push(c);
    lobbyAll();
    net.ui.lobby?.();
    return;
  }
  if (m.t === 'cmd' && net.started && net.battle && c.idx > 0) runCmd(c.idx, m.c);
}

// apply a player's command to the real battle (faction f = that player's global index)
function runCmd(f, c) {
  const b = net.battle;
  if (!Array.isArray(c) || b.state !== 'running') return;
  if (c[0] === 'send') b.send(f, c[1], c[2], c[3]);
  else if (c[0] === 'build') b.build(f, c[1], c[2]);
  else if (c[0] === 'route') b.setRoute(f, c[1], c[2], c[3]);
  else if (c[0] === 'unroute') { if (b.segs[c[1]]?.owner === f) b.clearRoute(c[1]); }
}

function hostClose(c) {
  if (c.closed) return;
  c.closed = true;
  const i = c.idx;
  if (i === undefined || !net.players[i]) return;
  if (!net.started) {
    // lobby: drop the player, everyone after it moves up one slot
    net.players.splice(i, 1);
    net.conns.splice(i, 1);
    net.conns.forEach((k, j) => { if (k) k.idx = j; });
    lobbyAll();
    net.ui.lobby?.();
    return;
  }
  dropPlayer(i);
}

// a player left mid-game: their land turns neutral with the troops it has, their marching armies vanish
function dropPlayer(i) {
  net.players[i].left = true;
  net.conns[i] = null;
  const b = net.battle;
  if (b) {
    for (const s of b.segs) if (s.owner === i) { s.owner = -1; s.home = false; b.routes.delete(s.id); }
    b.armies = b.armies.filter((a) => a.owner !== i);
    for (const a of b.armies) if (a.clash && a.clash.with.owner === i) a.clash = null;
    b.version++;
    b.updateGrowth();
  }
  net.ui.flash?.(`${net.players[i].name} left: their land is neutral now`);
  sendAll({ t: 'left', i });
}

const sendAll = (m) => { for (const c of net.conns) if (c && c.open) c.send(m); };
function lobbyAll() { net.conns.forEach((c, i) => { if (c && c.open) c.send({ t: 'lobby', players: net.players, you: i }); }); }

// host: start a game with everyone in the room (also used for 'play again')
export function startGame() {
  if (!net.host) return;
  const alive = net.players.filter((p) => !p.left);
  if (net.started) {
    // play again: leavers are gone for good, compact the list
    const keep = [];
    net.players.forEach((p, i) => { if (!p.left) keep.push([p, net.conns[i]]); });
    net.players = keep.map((k) => k[0]);
    net.conns = keep.map((k) => k[1]);
    net.conns.forEach((c, i) => { if (c) c.idx = i; });
    lobbyAll();
  }
  if (alive.length < 2) { net.ui.flash?.('Need at least 2 players'); return; }
  const setup = { seed: Math.floor(Math.random() * 1e9), n: net.players.length, names: net.players.map((p) => p.name) };
  net.started = true;
  sendAll({ t: 'start', setup });
  begin(setup);
}

// ---------- client ----------
export async function joinRoom(code, name) {
  leave();
  const Peer = await loadPeer();
  code = code.trim().toUpperCase();
  Object.assign(net, { on: true, host: false, code, players: [], started: false, winner: -1, out: false });
  net.ui.status?.('Joining...');
  return new Promise((ok, fail) => {
    const peer = new Peer();
    net.peer = peer;
    let done = false;
    const failWith = (msg) => { if (done) return; done = true; net.ui.status?.(msg); leave(); fail(new Error(msg)); };
    peer.on('error', (e) => failWith(e.type === 'peer-unavailable' ? `No room ${code}` : `Network error: ${e.type}`));
    peer.on('open', () => {
      const c = peer.connect(prefix + code, { reliable: true, serialization: 'json' });
      net.conn = c;
      const timer = setTimeout(() => failWith('Could not reach the host'), 12000);
      c.on('open', () => { clearTimeout(timer); done = true; c.send({ t: 'hello', name }); net.ui.status?.(''); ok(); });
      c.on('data', clientData);
      clearInterval(net.pingT);
      net.pingT = setInterval(() => {
        if (c.open) c.send({ t: 'ping' });
        if (net.started && net.winner === -1 && net.lastSeen && performance.now() - net.lastSeen > dropAfter * 1000) { net.winner = -2; net.ui.over?.(); }
      }, 2000);
      c.on('close', () => {
        if (!net.on || net.host) return;
        if (net.started && net.winner === -1) { net.winner = -2; net.ui.over?.(); }
        net.ui.flash?.('Disconnected from the host');
        net.ui.status?.('Disconnected from the host');
      });
    });
  });
}

function clientData(m) {
  net.lastSeen = performance.now();
  if (m.t === 'lobby') { net.players = m.players; net.me = m.you; net.ui.lobby?.(); }
  else if (m.t === 'full') { net.ui.status?.(m.why); leave(); }
  else if (m.t === 'start') { net.started = true; begin(m.setup); }
  else if (m.t === 'snap') applySnap(m);
  else if (m.t === 'left') { if (net.players[m.i]) net.players[m.i].left = true; net.ui.flash?.(`${net.players[m.i]?.name ?? 'A player'} left: their land is neutral now`); }
}

// both: reset per-game state and ask main.js to build the battle
function begin(setup) {
  net.lastSeen = performance.now();
  net.winner = -1;
  net.out = false;
  net.snapT = 0;
  net.lastSnap = null;
  net.players.forEach((p, i) => { if (i < setup.names.length) p.name = setup.names[i]; });
  net.ui.start?.(setup);
}

// main.js calls this right after new Battle(): mark it, swap my faction into slot 0 (clients),
// and route a client's own actions to the host instead of applying them
export function attach(b) {
  net.battle = b;
  b.net = true;   // battle.step skips its own end check: net.tick decides who won
  if (net.host) return;
  const me = net.me;
  if (me !== 0) {
    [b.factions[0], b.factions[me]] = [b.factions[me], b.factions[0]];
    b.factions.forEach((f, i) => { f.id = i; });
    for (const s of b.segs) if (s.owner >= 0) s.owner = swap(s.owner);
  }
  b.runRoutes = () => {};   // the host forwards route troops; we only draw them
  const send = (c) => { if (net.conn?.open) net.conn.send({ t: 'cmd', c }); };
  b.send = (f, a, to, n, auto = false) => {
    const s = b.segs[a];
    if (auto || f !== 0 || b.state !== 'running' || s.owner !== 0 || !s.adj.includes(to) || Math.floor(Math.min(n, s.troops)) < 1) return false;
    send(['send', a, to, n]);
    return true;
  };
  b.build = (f, sid, type) => {
    const s = b.segs[sid];
    if (f !== 0 || s.owner !== 0 || s.capital || s.building === type || s.troops < b.costOf(0, type)) return false;
    send(['build', sid, type]);
    return true;
  };
  b.setRoute = (f, a, to, keep) => {
    const s = b.segs[a], t = b.segs[to];
    if (f !== 0 || s.owner !== 0 || t.owner !== 0 || !s.adj.includes(to)) return false;
    send(['route', a, to, keep]);
    return true;
  };
  b.clearRoute = (a) => send(['unroute', a]);
}

// ---------- snapshots ----------
function snapshot(b) {
  const segs = [];
  for (const s of b.segs) segs.push(s.owner, Math.round(s.troops * 10) / 10, s.building ?? 0);
  const idx = new Map(b.armies.map((a, i) => [a, i]));
  const armies = b.armies.map((a) => [a.owner, a.n, a.atk, a.from, a.to, a.t, a.dur, a.stopAt, a.fight, a.clash ? [idx.get(a.clash.with) ?? -1, a.clash.k] : 0, a.hold ? 1 : 0]);
  const routes = [...b.routes].map(([a, r]) => [a, r.to, r.keep]);
  return { t: 'snap', time: b.time, segs, armies, routes, winner: net.winner, alive: net.players.map((p, i) => (b.alive(i) ? 1 : 0)) };
}

function applySnap(m) {
  const b = net.battle;
  if (!b) return;
  net.lastSnap = m;
  let changed = false;
  b.segs.forEach((s, i) => {
    const o = m.segs[i * 3], owner = o >= 0 ? swap(o) : -1, building = m.segs[i * 3 + 2] || null;
    if (s.owner !== owner || s.building !== building) { changed = true; if (s.owner >= 0 && owner !== s.owner) s.home = false; }
    s.owner = owner;
    s.troops = m.segs[i * 3 + 1];
    s.building = building;
  });
  if (changed) { b.version++; b.updateGrowth(); }
  const list = m.armies.map((a) => ({ owner: swap(a[0]), n: a[1], atk: a[2], from: a[3], to: a[4], t: a[5], dur: a[6], stopAt: a[7], fight: a[8] || null, clash: null, hold: !!a[10], done: false }));
  m.armies.forEach((a, i) => { if (a[9] && a[9][0] >= 0) list[i].clash = { with: list[a[9][0]], k: a[9][1] }; });
  b.armies = list;
  b.routes = new Map(m.routes.map((r) => [r[0], { to: r[1], keep: r[2] }]));
  net.alive = m.alive;
  if (!net.out && m.alive[net.me] === 0 && m.winner === -1) { net.out = true; net.ui.flash?.('You are out: watching the rest'); }
  if (m.winner !== -1 && net.winner === -1) { net.winner = m.winner; finish(); }
}

// game over on this phone: the battle state drives main.js's end card
function finish() {
  const b = net.battle;
  if (b) b.state = net.winner === net.me ? 'won' : 'lost';
  net.ui.over?.();
}

// host, every frame: snapshots, eliminations, the winner
export function tick(dt) {
  const b = net.battle;
  if (!net.on || !net.host || !net.started || !b) return;
  const now = performance.now();
  for (const c of net.conns) if (c && !c.closed && now - c.seen > dropAfter * 1000) { hostClose(c); try { c.close(); } catch { /* gone */ } }
  if (net.winner === -1) {
    const alive = net.players.map((p, i) => !p.left && b.alive(i));
    net.alive = alive.map((a) => (a ? 1 : 0));
    if (!net.out && !alive[0]) { net.out = true; net.ui.flash?.('You are out: watching the rest (keep this phone open, it runs the game)'); }
    const left = alive.filter(Boolean).length;
    if (left <= 1) {
      net.winner = Math.max(0, alive.indexOf(true));
      sendAll(snapshot(b));
      finish();
      return;
    }
  }
  net.snapT -= dt;
  if (net.snapT <= 0 && net.winner === -1) { net.snapT = snapEvery; sendAll(snapshot(b)); }
}

export function leave() {
  clearInterval(net.pingT);
  try { net.conn?.close(); } catch { /* closed */ }
  for (const c of net.conns) try { c?.close(); } catch { /* closed */ }
  try { net.peer?.destroy(); } catch { /* gone */ }
  Object.assign(net, { on: false, host: false, me: 0, players: [], conns: [], conn: null, peer: null, started: false, battle: null, winner: -1, out: false });
}

// deterministic sin / cos / atan2 / hypot (only + - * / and sqrt, which ieee 754 makes exact), so
// every phone (v8 on android, javascriptcore on iphone) generates the same island from a seed
const pi2 = Math.PI * 2;
function dsin(x) {
  x -= Math.round(x / pi2) * pi2;   // -pi..pi
  if (x > Math.PI / 2) x = Math.PI - x; else if (x < -Math.PI / 2) x = -Math.PI - x;   // -pi/2..pi/2
  const x2 = x * x;
  let term = x, sum = x;
  for (let k = 1; k < 12; k++) { term *= -x2 / ((2 * k) * (2 * k + 1)); sum += term; }
  return sum;
}
const dcos = (x) => dsin(x + Math.PI / 2);
function datan(x) {
  // two half-angle reductions bring |x| under ~0.2, then the taylor series
  let k = 1;
  for (let i = 0; i < 2; i++) { x = x / (1 + Math.sqrt(1 + x * x)); k *= 2; }
  const x2 = x * x;
  let term = x, sum = x;
  for (let n = 1; n < 20; n++) { term *= -x2; sum += term / (2 * n + 1); }
  return sum * k;
}
function datan2(y, x) {
  if (x > 0) return datan(y / x);
  if (x < 0) return datan(y / x) + (y >= 0 ? Math.PI : -Math.PI);
  return y > 0 ? Math.PI / 2 : y < 0 ? -Math.PI / 2 : 0;
}
const dhypot = (...a) => { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s); };

// run fn with the deterministic math in place of the built-ins
export function detMath(fn) {
  const keep = { sin: Math.sin, cos: Math.cos, atan2: Math.atan2, hypot: Math.hypot };
  Object.assign(Math, { sin: dsin, cos: dcos, atan2: datan2, hypot: dhypot });
  try { return fn(); } finally { Object.assign(Math, keep); }
}
