// war council portraits: each general is the in-game foglet (drawFoglet: body, head, kit) drawn big
// on a stone plinth, with general gear on top (cape, epaulettes, helmets, tools, a hound...) and a
// team-colour standard with the role's sigil. pure canvas drawing; the rules live in idle.js
import { drawFoglet, hexToRgb, shade } from './render.js?v=141';

// look per general: kit = base troop kit ('plain' = bare body), cape colour, epaulettes (default
// on), back() = gear drawn behind the body, front() = gear drawn over it
const looks = {
  warlord: { kit: 'plain', cape: '#7a2a20', back: () => greatsword(), front: () => warlordGear() },
  warden: { kit: 'knight', cape: '#22406e' },
  marksman: { kit: 'archer' },
  pathfinder: { kit: 'viking', cape: '#5a4a30' },
  quartermaster: { kit: 'plain', epaulettes: false, back: () => bigHammer(), front: () => quartermasterGear() },
  marshal: { kit: 'plain', cape: '#2c3260', front: () => marshalGear() },
  drummer: { kit: 'plain', front: () => drummerGear() },
  houndmaster: { kit: 'plain', epaulettes: false, back: () => hound(), front: () => houndGear() },
  surgeon: { kit: 'plain', epaulettes: false, back: () => medicBag(), front: () => surgeonGear() },
  empty: { kit: 'plain', cape: 'rgba(90,100,105,0.5)', epaulettes: false },
};

// drawing helpers for the general being drawn (unit coords, like drawFoglet: body x -1.3..1.3,
// y -4..0; head x -1.15..1.15, y -6.15..-3.9; feet at 0)
let H = {}, team = '#2f74d6', tDark = '', tLight = '';
const gold = '#d9b65a', goldD = '#a8863a', steel = '#c4ccd4', wood = '#7a5230', woodD = '#5a3a20', ink = '#22252c';

// draw general id (or 'empty') into canvas cv, sc = px per figure unit, level = stars on the
// plinth, banner = the standard behind the shoulder. the canvas keeps its css size
export function drawGeneral(cv, id, { sc = 10, level = 0, banner = true, color = '#2f74d6' } = {}) {
  const look = looks[id] ?? looks.empty, col = hexToRgb(color);
  team = color; tDark = `rgb(${shade(col, -0.35).join(',')})`; tLight = `rgb(${shade(col, 0.3).join(',')})`;
  const dpr = Math.min(3, window.devicePixelRatio || 1), W = cv.clientWidth, Hh = cv.clientHeight;
  if (!W || !Hh) return;
  cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr);
  const x = cv.getContext('2d');
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  const mx = W / 2, my = Hh - sc * 1.6;
  const X = (u) => mx + u * sc, Y = (u) => my + u * sc;
  H = {
    x, sc, X, Y,
    poly: (c, pts) => { x.fillStyle = c; x.beginPath(); pts.forEach(([a, b], i) => (i ? x.lineTo : x.moveTo).call(x, X(a), Y(b))); x.closePath(); x.fill(); },
    disc: (c, a, b, r) => { x.fillStyle = c; x.beginPath(); x.arc(X(a), Y(b), r * sc, 0, Math.PI * 2); x.fill(); },
    ring: (c, lw, a, b, r) => { x.strokeStyle = c; x.lineWidth = lw * sc; x.beginPath(); x.arc(X(a), Y(b), r * sc, 0, Math.PI * 2); x.stroke(); },
    ell: (c, a, b, rx, ry) => { x.fillStyle = c; x.beginPath(); x.ellipse(X(a), Y(b), rx * sc, ry * sc, 0, 0, Math.PI * 2); x.fill(); },
    R: (l, t, w, h, c) => { x.fillStyle = c; x.fillRect(X(l), Y(t), w * sc, h * sc); },
    line: (c, lw, pts) => { x.strokeStyle = c; x.lineWidth = lw * sc; x.lineCap = 'round'; x.lineJoin = 'round'; x.beginPath(); pts.forEach(([a, b], i) => (i ? x.lineTo : x.moveTo).call(x, X(a), Y(b))); x.stroke(); },
  };
  const { poly, line } = H;
  // soft shadow + stone plinth
  x.fillStyle = 'rgba(35,42,44,0.25)'; x.beginPath(); x.ellipse(X(0), Y(0.9), 3.4 * sc, 0.75 * sc, 0, 0, Math.PI * 2); x.fill();
  poly('#8d9396', [[-3, 0], [3, 0], [2.7, 1.05], [-2.7, 1.05]]); poly('#6f7679', [[-2.7, 0.75], [2.7, 0.75], [2.7, 1.05], [-2.7, 1.05]]);
  line('rgba(255,255,255,0.35)', 0.08, [[-2.9, 0.06], [2.9, 0.06]]);
  if (banner && id !== 'empty') {   // standard with the role sigil
    line('#5a3a20', 0.22, [[2.6, 0.2], [2.6, -9.6]]); H.disc(gold, 2.6, -9.75, 0.22);
    poly(team, [[2.7, -9.4], [5.1, -9.1], [4.6, -8.1], [5.1, -7.0], [2.7, -7.2]]);
    sigil(x, id, X(3.75), Y(-8.25), sc * 0.55);
  }
  look.back?.();
  if (look.cape) {
    poly(look.cape, [[-1.55, -4.3], [1.55, -4.3], [2.25, 0.05], [0.8, -0.2], [0, 0.1], [-0.8, -0.2], [-2.25, 0.05]]);
    line('rgba(0,0,0,0.18)', 0.08, [[-1.1, -3.6], [-1.6, -0.3]]); line('rgba(0,0,0,0.18)', 0.08, [[1.1, -3.6], [1.6, -0.3]]);
  }
  drawFoglet(x, mx, my, sc, col, look.kit, { noFace: id === 'empty' });
  look.front?.();
  if (look.epaulettes !== false) for (const s of [-1, 1]) {
    H.ell(gold, s * 1.25, -4.0, 0.55, 0.26);
    for (let i = 0; i < 4; i++) line(goldD, 0.06, [[s * (0.95 + i * 0.2), -3.85], [s * (0.95 + i * 0.2), -3.5]]);
  }
  for (let i = 0; i < level; i++) star(x, X(-0.7 * ((level - 1) / 2) + i * 0.7), Y(0.55), sc * 0.22, '#f0e2b0');
}

function star(x, cx, cy, r, c) {
  x.fillStyle = c; x.beginPath();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; (i ? x.lineTo : x.moveTo).call(x, cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
  x.fill();
}
// banner sigils: small off-white line marks, one per role
function sigil(x, id, cx, cy, s) {
  x.save(); x.translate(cx, cy); x.scale(s, s); x.strokeStyle = '#f2efe4'; x.fillStyle = '#f2efe4'; x.lineWidth = 0.32; x.lineCap = 'round'; x.lineJoin = 'round';
  const L = (pts) => { x.beginPath(); pts.forEach(([a, b], i) => (i ? x.lineTo : x.moveTo).call(x, a, b)); x.stroke(); };
  const C = (a, b, r, s0 = 0, s1 = 7) => { x.beginPath(); x.arc(a, b, r, s0, s1); x.stroke(); };
  if (id === 'warlord') { L([[-1, 1.2], [1, -1.2]]); L([[-1, -1.2], [1, 1.2]]); }
  if (id === 'warden') L([[0, -1.3], [1.1, -0.8], [1, 0.4], [0, 1.3], [-1, 0.4], [-1.1, -0.8], [0, -1.3]]);
  if (id === 'marksman') { C(-0.4, 0, 1.3, -1.2, 1.2); L([[-1.2, 0], [1.2, 0]]); L([[0.8, -0.4], [1.2, 0], [0.8, 0.4]]); }
  if (id === 'pathfinder') { C(0, 0, 1.1); L([[0, -0.9], [0.3, 0], [0, 0.9], [-0.3, 0], [0, -0.9]]); }
  if (id === 'quartermaster') { L([[-0.9, 1.2], [0.5, -0.4]]); L([[-0.1, -1.1], [1.2, 0.2]]); }
  if (id === 'marshal') { L([[-1.2, 0.8], [1, -0.6]]); L([[0.4, -0.7], [1, -0.6], [0.8, 0]]); L([[-1.2, -0.4], [1, 1]]); }
  if (id === 'drummer') { x.beginPath(); x.ellipse(0, 0.2, 1.1, 0.8, 0, 0, 7); x.stroke(); L([[-1.2, -1.2], [-0.2, -0.3]]); L([[1.2, -1.2], [0.2, -0.3]]); }
  if (id === 'houndmaster') L([[-1, 0.9], [-0.6, -0.5], [0.4, -0.6], [1, -1.1], [1.1, -0.3], [0.6, 0], [0.6, 0.9]]);
  if (id === 'surgeon') { x.fillRect(-0.3, -1.1, 0.6, 2.2); x.fillRect(-1.1, -0.3, 2.2, 0.6); }
  x.restore();
}

// ---------- general gear ----------
function greatsword() {
  const { line, poly, disc } = H;
  line(steel, 0.42, [[1.85, -1.4], [1.85, -7.6]]); poly(steel, [[1.64, -7.6], [2.06, -7.6], [1.85, -8.15]]);
  line('#eef2f5', 0.1, [[1.85, -2], [1.85, -7.4]]);
  line(gold, 0.3, [[1.15, -1.5], [2.55, -1.5]]); line('#3a2414', 0.3, [[1.85, -1.4], [1.85, -0.55]]); disc(gold, 1.85, -0.42, 0.22);
}
function warlordGear() {
  const { R, poly, line } = H, br = '#b8924e', brD = '#94733a';
  R(-1.3, -4, 2.6, 2.3, br); R(0.2, -4, 1.1, 2.3, brD);   // bronze cuirass
  line('#7a5c2c', 0.07, [[-0.85, -3.45], [-0.15, -3.2]]); line('#7a5c2c', 0.07, [[0.05, -3.2], [0.75, -3.45]]); line('#7a5c2c', 0.06, [[-0.05, -3.0], [-0.05, -2.0]]);
  for (let i = 0; i < 5; i++) R(-1.3 + i * 0.54, -1.7, 0.44, 1.35, i % 2 ? '#7a2420' : '#8e2a22');   // leather strips
  R(-1.3, -1.85, 2.6, 0.25, '#5e3b20');
  R(-1.3, -6.75, 2.6, 1.05, br); R(0.3, -6.75, 1.0, 1.05, brD);   // crested helmet + cheek guards
  R(-1.3, -5.75, 0.45, 1.2, br); R(0.85, -5.75, 0.45, 1.2, brD);
  poly('#c0302a', [[-1.55, -6.7], [-1.25, -7.55], [0, -7.95], [1.25, -7.55], [1.55, -6.7]]);
  for (let i = -4; i <= 4; i++) line('#8e2a22', 0.06, [[i * 0.3, -6.75], [i * 0.32, -7.6 + Math.abs(i) * 0.06]]);
  R(-0.15, -7.0, 0.3, 0.3, gold);
}
function bigHammer() {
  const { line, poly } = H;
  line(wood, 0.28, [[1.3, -1.4], [2.25, -6.3]]);
  poly('#8e98a2', [[1.55, -6.95], [2.95, -6.45], [2.7, -5.75], [1.3, -6.25]]); poly(steel, [[1.55, -6.95], [2.95, -6.45], [2.88, -6.25], [1.48, -6.75]]);
}
function quartermasterGear() {
  const { R, poly, line, ell } = H;
  poly('#8a6440', [[-1.0, -3.6], [1.0, -3.6], [1.15, -0.2], [-1.15, -0.2]]);   // apron + straps
  line('#6e4a2c', 0.14, [[-0.85, -3.6], [-0.75, -4.05]]); line('#6e4a2c', 0.14, [[0.85, -3.6], [0.75, -4.05]]);
  R(-0.6, -2.2, 1.2, 0.7, '#74532f'); line(steel, 0.1, [[-0.35, -2.2], [-0.35, -2.75]]); line(wood, 0.1, [[0.2, -2.2], [0.32, -2.85]]); line('#e8e2d0', 0.1, [[0.4, -2.2], [0.5, -2.7]]);
  R(-1.8, -2.1, 0.7, 0.95, '#7a5230'); line('#5a3a20', 0.1, [[-1.45, -2.1], [0.9, -4.0]]);   // satchel
  R(-1.2, -6.75, 2.4, 0.7, tDark); poly(tDark, [[-1.2, -6.1], [1.75, -6.1], [1.45, -5.88], [-1.2, -5.88]]);   // flat cap
  ell(tLight, -0.4, -6.65, 0.5, 0.12);
  line('#e8d8a0', 0.1, [[1.05, -5.4], [1.35, -6.0]]);   // pencil behind the ear
}
function marshalGear() {
  const { R, poly, line, disc, ell } = H;
  for (const bx of [-0.45, 0.45]) for (const by of [-3.6, -3.0, -2.4, -1.8]) disc(gold, bx, by, 0.09);   // double-breasted
  line('#efe9da', 0.36, [[-1.2, -4], [1.2, -1.5]]);   // sash
  for (const [a, c] of [[-0.85, '#c03030'], [-0.55, '#e0b040']]) { line(c, 0.14, [[a, -3.8], [a, -3.4]]); disc(gold, a, -3.25, 0.13); }
  R(-1.3, -1.4, 2.6, 0.3, '#2a2a30'); R(-0.2, -1.45, 0.4, 0.4, gold);
  line('#2a2a30', 0.3, [[1.45, -2.0], [2.25, -3.8]]); disc(gold, 1.45, -2.0, 0.17); disc(gold, 2.25, -3.8, 0.17);   // baton
  poly(ink, [[-2.15, -6.0], [-1.0, -6.6], [0, -7.45], [1.0, -6.6], [2.15, -6.0], [0, -6.3]]);   // bicorne
  line(gold, 0.09, [[-2.15, -6.0], [-1.0, -6.6], [0, -7.45], [1.0, -6.6], [2.15, -6.0]]);
  disc(team, 0, -6.65, 0.3); disc('#efe9da', 0, -6.65, 0.12);
  ell('#efe9da', 0, -7.45, 0.65, 0.18);
}
function drummerGear() {
  const { R, line, poly, ell, disc } = H;
  line('#efe9da', 0.24, [[-1.2, -4], [1.2, -1.9]]); line('#efe9da', 0.24, [[1.2, -4], [-1.2, -1.9]]);   // cross belts
  R(-1.6, -2.75, 3.2, 1.6, '#e9dfc4');   // drum: shell, rims, cords
  R(-1.65, -2.85, 3.3, 0.24, team); R(-1.65, -1.3, 3.3, 0.24, team);
  line(gold, 0.08, [[-1.5, -2.6], [-1.0, -1.35], [-0.5, -2.6], [0, -1.35], [0.5, -2.6], [1.0, -1.35], [1.5, -2.6]]);
  R(0.6, -2.75, 1.0, 1.6, 'rgba(0,0,0,0.1)');
  line(wood, 0.15, [[-1.95, -4.0], [-0.65, -2.95]]); line(wood, 0.15, [[1.95, -4.0], [0.65, -2.95]]); disc('#e8d8b0', -1.95, -4.0, 0.16); disc('#e8d8b0', 1.95, -4.0, 0.16);
  R(-1.0, -7.75, 2.0, 1.7, tDark); R(0.35, -7.75, 0.65, 1.7, 'rgba(0,0,0,0.18)');   // shako
  poly(gold, [[0, -7.25], [0.38, -6.85], [0, -6.45], [-0.38, -6.85]]);
  R(-1.15, -6.1, 2.3, 0.2, '#1d1d22'); line(gold, 0.06, [[-1.0, -6.0], [0, -5.3], [1.0, -6.0]]);
  ell('#efe9da', 0, -8.1, 0.24, 0.5); ell('#c0302a', 0, -8.5, 0.18, 0.22);
}
function hound() {
  const { R, poly, line, disc } = H, fur = '#8a7a68', furD = '#6e604f';
  line(fur, 0.28, [[-4.45, -0.5], [-5.0, -1.1], [-4.85, -1.75]]);   // tail
  poly(fur, [[-4.5, -0.05], [-2.55, -0.05], [-2.65, -1.95], [-3.95, -2.15]]);   // sitting body
  R(-3.0, -1.25, 0.32, 1.2, furD); R(-2.55, -1.25, 0.32, 1.2, fur);   // front legs
  poly('#a8987f', [[-2.95, -1.3], [-2.55, -1.3], [-2.6, -2.1], [-2.95, -2.1]]);   // chest
  R(-3.3, -3.45, 1.25, 1.15, fur); R(-2.05, -2.95, 0.65, 0.55, furD);   // head + snout
  disc('#22252c', -1.45, -2.8, 0.13); disc('#22252c', -2.55, -3.05, 0.09);
  poly(furD, [[-3.3, -3.45], [-2.8, -3.45], [-2.95, -2.55], [-3.35, -2.7]]);   // ear
  R(-3.25, -2.42, 1.15, 0.22, team);   // collar
  line('#5a3a20', 0.07, [[-2.4, -2.3], [-1.85, -1.6], [-1.25, -2.0]]);   // leash to the hand
}
function houndGear() {
  const { R, line, disc, ell } = H;
  R(-1.3, -4, 2.6, 2.6, '#7a5636'); R(0.2, -4, 1.1, 2.6, '#634528');   // leather jerkin + laces
  for (let i = 0; i < 4; i++) line('#3a2414', 0.06, [[-0.25, -3.7 + i * 0.5], [0.15, -3.45 + i * 0.5]]);
  R(-1.3, -1.6, 2.6, 0.3, '#3a2414');
  line(gold, 0.05, [[-0.7, -4], [-0.2, -3.0]]); disc(gold, -0.2, -2.95, 0.15);   // whistle
  ell('#5a3e26', 0, -6.1, 2.0, 0.36); R(-1.0, -7.05, 2.0, 1.0, '#6e4a2c'); R(-1.0, -6.45, 2.0, 0.2, team);   // wide hat
  line('#c8a050', 0.1, [[0.8, -6.4], [1.6, -7.4]]);
}
function medicBag() {
  const { R, line } = H;
  line('#5a3a20', 0.1, [[1.0, -4.0], [-1.6, -2.3]]);   // strap
  R(-2.45, -2.4, 1.25, 1.0, '#7a3a2a'); R(-2.45, -2.4, 1.25, 0.25, '#5e2a1e');   // bag with a white cross
  R(-1.92, -2.05, 0.2, 0.6, '#f2efe4'); R(-2.12, -1.85, 0.6, 0.2, '#f2efe4');
}
function surgeonGear() {
  const { R, line, ring, disc } = H, cloth = '#efece4', red = '#c03030';
  R(-1.1, -3.75, 2.2, 3.55, cloth); R(0.35, -3.75, 0.75, 3.55, 'rgba(0,0,0,0.07)');   // long white apron
  line('#d8d4ca', 0.12, [[-0.95, -3.75], [-0.8, -4.05]]); line('#d8d4ca', 0.12, [[0.95, -3.75], [0.8, -4.05]]);
  R(-0.14, -3.4, 0.28, 0.9, red); R(-0.45, -3.09, 0.9, 0.28, red);   // red cross
  R(-1.1, -1.95, 2.2, 0.2, '#d8d4ca');   // apron tie
  disc(cloth, 1.6, -1.9, 0.35); ring('#d8d4ca', 0.05, 1.6, -1.9, 0.2);   // bandage roll in hand
  R(-1.15, -6.8, 2.3, 0.7, cloth); R(0.4, -6.8, 0.75, 0.7, 'rgba(0,0,0,0.07)');   // cloth cap
  R(-0.08, -6.65, 0.16, 0.42, red); R(-0.22, -6.51, 0.44, 0.14, red);
  for (const ex of [-0.37, 0.53]) ring('#3a3a40', 0.07, ex, -5.15, 0.3);   // round glasses
  line('#3a3a40', 0.06, [[-0.07, -5.18], [0.23, -5.18]]);
}
