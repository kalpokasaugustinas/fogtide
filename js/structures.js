// building scenes: when a segment has a building, the whole segment turns into a small diorama.
// two passes per segment, both in css pixels with the segment path as clip where needed:
//   ground(...) = flat things under the owner tint (fields, courtyards, plazas, gardens)
//   top(...)    = standing things above everything (houses, walls, towers, soldiers, flags)
// view gives: scale, size, theme, seed, segP (paths), spots(id, n, sep) and edgeSpots(id, sep)

const css = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const dk = (c, k) => c.map((v) => v * (1 - k));
const lt = (c, k) => c.map((v) => v + (255 - v) * k);

// tiny deterministic random from (i, j, seed)
function rnd(i, j, s) {
  let h = Math.imul(i + 1, 374761393) ^ Math.imul(j + 7, 668265263) ^ Math.imul(s, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// building styles: wall / roof / stone colours plus the house shape (kind), set per sprite by usePalette:
//   gable: plain pitched roof · steep: tall turf roof, plank walls · flat: flat roof, parapet, small
//   windows · pagoda: curved two-tier roof with upturned eaves · tudor: white walls with dark timber
//   beams · gothic: tall pointed slate roof, lit window · tropical: bamboo walls, round straw roof
export const palettes = {
  classic: { wall: [244, 240, 230], roof: [178, 92, 70], stone: [196, 192, 182], stoneDark: [140, 136, 128], kind: 'gable' },
  nordic: { wall: [156, 116, 82], roof: [96, 126, 86], stone: [150, 156, 160], stoneDark: [94, 100, 108], kind: 'steep' },
  desert: { wall: [236, 210, 164], roof: [200, 156, 100], stone: [224, 198, 152], stoneDark: [172, 142, 100], kind: 'flat' },
  eastern: { wall: [238, 228, 216], roof: [58, 82, 122], stone: [206, 192, 172], stoneDark: [128, 74, 62], kind: 'pagoda' },
  tudor: { wall: [246, 242, 228], roof: [128, 84, 56], stone: [188, 180, 168], stoneDark: [120, 110, 98], kind: 'tudor' },
  gothic: { wall: [150, 150, 158], roof: [62, 58, 78], stone: [132, 132, 142], stoneDark: [84, 82, 96], kind: 'gothic' },
  tropical: { wall: [214, 182, 120], roof: [226, 194, 112], stone: [196, 176, 140], stoneDark: [140, 118, 86], kind: 'tropical' },
};
let stone, stoneDark, roofRed, wallWhite, houseKind = 'gable';
function usePalette(name) {
  const p = palettes[name] ?? palettes.classic;
  ({ stone, stoneDark, roof: roofRed, wall: wallWhite } = p);
  houseKind = p.kind ?? 'gable';
}
usePalette('classic');

// clip to a segment path (paths are in grid units, drawing continues in css px)
function clipSeg(v, x, id) {
  v.gridT(x);
  x.clip(v.segP[id]);
  v.cssT(x);
}

function shadow(x, cx, cy, rx, ry) {
  x.fillStyle = 'rgba(20,30,30,0.25)';
  x.beginPath(); x.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); x.fill();
}

// gabled house seen from the front-top: wall, door, two-tone roof
function house(x, cx, cy, u, wall = wallWhite, roof = roofRed, w = 2.4, h = 1.3) {
  w *= u; h *= u;
  const rh = u * 1.2, kind = houseKind;
  shadow(x, cx + u * 0.5, cy + u * 0.15, w * 0.7, u * 0.5);
  x.fillStyle = css(wall);
  x.fillRect(cx - w / 2, cy - h, w, h);
  x.fillStyle = css(dk(wall, 0.15));
  x.fillRect(cx + w * 0.2, cy - h, w * 0.3, h);
  x.fillStyle = css(dk(roof, 0.35));
  x.fillRect(cx - u * 0.25, cy - h * 0.6, u * 0.5, h * 0.6);   // door
  if (kind !== 'gable') { houseShape(x, cx, cy, u, w, h, rh, wall, roof, kind); return; }
  x.fillStyle = css(roof);
  x.beginPath(); x.moveTo(cx - w / 2 - u * 0.2, cy - h); x.lineTo(cx - w * 0.15, cy - h - rh); x.lineTo(cx + w * 0.35, cy - h - rh); x.lineTo(cx + w / 2 + u * 0.2, cy - h); x.fill();
  x.fillStyle = css(dk(roof, 0.2));
  x.beginPath(); x.moveTo(cx + w * 0.35, cy - h - rh); x.lineTo(cx + w / 2 + u * 0.2, cy - h); x.lineTo(cx + w * 0.1, cy - h); x.lineTo(cx - w * 0.05, cy - h - rh * 0.4); x.closePath(); x.fill();
}

// the non-classic house shapes (walls and door are already drawn; w, h in css px)
function houseShape(x, cx, cy, u, w, h, rh, wall, roof, kind) {
  const l = cx - w / 2, r = cx + w / 2, top = cy - h;
  x.lineWidth = Math.max(0.5, u * 0.16);
  if (kind === 'steep') {
    // plank walls, tall turf roof with a grass fringe
    x.strokeStyle = css(dk(wall, 0.3), 0.6);
    for (let i = 1; i < 4; i++) { x.beginPath(); x.moveTo(l, top + (h * i) / 4); x.lineTo(r, top + (h * i) / 4); x.stroke(); }
    x.fillStyle = css(roof);
    x.beginPath(); x.moveTo(l - u * 0.3, top + u * 0.1); x.lineTo(cx, top - rh * 1.8); x.lineTo(r + u * 0.3, top + u * 0.1); x.fill();
    x.fillStyle = css(dk(roof, 0.22));
    x.beginPath(); x.moveTo(cx, top - rh * 1.8); x.lineTo(r + u * 0.3, top + u * 0.1); x.lineTo(cx + u * 0.2, top + u * 0.1); x.fill();
    x.fillStyle = css(lt(roof, 0.25));
    for (let i = 0; i < 5; i++) x.fillRect(l - u * 0.2 + (i * (w + u * 0.4)) / 5, top - u * 0.05, u * 0.3, u * 0.3);
  } else if (kind === 'flat') {
    // flat roof with a darker parapet, two small dark windows, a little dome on wide houses
    x.fillStyle = css(dk(wall, 0.12));
    x.fillRect(l - u * 0.15, top - u * 0.45, w + u * 0.3, u * 0.45);
    x.fillStyle = css(lt(wall, 0.15));
    x.fillRect(l - u * 0.15, top - u * 0.45, w + u * 0.3, u * 0.12);
    x.fillStyle = css(dk(roof, 0.45));
    x.fillRect(l + w * 0.12, top + h * 0.22, u * 0.35, u * 0.35);
    x.fillRect(r - w * 0.12 - u * 0.35, top + h * 0.22, u * 0.35, u * 0.35);
    if (w > u * 2.2) { x.fillStyle = css(roof); x.beginPath(); x.arc(cx - w * 0.15, top - u * 0.45, u * 0.55, Math.PI, 0); x.fill(); }
  } else if (kind === 'pagoda') {
    // two curved roof tiers with upturned eaves
    const tier = (y, half, hh) => {
      x.fillStyle = css(roof);
      x.beginPath(); x.moveTo(cx - half - u * 0.5, y - u * 0.25);
      x.quadraticCurveTo(cx - half * 0.5, y - u * 0.05, cx - half * 0.35, y - hh);
      x.lineTo(cx + half * 0.35, y - hh);
      x.quadraticCurveTo(cx + half * 0.5, y - u * 0.05, cx + half + u * 0.5, y - u * 0.25);
      x.quadraticCurveTo(cx, y + u * 0.2, cx - half - u * 0.5, y - u * 0.25); x.fill();
      x.fillStyle = css(dk(roof, 0.25)); x.fillRect(cx - half * 0.35, y - hh - u * 0.12, half * 0.7, u * 0.12);
    };
    tier(top + u * 0.1, w / 2, rh * 0.75);
    x.fillStyle = css(dk(wall, 0.1)); x.fillRect(cx - w * 0.2, top - rh * 0.75 - u * 0.5, w * 0.4, u * 0.55);
    tier(top - rh * 0.75 - u * 0.4, w * 0.32, rh * 0.55);
  } else if (kind === 'tudor') {
    // dark timber frame on white walls, brown gable roof
    x.strokeStyle = css([86, 58, 40]); x.lineWidth = Math.max(0.6, u * 0.2);
    x.strokeRect(l, top, w, h);
    x.beginPath(); x.moveTo(l, top + h * 0.45); x.lineTo(r, top + h * 0.45);
    x.moveTo(l + w * 0.18, top); x.lineTo(l + w * 0.38, top + h * 0.45); x.moveTo(r - w * 0.18, top); x.lineTo(r - w * 0.38, top + h * 0.45); x.stroke();
    x.fillStyle = css(roof);
    x.beginPath(); x.moveTo(l - u * 0.3, top); x.lineTo(cx, top - rh * 1.25); x.lineTo(r + u * 0.3, top); x.fill();
    x.fillStyle = css(dk(roof, 0.22));
    x.beginPath(); x.moveTo(cx, top - rh * 1.25); x.lineTo(r + u * 0.3, top); x.lineTo(cx + u * 0.15, top); x.fill();
  } else if (kind === 'gothic') {
    // tall pointed slate roof with a little spire, narrow lit window
    x.fillStyle = css(roof);
    x.beginPath(); x.moveTo(l - u * 0.15, top); x.lineTo(cx, top - rh * 2.3); x.lineTo(r + u * 0.15, top); x.fill();
    x.fillStyle = css(lt(roof, 0.18));
    x.beginPath(); x.moveTo(l - u * 0.15, top); x.lineTo(cx, top - rh * 2.3); x.lineTo(cx - u * 0.1, top); x.fill();
    x.strokeStyle = css(dk(roof, 0.3)); x.beginPath(); x.moveTo(cx, top - rh * 2.3); x.lineTo(cx, top - rh * 2.3 - u * 0.6); x.stroke();
    x.fillStyle = 'rgb(255, 214, 120)';
    x.beginPath(); x.moveTo(l + w * 0.18, top + h * 0.7); x.lineTo(l + w * 0.18, top + h * 0.32); x.lineTo(l + w * 0.24, top + h * 0.2); x.lineTo(l + w * 0.3, top + h * 0.32); x.lineTo(l + w * 0.3, top + h * 0.7); x.fill();
  } else if (kind === 'tropical') {
    // bamboo walls (vertical canes), round straw roof
    x.strokeStyle = css(dk(wall, 0.25), 0.7);
    for (let i = 1; i < 6; i++) { x.beginPath(); x.moveTo(l + (w * i) / 6, top); x.lineTo(l + (w * i) / 6, cy); x.stroke(); }
    x.fillStyle = css(roof);
    x.beginPath(); x.ellipse(cx, top + u * 0.05, w / 2 + u * 0.45, rh * 1.15, 0, Math.PI, 0); x.fill();
    x.strokeStyle = css(dk(roof, 0.25), 0.8);
    for (let i = -2; i <= 2; i++) { x.beginPath(); x.moveTo(cx + i * w * 0.12, top - rh * 1.05 * Math.cos(i * 0.45)); x.lineTo(cx + i * w * 0.27, top + u * 0.05); x.stroke(); }
    x.fillStyle = css(dk(roof, 0.15)); x.fillRect(l - u * 0.45, top - u * 0.05, w + u * 0.9, u * 0.2);
  }
}

// square stone tower with battlements; returns its top y
function tower(x, cx, cy, u, w, h, col = stone) {
  w *= u; h *= u;
  shadow(x, cx + u * 0.6, cy + u * 0.1, w * 0.8, u * 0.55);
  x.fillStyle = css(col);
  x.fillRect(cx - w / 2, cy - h, w, h);
  x.fillStyle = css(dk(col, 0.22));
  x.fillRect(cx + w * 0.15, cy - h, w * 0.35, h);
  const m = Math.max(2, Math.round(w / (u * 0.7)));
  for (let i = 0; i < m; i += 2) {
    x.fillStyle = css(i * (w / m) > w * 0.65 ? dk(col, 0.22) : col);
    x.fillRect(cx - w / 2 + i * (w / m), cy - h - u * 0.45, w / m, u * 0.45);
  }
  x.fillStyle = 'rgba(40,40,50,0.7)';
  x.fillRect(cx - u * 0.15, cy - h * 0.7, u * 0.3, u * 0.45);   // window slit
  return cy - h - u * 0.45;
}

function flag(x, px, py, u, color) {
  x.strokeStyle = 'rgba(60,50,40,0.9)';
  x.lineWidth = Math.max(1, u * 0.15);
  x.beginPath(); x.moveTo(px, py); x.lineTo(px, py - u * 2.2); x.stroke();
  x.fillStyle = css(color);
  x.beginPath(); x.moveTo(px, py - u * 2.2); x.lineTo(px + u * 1.4, py - u * 1.85); x.lineTo(px, py - u * 1.5); x.fill();
}

function soldier(x, cx, cy, u, color) {
  x.fillStyle = 'rgba(20,30,30,0.22)';
  x.fillRect(cx - u * 0.1, cy - u * 0.05, u * 0.55, u * 0.18);
  x.fillStyle = css(color);
  x.fillRect(cx - u * 0.22, cy - u * 0.75, u * 0.44, u * 0.75);
  x.fillStyle = css([236, 206, 176]);
  x.beginPath(); x.arc(cx, cy - u * 0.95, u * 0.22, 0, Math.PI * 2); x.fill();
  x.strokeStyle = 'rgba(70,60,50,0.9)';
  x.lineWidth = Math.max(0.6, u * 0.08);
  x.beginPath(); x.moveTo(cx + u * 0.3, cy); x.lineTo(cx + u * 0.3, cy - u * 1.6); x.stroke();   // spear
}

function tent(x, cx, cy, u, col, mark) {
  shadow(x, cx + u * 0.4, cy + u * 0.1, u * 1.2, u * 0.4);
  x.fillStyle = css(col);
  x.beginPath(); x.moveTo(cx - u * 1.1, cy); x.lineTo(cx, cy - u * 1.4); x.lineTo(cx + u * 1.1, cy); x.fill();
  x.fillStyle = css(dk(col, 0.18));
  x.beginPath(); x.moveTo(cx, cy - u * 1.4); x.lineTo(cx + u * 1.1, cy); x.lineTo(cx + u * 0.2, cy); x.fill();
  if (mark) cross(x, cx - u * 0.25, cy - u * 0.55, u * 0.32, mark);
}

function cross(x, cx, cy, s, col) {
  x.fillStyle = css(col);
  x.fillRect(cx - s, cy - s * 0.33, s * 2, s * 0.66);
  x.fillRect(cx - s * 0.33, cy - s, s * 0.66, s * 2);
}

// ---------- per building ----------

const fieldColors = [[226, 198, 112], [150, 172, 92], [176, 132, 92], [184, 196, 112], [212, 184, 96]];

// radius (css px) of the field patch a farm gets on a terrain tile: about half the tile's size
export function fieldPatch(v, s) { return Math.min(v.u * 8, 0.5 * Math.sqrt(s.area / Math.PI) * v.scale); }

export function ground(v, x, id, type, owner) {
  usePalette('classic');
  const s = v.map.segs[id], u = v.u, cx = v.sx(s.x), cy = v.sy(s.y), seed = v.seed + id * 31;
  const snow = v.theme === v.themes?.winter || v.theme.groundA[0] > 215;
  x.save();
  clipSeg(v, x, id);
  if (type === 'farm') {
    // patchwork of strips at a per-segment angle, with furrows and a dirt track
    x.translate(cx, cy);
    x.scale(1, v.tilt);   // fields lie flat on the tilted ground
    // on a terrain tile the fields are a patch in the middle, so the forest floor, scree or shore
    // around them still shows what kind of tile it is (plain land is fully farmed)
    if (s.trait) { x.beginPath(); x.arc(0, 0, fieldPatch(v, s), 0, Math.PI * 2); x.clip(); }
    x.rotate(rnd(1, 1, seed) * Math.PI);
    const w = u * 2.6, R = v.size * 0.35;
    for (let i = -Math.ceil(R / w); i <= Math.ceil(R / w); i++) {
      for (let j = -3; j <= 3; j++) {
        let col = fieldColors[Math.floor(rnd(i, j, seed) * fieldColors.length)];
        if (snow) col = lt(col, 0.6);
        const len = R / 3;
        x.fillStyle = css(col);
        x.fillRect(i * w, j * len, w - u * 0.25, len - u * 0.25);
        x.strokeStyle = css(dk(col, 0.18), 0.6);
        x.lineWidth = Math.max(0.5, u * 0.08);
        for (let f = 1; f < 4; f++) { x.beginPath(); x.moveTo(i * w + f * w / 4, j * len); x.lineTo(i * w + f * w / 4, j * len + len - u * 0.25); x.stroke(); }
      }
    }
    x.strokeStyle = css(snow ? [214, 206, 196] : [196, 170, 128]);
    x.lineWidth = u * 0.5;
    x.beginPath(); x.moveTo(-R, u * 0.6); x.bezierCurveTo(-R / 3, -u * 3, R / 3, u * 4, R, -u); x.stroke();
  } else if (type === 'barracks' || type === 'fort') {
    // trampled courtyard around the main spot
    const [p] = v.spots(id, 1, 0);
    if (!p) { x.restore(); return; }
    x.fillStyle = css(snow ? [214, 214, 216] : [184, 164, 128], 0.75);
    x.beginPath(); x.ellipse(p[0], p[1] - u * 0.5, u * 6.5, u * 3.8, 0, 0, Math.PI * 2); x.fill();
  } else if (type === 'hospital') {
    // herb gardens: small green beds with flower dots
    for (const [px, py] of v.spots(id, 6, u * 4).slice(1)) {
      x.fillStyle = css([128, 160, 92]);
      x.fillRect(px - u * 1.2, py - u * 0.8, u * 2.4, u * 1.6);
      for (let k = 0; k < 5; k++) {
        x.fillStyle = css(k % 2 ? [236, 236, 240] : [220, 120, 140]);
        x.beginPath(); x.arc(px - u + rnd(k, 3, seed + px | 0) * u * 2, py - u * 0.6 + rnd(k, 4, seed + py | 0) * u * 1.2, u * 0.18, 0, Math.PI * 2); x.fill();
      }
    }
  } else if (type === 'capital') {
    // cobbled town square
    const [p] = v.spots(id, 1, 0);
    if (!p) { x.restore(); return; }
    x.fillStyle = css(snow ? [222, 222, 224] : [196, 186, 168]);
    x.beginPath(); x.ellipse(p[0], p[1] - u * 0.4, u * 7.5, u * 4.4, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = css(snow ? [206, 206, 210] : [176, 166, 148]);
    for (let i = 0; i < 40; i++) {
      const a = rnd(i, 21, seed) * Math.PI * 2, d = Math.sqrt(rnd(i, 22, seed));
      x.fillRect(p[0] + Math.cos(a) * d * u * 6.5, p[1] - u * 0.4 + Math.sin(a) * d * u * 3.6, u * 0.5, u * 0.3);
    }
  } else if (type.startsWith('camp')) {
    // zoomed-out maps: smaller hamlets, so they don't crowd the tile
    ((u) => {
      // neutral camp: trampled ground under the hamlet
      const [p] = v.spots(id, 1, 0);
      if (!p) return;
      const r = 3.5 + Number(type.slice(4)) * 1.2;
      x.fillStyle = css(snow ? [220, 218, 214] : [178, 160, 122], 0.7);
      x.beginPath(); x.ellipse(p[0], p[1] - u * 0.5, u * r, u * r * 0.58, 0, 0, Math.PI * 2); x.fill();
    })(u * Math.max(0.62, v.map.detail ?? 1));
  } else if (type === 'home') {
    // starting tile: a small dirt yard and a path around the single house
    const [p] = v.spots(id, 1, 0);
    if (!p) { x.restore(); return; }
    x.fillStyle = css(snow ? [222, 220, 216] : [196, 176, 134], 0.8);
    x.beginPath(); x.ellipse(p[0], p[1] - u * 0.3, u * 3.4, u * 1.9, 0, 0, Math.PI * 2); x.fill();
    x.strokeStyle = css(snow ? [214, 210, 204] : [190, 168, 126], 0.8);
    x.lineWidth = u * 0.45;
    x.beginPath(); x.moveTo(p[0] - u * 0.2, p[1] + u * 1.4); x.quadraticCurveTo(p[0] - u * 2, p[1] + u * 3.5, p[0] - u * 4.5, p[1] + u * 4.2); x.stroke();
  } else if (type === 'relic') {
    // glowing ring of standing stones on the ground
    const [p] = v.spots(id, 1, 0);
    if (!p) { x.restore(); return; }
    x.fillStyle = 'rgba(255, 215, 106, 0.28)';
    x.beginPath(); x.ellipse(p[0], p[1] - u * 0.3, u * 5, u * 3, 0, 0, Math.PI * 2); x.fill();
    x.strokeStyle = 'rgba(255, 235, 170, 0.8)';
    x.lineWidth = Math.max(1, u * 0.18);
    x.beginPath(); x.ellipse(p[0], p[1] - u * 0.3, u * 3.6, u * 2.1, 0, 0, Math.PI * 2); x.stroke();
  } else if (type === 'lab') {
    // paved plaza with a ring pattern
    const [p] = v.spots(id, 1, 0);
    if (!p) { x.restore(); return; }
    x.fillStyle = css([206, 204, 198]);
    x.beginPath(); x.ellipse(p[0], p[1] - u * 0.4, u * 6, u * 3.6, 0, 0, Math.PI * 2); x.fill();
    x.strokeStyle = css([170, 168, 160]);
    x.lineWidth = Math.max(0.6, u * 0.12);
    x.beginPath(); x.ellipse(p[0], p[1] - u * 0.4, u * 4, u * 2.4, 0, 0, Math.PI * 2); x.stroke();
  }
  x.restore();
}

export function top(v, x, id, type, owner, skin) {
  usePalette(skin);
  const u = v.u, seed = v.seed + id * 31, col = owner ?? [140, 140, 140];
  x.save();
  v.cssT(x);
  if (type === 'farm') {
    // farmhouses with haystacks
    for (const [i, [px, py]] of v.spots(id, 3, u * 6).entries()) {
      house(x, px, py, u, wallWhite, i === 0 ? roofRed : [150, 120, 80]);
      x.fillStyle = css([224, 190, 100]);
      x.beginPath(); x.arc(px + u * 2.4, py - u * 0.4, u * 0.6, Math.PI, 0); x.fill();
    }
  } else if (type === 'fort') {
    // tall stone wall along the segment edge: the wall band is stacked upward (like the cliffs) so
    // the edges facing the camera show a high stone face, then the walkway and merlons on top;
    // round towers stand along it, keep in the middle
    const p = v.segP[id], wpx = (u * 0.9) / v.scale, wallH = u * 3, gy = 1 / (v.scale * v.tilt);   // css px -> grid y
    x.save();
    v.gridT(x);
    x.lineJoin = 'round';
    x.save(); x.clip(p); x.lineWidth = wpx * 3.4; x.strokeStyle = 'rgba(20,30,30,0.22)'; x.stroke(p); x.restore();   // foot shadow
    for (let h = 0; h <= wallH; h += 0.5) {
      x.save();
      x.translate(0, -h * gy);
      x.clip(p);
      x.lineWidth = wpx * 2.4;
      x.strokeStyle = css(h < wallH * 0.2 ? dk(stoneDark, 0.12) : (Math.round(h / (u * 0.75)) % 2 ? stoneDark : dk(stoneDark, 0.06)));   // stone courses
      x.stroke(p);
      x.restore();
    }
    x.translate(0, -wallH * gy);
    x.clip(p);
    x.lineWidth = wpx * 2;
    x.strokeStyle = css(stone);
    x.stroke(p);
    x.setLineDash([wpx * 0.7, wpx * 0.7]);
    x.lineWidth = wpx * 0.8;
    x.strokeStyle = css(lt(stone, 0.35));
    x.stroke(p);
    x.restore();
    for (const [px, py] of v.edgeSpots(id, u * 9)) {
      const th = wallH + u * 1.6;
      shadow(x, px + u * 0.5, py + u * 0.2, u * 1.2, u * 0.45);
      x.fillStyle = css(stoneDark);
      x.fillRect(px - u * 1, py - th, u * 2, th);
      x.fillStyle = css(stone);
      x.fillRect(px - u * 1, py - th, u * 1.2, th);
      x.fillStyle = css(lt(stone, 0.2));
      x.beginPath(); x.ellipse(px, py - th, u * 1, u * 0.45, 0, 0, Math.PI * 2); x.fill();
      x.fillStyle = css(dk(stoneDark, 0.3));
      x.fillRect(px - u * 0.15, py - th + u * 0.9, u * 0.3, u * 0.6);   // arrow slit
    }
    const [k] = v.spots(id, 1, 0);
    if (!k) { x.restore(); return; }
    const ty = tower(x, k[0], k[1], u, 2.6, 4);
    flag(x, k[0], ty, u, col);
  } else if (type === 'barracks') {
    // castle: two towers + hall with a gate, flag, tents and a formation of soldiers
    const [c, a, b] = v.spots(id, 3, u * 7);
    if (!c) { x.restore(); return; }
    const [px, py] = c;
    shadow(x, px + u, py + u * 0.2, u * 4.5, u * 0.8);
    x.fillStyle = css(stone);
    x.fillRect(px - u * 3, py - u * 2.4, u * 6, u * 2.4);
    x.fillStyle = css(dk(stone, 0.22));
    x.fillRect(px + u * 1, py - u * 2.4, u * 2, u * 2.4);
    x.fillStyle = 'rgba(50,40,40,0.85)';
    x.beginPath(); x.moveTo(px - u * 0.7, py); x.lineTo(px - u * 0.7, py - u * 1.1); x.arc(px, py - u * 1.1, u * 0.7, Math.PI, 0); x.lineTo(px + u * 0.7, py); x.fill();
    tower(x, px - u * 3.2, py, u, 1.8, 3.6);
    const t2 = tower(x, px + u * 3.2, py, u, 1.8, 3.6);
    flag(x, px + u * 3.2, t2, u, col);
    if (a) for (let i = 0; i < 2; i++) tent(x, a[0] + (i - 0.5) * u * 2.6, a[1], u, [226, 218, 200]);
    if (b) for (let r = 0; r < 3; r++) for (let q = 0; q < 5; q++) soldier(x, b[0] + (q - 2) * u * 0.9 + r * u * 0.3, b[1] + (r - 1) * u * 1.1, u, col);
  } else if (type === 'capital') {
    // walled town: wall along the segment edge, houses around a tall keep with a big flag
    x.save();
    v.gridT(x);
    x.clip(v.segP[id]);
    const wpx = (u * 0.7) / v.scale;
    x.lineJoin = 'round';
    x.lineWidth = wpx * 2.4;
    x.strokeStyle = css(stoneDark);
    x.stroke(v.segP[id]);
    x.lineWidth = wpx * 1.8;
    x.strokeStyle = css(lt(stone, 0.15));
    x.stroke(v.segP[id]);
    x.restore();
    const [c, ...homes] = v.spots(id, 7, u * 3.2);
    if (!c) { x.restore(); return; }
    const roofs = [roofRed, [150, 110, 80], [120, 130, 150], roofRed];
    for (const [i, h] of homes.entries()) house(x, h[0], h[1], u * 0.85, wallWhite, roofs[i % roofs.length]);
    const ty = tower(x, c[0], c[1], u, 3, 5.4, lt(stone, 0.1));
    tower(x, c[0] - u * 2.2, c[1] + u * 0.3, u, 1.5, 3.6);
    tower(x, c[0] + u * 2.2, c[1] + u * 0.3, u, 1.5, 3.6);
    flag(x, c[0], ty, u * 1.5, col);
  } else if (type.startsWith('camp')) {
    // zoomed-out maps: smaller hamlets, so they don't crowd the tile
    ((u) => {
      // neutral camp: 2-4 houses (more = stronger garrison) behind a ring of palisade stakes,
      // with a watch fire; roofs turn to the owner's colour once someone takes it
      const lv = Number(type.slice(4)), [p] = v.spots(id, 1, 0);
      if (!p) return;
      const r = 3.5 + lv * 1.2, roofs = owner ? [col, dk(col, 0.25)] : [[124, 104, 86], [150, 120, 84], [112, 112, 118]];
      const homes = [];
      for (let i = 0; i <= lv; i++) {
        const a = (i / (lv + 1)) * Math.PI * 2 + rnd(i, 41, seed) * 0.8;
        homes.push([p[0] + Math.cos(a) * u * r * 0.45, p[1] - u * 0.5 + Math.sin(a) * u * r * 0.26]);
      }
      homes.sort((a, b) => a[1] - b[1]);
      const stakes = (from, to) => {
        for (let i = from; i < to; i++) {
          const a = (i / 22) * Math.PI * 2, sx = p[0] + Math.cos(a) * u * r * 0.95, sy = p[1] - u * 0.5 + Math.sin(a) * u * r * 0.55;
          x.fillStyle = css(i % 2 ? [128, 98, 66] : [150, 116, 78]);
          x.fillRect(sx - u * 0.18, sy - u * 1.1, u * 0.36, u * 1.1);
        }
      };
      stakes(11, 22);   // back half of the palisade first, front half after the houses
      for (const [i, h] of homes.entries()) house(x, h[0], h[1], u * 0.95, wallWhite, roofs[i % roofs.length]);
      x.fillStyle = 'rgba(255, 170, 70, 0.35)';
      x.beginPath(); x.arc(p[0], p[1] - u * 0.6, u * 1, 0, Math.PI * 2); x.fill();
      x.fillStyle = css([240, 150, 60]);
      x.beginPath(); x.moveTo(p[0] - u * 0.35, p[1] - u * 0.3); x.lineTo(p[0], p[1] - u * 1.3); x.lineTo(p[0] + u * 0.35, p[1] - u * 0.3); x.fill();
      stakes(0, 11);
    })(u * Math.max(0.62, v.map.detail ?? 1));
  } else if (type === 'home') {
    // starting tile: one house with a roof in the owner's colour, a little fence and a tree
    const [p] = v.spots(id, 1, 0);
    if (!p) { x.restore(); return; }
    x.strokeStyle = css([150, 120, 86]);
    x.lineWidth = Math.max(0.6, u * 0.16);
    for (let i = 0; i < 6; i++) {
      const fx = p[0] - u * 3 + i * u * 0.6;
      x.beginPath(); x.moveTo(fx, p[1] + u * 0.6); x.lineTo(fx, p[1] - u * 0.2); x.stroke();
    }
    x.beginPath(); x.moveTo(p[0] - u * 3, p[1] + u * 0.2); x.lineTo(p[0] - u * 0.1, p[1] + u * 0.2); x.stroke();
    house(x, p[0] + u * 0.6, p[1], u * 1.25, wallWhite, col);
    // the tree stands a step away from the house wall so the two never touch
    shadow(x, p[0] + u * 4.2, p[1] - u * 0.1, u * 0.9, u * 0.35);
    x.fillStyle = css([96, 72, 54]);
    x.fillRect(p[0] + u * 3.75, p[1] - u * 1.1, u * 0.3, u * 1.1);
    x.fillStyle = css([74, 112, 76]);
    x.beginPath(); x.arc(p[0] + u * 3.9, p[1] - u * 1.6, u * 0.95, 0, Math.PI * 2); x.fill();
  } else if (type === 'relic') {
    // standing stones around a tall obelisk with a glowing gold gem
    const [p] = v.spots(id, 1, 0);
    if (!p) { x.restore(); return; }
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2, sx = p[0] + Math.cos(a) * u * 3.6, sy = p[1] - u * 0.3 + Math.sin(a) * u * 2.1;
      shadow(x, sx + u * 0.3, sy, u * 0.5, u * 0.2);
      x.fillStyle = css(i % 2 ? stone : stoneDark);
      x.fillRect(sx - u * 0.35, sy - u * 1.3, u * 0.7, u * 1.3);
    }
    shadow(x, p[0] + u * 0.8, p[1], u * 1.4, u * 0.45);
    // pale sandstone obelisk (stands out from the grey stones) with a gold rune line up its face
    x.fillStyle = css([236, 226, 196]);
    x.beginPath(); x.moveTo(p[0] - u * 0.8, p[1]); x.lineTo(p[0] - u * 0.45, p[1] - u * 4.6); x.lineTo(p[0] + u * 0.45, p[1] - u * 4.6); x.lineTo(p[0] + u * 0.8, p[1]); x.fill();
    x.fillStyle = css([196, 178, 140]);
    x.beginPath(); x.moveTo(p[0], p[1]); x.lineTo(p[0] + u * 0.8, p[1]); x.lineTo(p[0] + u * 0.45, p[1] - u * 4.6); x.lineTo(p[0], p[1] - u * 4.6); x.fill();
    x.strokeStyle = css([255, 200, 70], 0.95);
    x.lineWidth = Math.max(1, u * 0.22);
    x.beginPath(); x.moveTo(p[0] - u * 0.32, p[1] - u * 0.6); x.lineTo(p[0] - u * 0.22, p[1] - u * 4.1); x.stroke();
    for (let i = 1; i <= 3; i++) { x.beginPath(); x.moveTo(p[0] - u * 0.55, p[1] - u * i * 1.1); x.lineTo(p[0] - u * 0.05, p[1] - u * i * 1.1); x.stroke(); }
    // soft halo around the gem (the live pulse is drawn on top every frame, see main.js)
    const halo = x.createRadialGradient(p[0], p[1] - u * 5.3, 0, p[0], p[1] - u * 5.3, u * 2.4);
    halo.addColorStop(0, 'rgba(255, 230, 140, 0.6)'); halo.addColorStop(1, 'rgba(255, 215, 106, 0)');
    x.fillStyle = halo;
    x.beginPath(); x.arc(p[0], p[1] - u * 5.3, u * 2.4, 0, Math.PI * 2); x.fill();
    x.fillStyle = css([255, 205, 80]);
    x.beginPath(); x.moveTo(p[0], p[1] - u * 6.2); x.lineTo(p[0] - u * 0.6, p[1] - u * 5.3); x.lineTo(p[0], p[1] - u * 4.5); x.lineTo(p[0] + u * 0.6, p[1] - u * 5.3); x.fill();
  } else if (type === 'hospital') {
    // white infirmary with a red cross, medical tents
    const [c, ...rest] = v.spots(id, 3, u * 6);
    if (!c) { x.restore(); return; }
    house(x, c[0], c[1], u, wallWhite, [214, 214, 218], 4, 1.8);
    cross(x, c[0] - u * 0.8, c[1] - u * 3.1, u * 0.6, [214, 64, 60]);
    flag(x, c[0] + u * 2.2, c[1] - u * 1.8, u, col);
    for (const p of rest) tent(x, p[0], p[1], u, [242, 242, 238], [214, 64, 60]);
  } else if (type === 'lab') {
    // domed observatory, a tower with glowing windows, crystals
    const [c, a, b] = v.spots(id, 3, u * 6);
    if (!c) { x.restore(); return; }
    const [px, py] = c;
    shadow(x, px + u, py + u * 0.2, u * 3, u * 0.7);
    x.fillStyle = css([226, 224, 218]);
    x.fillRect(px - u * 2, py - u * 2.2, u * 4, u * 2.2);
    x.fillStyle = css([196, 194, 188]);
    x.fillRect(px + u * 0.6, py - u * 2.2, u * 1.4, u * 2.2);
    x.fillStyle = css([150, 170, 190]);
    x.beginPath(); x.arc(px, py - u * 2.2, u * 2, Math.PI, 0); x.fill();
    x.fillStyle = css([110, 130, 150]);
    x.beginPath(); x.arc(px, py - u * 2.2, u * 2, Math.PI * 1.5, 0); x.lineTo(px, py - u * 2.2); x.fill();
    x.strokeStyle = css([70, 80, 96]);
    x.lineWidth = u * 0.35;
    x.beginPath(); x.moveTo(px - u * 0.3, py - u * 3.4); x.lineTo(px + u * 1.4, py - u * 4.6); x.stroke();   // telescope
    flag(x, px - u * 1.8, py - u * 2.2, u, col);
    if (a) {
      const ty = tower(x, a[0], a[1], u, 1.6, 4.2, [210, 206, 214]);
      x.fillStyle = css([120, 230, 240]);
      for (let i = 0; i < 3; i++) x.fillRect(a[0] - u * 0.2, ty + u * (1 + i * 1.1), u * 0.4, u * 0.5);
    }
    if (b) for (let i = 0; i < 3; i++) {
      const bx = b[0] + (i - 1) * u * 1.2, by = b[1] + (i % 2) * u * 0.4, hgt = u * (1.4 + rnd(i, 9, seed) * 1.2);
      x.fillStyle = 'rgba(120,230,240,0.35)';
      x.beginPath(); x.arc(bx, by - hgt * 0.5, hgt * 0.7, 0, Math.PI * 2); x.fill();
      x.fillStyle = css([110, 210, 228]);
      x.beginPath(); x.moveTo(bx, by - hgt); x.lineTo(bx - u * 0.45, by - hgt * 0.4); x.lineTo(bx, by); x.lineTo(bx + u * 0.45, by - hgt * 0.4); x.fill();
      x.fillStyle = css([70, 170, 200]);
      x.beginPath(); x.moveTo(bx, by - hgt); x.lineTo(bx + u * 0.45, by - hgt * 0.4); x.lineTo(bx, by); x.fill();
    }
  }
  x.restore();
}

// small preview for the commander panel: a house and a tower in the given style and colour
export function previewBuildings(x, w, h, style, color) {
  usePalette(style);
  const u = h / 9;
  tower(x, w * 0.72, h * 0.86, u, 2.2, 5.2);
  flag(x, w * 0.72, h * 0.86 - u * 5.2 - u * 0.45, u, color);
  house(x, w * 0.34, h * 0.88, u * 1.2, wallWhite, roofRed);
  usePalette('classic');
}
