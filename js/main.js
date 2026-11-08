// app shell: menu, campaign map, battle screen, input and the frame loop
import { rules, buildings, effects, factionColors, factionNames, colorNames, troopStyles, buildingStyles, neutralColor, themeNames, themes, traits } from './config.js?v=94';
import { generateMap, rng } from './mapgen.js?v=94';
import { initAnalytics, track } from './analytics.js?v=94';
import { makeBand, drawBand, dressBand } from './foglets.js?v=94';
import { Battle } from './battle.js?v=94';
import { personalities } from './ai.js?v=94';
import { Campaign } from './campaign.js?v=94';
import { Expedition, stages, perks, scoring, islandShape } from './expedition.js?v=94';
import { Idle, fmtBig, upgrades, upgradeById, branches, displayScale } from './idle.js?v=94';
import { initAudio, sfx, setSfx, setMusic, setVolume, setTrack, audioPrefs, audioState, audioFiles } from './audio.js?v=94';
import { MapView, mapScale, hexToRgb, shade, label, pill, unitSprite, pagePoint, pageRect, cloudTexture } from './render.js?v=94';
import { previewBuildings } from './structures.js?v=94';
import { initTune, tuneChanges } from './tune.js?v=94';

const $ = (id) => document.getElementById(id);

// ---------- sitelock ----------
// the game only runs where it's published: its own site, itch.io's game hosting, the portals it may
// go to, and local / home-network addresses for testing. a re-uploaded copy, or the game framed
// inside someone else's page, shows a link to the original instead (and is counted, so copies show
// up on the dashboard). stops honest-lazy copies, not a determined one
const home = 'https://kalpokasaugustinas.github.io/fogtide/';
const hostOk = (h) => /^(kalpokasaugustinas\.github\.io|localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(h)
  || /(^|\.)(itch\.zone|itch\.io|hwcdn\.net|crazygames\.com|poki\.com|poki-gdn\.com)$/.test(h);
function parentHost() {
  if (window.top === window) return null;
  const a = location.ancestorOrigins?.[location.ancestorOrigins.length - 1] ?? document.referrer;
  try { return new URL(a).hostname; } catch { return ''; }
}
const framedBy = parentHost();
// windows desktop build (electron, desktop/main.js) serves the game from its own app:// scheme
const desktop = location.protocol === 'app:';
if (!desktop && !hostOk(location.hostname) || (framedBy !== null && !hostOk(framedBy))) {
  initAnalytics();
  track(`sitelock-${location.hostname}${framedBy ? '-in-' + framedBy : ''}`);
  document.documentElement.classList.remove('booting');
  document.body.innerHTML = `<div class="sitelock"><div class="card end-card"><div class="end-ribbon"><h2>Fogtide</h2></div>
    <p>This copy of Fogtide isn't the original.</p><p><a class="mode pink big-btn" href="${home}" target="_top" rel="noopener">▶ Play the original</a></p>
    <p class="credits">${home}</p></div></div>`;
  throw new Error('sitelock: not an approved host');
}

const params = new URLSearchParams(location.search);
// ui zoom (1 = designed size 1280x720, 1.5 at 1080p), kept in sync by syncRotation; map labels use it
let uiK = 1;
// settings saved in the browser: uiSize = interface size multiplier (0.85 / 1 / 1.2)
const settings_key = 'frontlines.settings';
const settings = (() => { try { return { uiSize: 1, ...JSON.parse(localStorage.getItem(settings_key)) }; } catch { return { uiSize: 1 }; } })();
function saveSettings() { try { localStorage.setItem(settings_key, JSON.stringify(settings)); } catch { /* not saved */ } }
const autoplay = params.has('autoplay');   // test mode: the player side is played by a bot too

const colors = factionColors.map(hexToRgb);
const neutral = hexToRgb(neutralColor);

// ---------- screens ----------
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== id);
  screen = id;
  setTrack(id === 'battle' ? 'battle' : 'menu');   // aphelion on menus, rotating war tracks in battle
  if (id === 'menu') { renderMenuStats(); requestAnimationFrame(() => mv?.resize()); }
  requestAnimationFrame(() => { if (id === 'battle' && bv) { bv.resize(); key = ''; } if (id === 'campaign') cv.resize(), paintCampaign(); });
}
let screen = 'menu';

// ---------- campaign screen ----------
const campaign = new Campaign();
const cv = new MapView($('campaign-canvas'), campaign.map, 'summer', campaign.regions.map((r) => r.climate));
let pickedRegion = -1;

function paintCampaign() {
  cv.paint((id) => {
    // light tints so each region's climate (snow, autumn, moor, summer) still shows through
    if (campaign.owned.has(id)) return { color: colors[0], fill: 0.2 };
    const c = colors[campaign.regions[id].empire];
    return { color: campaign.attackable(id) ? c : shade(c, -0.2), fill: campaign.attackable(id) ? 0.1 : 0.04 };
  });
  renderRegionInfo();
}

function drawCampaign() {
  const ctx = cv.drawBase();
  const time = performance.now() / 1000;
  // sea routes between islands: moving dashed lines
  ctx.save();
  ctx.setLineDash([5, 5]);
  ctx.lineDashOffset = -time * 14;
  ctx.lineCap = 'round';
  for (const b of campaign.map.bridges) {
    const x1 = cv.sx(b.ax), y1 = cv.sy(b.ay), x2 = cv.sx(b.bx), y2 = cv.sy(b.by);
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(60,80,90,0.25)';
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.quadraticCurveTo((x1 + x2) / 2, (y1 + y2) / 2 + 10, x2, y2); ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.stroke();
  }
  ctx.restore();
  // picked region: glowing outline; regions you can attack: dashed outlines
  const open = campaign.regions.filter((r) => campaign.attackable(r.id)).map((r) => r.id);
  if (pickedRegion >= 0) cv.highlight(ctx, pickedRegion, colors[campaign.owned.has(pickedRegion) ? 0 : campaign.regions[pickedRegion].empire], open, time);
  else if (open.length) cv.highlight(ctx, open[0], colors[campaign.regions[open[0]].empire], open, time, true);
  const fs = Math.max(9, Math.min(13, cv.size / 48));
  for (const r of campaign.regions) {
    const s = campaign.map.segs[r.id], x = cv.sx(s.x), y = cv.sy(s.y);
    const owned = campaign.owned.has(r.id), open = campaign.attackable(r.id);
    label(ctx, owned ? '🏳️' : open ? '⚔️' : r.capital ? '👑' : '🔒', x, y - fs * 0.9, fs * 1.1);
    label(ctx, r.name, x, y + fs * 0.4, fs * 0.85, owned || open ? '#fff' : '#eef1f0', 700);
    if (!owned) label(ctx, 'Lv ' + r.level, x, y + fs * 1.4, fs * 0.75, '#ffd76a', 700);
  }
}

function renderRegionInfo() {
  const box = $('region-info');
  $('campaign-progress').textContent = `${campaign.owned.size} / ${campaign.regions.length} regions`;
  if (pickedRegion < 0) {
    box.innerHTML = campaign.done()
      ? '<p class="big">🏆 World conquered!</p><p>Reset the campaign to play again.</p>'
      : '<p>Tap a region marked ⚔️ next to your territory to attack it.</p>';
    return;
  }
  const r = campaign.regions[pickedRegion], open = campaign.attackable(r.id);
  box.innerHTML = `
    <p class="big">${r.capital ? '👑 ' : ''}${r.name}</p>
    <p>Held by <b style="color:${factionColors[r.empire]}">${factionNames[r.empire]}</b> · level ${r.level}</p>
    <p>${r.segments} segments · ${r.bots} enem${r.bots > 1 ? 'ies' : 'y'} · neutral garrisons ${Math.round(r.neutral[0] * 100)}–${Math.round(r.neutral[1] * 100)}% of tile size</p>
    ${open ? '<button id="attack-btn" class="primary">⚔️ Attack</button>'
           : campaign.owned.has(r.id) ? '<p>✅ Yours</p>' : '<p>🔒 Conquer a neighbouring region first</p>'}`;
  if (open) $('attack-btn').onclick = () => withLoading(() => startBattle(campaign.battleSetup(r.id), 'campaign', r.id));
}

$('campaign-canvas').addEventListener('pointerdown', (e) => {
  const id = cv.segAt(e.clientX, e.clientY);
  pickedRegion = id;
  paintCampaign();
});

// ---------- battle screen ----------
let battle = null, bv = null, mode = 'skirmish', regionId = -1;
let countdown = 0, goFlash = 0;   // 3-2-1 before a battle starts (s left), 'Conquer!' banner after
let selected = -1, pct = 0.5, drag = null, hover = -1, speed = 1, paused = false, key = '';
let userPaused = false;   // paused by the player (pause button, space, leave dialog), not by a transition
// numbers on screen: sim foglets x numScale (idle mode grows it every stage: 1.2K, 3.4M ...; 1 elsewhere)
let numScale = 1;
const num = (v) => (numScale === 1 ? Math.floor(v) : fmtBig(v * numScale));

// ---------- commander profile: your colour, troop style and building style ----------
const profileKey = 'frontlines.profile';
let profile = { color: 0, troops: 'soldier', buildings: 'classic' };
try { profile = { ...profile, ...JSON.parse(localStorage.getItem(profileKey) || '{}') }; } catch { /* private mode: defaults */ }
function saveProfile() { try { localStorage.setItem(profileKey, JSON.stringify(profile)); } catch { /* not saved */ } syncBands(); }

// give every side its look: the player gets the profile (and swaps colours with the bot that had
// it), bots get a random troop / building style, different from each other where possible
function dress(factions, seed, withPlayer = true) {
  const r = rng(seed ^ 0x5eed);
  if (withPlayer && factions[0] && !factions[0].ai) {
    const mine = factions[0].color, other = factions.find((f, i) => i > 0 && f.color === profile.color);
    if (other) other.color = mine;
    factions[0].color = profile.color;
    factions[0].skin = { troops: profile.troops, buildings: profile.buildings };
  }
  const shuffle = (a) => a.map((v) => [r(), v]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  const pick = (all, taken) => { const free = shuffle(all.filter((v) => !taken.includes(v))); return free.length ? free : shuffle(all); };
  const tPool = pick(Object.keys(troopStyles), withPlayer ? [profile.troops] : []), bPool = pick(Object.keys(buildingStyles), withPlayer ? [profile.buildings] : []);
  factions.forEach((f, i) => {
    if (f.skin) return;
    f.skin = { troops: tPool[i % tPool.length], buildings: bPool[(i + 1) % bPool.length] };
  });
  return factions;
}

// next conquest map, built in a worker while the perk card is up; startBattle takes it when it
// matches (else, or without worker support, it generates the map itself as before)
let nextMap = null;   // { key, map | null }
const mapOpts = (setup) => ({ seed: setup.seed, cells: setup.cells, grid: rules.grid, shape: setup.shape ?? 'random', obstacles: true, detail: setup.detail ?? 1, stamp: setup.stamp ?? null });
const mapKey = (o) => `${o.seed}|${o.cells}|${o.detail}|${o.shape}`;
function preloadMap(setup) {
  const opts = mapOpts(setup), key = mapKey(opts);
  nextMap = { key, map: null };
  try {
    // same ?v= build stamp as this module, so the worker never mixes old and new files
    const w = new Worker(new URL('./mapworker.js' + new URL(import.meta.url).search, import.meta.url), { type: 'module' });
    w.onmessage = (e) => { if (nextMap?.key === key) nextMap.map = e.data; w.terminate(); };
    w.onerror = () => w.terminate();
    w.postMessage(opts);
  } catch { /* no module workers: the stage generates its map on start */ }
}

let lastStart = null;   // tuning panel: 'restart round' replays the last battle setup
function startBattle(setup, m, rid = -1) {
  lastStart = [setup, m, rid];
  // battle maps: random island shape + lakes/mountains (setup.shape can force a shape)
  const opts = mapOpts(setup), pre = nextMap?.key === mapKey(opts) ? nextMap.map : null;
  const map = pre ?? generateMap(opts);
  nextMap = null;
  if (autoplay) setup.factions[0] = { ai: true, color: 0, think: 1.5, personality: personalities.aggressive };
  dress(setup.factions, setup.seed);
  battle = new Battle(map, setup);
  zoomMax = 5 / mapScale(map);
  mode = m; regionId = rid; selected = -1; hover = -1; drag = null; paused = false; userPaused = false; key = '';
  endTutor(false);
  tutorWanted = false;   // startTutorial sets it after this
  // idle: only the first stage of a run counts down; later stages roll straight on after the zoom-out
  countdown = autoplay || (m === 'idle' && idle.stage > 1) ? 0 : 3; goFlash = 0;
  numScale = m === 'idle' ? idle.scale : 1;
  idleKilled = 0;
  const theme = setup.theme ?? themeNames[setup.seed % themeNames.length];
  if (!bv) { bv = new MapView($('battle-canvas'), map, theme); bv.fitIsland = true; bv.size = 0; bv.resize(); } else bv.setMap(map, theme);   // fitIsland: the island fills the screen
  bv.prewarm(battle.factions.map((f) => colors[f.color]), 0.16);
  $('stage').classList.toggle('hidden', m !== 'expedition' && m !== 'idle');
  if (m === 'expedition') $('stage').textContent = `Stage ${expedition.stage + 1}`;
  if (m === 'idle') $('stage').textContent = `${setup.boss ? '👑 ' : setup.ghost ? '👤 ' : ''}Stage ${idle.stage}`;
  for (const id of ['idle-fogs', 'idle-shop-btn', 'idle-auto']) $(id).classList.toggle('hidden', m !== 'idle');
  $('idle-mist').classList.toggle('hidden', m !== 'idle' || !idle?.mistTotal);
  if (m === 'idle') syncIdleButtons();
  wheelOn = false;
  setCam(1, 0, 0);
  $('end').classList.add('hidden');
  renderWheel();
  show('battle');
}

function startSkirmish() {
  track('play-quick-battle');
  const seed = Math.floor(Math.random() * 1e9), r = rng(seed), types = Object.keys(personalities);
  startBattle({
    seed, cells: 22, neutral: [0.15, 0.35],
    factions: [{ ai: false, color: 0 }, ...[1, 2, 3].map((color) => ({
      ai: true, color, think: 3, personality: personalities[types[Math.floor(r() * types.length)]],
    }))],
  }, 'skirmish');
}

const colorOfFaction = (f) => (f < 0 ? neutral : colors[battle.factions[f].color]);
const isMine = (sid) => sid >= 0 && battle.segs[sid].owner === 0;
const canTarget = (from, to) => from >= 0 && to >= 0 && from !== to && battle.segs[from].adj.includes(to);

// repaint the map raster when ownership, buildings or the selection changed
function paintBattle() {
  const k = `${battle.version}:${selected}:${wheelOn}`;
  if (k === key) return;
  key = k;
  if (selected >= 0 && !isMine(selected)) selected = -1;
  const adj = selected >= 0 ? battle.segs[selected].adj : [];
  bv.paint((id) => {
    const s = battle.segs[id], o = s.owner, building = s.building ?? (s.relic ? 'relic' : s.home ? 'home' : s.camp ? 'camp' + s.camp : null);   // shrine shows until something is built
    if (o < 0) return { color: null, fill: 0, building, huts: !building };   // neutral: shacks show people live there
    return { color: colors[battle.factions[o].color], fill: 0.16, building, skin: battle.factions[o].skin?.buildings };
  });
  renderWheel();
}

// troop figures in tiles, tile numbers, sea routes and armies (marching / fighting) for battle b
// drawn on view v; ac = not-yet-simulated time (smooth motion); numbers = draw the number badges
// big conquest maps (continent, world): badges, labels and figures shrink by mapScale (render.js)
// and the camera glides in by 1 / mapScale after the zoom-out
function drawUnits(ctx, v, b, ac, numbers) {
  // battle camera zoom: badges grow only with zoom^0.35 on screen (else they'd fill the view at 5x)
  const lk = v === bv ? cam.z ** 0.65 : 1;
  const fs = Math.max(11, Math.min(18 * uiK, v.size / 30)) * mapScale(b.map) / lk;
  // troop figures: one soldier per troopsPerDot troops (battalions of x5 on zoomed-out maps)
  const z = Math.max(1, Math.min(1.9, v.size / 480)) * mapScale(b.map), dpr = v.dpr;   // figure scale: small but visible
  const kind = (b.map.detail ?? 1) < 0.7 ? 'battalion' : 'soldier';
  const per = rules.troopsPerDot * (kind === 'battalion' ? 5 : 1), sp = (kind === 'battalion' ? 12 : 4.6) * z;
  // relic obelisks (tile without a building): a slow pulsing glow around the gem and a faint
  // light pool at its foot, added on top of the cached sprite so the special tiles catch the eye
  const glow = 0.5 + 0.5 * Math.sin(performance.now() / 650);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const s of b.segs) {
    if (!s.relic || s.building) continue;
    const [p] = v.spots(s.id, 1, 0), u = v.u;
    if (!p) continue;
    const gx = p[0], gy = p[1] - u * 5.3, r = u * (2.8 + 0.9 * glow);
    const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);
    g.addColorStop(0, `rgba(255, 220, 120, ${0.32 + 0.2 * glow})`); g.addColorStop(0.4, `rgba(255, 200, 90, ${0.12 + 0.1 * glow})`); g.addColorStop(1, 'rgba(255, 190, 80, 0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(gx, gy, r, 0, Math.PI * 2); ctx.fill();
    const f = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], u * 4.5);
    f.addColorStop(0, `rgba(255, 210, 110, ${0.08 + 0.07 * glow})`); f.addColorStop(1, 'rgba(255, 210, 110, 0)');
    ctx.fillStyle = f;
    ctx.save(); ctx.translate(p[0], p[1]); ctx.scale(1, 0.55); ctx.translate(-p[0], -p[1]);
    ctx.beginPath(); ctx.arc(p[0], p[1], u * 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
  for (const s of b.segs) {
    const spots = v.troopSpots(s.id, sp);
    // neutral tiles on battalion maps (later conquest stages) show one battalion at most: their big
    // garrisons filled the map with grey figures; the number badge still tells the real count
    const n = Math.min(spots.length, s.owner < 0 && kind === 'battalion' ? 1 : Infinity, Math.ceil(s.troops / per - 0.01));
    const u = unitSprite(kind, s.owner < 0 ? '#8a8f86' : factionColors[b.factions[s.owner].color], z, dpr, s.owner < 0 ? 'soldier' : b.factions[s.owner].skin?.troops);
    for (let i = 0; i < n; i++) ctx.drawImage(u.c, spots[i][0] - u.w / 2, spots[i][1] - u.h, u.w, u.h);
  }
  // segment numbers, with the relic perk above (terrain shows in the ground itself)
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
  if (numbers) for (const s of b.segs) {
    const x = v.sx(s.x), y = v.sy(s.y);
    if (s.relic) {
      ctx.fillStyle = `rgba(255, 215, 106, ${0.25 + 0.25 * pulse})`;
      ctx.beginPath(); ctx.arc(x, y - fs * 1.35, fs * (0.75 + 0.12 * pulse), 0, Math.PI * 2); ctx.fill();
      label(ctx, perks.find((p) => p.id === s.relic).icon, x, y - fs * 1.35, fs * 0.9);
    }
    const own = s.owner >= 0 ? factionColors[b.factions[s.owner].color] : null;
    pill(ctx, num(s.troops), x, y, fs * 0.85, own ?? 'rgba(90,100,95,.55)', own ?? '#4b5552');
    // idle: land left (green -> amber -> red; a red dot once dry)
    if (b.deplete && s.owner >= 0) {
      const k = b.landShare(s), w = fs * 1.5, h = Math.max(2.5, fs * 0.17), bx = x - w / 2, by = y + fs * 0.78;
      ctx.fillStyle = 'rgba(20,30,35,0.45)';
      ctx.fillRect(bx - 1, by - 1, w + 2, h + 2);
      ctx.fillStyle = k > 0.5 ? '#5bd18f' : k > 0.2 ? '#f0b43c' : '#e0533f';
      if (k > 0) ctx.fillRect(bx, by, w * k, h);
      else { ctx.beginPath(); ctx.arc(x, by + h / 2, h, 0, Math.PI * 2); ctx.fill(); }
    }
  }
  // sea routes (world-style maps): dashed lines between islands
  if (b.map.bridges?.length) {
    ctx.save();
    ctx.setLineDash([5, 5]);
    ctx.lineDashOffset = -(b.time + ac) * 14;
    for (const br of b.map.bridges) {
      const x1 = v.sx(br.ax), y1 = v.sy(br.ay), x2 = v.sx(br.bx), y2 = v.sy(br.by);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.quadraticCurveTo((x1 + x2) / 2, (y1 + y2) / 2 + 10, x2, y2);
      ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(60,80,90,0.25)'; ctx.stroke();
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.stroke();
    }
    ctx.restore();
  }
  // archers (idle): one arrow at a time arcs from each tile of a side with archers into every enemy
  // tile next to it, in the shooter's colour; each pair has its own timing so volleys don't sync
  if (numbers) {
    const tnow = (b.time + ac) / rules.timeScale;   // battle time: arrows stop while paused, smooth between steps
    ctx.save();
    ctx.lineCap = 'round';
    for (const s of b.segs) {
      if (s.owner < 0 || !b.mods(s.owner).archers) continue;
      const col = factionColors[b.factions[s.owner].color];
      for (const id of s.adj) {
        const t = b.segs[id];
        if (t.owner < 0 || t.owner === s.owner) continue;
        for (const off of [0, 0.5]) {   // two arrows per pair, half a flight apart, side by side
          const k = (tnow * 0.8 + off + ((s.id * 7 + id * 13) % 10) / 10) % 1;   // flight progress 0..1
          const x1 = v.sx(s.x), y1 = v.sy(s.y), x2 = v.sx(t.x), y2 = v.sy(t.y), hgt = fs * 1.8, along = 0.2 + 0.6 * k;
          const side = (off ? 1 : -1) * fs * 0.35, nx = -(y2 - y1), ny = x2 - x1, nl = Math.hypot(nx, ny) || 1;
          const x = x1 + (x2 - x1) * along + (nx / nl) * side, y = y1 + (y2 - y1) * along + (ny / nl) * side - Math.sin(Math.PI * k) * hgt;
          // flight direction = derivative of the arc, so the arrow tilts up, then down
          const dx = (x2 - x1) * 0.6, dy = (y2 - y1) * 0.6 - Math.cos(Math.PI * k) * Math.PI * hgt, d = Math.hypot(dx, dy) || 1;
          const ux = dx / d, uy = dy / d, len = fs * 1.1, w = fs * 0.22;
          ctx.globalAlpha = Math.min(1, Math.sin(Math.PI * k) * 3);   // fades in / out at the ends
          ctx.strokeStyle = 'rgba(255,255,255,0.75)';   // light rim so the shaft shows on dark ground
          ctx.lineWidth = Math.max(2.4, fs * 0.2);
          ctx.beginPath(); ctx.moveTo(x - ux * len, y - uy * len); ctx.lineTo(x, y); ctx.stroke();
          ctx.strokeStyle = 'rgba(60,44,28,0.95)';
          ctx.lineWidth = Math.max(1.4, fs * 0.11);
          ctx.stroke();
          ctx.fillStyle = col;   // head in the shooter's colour, fletching at the tail
          ctx.beginPath();
          ctx.moveTo(x + ux * w * 1.6, y + uy * w * 1.6);
          ctx.lineTo(x - uy * w, y + ux * w);
          ctx.lineTo(x + uy * w, y - ux * w);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.fillRect(x - ux * len - w * 0.4, y - uy * len - w * 0.4, w * 0.8, w * 0.8);
        }
      }
    }
    ctx.restore();
  }
  // armies: marching formations; at the border they jostle and clash for the fight's 1-3 s
  const now = performance.now() / 1000;
  for (const a of b.armies) {
    const f = b.segs[a.from], t = b.segs[a.to];
    // progress between sim steps: add the not-yet-simulated time, so movement is smooth at any fps
    const fighting = a.fight || a.clash, tt = fighting ? a.t : Math.min(a.stopAt, a.t + ac / a.dur);
    const x = v.sx(f.x + (t.x - f.x) * tt), y = v.sy(f.y + (t.y - f.y) * tt);
    const ang = Math.atan2(v.sy(t.y) - v.sy(f.y), v.sx(t.x) - v.sx(f.x)), ca = Math.cos(ang), sa = Math.sin(ang);
    const col = factionColors[b.factions[a.owner].color], u = unitSprite(kind, col, z, dpr, b.factions[a.owner].skin?.troops);
    const m = Math.max(1, Math.min(kind === 'battalion' ? 12 : 30, Math.ceil(a.n / per - 0.01)));
    const cols = Math.ceil(Math.sqrt(m)), seed = a.from * 31 + a.to;
    for (let i = 0; i < m; i++) {
      // rows behind the leader, ranks across the direction of travel
      const r = Math.floor(i / cols), c = i % cols, along = -r * sp * 0.9, across = (c - (cols - 1) / 2) * sp * 0.8;
      let px = x + ca * along - sa * across, py = y + sa * along + ca * across;
      if (fighting) { px += Math.sin(now * 23 + i * 1.7 + seed) * z * 1.2; py += Math.cos(now * 19 + i) * z * 0.8; }
      else py += Math.sin(now * 14 + i) * z * 0.5;   // marching bob
      ctx.drawImage(u.c, px - u.w / 2, py - u.h, u.w, u.h);
    }
    if (fighting) {
      // clash sparks just ahead of the formation
      const fx = x + ca * sp * 1.3, fy = y + sa * sp * 1.3 - 3 * z;
      ctx.lineWidth = 1.4;
      for (let k = 0; k < 4; k++) {
        const ph = now * 9 + k * 2.1 + seed, a2 = ph * 2.3;
        if (Math.sin(ph * 3.1) < 0.2) continue;
        const sx = fx + Math.sin(ph) * sp * 0.9, sy = fy + Math.cos(ph * 1.3) * sp * 0.6, len = 2.5 * z;
        ctx.strokeStyle = k % 2 ? '#fff6c8' : '#ffd76a';
        ctx.beginPath(); ctx.moveTo(sx - Math.cos(a2) * len, sy - Math.sin(a2) * len); ctx.lineTo(sx + Math.cos(a2) * len, sy + Math.sin(a2) * len); ctx.stroke();
      }
    }
    // small number above the formation (gold rim = barracks bonus)
    if (numbers) pill(ctx, num(a.n), x, y - u.h - 7 * z, fs * 0.62, a.atk > 1 ? '#e0a020' : col, col);
  }
}

function drawBattle() {
  paintBattle();
  const ctx = bv.drawBase();
  bv.drawAmbient(ctx, performance.now() / 1000);   // water sparkles + drifting cloud shadows
  // selected segment: glowing outline; its neighbours: dashed outlines
  // highlight: the tile you're dragging from (with its neighbours), else the selected tile
  const hl = drag ? drag.from : selected;
  if (hl >= 0) bv.highlight(ctx, hl, colors[battle.factions[0].color], battle.segs[hl].adj, performance.now() / 1000);
  // mouse hover: the tile under the cursor lights up; while dragging, the tile that would get the
  // troops (gold = attack, white = move to your own); touch has no hover, so it skips this
  if (mouseOver && hover >= 0 && battle.segs[hover]) {
    if (drag) { if (hover !== drag.from && canTarget(drag.from, hover)) bv.hoverTile(ctx, hover, isMine(hover) ? [255, 255, 255] : [240, 170, 40], true); }
    else if (hover !== selected) bv.hoverTile(ctx, hover);
  }
  const fs = Math.max(11, Math.min(18 * uiK, bv.size / 30)) * mapScale(battle.map);
  drawUnits(ctx, bv, battle, acc, true);
  drawFx(ctx, fs);
  drawTutor(ctx, fs);
  updateWheel();   // follows zoom / pan
  // player routes: dashed arrows with a moving dash
  ctx.save();
  for (const [a, r] of battle.routes) {
    const s = battle.segs[a], t = battle.segs[r.to];
    if (s.owner !== 0) continue;
    const x1 = bv.sx(s.x), y1 = bv.sy(s.y), x2 = bv.sx(t.x), y2 = bv.sy(t.y);
    const ang = Math.atan2(y2 - y1, x2 - x1), len = Math.hypot(x2 - x1, y2 - y1);
    const sx = x1 + Math.cos(ang) * fs * 1.2, sy = y1 + Math.sin(ang) * fs * 1.2;
    const ex = x1 + Math.cos(ang) * (len - fs * 1.3), ey = y1 + Math.sin(ang) * (len - fs * 1.3);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey);
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.setLineDash([6, 5]); ctx.lineDashOffset = -(battle.time + acc) * 20;
    ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath();   // arrow head
    ctx.moveTo(ex + Math.cos(ang) * 6, ey + Math.sin(ang) * 6);
    ctx.lineTo(ex + Math.cos(ang + 2.5) * 8, ey + Math.sin(ang + 2.5) * 8);
    ctx.lineTo(ex + Math.cos(ang - 2.5) * 8, ey + Math.sin(ang - 2.5) * 8);
    ctx.fillStyle = '#fff'; ctx.fill();
  }
  ctx.restore();
  // drag arrow from the selected segment to the pointer
  if (drag && drag.moved) {
    const f = battle.segs[drag.from], fx = bv.sx(f.x), fy = bv.sy(f.y);
    const ok = canTarget(drag.from, hover);
    const tx = ok ? bv.sx(battle.segs[hover].x) : drag.x, ty = ok ? bv.sy(battle.segs[hover].y) : drag.y;
    ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(tx, ty);
    ctx.lineWidth = 4; ctx.setLineDash([8, 6]);
    ctx.strokeStyle = ok ? '#fff' : 'rgba(255,255,255,.4)';
    ctx.stroke(); ctx.setLineDash([]);
    if (ok) label(ctx, '→ ' + num(battle.segs[drag.from].troops * pct), (fx + tx) / 2, (fy + ty) / 2 - fs, fs * 0.8, '#ffd76a');
  }
  if ((countdown > 0 && (!paused || userPaused)) || goFlash > 0) drawCountdown(ctx);
}

// 3-2-1 countdown: a gold-rimmed shield medallion with a big number that pops in and settles,
// over a soft dark vignette; then a 'Conquer!' ribbon banner that fades as the battle starts
function drawCountdown(ctx) {
  const w = bv.canvas.width / bv.dpr, h = bv.canvas.height / bv.dpr, cx = w / 2, cy = h * 0.46, R = Math.min(w, h) * 0.13;
  ctx.save();
  const fade = countdown > 0 ? 1 : goFlash;
  // soft dark halo behind the medallion (fades out well inside the canvas, so no square edge)
  const vig = ctx.createRadialGradient(cx, cy, R * 0.8, cx, cy, R * 2.6);
  vig.addColorStop(0, `rgba(20,30,40,${0.3 * fade})`);
  vig.addColorStop(1, 'rgba(20,30,40,0)');
  ctx.fillStyle = vig;
  ctx.beginPath(); ctx.arc(cx, cy, R * 2.6, 0, Math.PI * 2); ctx.fill();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (countdown > 0) {
    const n = Math.ceil(countdown), f = n - countdown;   // f: 0 -> 1 within each second
    // paused: the number holds still at full size
    const pop = userPaused ? 1 : 1 + 0.35 * Math.max(0, 1 - f * 5) ** 2 - 0.06 * Math.max(0, f - 0.8) * 5;
    const alpha = f > 0.85 && !userPaused ? (1 - f) / 0.15 : 1;
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.scale(pop, pop);
    // medallion: drop shadow, gold rim, parchment face, inner ring, crossed-sword ticks
    ctx.fillStyle = 'rgba(20,30,30,0.3)';
    ctx.beginPath(); ctx.ellipse(R * 0.08, R * 1.05, R * 0.9, R * 0.22, 0, 0, Math.PI * 2); ctx.fill();
    const rim = ctx.createLinearGradient(0, -R, 0, R);
    rim.addColorStop(0, '#ffe7a0'); rim.addColorStop(0.5, '#e0a43a'); rim.addColorStop(1, '#9a6420');
    ctx.fillStyle = rim;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();
    const face = ctx.createRadialGradient(-R * 0.3, -R * 0.4, R * 0.1, 0, 0, R * 0.86);
    face.addColorStop(0, '#fffaf0'); face.addColorStop(1, '#e8dcc0');
    ctx.fillStyle = face;
    ctx.beginPath(); ctx.arc(0, 0, R * 0.84, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(154,100,32,0.55)';
    ctx.lineWidth = Math.max(1.5, R * 0.03);
    ctx.beginPath(); ctx.arc(0, 0, R * 0.74, 0, Math.PI * 2); ctx.stroke();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(Math.cos(a) * R * 0.76, Math.sin(a) * R * 0.76); ctx.lineTo(Math.cos(a) * R * 0.82, Math.sin(a) * R * 0.82); ctx.stroke();
    }
    ctx.font = `900 ${R * 1.15}px Georgia, 'Times New Roman', serif`;
    ctx.lineJoin = 'round';
    ctx.lineWidth = R * 0.08;
    ctx.strokeStyle = '#fffaf0';
    ctx.strokeText(n, 0, R * 0.06);
    ctx.fillStyle = factionColors[battle.factions[0].color];
    ctx.fillText(n, 0, R * 0.06);
  } else {
    // ribbon banner sliding up a little as it fades
    ctx.globalAlpha = Math.min(1, goFlash * 1.6);
    ctx.translate(cx, cy - (1 - goFlash) * R * 0.4);
    const bw = R * 3.4, bh = R * 0.85;
    ctx.fillStyle = '#9a2f2a';
    for (const s of [-1, 1]) {   // ribbon tails
      ctx.beginPath(); ctx.moveTo(s * bw * 0.42, -bh * 0.3); ctx.lineTo(s * bw * 0.62, -bh * 0.3); ctx.lineTo(s * bw * 0.54, bh * 0.05); ctx.lineTo(s * bw * 0.62, bh * 0.4); ctx.lineTo(s * bw * 0.42, bh * 0.4); ctx.fill();
    }
    const band = ctx.createLinearGradient(0, -bh / 2, 0, bh / 2);
    band.addColorStop(0, '#e2554c'); band.addColorStop(1, '#b8382f');
    ctx.fillStyle = band;
    ctx.beginPath(); ctx.moveTo(-bw / 2, -bh / 2); ctx.quadraticCurveTo(0, -bh * 0.75, bw / 2, -bh / 2); ctx.lineTo(bw / 2, bh / 2); ctx.quadraticCurveTo(0, bh * 0.25, -bw / 2, bh / 2); ctx.fill();
    ctx.strokeStyle = '#ffd76a';
    ctx.lineWidth = Math.max(1.5, R * 0.035);
    ctx.stroke();
    ctx.font = `900 ${R * 0.5}px Georgia, 'Times New Roman', serif`;
    ctx.fillStyle = '#fff6dc';
    ctx.fillText('Conquer!', 0, -bh * 0.08);
  }
  ctx.restore();
}

// battle input:
// - tap a neighbour of the selected segment = send troops there (attack, or move if it's yours)
// - tap your segment that isn't a neighbour = select it; tap the selected one again = deselect
// - drag from your segment to any neighbour = send troops
function localPos(e) {
  // canvas css px, undoing the zoom transform
  const r = pageRect(bv.canvas), p = pagePoint(e.clientX, e.clientY);
  return { x: ((p.x - r.left) * bv.size) / r.width, y: ((p.y - r.top) * bv.cssH) / r.height };
}

// ---------- zoom + pan ----------
// the map sits in #cam, which is scaled / moved with a css transform (cheap, no redraw). pinch or
// mouse wheel zooms (1x-5x) around the fingers / cursor; one finger on empty ground pans. when
// zooming settles, the view re-renders at a higher resolution so it stays sharp
let zoomMax = 5;   // 5x, more on big conquest maps (5 / mapScale, set in startBattle)
const cam = { z: 1, x: 0, y: 0 }, pointers = new Map();
let pinch = null, boostTimer = 0, boostLock = false;   // lock: the zoom-out has set the boost itself
// render resolution for zoom z (MapView.resize caps the pixels), so zoomed-in maps stay sharp
const boostFor = (z) => (z >= 3.6 ? 4 : z >= 2.6 ? 3 : z >= 1.9 ? 2 : z >= 1.4 ? 1.5 : 1);
function setCam(z, x, y) {
  const w = $('battle-wrap').clientWidth, h = $('battle-wrap').clientHeight;
  cam.z = Math.min(zoomMax, Math.max(1, z));
  cam.x = Math.min(0, Math.max(w - w * cam.z, x));
  cam.y = Math.min(0, Math.max(h - h * cam.z, y));
  $('cam').style.transform = cam.z === 1 ? '' : `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
  clearTimeout(boostTimer);
  boostTimer = setTimeout(() => {
    // render resolution follows the zoom (a change rebuilds every layer, so it waits for the zoom to settle)
    if (boostLock) return;
    const boost = boostFor(cam.z);
    if (bv && bv.boost !== boost) { bv.boost = boost; bv.resize(); }
  }, 300);
}
// glide the camera to zoom z centred on your capital (big conquest maps start zoomed in)
function focusHome(z) {
  if (z <= 1.01) return;
  const s = battle.segs[battle.factions[0].capitalSeg] ?? battle.segs.find((q) => q.owner === 0);
  if (!s) return;
  const c = bv.canvas, w = $('battle-wrap').clientWidth, h = $('battle-wrap').clientHeight;
  const px = c.offsetLeft + bv.sx(s.x), py = c.offsetTop + bv.sy(s.y), t0 = performance.now(), z0 = cam.z, x0 = cam.x, y0 = cam.y;
  const tick = (now) => {
    const k = Math.min(1, (now - t0) / 700), e = 1 - (1 - k) ** 3, zz = z0 + (z - z0) * e;
    // target: capital in the middle of the screen (setCam clamps at the map edges)
    setCam(zz, x0 + (w / 2 - px * z - x0) * e, y0 + (h / 2 - py * z - y0) * e);
    if (k < 1 && screen === 'battle') requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
// zoom to nz keeping the screen point (px, py) (relative to the map area) fixed
function zoomAt(px, py, nz) {
  nz = Math.min(zoomMax, Math.max(1, nz));
  const wx = (px - cam.x) / cam.z, wy = (py - cam.y) / cam.z;
  setCam(nz, px - wx * nz, py - wy * nz);
}
function wrapPos(e) {
  const r = pageRect($('battle-wrap')), p = pagePoint(e.clientX, e.clientY);
  return { x: p.x - r.left, y: p.y - r.top };
}
$('battle-wrap').addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = wrapPos(e);
  zoomAt(p.x, p.y, cam.z * Math.exp(-e.deltaY * 0.0015));
}, { passive: false });
const pinchInfo = () => {
  const [a, b] = [...pointers.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
};
// one finger = a gesture, decided when it moves or ends:
// - drag from your tile to a neighbour = send troops there (attack, or move to your own tile;
//   a move also sets a standing route). released anywhere else = nothing sent
// - drag starting anywhere else = pan the map
// - tap your tile = select it and open its build wheel; tap anything else = close / deselect
// two fingers = pinch zoom
let gesture = null;
$('battle-canvas').addEventListener('pointerdown', (e) => {
  if (!battle) return;
  bv.canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, wrapPos(e));
  if (pointers.size === 2) {
    gesture = drag = null;
    pinch = { ...pinchInfo(), z0: cam.z, x0: cam.x, y0: cam.y };
    return;
  }
  if (pointers.size > 2) return;
  const sid = bv.segAt(e.clientX, e.clientY);
  hover = sid;
  gesture = { sid, ...wrapPos(e), x0: cam.x, y0: cam.y, mode: null };
});
// mouse over the map (hover highlight + cursor). cursor: grab hand over your own tiles (drag to
// send), pointer over others (tap for info), grabbing while dragging / panning
let mouseOver = false, cursorNow = '';
function setCursor() {
  const on = mouseOver && hover >= 0 && !!battle?.segs[hover];   // a hover from the previous map can point past this one
  const c = gesture?.mode ? 'grabbing' : !on ? '' : isMine(hover) ? 'grab' : 'pointer';
  if (c !== cursorNow) { cursorNow = c; $('battle-canvas').style.cursor = c; }
}
$('battle-canvas').addEventListener('pointerleave', (e) => {
  if (e.pointerType !== 'mouse' || gesture) return;
  mouseOver = false; hover = -1; setCursor();
});
$('battle-canvas').addEventListener('pointermove', (e) => {
  if (!battle) return;
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, wrapPos(e));
  if (pinch && pointers.size === 2) {
    // keep the map point under the pinch centre under the fingers while scaling
    const p = pinchInfo(), nz = Math.min(zoomMax, Math.max(1, pinch.z0 * (p.d / Math.max(1, pinch.d))));
    const wx = (pinch.x - pinch.x0) / pinch.z0, wy = (pinch.y - pinch.y0) / pinch.z0;
    setCam(nz, p.x - wx * nz, p.y - wy * nz);
    return;
  }
  hover = bv.segAt(e.clientX, e.clientY);
  mouseOver = e.pointerType === 'mouse';
  setCursor();
  if (!gesture) return;
  const p = wrapPos(e);
  if (!gesture.mode && Math.hypot(p.x - gesture.x, p.y - gesture.y) > 8) {
    const troopDrag = isMine(gesture.sid) && battle.state === 'running' && countdown <= 0;
    gesture.mode = troopDrag ? 'drag' : 'pan';
    if (troopDrag) drag = { from: gesture.sid, moved: true, ...localPos(e) };
  }
  if (gesture.mode === 'pan') setCam(cam.z, gesture.x0 + p.x - gesture.x, gesture.y0 + p.y - gesture.y);
  else if (gesture.mode === 'drag') Object.assign(drag, localPos(e));
});
function pointerEnd(e) {
  pointers.delete(e.pointerId);
  if (pinch && pointers.size < 2) pinch = null;
}
$('battle-canvas').addEventListener('pointercancel', (e) => { pointerEnd(e); gesture = drag = null; });
$('battle-canvas').addEventListener('pointerup', (e) => {
  const wasPinch = !!pinch, g = gesture;
  pointerEnd(e);
  gesture = null;
  if (wasPinch || !g) { drag = null; return; }
  const playing = battle.state === 'running' && countdown <= 0;
  if (g.mode === 'drag') {
    const to = bv.segAt(e.clientX, e.clientY);
    if (playing && canTarget(g.sid, to)) sendFrom(g.sid, to);
    // dragged back onto the same tile: stop its sending (the standing route)
    else if (playing && to === g.sid && isMine(to)) {
      if (battle.routes.has(to)) { battle.clearRoute(to); flash('✋ Route removed: this tile keeps its foglets'); }
      else flash('Cancelled');
    }
  } else if (!g.mode && playing) tapAt(g.sid);
  drag = null;
});

// a tap on tile sid (or -1 = off the map): your tile = select it + build wheel (tiles with a
// structure or capitals just show their info / route); the same tile again or anything else = close
function tapAt(sid) {
  if (isMine(sid) && sid !== selected) { selected = sid; wheelOn = true; }
  else { selected = -1; wheelOn = false; }
}

function sendFrom(from, to) {
  const n = Math.floor(battle.segs[from].troops * pct);
  if (!tutorAllows(from, to)) { flash('👆 Follow the tutorial: drag along the glowing path'); return; }
  const sent = battle.send(0, from, to, n);
  if (sent && !isMine(to)) tutorEvent('attack');
  // own target: also set a standing route that keeps (1 - pct) of the cap (always on)
  if (isMine(to) && battle.setRoute(0, from, to, 1 - pct)) {
    flash(`🔁 Route set: keeps ${Math.round((1 - pct) * 100)}% of cap, forwards the rest`);
    tutorEvent('route');
  } else if (!sent) flash('Not enough foglets');
}

$('route-stop').onclick = () => { if (selected >= 0) battle.clearRoute(selected); };

// build wheel: tapping your tile that has no structure opens a ring of the 5 buildings around it.
// tap a sector to build (paid with that tile's troops); the hole in the middle and everything
// outside the ring stay tappable, so sending troops works as usual (and closes the wheel)
let wheelOn = false, wheelFor = -1, wheelPos = '';
// white line icons (24x24, stroked) per building
const wheelIcons = {
  farm: '<path d="M12 22V9"/><path d="M12 9c-2.5 0-4-1.8-4-4 2.5 0 4 1.8 4 4zM12 9c2.5 0 4-1.8 4-4-2.5 0-4 1.8-4 4z"/><path d="M12 14c-2.5 0-4-1.8-4-4 2.5 0 4 1.8 4 4zM12 14c2.5 0 4-1.8 4-4-2.5 0-4 1.8-4 4z"/><path d="M12 19c-2.5 0-4-1.8-4-4 2.5 0 4 1.8 4 4zM12 19c2.5 0 4-1.8 4-4-2.5 0-4 1.8-4 4z"/>',
  barracks: '<path d="M4 4l11 11M4 4v3l10 10M4 4h3l10 10"/><path d="M20 4L9 15M20 4v3L10 17M20 4h-3L7 14"/><path d="M13 17l4 4M11 17l-4 4"/>',
  fort: '<path d="M4 21V9h3V6h2v3h2V6h2v3h2V6h2v3h3v12z"/><path d="M10 21v-5a2 2 0 0 1 4 0v5"/>',
  hospital: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/>',
  lab: '<path d="M9 3h6M10 3v6l-5.5 9.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3"/><path d="M7.5 15h9"/><circle cx="10.5" cy="17.5" r=".6"/><circle cx="13.5" cy="18" r=".6"/>',
};
function renderWheel() {
  const box = $('wheel'), s = battle && selected >= 0 ? battle.segs[selected] : null;
  const want = wheelOn && s && s.owner === 0 && !s.building && !s.capital ? selected : -1;
  if (want === wheelFor) return;
  wheelFor = want;
  wheelPos = '';
  box.classList.toggle('hidden', want < 0);
  if (want < 0) { box.innerHTML = ''; return; }
  // ring of wedges between r0 and R, thin gaps, tick marks on the outer rim (like a game hud dial)
  const R = 100, r0 = 46, types = Object.keys(buildings), n = types.length, gap = 0.025;
  const pt = (rad, a) => [Math.cos(a) * rad, Math.sin(a) * rad].map((v) => v.toFixed(1));
  let svg = `<svg width="${(R + 8) * 2}" height="${(R + 8) * 2}" viewBox="${-R - 8} ${-R - 8} ${(R + 8) * 2} ${(R + 8) * 2}" style="left:${-R - 8}px;top:${-R - 8}px">
    <defs><radialGradient id="wheel-hot" cx="0" cy="0" r="${R}" gradientUnits="userSpaceOnUse"><stop offset="0.45" stop-color="#e0961a" stop-opacity="0.35"/><stop offset="1" stop-color="#ffd76a" stop-opacity="0.95"/></radialGradient></defs>
    <circle class="glass" r="${R}"/><circle class="hole" r="${r0}"/>`;
  for (let i = 0; i < 60; i++) {   // tick marks
    const a = (i / 60) * Math.PI * 2, [x1, y1] = pt(R + 2, a), [x2, y2] = pt(R + (i % 5 ? 4 : 7), a);
    svg += `<line class="tick" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }
  types.forEach((t, i) => {
    const a0 = -Math.PI / 2 - Math.PI / n + (i / n) * Math.PI * 2 + gap, a1 = a0 + (Math.PI * 2) / n - gap * 2, am = (a0 + a1) / 2;
    const [ax, ay] = pt(r0 + 2, a0), [bx, by] = pt(R - 2, a0), [cx, cy] = pt(R - 2, a1), [dx, dy] = pt(r0 + 2, a1);
    const d = `M${ax},${ay} L${bx},${by} A${R - 2},${R - 2} 0 0 1 ${cx},${cy} L${dx},${dy} A${r0 + 2},${r0 + 2} 0 0 0 ${ax},${ay} Z`;
    const [ix, iy] = pt(72, am);
    svg += `<g class="sector" data-type="${t}"><path class="bg" d="${d}"/>
      <g class="ico" transform="translate(${ix},${iy - 7}) scale(1.3) translate(-12,-12)">${wheelIcons[t]}</g>
      <text class="cost" x="${ix}" y="${+iy + 17}">${num(battle.costOf(0, t))}</text></g>`;
  });
  svg += `<circle class="rim" r="${R}"/><circle class="rim inner" r="${r0}"/></svg>`;
  box.innerHTML = svg;
  // small screens (phone landscape): shrink the wheel to fit around the tile
  const k = Math.max(0.62, Math.min(1, $('battle-wrap').clientHeight / 560));
  box.firstElementChild.style.setProperty('--k', k);
  box.firstElementChild.style.transformOrigin = `${R + 8}px ${R + 8}px`;
  for (const g of box.querySelectorAll('.sector')) {
    g.addEventListener('pointerdown', (e) => e.stopPropagation());
    g.addEventListener('click', () => {
      if (battle.build(0, selected, g.dataset.type)) { sfx.build(); tutorEvent('build'); }
      else flash(`${buildings[g.dataset.type].name} needs ${num(battle.costOf(0, g.dataset.type))} foglets in this tile`);
    });
  }
  updateWheel();
}
// sector states (enough troops?) and position over the tile, following zoom / pan
function updateWheel() {
  if (wheelFor < 0) return;
  const s = battle.segs[wheelFor];
  for (const g of $('wheel').querySelectorAll('.sector')) {
    g.classList.toggle('off', s.troops < battle.costOf(0, g.dataset.type));
    g.classList.toggle('hint', !!tutor && tutorSteps[tutor.step].id === 'build' && g.dataset.type === 'farm');   // tutorial: build this
  }
  const r = pageRect(bv.canvas), wr = pageRect($('battle-wrap'));
  const left = Math.round(r.left - wr.left + (bv.sx(s.x) * r.width) / bv.size), top = Math.round(r.top - wr.top + (bv.sy(s.y) * r.height) / bv.cssH);
  const pos = `${left}px,${top}px`;
  if (pos !== wheelPos) { wheelPos = pos; $('wheel').style.transform = `translate(${pos})`; }
}

// capital: nothing can be built; its carried-over bonuses
function capitalInfo(s) {
  const b = s.bonus, pc = (v) => `+${Math.round(v * 100)}%`;
  return `Bonuses: ${pc(b.growth)} growth here · ${pc(b.hosp)} in neighbours · ${pc(b.lab)} everywhere · defense ${pc(b.def)} · attack ${pc(b.atk)}`;
}

// what a tile's building does, with its owner's perks (granary, healers, scholars, stonemasons)
function buildingEffect(s) {
  const m = battle.mods(s.owner), pc = (v) => `+${Math.round(v * 100)}%`;
  switch (s.building) {
    case 'farm': return `${pc(effects.farmGrowth * (m.farm ?? 1))} growth here`;
    case 'hospital': return `${pc(effects.hospitalGrowth * (m.hospital ?? 1))} growth on the owner's tiles next to it`;
    case 'lab': return `${pc(effects.labGrowth * (m.lab ?? 1))} growth on all the owner's tiles`;
    case 'barracks': return `foglets sent from here attack x${effects.barracksAttack}`;
    case 'fort': return `defenders count x${m.fort ?? effects.fortDefense}`;
    default: return '';
  }
}
function updatePanel() {
  // segment info line: selected segment, or the hovered one
  // (a hover / selection from the previous map can point past this map's tiles: no card then)
  const sid = selected >= 0 ? selected : hover;
  if (sid >= 0 && battle.segs[sid]) {
    // rivals are named after their colour (idle: a boss or another player's profile has its own name)
    const s = battle.segs[sid], who = s.owner < 0 ? 'Neutral' : s.owner === 0 ? 'You' : battle.factions[s.owner].name ?? colorNames[battle.factions[s.owner].color];
    const col = s.owner < 0 ? neutralColor : factionColors[battle.factions[s.owner].color];
    // card: owner ribbon (+ tile kind), troops / cap and growth, then chips for terrain, structure, relic
    const relic = s.relic ? perks.find((p) => p.id === s.relic) : null;
    const kind = s.capital ? 'Capital' : s.home ? 'Homeland' : s.camp ? 'Camp' : s.owner < 0 ? 'Village' : 'Territory';
    const r1 = (v) => (numScale === 1 ? Math.round(v * 10) / 10 : fmtBig(v * numScale));   // per-second rates
    const rate = s.owner < 0 ? `regrows to ${num(s.garrison)} · +${r1(s.baseGrowth * rules.neutralRegrow)}/s` : `+${r1(s.growth)}/s`;
    const chips = [
      s.trait && `<span>${traits[s.trait].name}: ${traits[s.trait].desc}</span>`,
      s.building && !s.capital && `<span>${buildings[s.building].icon} ${buildings[s.building].name}: ${buildingEffect(s)}</span>`,
      relic && `<span class="gold">✨ ${relic.name}: ${relic.desc}</span>`,
      s.capital && s.owner === 0 && `<span class="gold">${capitalInfo(s)}</span>`,
      battle.deplete && s.owner >= 0 && `<span>🌾 Land: ${battle.landShare(s) > 0 ? `${Math.round(battle.landShare(s) * 100)}% left (raises ${num(battle.landLimit(s))} in all)` : 'dry, no more growth'}</span>`,
    ].filter(Boolean).join('');
    $('seg-info').innerHTML = `<div class="who" style="background:${col}">${who}<small>${kind}</small></div>
      <div class="body"><div class="troops">${num(s.troops)} <small>/ ${num(s.owner < 0 ? s.garrison : s.cap)} · ${rate}</small></div>${chips ? `<div class="chips">${chips}</div>` : ''}</div>`;
  } else $('seg-info').textContent = '';
  // selected tile's route (if any) with a stop button
  const route = selected >= 0 ? battle.routes.get(selected) : null;
  $('route-info').classList.toggle('hidden', !route);
  if (route) $('route-info').firstElementChild.textContent = `🔁 Route active, keeps ${Math.round(route.keep * 100)}% of cap`;
  const res = battle.factions[0].reserve;
  $('clock').textContent = fmtTime(battle.time) + (res >= 1 ? ` · 🏕️ ${num(res)}` : '');
  $('clock').title = res >= 1 ? 'Reserve: flows into your capital when it has room' : '';
  renderPerks();
  if (mode === 'idle') updateIdleHud();
}

// conquest perk column (left, under the top-left hud): the perks picked so far, then the relic
// perks of tiles you hold (gold ring, gone when the tile is lost). rebuilt only when the list changes
let perkKey = '';
function renderPerks() {
  const on = mode === 'expedition' && expedition;
  const picked = on ? expedition.perks : [];
  const relics = on ? [...new Set(battle.segs.filter((s) => s.owner === 0 && s.relic).map((s) => s.relic))] : [];
  const k = picked.join() + '|' + relics.join();
  if (k === perkKey) return;
  perkKey = k;
  const bar = $('perk-bar');
  bar.innerHTML = '';
  for (const [id, relic] of [...picked.map((id) => [id, false]), ...relics.map((id) => [id, true])]) {
    const p = perks.find((x) => x.id === id), b = document.createElement('button');
    b.className = 'perk-chip' + (relic ? ' relic' : '');
    b.textContent = p.icon;
    b.title = `${p.name}: ${p.desc}`;
    b.onclick = () => flash(`${p.icon} ${p.name}${relic ? ' (relic)' : ''}: ${p.desc}`, 2600);
    bar.appendChild(b);
  }
  bar.classList.toggle('hidden', !bar.children.length);
}

for (const b of document.querySelectorAll('#pct button')) {
  b.onclick = () => setPct(+b.dataset.pct);
}
function setPct(p) {
  pct = p;
  for (const b of document.querySelectorAll('#pct button')) b.classList.toggle('on', +b.dataset.pct === p);
}

$('speed').onclick = () => setSpeed(paused ? speed : 0);   // one button: pause <-> play
function setSpeed(s) {
  // during the 3-2-1 the drum stops on pause and picks up where the count is on resume
  if (screen === 'battle' && countdown > 0 && countdown < 3 && (s === 0) !== paused) { if (s === 0) sfx.drumStop(); else sfx.drumFrom(3 - countdown); }
  paused = s === 0;
  userPaused = paused;
  if (s > 0) speed = s;
  $('speed').textContent = paused ? '▶' : '❚❚';
  $('speed').classList.toggle('paused', paused);
}

// stats grid for end screens: fights, economy, territory, buildings by type
// conquest score box: this stage's points by part, the run total; at the end of a run (saved =
// saveRun result) the rank and the top 5 runs with this one highlighted
function scoreHtml(gain, saved = null) {
  const part = (label, v) => (v ? `<span>${label} <b>+${v.toLocaleString()}</b></span>` : '');
  let h = `<div class="score-box"><div class="score-total">🏅 <b data-n="${expedition.points}">0</b> points`
    + (saved?.rank ? ` · <b>#${saved.rank}</b> of your runs` : '') + `</div><div class="score-parts">`
    + part('clear', gain.clear) + part('★ stars', gain.stars) + part('⏱️ speed', gain.speed) + part('🗡️ kills', gain.kills) + '</div>';
  if (saved) h += boardHtml(saved.runs.slice(0, 5), saved.run.id);
  return h + '</div>';
}
// table of runs (rank, points, stage reached, time, date); mark = id of the row to highlight
function boardHtml(runs, mark = null) {
  if (!runs.length) return '<p class="hint">No runs yet: play a conquest to get on the board.</p>';
  const rows = runs.map((r, i) => `<tr class="${r.id === mark ? 'me' : ''}"><td>#${i + 1}</td><td><b>${r.points.toLocaleString()}</b></td>`
    + `<td>${r.won ? '🌍 World' : `stage ${r.reached}`}</td><td>${fmtTime(r.secs * rules.timeScale)}</td><td>${r.date}</td></tr>`).join('');
  return `<table class="board"><tr><th></th><th>Points</th><th>Reached</th><th>Time</th><th>Date</th></tr>${rows}</table>`;
}

function statsHtml(b) {
  const st = b.stats, n = (v) => Math.round(v).toLocaleString();
  const mine = b.segs.filter((s) => s.owner === 0);
  const blds = Object.entries(buildings).map(([k, v]) => [v.icon, mine.filter((s) => s.building === k).length]).filter(([, c]) => c);
  const cells = [
    ['⏱️', fmtTime(b.time), 'time'], ['🗡️', st.killed, 'killed'], ['💀', st.deaths, 'foglets lost'],
    ['🌱', st.made, 'foglets raised'], ['🏳️', st.captured, 'tiles taken'], ['🏚️', st.lost, 'tiles lost'],
    ['🗺️', `${mine.length} / ${Math.max(st.peak, mine.length)}`, 'tiles held / peak'], ['🏗️', st.built, 'built'], ['📣', st.sent, 'orders'],
  ];
  // numbers count up when the card opens (data-n = final value); tiles pop in one after another
  const val = (v) => (typeof v === 'number' ? `<b data-n="${Math.round(v)}">0</b>` : `<b>${v}</b>`);
  return `<div class="stats">${cells.map(([i, v, l], k) => `<div style="animation-delay:${0.25 + k * 0.05}s"><span>${i}</span>${val(v)}<small>${l}</small></div>`).join('')}</div>`
    + (blds.length ? `<p class="blds">Standing buildings: ${blds.map(([i, c]) => `${i} ${c}`).join(' · ')}</p>` : '');
}

// end card chrome: win/lose look, stars (1 for the win, +1 no tile lost, +1 under 6 minutes),
// then count the stat numbers up
// stars of a won battle: the win, no tile lost, under 6:00 (real time)
function starsOf(b) { return [true, b.stats.lost === 0, b.time / rules.timeScale < 360]; }

function showEnd(won, starsFor) {
  $('end').classList.toggle('win', won);
  $('end').classList.toggle('lose', !won);
  if (won && starsFor) {
    const got = starsOf(starsFor);
    $('end-stars').innerHTML = got.map((on) => `<span class="${on ? 'on' : ''}">★</span>`).join('');
    $('end-why').textContent = '★ victory · ★ no tile lost · ★ under 6:00';
  } else $('end-stars').innerHTML = $('end-why').textContent = '';
  $('end').classList.remove('hidden');
  const nums = [...$('end').querySelectorAll('[data-n]')], t0 = performance.now();
  const tick = (now) => {
    const k = Math.min(1, (now - t0 - 300) / 900), e = k <= 0 ? 0 : 1 - (1 - k) ** 3;
    for (const el of nums) el.textContent = Math.round(+el.dataset.n * e).toLocaleString();
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// the end card's second button is red when it reads 'Withdraw', green otherwise
function withdrawLook() {
  const w = $('end-continue').textContent === 'Withdraw';
  $('end-continue').classList.toggle('red', w);
  $('end-continue').classList.toggle('green', !w);
}
function endBattle() {
  const won = battle.state === 'won';
  if (mode === 'expedition') return endStage(won);
  if (mode === 'idle') return endIdleStage(won);
  // regular end card: undo the expedition variants
  $('end-perks').innerHTML = '';
  $('end-retry').textContent = '↻ Retry';
  $('end-continue').classList.remove('hidden');
  if (won && mode === 'campaign') { campaign.conquer(regionId); pickedRegion = -1; }
  if (won && mode === 'skirmish') addQuickWin();
  track(`${mode}-${won ? 'won' : 'lost'}`);
  if (mode === 'tutorial') markTutorSeen();
  const st = battle.stats;
  $('end-title').textContent = won ? (mode === 'campaign' ? 'Region conquered!' : mode === 'tutorial' ? 'Tutorial complete!' : 'Victory!') : 'Defeated';
  $('end-stats').innerHTML = statsHtml(battle);
  // quick battle: always offer a fresh map; campaign: retry only after a loss
  $('end-retry').textContent = mode === 'skirmish' ? '▶ Play again' : '↻ Retry';
  $('end-retry').classList.toggle('hidden', won && mode !== 'skirmish');
  // quick battle: play again or withdraw to the menu (no 'continue': there is nothing to continue)
  $('end-continue').textContent = mode === 'skirmish' ? 'Withdraw' : won ? 'Continue' : 'Menu';
  if (mode === 'tutorial') $('end-continue').textContent = afterTutor === startExpedition ? '▶ Conquest' : afterTutor === startIdle ? '▶ Idle' : afterTutor ? '▶ Quick battle' : 'Menu';
  withdrawLook();
  showEnd(won, won ? battle : null);
  setTrack(won ? 'victory' : 'defeat');
}
$('end-continue').onclick = () => {
  if (mode === 'campaign') show('campaign');
  else if (mode === 'tutorial' && afterTutor) withLoading(afterTutor);
  else show('menu');
};
$('end-retry').onclick = () => {
  if (mode === 'campaign') withLoading(() => startBattle(campaign.battleSetup(regionId), 'campaign', regionId));
  else if (mode === 'expedition') withLoading(startExpedition);
  else if (mode === 'idle') { $('idle-shop').classList.add('hidden'); withLoading(startIdle); }
  else if (mode === 'tutorial') withLoading(() => startTutorial(afterTutor));
  else withLoading(startSkirmish);
};

// ---------- expedition (zoom-out roguelite) ----------
let expedition = null;

function startExpedition() {
  track('play-conquest');
  expedition = new Expedition(Math.floor(Math.random() * 1e9));
  expedition.save();
  startBattle(expedition.setup(), 'expedition');
  flash(`🧭 Stage 1: ${expedition.current.name}`);
}
// a saved run (closed tab, reload, left during the perk card): its current stage starts over
function resumeExpedition(run) {
  track('conquest-resume');
  expedition = Expedition.load(run);
  startBattle(expedition.setup(), 'expedition');
  flash(`🧭 Stage ${expedition.stage + 1}: ${expedition.current.name}`);
}
// menu: conquest asks first when a run is saved on this device
function conquestEntry() {
  const run = Expedition.saved();
  if (!run || run.stage >= stages.length) { viaTutor(startExpedition)(); return; }
  const pts = (run.scores ?? []).reduce((v, s) => v + s.total, 0);
  $('resume-text').textContent = `Your run is saved at stage ${run.stage + 1}/${stages.length} (${stages[run.stage].name})`
    + ` with ${run.perks?.length ?? 0} perk${run.perks?.length === 1 ? '' : 's'} and ${pts.toLocaleString()} points. That stage starts over.`;
  $('resume').classList.remove('hidden');
  $('resume-go').onclick = () => { $('resume').classList.add('hidden'); withLoading(() => resumeExpedition(run)); };
  $('resume-new').onclick = () => { $('resume').classList.add('hidden'); Expedition.clearSave(); viaTutor(startExpedition)(); };
}

// stage over: run lost / world won / collapse into the next capital and pick a perk
function endStage(won) {
  $('end-perks').innerHTML = '';
  track(`conquest-stage-${expedition.stage + 1}-${won ? 'won' : 'lost'}`);
  const last = expedition.stage === stages.length - 1;
  const gain = expedition.record({ won, stars: won ? starsOf(battle).filter(Boolean).length : 0, secs: battle.time / rules.timeScale, killed: battle.stats.killed });
  if (!won || last) {
    Expedition.clearSave();   // run over
    if (won) expedition.collapse(battle);
    const reached = won ? stages.length : expedition.stage + 1;
    const record = expedition.saveBest(reached);
    $('end-title').textContent = won ? 'The world is yours!' : 'Conquest over';
    const total = expedition.time + (won ? 0 : battle.time), saved = expedition.saveRun(reached, won, total / rules.timeScale);
    $('end-stats').innerHTML = `<p class="next-up">Reached stage ${reached} · total time ${fmtTime(total)}${record ? ' · 🏆 new best' : ''}</p>`
      + scoreHtml(gain, saved) + statsHtml(battle);
    $('end-retry').textContent = '▶ New conquest';
    $('end-retry').classList.remove('hidden');
    $('end-continue').textContent = 'Withdraw';
    withdrawLook();
    $('end-continue').classList.remove('hidden');
    showEnd(won, won ? battle : null);
    setTrack(won ? 'victory' : 'defeat');
    return;
  }
  const from = expedition.current, sum = expedition.collapse(battle), b = sum.bonus, pc = (v) => `+${Math.round(v * 100)}%`;
  const share = (k, label, eff) => (k ? `<li>${label}: ${k}/${sum.segments} → ${eff}</li>` : '');
  $('end-title').textContent = `${from.name} conquered!`;
  $('end-stats').innerHTML = statsHtml(battle) + `<div class="carry-box">Your ${sum.segments} tiles become one capital with <b>${sum.troops.toLocaleString()}</b> people.
    <ul class="carry">
      ${share(sum.farms, '🌾 Farms', pc(b.growth) + ' growth')}${share(sum.hosp, '➕ Hospitals', pc(b.hosp) + ' neighbour growth')}
      ${share(sum.labs, '🔬 Labs', pc(b.lab) + ' growth everywhere')}${share(sum.forts, '🛡️ Forts', pc(b.def) + ' defense')}
      ${share(sum.barracks, '⚔️ Barracks', pc(b.atk) + ' attack')}
    </ul></div>${scoreHtml(gain)}<p class="next-up">Next: ${expedition.current.name} · pick a perk</p>`;
  for (const p of expedition.choices()) {
    const btn = document.createElement('button');
    btn.className = 'perk';
    btn.innerHTML = `<span class="ico">${p.icon}</span><span><b>${p.name}</b><br><small>${p.desc}</small></span>`;
    btn.onclick = () => {
      if ($('end-perks').classList.contains('chosen')) return;   // one pick only
      expedition.perks.push(p.id);
      sfx.perk();
      $('end-perks').classList.add('chosen');
      for (const b of $('end-perks').children) b.classList.add(b === btn ? 'picked' : 'dropped');
      // sparks fly out of the picked card in a ring
      for (let i = 0; i < 16; i++) {
        const sp = document.createElement('i');
        sp.className = 'perk-spark';
        sp.style.setProperty('--a', `${(i / 16) * 360 + Math.random() * 12}deg`);
        sp.style.setProperty('--d', `${70 + Math.random() * 50}px`);
        btn.appendChild(sp);
      }
      setTimeout(() => { $('end').classList.add('hidden'); $('end-perks').classList.remove('chosen'); zoomOut(); }, 750);
    };
    $('end-perks').appendChild(btn);
  }
  $('end-retry').classList.add('hidden');
  $('end-continue').classList.add('hidden');
  showEnd(true, battle);
  setTrack('victory');
  preloadMap(expedition.setup());
}

// zoom-out: the old map shrinks into the new capital while the bigger map fades in around it
// expedition stage change, told without words in three steps:
// 1. shrink: only the won island (a snapshot) is left over the fog and shrinks smoothly to the size
//    and place of the new capital tile (the capital has the old island's outline)
// 2. glow: the little island pulses gold: it has become one tile
// 3. reveal: the new map grows outward from that tile in a widening circle, and the little island
//    fades into the capital tile underneath
const zoomSteps = { hold: 0.5, shrink: 2.2, glow: 0.7, reveal: 1.8 };   // seconds
// next = the stage to zoom out to: conquest by default, idle passes its own setup / save
function zoomOut(next = { save: () => expedition.save(), setup: () => expedition.setup(), mode: 'expedition' }) {
  const wrap = bv.canvas.parentElement, old = bv.canvas;
  // the player may be zoomed in / panned (pinch, drag) or mid-gesture: put the camera back to the
  // whole map first, so the snapshot and the new map line up. the render boost stays as it is (the
  // snapshot doesn't need a rebuild) and is locked until the new map's camera has glided in
  pointers.clear(); pinch = gesture = null;
  boostLock = true;
  setCam(1, 0, 0);
  clearTimeout(boostTimer);
  // old island: bounding box of its tiles, in canvas css px
  const om = bv.map, g = om.grid;
  let x0 = g, y0 = g, x1 = 0, y1 = 0;
  for (let c = 0; c < g * g; c++) {
    if (om.ids[c] < 0) continue;
    const x = c % g, y = Math.floor(c / g);
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const oc = { x: bv.sx((x0 + x1 + 1) / 2), y: bv.sy((y0 + y1 + 1) / 2), w: (x1 - x0 + 1) * bv.scale };
  // redraw the old map clean (no selection, drag arrow or banner) and keep a snapshot of it
  // (ground only: no cloud banks, so a frozen picture of the fog doesn't shrink along with it)
  selected = -1; drag = null; goFlash = 0; wheelOn = false;
  bv.groundOnly = true;
  drawBattle();
  bv.groundOnly = false;
  const snap = document.createElement('canvas');
  snap.width = old.width; snap.height = old.height;
  snap.getContext('2d').drawImage(old, 0, 0);
  // layout px (offset*/client*): unaffected by the page rotation on phones and the camera
  const so = { x: old.offsetLeft, y: old.offsetTop };   // snapshot's place in the wrap
  Object.assign(snap.style, { position: 'absolute', left: so.x + 'px', top: so.y + 'px', width: old.clientWidth + 'px', height: old.clientHeight + 'px', transformOrigin: '0 0' });
  snap.className = 'zoom-snap';
  wrap.appendChild(snap);
  old.style.opacity = '0';
  paused = true;
  const w0 = performance.now();
  // the snapshot goes on screen first; the heavy part (new battle, map view, first draw of every
  // layer, ~0.5-1 s on big maps) runs behind it and counts as the hold, instead of adding to it
  requestAnimationFrame(() => setTimeout(() => {
    next.save();   // the new stage is where a reload picks up
    const setup = next.setup();
    // the new map renders straight away at the resolution of the zoom its camera glides to, so its
    // layers are built once (not again when the glide ends)
    bv.boost = boostFor(1 / mapScale({ detail: setup.detail }));
    startBattle(setup, next.mode);
    paused = true;
    old.style.opacity = '0';
    drawBattle();
    const capId = battle.factions[0].capitalSeg, nr = { width: old.clientWidth, height: old.clientHeight }, no = { x: old.offsetLeft, y: old.offsetTop };
    const box = bv.boxes[capId] ?? [0, 0, g - 1, g - 1];
    const cc = { x: bv.sx((box[0] + box[2] + 1) / 2), y: bv.sy((box[1] + box[3] + 1) / 2), w: (box[2] - box[0] + 1) * bv.scale };
    const ratio = Math.min(1, cc.w / Math.max(1, oc.w));   // old island -> capital tile size
    const from = { x: so.x + oc.x, y: so.y + oc.y }, to = { x: no.x + cc.x, y: no.y + cc.y };   // island centre on screen
    const farthest = Math.hypot(Math.max(cc.x, nr.width - cc.x), Math.max(cc.y, nr.height - cc.y));   // reveal radius at the end
    const { hold, shrink, glow, reveal } = zoomSteps, total = hold + shrink + glow + reveal;
    const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
    const phase = (t, a, d) => Math.min(1, Math.max(0, (t - a) / d));
    const t0 = performance.now() - Math.min(hold * 1000, performance.now() - w0);   // work done = hold used up
    const tick = (now) => {
      const t = (now - t0) / 1000;
      // 1. shrink (scale falls off exponentially, so it reads as a steady pull-back)
      const k = ease(phase(t, hold, shrink)), s = ratio ** k;
      const px = from.x + (to.x - from.x) * k, py = from.y + (to.y - from.y) * k;
      snap.style.transform = `translate(${px - so.x - s * oc.x}px, ${py - so.y - s * oc.y}px) scale(${s})`;
      // the fog behind recedes too, slower than the island (parallax: we pull back through the
      // clouds), drifting a little, and settles at its normal size as the shrink ends
      const fs = 720 * (s / ratio) ** 0.35, drift = 40 * Math.sin(Math.PI * Math.min(1, t / total));   // back to 0 at the end
      wrap.style.backgroundSize = `${fs}px ${fs}px, auto`;
      wrap.style.backgroundPosition = `calc(50% + ${drift}px) calc(50% + ${drift * 0.6}px), 0 0`;
      wrap.style.setProperty('--fog-zoom', fs / 720);   // the twirling fog layers shrink alike
      // 2. glow: a gold pulse around the little island
      const gk = phase(t, hold + shrink, glow), pulse = Math.sin(gk * Math.PI);
      snap.style.filter = pulse > 0.01 ? `drop-shadow(0 0 ${2 + 10 * pulse}px rgba(255, 210, 90, ${0.9 * pulse}))` : '';
      // 3. reveal: the new map in a growing soft-edged circle around the capital; the island fades
      const rk = ease(phase(t, hold + shrink + glow * 0.5, reveal)), rad = 6 + rk * (farthest + 60);
      const mask = `radial-gradient(circle at ${cc.x}px ${cc.y}px, #000 ${Math.max(0, rad - 50)}px, transparent ${rad}px)`;
      old.style.opacity = rk > 0 ? '1' : '0';
      old.style.webkitMaskImage = old.style.maskImage = rk >= 1 ? '' : mask;
      snap.style.opacity = String(1 - phase(t, hold + shrink + glow * 0.6, reveal * 0.5));
      if (t < total) { requestAnimationFrame(tick); return; }
      snap.remove();
      old.style.opacity = old.style.webkitMaskImage = old.style.maskImage = '';
      wrap.style.backgroundSize = '720px 720px, auto';   // as MapView.setMap sets them
      wrap.style.backgroundPosition = 'center, 0 0';
      wrap.style.removeProperty('--fog-zoom');
      paused = false;
      setSpeed(speed);
      boostLock = false;
      focusHome(1 / mapScale(battle.map));
    };
    requestAnimationFrame(tick);
  }, 0));
}

// ---------- idle mode (js/idle.js): endless zoom-out, Fog from defeated foglets buys upgrades ----------
let idle = null, idleKilled = 0, idleSaveT = 0;
const idleMilestones = new Set([2, 3, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200]);   // analytics: stage reached

// menu / new run. a run saved mid-way (closed tab) picks up at the start of its stage
function startIdle() {
  track('play-idle');
  idle = idle ?? Idle.load();
  if (idle.stage > 1) flash(`🌫️ Stage ${idle.stage}`, 1800);
  startBattle(idle.setup(), 'idle');
  idleIntro();
}

// boss / other player's army: say so when the stage starts
function idleIntro() {
  const f = battle.factions.find((x) => x.boss || x.ghost);
  if (f?.boss) flash('👑 Boss stage: one rival is much stronger · stage bonus x3', 2600);
  else if (f?.ghost) flash(`👤 ${f.name}'s army (sample profile) · Fog x2 this stage`, 2600);
}

// every frame of a running idle battle: Fog for newly defeated foglets (fights and arrows) and
// for tiles held (fog wells), a save every 5 s
function idleTick(dt) {
  const k = battle.stats.killed;
  if (k > idleKilled) { idle.earn(idle.fogsFor(k - idleKilled)); idleKilled = k; }
  if (dt > 0 && idle.lvl('wells')) idle.earn(idle.wellFogs(battle.segs.filter((s) => s.owner === 0).length, dt * rules.timeScale));
  idleSaveT -= dt;
  if (idleSaveT <= 0) { idle.save(); idleSaveT = 5; }
}

// stage over: a win zooms straight out to the next stage; a loss ends the run (Fog, Mist, upgrades kept)
function endIdleStage(won) {
  idleTick(0);
  const secs = battle.time / rules.timeScale;
  if (won) {
    const { bonus, mist } = idle.win(secs), stamp = islandShape(battle);
    if (idleMilestones.has(idle.stage)) track(`idle-stage-${idle.stage}`);
    if (mist) track(`idle-boss-${idle.stage - 1}`);
    idle.save();
    const why = battle.closedIn ? '🌫️ The fog closed in: your bigger army takes it · ' : '';
    flash(mist ? `👑 Boss down! +${mist} 💠 Mist · +${fmtBig(bonus)} 🌫️ Fog` : `${why}🏆 Stage ${idle.stage - 1} cleared · +${fmtBig(bonus)} 🌫️`, mist || why ? 3200 : 2200);
    sfx.perk();
    fogFlow($('toast'), $('idle-shop-btn'), 10, mist ? 4 : 0);
    setTimeout(() => {
      if (mode !== 'idle' || screen !== 'battle' || battle.state !== 'won') return;   // left meanwhile
      zoomOut({ save: () => idle.save(), setup: () => idle.setup(stamp), mode: 'idle' });
      setTimeout(idleIntro, 5200);   // after the zoom-out
    }, 1000);
    return;
  }
  const prevBest = idle.best, run = idle.endRun(secs);
  idle.save();
  trackIdleRun(run);
  $('end-title').textContent = 'Run over';
  $('end-stats').innerHTML = (battle.closedIn ? '<p class="next-up">🌫️ The fog closed in: the bigger army took the island</p>' : '')
    + `<p class="next-up">Reached stage <b>${run.reached}</b>${run.reached > prevBest ? ' · 🏆 new best' : ` · best ${run.best}`}`
    + ` · ${fmtTime(run.secs * rules.timeScale)}</p><div class="score-box"><div class="score-total">🌫️ <b>${fmtBig(run.fogs)}</b> Fog this run · <b>${fmtBig(idle.fogs)}</b> Fog`
    + `${idle.mistTotal ? ` · <b>${idle.mist}</b> 💠 Mist` : ''} to spend</div></div>`
    + statsHtml(battle);
  $('end-perks').innerHTML = '<button id="end-shop" class="mode blue big-btn">⬆️ Spend Fog</button>';
  $('end-shop').onclick = openShop;
  $('end-retry').textContent = '▶ New run';
  $('end-retry').classList.remove('hidden');
  $('end-continue').textContent = 'Menu';
  $('end-continue').classList.remove('hidden');
  withdrawLook();
  showEnd(false, null);
  setTrack('defeat');
}

// analytics for an ended run: how far (stage buckets) and how long (minute buckets)
function trackIdleRun(run) {
  const stage = [1, 2, 3, 5, 10, 15, 20, 30, 50, 100].filter((s) => run.reached >= s).pop();
  const mins = [0, 1, 3, 5, 10, 20, 30, 60].filter((m) => run.secs / 60 >= m).pop();
  track(`idle-run-stage-${stage}plus`);
  track(`idle-run-${mins}min-plus`);
}

// upgrade tree (shop): branches as rows, deeper upgrades to the right. opened at any time (the battle
// keeps running), purchases apply at once. the tree sits in the battle's own fog: locked upgrades are
// hidden under drifting clouds until their requirements are met. tap a node for its card below
let shopKey = '', shopSel = 'atk';
function openShop() {
  // fog sky behind the tree: the current battle's cloud texture and fog colour
  const t = bv?.theme ?? themes.summer;
  $('shop-tree').style.setProperty('--fog', `url(${cloudTexture(t)})`);
  $('shop-tree').style.setProperty('--fog-bg', `rgb(${t.fogB})`);
  shopKey = '';
  $('idle-shop').classList.remove('hidden');
  renderShop();
}
function renderShop() {
  const key = upgrades.map((u) => `${idle.lvl(u.id)}${idle.canBuy(u.id) ? 1 : 0}`).join('') + idle.stage + shopSel + idle.best;
  $('shop-fogs').textContent = `🌫️ ${fmtBig(idle.fogs)} Fog` + (idle.mistTotal ? ` · 💠 ${idle.mist} Mist` : '');
  if (key === shopKey) return;
  shopKey = key;
  const tree = $('shop-tree');
  let h = '<svg class="shop-links"></svg>';
  branches.forEach((br, row) => {
    h += `<div class="br-label" style="grid-row:${row + 1}"><span>${br.icon}</span>${br.name}</div>`;
    for (const u of upgrades.filter((x) => x.branch === br.id)) {
      const l = idle.lvl(u.id), locked = idle.locked(u.id), maxed = idle.maxed(u.id);
      const cls = ['node', u.cur === 'mist' && 'mist', locked && 'veiled', !locked && idle.canBuy(u.id) && 'buyable', l > 0 && 'owned', maxed && 'maxed', u.id === shopSel && 'sel'].filter(Boolean).join(' ');
      const lv = u.max ? `${l}/${u.max}` : `${l}`;
      h += `<button class="${cls}" data-id="${u.id}" style="grid-row:${row + 1};grid-column:${u.col + 2}" title="${u.name}">`
        + `<span class="n-ico">${u.icon}</span><span class="n-lv">${maxed ? '★' : lv}</span>`
        + (locked ? '<span class="n-fog">🔒</span>' : maxed ? '' : `<span class="n-cost">${u.cur === 'mist' ? '💠' : ''}${fmtBig(idle.cost(u.id))}</span>`) + '</button>';
    }
  });
  tree.innerHTML = h;
  for (const b of tree.querySelectorAll('.node')) b.onclick = () => { shopSel = b.dataset.id; sfx.click(); renderShop(); };
  renderShopDetail();
  drawShopLinks();
}
// connector lines: requirement -> upgrade, bright when met, faint dashes while still unmet.
// positions come from the layout (offsetLeft/Top: unaffected by the css page rotation on phones)
function drawShopLinks() {
  const tree = $('shop-tree'), svg = tree.querySelector('.shop-links');
  if (!svg || $('idle-shop').classList.contains('hidden')) return;
  const at = (id) => { const n = tree.querySelector(`.node[data-id="${id}"]`); return [n.offsetLeft + n.offsetWidth / 2, n.offsetTop + n.offsetHeight / 2]; };
  svg.setAttribute('width', tree.scrollWidth);
  svg.setAttribute('height', tree.scrollHeight);
  let h = '';
  for (const u of upgrades) for (const [n, l] of u.needs ?? []) {
    const [x1, y1] = at(n), [x2, y2] = at(u.id), mx = (x1 + x2) / 2;
    h += `<path class="${idle.lvl(n) >= l ? 'met' : ''}" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`;
  }
  svg.innerHTML = h;
}
// card under the tree: what the selected upgrade does now and next, what it needs, buy button
function renderShopDetail() {
  // numbers at the running stage's scale (from the menu: the stage the next run starts at)
  const u = upgradeById[shopSel], l = idle.lvl(u.id), sc = mode === 'idle' && screen === 'battle' ? numScale : displayScale(idle.stage), maxed = idle.maxed(u.id);
  const now = l ? u.text(u.value(l), sc, idle) : '', next = u.text(u.value(l + 1), sc, idle);
  const needs = (u.needs ?? []).map(([n, lv]) => `<span class="${idle.lvl(n) >= lv ? 'ok' : ''}">${upgradeById[n].icon} ${upgradeById[n].name} ${lv}</span>`).join('');
  const what = maxed ? `${now} · <b>max</b>` : l ? `${now} → <b>${next}</b>` : `<b>${next}</b>`;
  const btn = maxed ? '<button class="up-buy" disabled>MAX</button>'
    : `<button class="up-buy${u.cur === 'mist' ? ' mist' : ''}" id="shop-buy" ${idle.canBuy(u.id) ? '' : 'disabled'}>${idle.locked(u.id) ? '🔒' : u.cur === 'mist' ? '💠' : '🌫️'} ${fmtBig(idle.cost(u.id))}</button>`;
  $('shop-detail').innerHTML = `<span class="d-ico">${u.icon}</span><span class="d-txt"><b>${u.name}</b> <em>Lv ${u.max ? `${l}/${u.max}` : l}</em>`
    + `<small>${what}</small>${needs ? `<small class="d-needs">Needs: ${needs}</small>` : ''}</span>${btn}`;
  if ($('shop-buy')) $('shop-buy').onclick = () => buyUpgrade(u.id);
}

function buyUpgrade(id) {
  if (!idle.buy(id)) return;
  sfx.build();
  if (idle.lvl(id) === 1) track(`idle-buy-${id}`);
  // live: the running battle gets the new modifiers straight away (auto-play reads the levels itself)
  if (mode === 'idle' && battle && screen === 'battle') {
    battle.factions[0].mods = idle.mods();
    battle.updateGrowth();
  }
  if (id === 'auto' && idle.lvl('auto') === 1) flash('🤖 Auto-attack bought: full tiles attack on their own (🤖 button toggles it)', 3000);
  // upgrades this purchase opened: their fog clears with a pop
  const opened = upgrades.filter((u) => (u.needs ?? []).some(([n]) => n === id) && !idle.locked(u.id) && !idle.lvl(u.id)).map((u) => u.id);
  if (id === 'horn' && idle.lvl('horn') === 1) flash('📯 Fog horn: it gathers Fog all the time, collect it in the menu', 3200);
  idle.save();
  syncIdleButtons();
  renderShop();
  renderHub();
  for (const o of opened) $('shop-tree').querySelector(`.node[data-id="${o}"]`)?.classList.add('reveal');
}

// hud: fog counter, the shop button glows when something is affordable, auto-battle toggle
function updateIdleHud() {
  $('idle-fogs').textContent = `🌫️ ${fmtBig(idle.fogs)}`;
  $('idle-mist').textContent = `💠 ${idle.mist}`;
  $('idle-mist').classList.toggle('hidden', !idle.mistTotal);
  $('idle-shop-btn').classList.toggle('ready', upgrades.some((u) => idle.canBuy(u.id)));
  if (!$('idle-shop').classList.contains('hidden')) renderShop();
}
function syncIdleButtons() {
  if (!idle) return;
  $('idle-auto').classList.toggle('off', !idle.autoOn);
  $('idle-auto').classList.toggle('locked', idle.lvl('auto') === 0);
  $('idle-auto').title = idle.lvl('auto') ? `Auto-battle ${idle.autoOn ? 'on' : 'off'}` : 'Auto-battle: buy Auto-attack in the upgrades';
}
$('idle-shop-btn').onclick = openShop;
$('shop-close').onclick = () => $('idle-shop').classList.add('hidden');
$('idle-shop').addEventListener('click', (e) => { if (e.target === e.currentTarget) $('shop-close').click(); });
addEventListener('resize', () => requestAnimationFrame(drawShopLinks));
$('idle-auto').onclick = () => {
  if (!idle.lvl('auto')) { flash('🤖 Buy Auto-attack in ⬆️ upgrades first', 2200); return; }
  idle.auto = !idle.auto;
  idle.save();
  syncIdleButtons();
  flash(idle.autoOn ? '🤖 Auto-battle on' : '🖐️ You have control', 1400);
};

// ---------- idle hub on the menu: Fog / Mist bank, upgrade tree button, fog horn ----------
// the horn gathers Fog in real time (played or away, up to its cap); tap it to blow: the Fog flies
// out as puffs into the upgrade button and the bank counts up
let hubTimer = 0, bankShown = null;
function renderHub() {
  const id = idle ?? Idle.load();
  const seen = id.runs > 0 || id.total > 0;   // shown once idle has been played
  $('idle-hub').classList.toggle('hidden', !seen);
  if (!seen) return;
  $('hub-horn').classList.toggle('hidden', !id.lvl('horn'));
  $('hub-mist').classList.toggle('hidden', !id.mistTotal);
  $('hub-mist').textContent = `💠 ${id.mist}`;
  if (bankShown === null || !$('hub-fog').dataset.counting) { bankShown = id.fogs; $('hub-fog').textContent = `🌫️ ${fmtBig(id.fogs)}`; }
  tickHub();
}
// live horn level (the menu calls this 4 times a second)
function tickHub() {
  const id = idle ?? (idle = Idle.load());
  if ($('idle-hub').classList.contains('hidden') || !id.lvl('horn')) return;
  const a = id.hornAmount(), k = id.hornCap ? a / id.hornCap : 0;
  $('hub-horn-amt').textContent = fmtBig(a);
  $('horn-fill').style.width = `${Math.round(k * 100)}%`;
  $('hub-horn').classList.toggle('has', a >= 1);
  $('hub-horn').classList.toggle('full', k >= 0.999);
  $('hub-horn').title = `Fog horn: ${fmtBig(id.hornRate)} Fog/s, holds ${fmtBig(id.hornCap)} (${Math.round(k * 100)}% full). Tap to collect`;
}
$('hub-horn').onclick = () => {
  idle = idle ?? Idle.load();
  const before = idle.fogs, got = idle.collectHorn();
  if (got < 1) { flash('📯 The horn is still gathering Fog', 1600); return; }
  idle.save();
  track('idle-horn-collect');
  sfx.horn();
  $('hub-horn').classList.remove('blow'); void $('hub-horn').offsetWidth; $('hub-horn').classList.add('blow');
  flash(`📯 +${fmtBig(got)} 🌫️ Fog`, 1800);
  fogFlow($('hub-horn'), $('hub-shop'), Math.min(18, 6 + Math.round(Math.log10(got + 1) * 2)), 0, () => countBank(before, idle.fogs));
  tickHub();
};
$('hub-shop').onclick = () => { idle = idle ?? Idle.load(); openShop(); };
// bank count-up after the puffs land
function countBank(from, to) {
  const el = $('hub-fog'), t0 = performance.now();
  el.dataset.counting = '1';
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 700), v = from + (to - from) * (1 - (1 - k) ** 3);
    el.textContent = `🌫️ ${fmtBig(v)}`;
    if (k < 1) requestAnimationFrame(step); else { delete el.dataset.counting; bankShown = to; }
  };
  requestAnimationFrame(step);
}
// layout position of an element's centre in page (body) coordinates. offsets ignore transforms, so
// this stays right when phones turn the whole page by css
function layoutCenter(el) {
  let x = el.offsetWidth / 2, y = el.offsetHeight / 2;
  for (let e = el; e; e = e.offsetParent) { x += e.offsetLeft - (e.scrollLeft || 0); y += e.offsetTop - (e.scrollTop || 0); }
  return { x, y };
}
// fog flow: n soft fog puffs (and m Mist sparks) fly on curved paths from one element into another;
// the target gulps as each lands. done() runs when the last one arrives
function fogFlow(from, to, n, m = 0, done = null) {
  if (!from || !to || to.offsetParent === null) { done?.(); return; }
  const a = layoutCenter(from), b = layoutCenter(to), t0 = performance.now(), total = n + m;
  let left = total;
  for (let i = 0; i < total; i++) {
    const mist = i >= n, el = document.createElement('i');
    el.className = mist ? 'fog-puff mist' : 'fog-puff';
    document.body.appendChild(el);
    const delay = i * 55, dur = 750 + Math.random() * 300;
    const sx = a.x + (Math.random() - 0.5) * 40, sy = a.y + (Math.random() - 0.5) * 24;
    const cx = (sx + b.x) / 2 + (Math.random() - 0.5) * 160, cy = Math.min(sy, b.y) - 60 - Math.random() * 80;   // arc up and over
    const size = mist ? 14 : 18 + Math.random() * 16;
    const tick = (now) => {
      const k = Math.min(1, Math.max(0, (now - t0 - delay) / dur)), e = k * k * (3 - 2 * k), u = 1 - e;
      const x = u * u * sx + 2 * u * e * cx + e * e * b.x, y = u * u * sy + 2 * u * e * cy + e * e * b.y;
      const sc = (k < 0.15 ? k / 0.15 : 1) * (1 - 0.55 * e);
      el.style.cssText = `left:${x - size / 2}px;top:${y - size / 2}px;width:${size}px;height:${size}px;opacity:${k <= 0 ? 0 : 0.95 - 0.35 * e};transform:scale(${sc})`;
      if (k < 1) { requestAnimationFrame(tick); return; }
      el.remove();
      to.classList.remove('gulp'); void to.offsetWidth; to.classList.add('gulp');
      if (--left === 0) done?.();
    };
    requestAnimationFrame(tick);
  }
}

let flashTimer = 0;
function flash(msg, ms = 1200) {
  $('toast').textContent = msg;
  $('toast').classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => $('toast').classList.remove('show'), ms);
}

// game time shown as real minutes:seconds at speed x1 (the sim runs at rules.timeScale)
const fmtTime = (g) => { const t = g / rules.timeScale; return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };

// ---------- menu: live demo battle in the background ----------
// four bots fight on a decorative island behind the menu (attract mode); a new island when it ends
let demo = null, mv = null, demoAcc = 0, demoN = 0;
function newDemo() {
  const seed = 4242 + demoN * 977, r = rng(seed), types = Object.keys(personalities);
  const map = generateMap({ seed, cells: 18, grid: rules.grid, shape: 'random', obstacles: true });
  demo = new Battle(map, {
    seed, neutral: [0.1, 0.25],
    factions: dress([0, 1, 2, 3].map((color) => ({ ai: true, color, think: 1.4, personality: personalities[types[Math.floor(r() * types.length)]] })), seed, false),
  });
  // a few ready-made buildings so the island looks lived in
  const blds = Object.keys(buildings);
  demo.segs.forEach((s, i) => { if (r() < 0.3 && !s.capital) s.building = blds[i % blds.length]; });
  const theme = themeNames[demoN % themeNames.length];
  if (!mv) mv = new MapView($('menu-canvas'), map, theme); else mv.setMap(map, theme);
  demoN++;
}
// menu mascots: your band on the left (commander profile colour + troop kit), a rival band on the
// right (red, or blue if you are red) in the three other kits
const bands = [makeBand($('foglets-l'), factionColors[0], ['soldier', 'soldier', 'soldier'], 1, 0), makeBand($('foglets-r'), factionColors[1], ['viking', 'knight', 'archer'], -1, 1)];
window.__bands = bands;   // tests read the hop state
function syncBands() {
  const mine = profile.troops, others = Object.keys(troopStyles).filter((k) => k !== mine);
  dressBand(bands[0], factionColors[profile.color], [mine, mine, mine]);
  dressBand(bands[1], factionColors[profile.color === 1 ? 0 : 1], others.slice(0, 3));
}
syncBands();
function drawMenu(dt) {
  for (const b of bands) drawBand(b, performance.now() / 1000);
  hubTimer -= dt;
  if (hubTimer <= 0) { hubTimer = 0.25; tickHub(); }
  if (!demo || demo.state !== 'running' || demo.time > 240) newDemo();
  demoAcc += dt * rules.timeScale;
  while (demoAcc >= rules.step) { demo.step(rules.step); demoAcc -= rules.step; }
  demo.events.length = 0;   // demo is silent
  mv.paint((id) => {
    const s = demo.segs[id];
    const building = s.building ?? (s.relic ? 'relic' : s.home ? 'home' : null);
    return { color: s.owner < 0 ? null : colors[demo.factions[s.owner].color], fill: s.owner < 0 ? 0 : 0.16, building, huts: s.owner < 0 && !building, skin: s.owner < 0 ? null : demo.factions[s.owner].skin?.buildings };
  });
  const mctx = mv.drawBase();
  mv.drawAmbient(mctx, performance.now() / 1000);
  drawUnits(mctx, mv, demo, demoAcc, false);
}

// menu badges: campaign progress, best expedition, quick battle wins
function renderMenuStats() {
  const best = Expedition.best();
  $('m-regions').textContent = `🏳️ ${campaign.owned.size}/${campaign.regions.length}`;
  $('m-campaign').textContent = `${campaign.owned.size}/${campaign.regions.length} regions conquered`;
  const run = Expedition.saved();
  $('m-expedition').textContent = run ? `Continue: stage ${run.stage + 1}/5` : best ? `Best: stage ${best.stage}/5` : 'Valley → World roguelite';
  const id = idle ?? Idle.load();
  renderHub();
  $('m-idle').textContent = id.stage > 1 ? `Continue: stage ${id.stage} · 🌫️ ${fmtBig(id.fogs)}` : id.best ? `Best: stage ${id.best} · 🌫️ ${fmtBig(id.fogs)}` : 'Endless zoom-out · upgrades';
}
const wins_key = 'frontlines.quickwins';
function quickWins() { try { return +localStorage.getItem(wins_key) || 0; } catch { return 0; } }
function addQuickWin() { try { localStorage.setItem(wins_key, quickWins() + 1); } catch { /* storage blocked */ } }

// ---------- offline play + install ----------
// service worker (sw.js, one cache per build): the game starts without internet once it has been
// opened online. off on localhost (development would get stale files) unless the url has ?sw
function initOffline() {
  const local = /^(localhost|127\.)/.test(location.hostname);
  // the desktop app ships every file, so it never needs the offline cache
  if (desktop || !('serviceWorker' in navigator) || (local && !/[?&]sw(=|&|$)/.test(location.search))) return;
  const v = new URL(import.meta.url).search;   // same ?v=N build stamp as this module
  navigator.serviceWorker.register('sw.js' + v).then(() => navigator.serviceWorker.ready).then((reg) => {
    // everything this page loaded (modules, css, fonts, icons), the map worker and the sound
    // effects: cached now, so a first visit is enough for offline play
    const own = (u) => u.startsWith(location.origin) || /\/\/fonts\.(googleapis|gstatic)\.com\//.test(u);
    const urls = performance.getEntriesByType('resource').map((e) => e.name).filter(own);
    urls.push(new URL('./mapworker.js' + v, import.meta.url).href, ...audioFiles().sfx);
    reg.active?.postMessage({ cache: [...new Set(urls)] });
  }).catch(() => { /* no offline play */ });
}

// install button (menu): chrome / android offer an install prompt, saved here until tapped;
// iphone safari has none, so the button explains share -> add to home screen. hidden when the
// game already runs as an installed app
let installEvt = null;
const installed = () => matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone === true;
const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('btn-install').classList.remove('hidden'); });
addEventListener('appinstalled', () => { installEvt = null; $('btn-install').classList.add('hidden'); track('app-installed'); });
if (ios && !installed()) $('btn-install').classList.remove('hidden');
$('btn-install').onclick = () => {
  if (installEvt) {
    track('install-prompt');
    installEvt.prompt();
    installEvt.userChoice.finally(() => { installEvt = null; $('btn-install').classList.add('hidden'); });
  } else if (ios) flash('📲 Tap Share ⬆️, then "Add to Home Screen"', 4000);
};

// ---------- menu, help, keyboard ----------
$('btn-campaign').onclick = () => show('campaign');
$('btn-skirmish').onclick = viaTutor(startSkirmish);
$('btn-expedition').onclick = conquestEntry;
$('btn-idle').onclick = viaTutor(startIdle);
$('btn-help').onclick = () => $('help').classList.remove('hidden');

// commander panel: colour swatches, troop and building style cards with live previews
function renderProfile() {
  const col = factionColors[profile.color];
  $('pf-colors').innerHTML = factionColors.map((c, i) => `<button class="pf-swatch ${i === profile.color ? 'on' : ''}" data-i="${i}" title="${colorNames[i]}" style="background:${c}"></button>`).join('');
  const cards = (box, list, cur, key) => {
    $(box).innerHTML = Object.entries(list).map(([id, name]) => `<button class="pf-card ${id === cur ? 'on' : ''}" data-id="${id}"><canvas width="192" height="112"></canvas>${name}</button>`).join('');
    for (const b of $(box).querySelectorAll('.pf-card')) b.onclick = () => { profile[key] = b.dataset.id; saveProfile(); renderProfile(); sfx.click(); };
  };
  cards('pf-troops', troopStyles, profile.troops, 'troops');
  cards('pf-buildings', buildingStyles, profile.buildings, 'buildings');
  // previews: a small squad per troop style, a house + tower per building style
  for (const b of $('pf-troops').querySelectorAll('.pf-card')) {
    const x = b.firstElementChild.getContext('2d'), u = unitSprite('soldier', col, 2.6, 2, b.dataset.id);
    x.scale(2, 2);   // canvas is 2x its css size
    for (const [px, py] of [[26, 24], [48, 21], [70, 24], [37, 36], [59, 36]]) x.drawImage(u.c, px - u.w / 2, py - u.h / 2, u.w, u.h);
  }
  for (const b of $('pf-buildings').querySelectorAll('.pf-card')) {
    const x = b.firstElementChild.getContext('2d');
    x.scale(2, 2);
    previewBuildings(x, 96, 56, b.dataset.id, hexToRgb(col));
  }
  for (const s of $('pf-colors').querySelectorAll('.pf-swatch')) s.onclick = () => { profile.color = +s.dataset.i; saveProfile(); renderProfile(); sfx.click(); };
}
$('btn-profile').onclick = () => { renderProfile(); $('profile').classList.remove('hidden'); };
$('pf-done').onclick = () => $('profile').classList.add('hidden');
$('help-close').onclick = () => $('help').classList.add('hidden');
// leaderboard: your best conquest runs
$('btn-board').onclick = () => { $('board-list').innerHTML = boardHtml(Expedition.runs()); $('board').classList.remove('hidden'); };
$('board-close').onclick = () => $('board').classList.add('hidden');
$('campaign-back').onclick = () => show('menu');
$('campaign-reset').onclick = () => {
  if (confirm('Reset campaign progress?')) { campaign.reset(); pickedRegion = -1; paintCampaign(); }
};
// testing aid: fill every tile you own to its cap (capital too)
// test buttons (🧪 fill, 🏆 win): hidden unless the url has ?test, or on localhost
if (!/[?&]test(=|&|$)/.test(location.search) && !/^(localhost|127\.)/.test(location.hostname)) for (const id of ['test-fill', 'test-win']) $(id).classList.add('hidden');
$('test-fill').onclick = () => {
  if (!battle) return;
  for (const s of battle.segs) if (s.owner === 0) s.troops = s.cap;
  flash('🧪 Your tiles are full');
};
// test: instant win. every bot tile (with its foglets) becomes yours and bot armies vanish; the
// next sim step sees no bots left and ends the battle as won (conquest goes on to the perk card)
$('test-win').onclick = () => {
  if (!battle || battle.state !== 'running') return;
  for (const s of battle.segs) if (s.owner > 0) s.owner = 0;
  battle.armies = battle.armies.filter((a) => a.owner === 0);
  for (const f of battle.factions) if (f.id > 0) f.reserve = 0;
  battle.version++;
  battle.updateGrowth();
  battle.step(rules.step);   // ends it now, even while paused
};
// leave: a finished battle goes straight back; a running one asks first (and pauses meanwhile)
let pausedBeforeLeave = false;
const leaveBattle = () => { $('leave').classList.add('hidden'); show(mode === 'campaign' ? 'campaign' : 'menu'); };
// withdrawing from a running conquest battle ends the run (as the dialog says)
// idle: withdrawing ends the run (Fog, Mist and upgrades are kept)
const withdraw = () => {
  if (mode === 'expedition' && battle.state === 'running') Expedition.clearSave();
  if (mode === 'idle' && battle.state === 'running') { idleTick(0); trackIdleRun(idle.endRun(battle.time / rules.timeScale)); idle.save(); }
  $('idle-shop').classList.add('hidden');
  leaveBattle();
};
$('battle-quit').onclick = () => {
  if (battle.state !== 'running') { $('idle-shop').classList.add('hidden'); leaveBattle(); return; }
  $('leave-text').textContent = mode === 'expedition'
    ? 'Are you sure you want to withdraw? Your conquest will end and its progress will not be saved.'
    : mode === 'idle' ? `Withdraw? This run ends at stage ${idle.stage}. Your Fog, Mist and upgrades are kept.`
    : 'Are you sure you want to withdraw? Your progress in this battle will not be saved.';
  pausedBeforeLeave = paused;
  setSpeed(0);
  $('leave').classList.remove('hidden');
};
$('leave-go').onclick = withdraw;
$('leave-stay').onclick = () => { $('leave').classList.add('hidden'); if (!pausedBeforeLeave) setSpeed(speed); };
// submenus close on a tap outside their card (on the dimmed backdrop), same as their close button;
// leave = 'keep fighting'. end-of-battle and resume screens need a real choice, so they don't.
for (const [id, btn] of [['help', 'help-close'], ['board', 'board-close'], ['profile', 'pf-done'], ['leave', 'leave-stay'], ['settings', 'set-done']]) {
  $(id).addEventListener('click', (e) => { if (e.target === e.currentTarget) $(btn).click(); });
}
$('help-buildings').innerHTML = Object.values(buildings).map((b) => `<li>${b.icon} <b>${b.name}</b> (cost ${b.cost}): ${b.desc}</li>`).join('');

// cards that esc closes, each with the button that closes it (same as clicking it)
const escClose = { settings: 'set-done', 'idle-shop': 'shop-close', help: 'help-close', board: 'board-close', profile: 'pf-done', leave: 'leave-stay' };
const shown = (id) => !$(id).classList.contains('hidden');
addEventListener('keydown', (e) => {
  if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
  // esc: close the top card first, anywhere
  if (e.key === 'Escape') {
    const open = Object.keys(escClose).find(shown);
    if (open) { $(escClose[open]).click(); return; }
    // menu with nothing open: esc opens settings (pc games' usual pause/options key)
    if (screen === 'menu' && !document.documentElement.classList.contains('booting')) { openSettings(); return; }
  }
  if (screen !== 'battle') return;
  if (e.key === ' ') { setSpeed(paused ? speed : 0); e.preventDefault(); }
  if (['1', '2', '3', '4'].includes(e.key)) setPct(+e.key * 0.25);
  // esc in battle: deselect, or with nothing selected open the leave card (like the back button)
  if (e.key === 'Escape') { if (selected >= 0) selected = -1; else if (!shown('end')) $('battle-quit').click(); }
  // idle mode: u = upgrade tree (open/close), a = auto-battle on/off
  const k = e.key.toLowerCase();
  if (k === 'u' && shown('idle-shop-btn')) $(shown('idle-shop') ? 'shop-close' : 'idle-shop-btn').click();
  if (k === 'a' && shown('idle-auto')) $('idle-auto').click();
});
addEventListener('resize', () => { if (screen === 'battle' && bv) { bv.resize(); key = ''; } if (screen === 'campaign') cv.resize(), paintCampaign(); });

// ---------- battle effects: alert rings on attacked tiles, capture confetti ----------
// effects live in map coordinates (they follow pan / zoom) and are animated from their birth
// time, so they need no per-frame update
let fxs = [];
function celebrate(id) {
  // the tile lights up: warm glow, a light sweep across it, a gold rim, twinkling stars
  const now = performance.now(), pts = bv.troopSpots(id, 8);
  fxs.push({ kind: 'shine', id, born: now, life: 1.3 });
  for (let i = 0; i < 9 && pts.length; i++) {
    const [x, y] = pts[Math.floor(Math.random() * pts.length)];
    fxs.push({ kind: 'star', id, x, y, born: now + 120 + Math.random() * 520, life: 0.75, size: 0.5 + Math.random() * 0.6 });
  }
}
// four-point twinkle star
function star(ctx, x, y, r) {
  ctx.beginPath();
  ctx.moveTo(x, y - r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.quadraticCurveTo(x, y, x, y + r);
  ctx.quadraticCurveTo(x, y, x - r, y); ctx.quadraticCurveTo(x, y, x, y - r);
  ctx.fill();
}
function drawFx(ctx, fs) {
  const now = performance.now();
  fxs = fxs.filter((f) => now - f.born < (f.life ?? 1.2) * 1000 + 100);
  if (!fxs.length) return;
  ctx.save();
  for (const f of fxs) {
    const age = (now - f.born) / 1000;
    if (age < 0) continue;
    const s = battle.segs[f.id], x = bv.sx(s.x), y = bv.sy(s.y);
    if (f.kind === 'alert') {
      // two red rings shrinking onto the tile
      for (const d of [0, 0.35]) {
        const k = (age - d) / 0.7;
        if (k < 0 || k > 1) continue;
        ctx.globalAlpha = 0.9 * (1 - k);
        ctx.lineWidth = 3.5; ctx.strokeStyle = '#ff3b30';
        ctx.beginPath(); ctx.arc(x, y, fs * (2.8 - 1.4 * k), 0, Math.PI * 2); ctx.stroke();
      }
    } else if (f.kind === 'shine') {
      const k = Math.min(1, age / f.life), fade = (1 - k) ** 1.5, p = bv.segP[f.id], [x0, y0, x1, y1] = bv.boxes[f.id];
      ctx.save();
      bv.gridT(ctx);
      ctx.clip(p);
      ctx.globalCompositeOperation = 'lighter';
      // warm glow over the whole tile, quick rise then a slow fade
      ctx.globalAlpha = Math.min(1, age / 0.12) * fade;
      ctx.fillStyle = 'rgba(255, 206, 110, 0.42)';
      ctx.fill(p);
      // a band of light sweeping across, left to right
      const w = x1 - x0 + 1, c = x0 - w * 0.3 + w * 1.6 * Math.min(1, age / 0.8), bw = Math.max(8, w * 0.22);
      const g = ctx.createLinearGradient(c - bw, y0, c + bw, y0 + bw * 0.8);
      g.addColorStop(0, 'rgba(255, 248, 220, 0)'); g.addColorStop(0.5, 'rgba(255, 248, 220, 0.75)'); g.addColorStop(1, 'rgba(255, 248, 220, 0)');
      ctx.globalAlpha = 1 - Math.min(1, age / 0.9);
      ctx.fillStyle = g;
      ctx.fillRect(x0, y0, w, y1 - y0 + 1);
      // gold rim just inside the border
      ctx.globalAlpha = fade;
      ctx.lineJoin = 'round';
      ctx.lineWidth = (5 / bv.scale) * (1 - 0.5 * k);
      ctx.strokeStyle = 'rgba(255, 220, 130, 0.9)';
      ctx.stroke(p);
      ctx.restore();
    } else if (f.kind === 'star') {
      // twinkle: grows and shrinks while drifting up a little
      const k = age / f.life, r = fs * 0.55 * f.size * Math.sin(Math.PI * Math.min(1, k));
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(255, 236, 170, 0.95)';
      star(ctx, f.x, f.y - fs * 1.2 * k - fs * 0.6, r);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      star(ctx, f.x, f.y - fs * 1.2 * k - fs * 0.6, r * 0.45);
      ctx.globalCompositeOperation = 'source-over';
    }
  }
  ctx.restore();
}

// ---------- tutorial: a scripted battle on a fixed map ----------
// shown before the first quick battle / conquest (and from the help). each step tells the player
// one move; hold steps stop time until it's made (only that move is allowed), the 'time' step lets
// it run to show growth and the speed buttons. the rival bot sleeps until the last step.
const tutorKey = 'frontlines.tutorial';
let tutor = null, tutorWanted = false, afterTutor = null;   // tutor = { step, t, home, target, rival }
function tutorSeen() { try { return localStorage.getItem(tutorKey) === '1'; } catch { return false; } }
function markTutorSeen() { if (!tutorSeen()) track('tutorial-done'); try { localStorage.setItem(tutorKey, '1'); } catch { /* not saved */ } }

function startTutorial(next = null) {
  afterTutor = next;
  startBattle({
    seed: 20261103, cells: 9, shape: 'blob', neutral: [0.2, 0.3], relics: 0, theme: 'summer',
    factions: [{ ai: false, color: 0 }, { ai: true, color: 1, think: 1e9, personality: personalities.turtle }],
  }, 'tutorial');
  battle.factions[1].timer = 1e9;   // asleep: no first move either
  tutorWanted = true;
}
// menu: the first quick battle / conquest goes through the tutorial first
function viaTutor(start) { return () => withLoading(tutorSeen() ? start : () => startTutorial(start)); }

const tseg = (id) => battle.segs[id];
const pair = (from, to) => (f, t2) => f === from && t2 === to;
const tutorSteps = [
  { id: 'intro', hold: true, ok: 'Start', ring: () => [tutor.home],
    text: () => 'Welcome, commander! 🏰 This is your castle. Grey tiles are neutral; the other castle belongs to your rival.' },
  { id: 'attack', hold: true, finger: () => [tutor.home, tutor.target], allow: () => pair(tutor.home, tutor.target),
    enter() { tseg(tutor.home).troops = 40; tseg(tutor.target).troops = 8; },
    text: () => `👆 Drag from your castle to the glowing tile. ${Math.round(pct * 100)}% of your 40 foglets = ${Math.floor(40 * pct)} attack its 8 defenders.` },
  { id: 'capture', ring: () => [tutor.target],
    text: () => 'Your foglets march to the border and fight. The bigger number wins and keeps the difference.' },
  { id: 'build', hold: true, ring: () => [tutor.target],
    enter() { tseg(tutor.target).troops = battle.costOf(0, 'farm'); },
    text: () => `🌾 Your new tile has ${battle.costOf(0, 'farm')} foglets. A Farm costs ${battle.costOf(0, 'farm')} and adds +${Math.round(effects.farmGrowth * 100)}% growth to its tile. Tap the tile, then the glowing farm.` },
  { id: 'time', ok: 'Got it', okAfter: 3, pulse: ['speed', 'clock'],
    text: () => '⏱️ Time runs now: every tile grows foglets each second (watch the numbers). ❚❚ (top right) pauses, ▶ plays on.' },
  // zoom lesson: a pinch hint over the castle; the step ends when the camera actually zooms
  // (Next shows after 8 s, for anyone whose device can't pinch)
  { id: 'zoomin', hold: true, ok: 'Next', okAfter: 8, pinch: 1,
    text: () => '🔍 Zoom in: spread two fingers on the map (mouse: scroll up). Drag empty ground to look around.' },
  { id: 'zoomout', hold: true, ok: 'Next', okAfter: 8, pinch: -1,
    text: () => '🔭 Now zoom back out: pinch two fingers together (mouse: scroll down) to see the whole island.' },
  { id: 'route', hold: true, finger: () => [tutor.home, tutor.target], allow: () => pair(tutor.home, tutor.target),
    enter() { tseg(tutor.home).troops = Math.max(tseg(tutor.home).troops, 20); },
    text: () => '🔁 Drag from your castle to your farm tile. This sets a route: spare foglets keep flowing there.' },
  { id: 'goal', hold: true, ok: "Let's go", ring: () => [tutor.rival],
    text: () => '🏆 Take every enemy tile to win. Your rival wakes up now. Good luck!' },
];

function startTutor() {
  // the tiles the script points at: your start, its weakest neutral neighbour, the rival's start
  const home = battle.segs.find((s) => s.owner === 0), rival = battle.segs.find((s) => s.owner === 1);
  const opts = home.adj.map(tseg).filter((s) => s.owner < 0).sort((x, y) => x.troops - y.troops);
  tutor = { step: -1, t: 0, home: home.id, target: (opts[0] ?? tseg(home.adj[0])).id, rival: rival?.id ?? -1 };
  nextTutor();
}
function tutorHold() { return !!tutor && !!tutorSteps[tutor.step].hold; }
// may the player send from -> to right now? (hold steps only allow the move they ask for)
function tutorAllows(from, to) {
  if (!tutor) return true;
  const st = tutorSteps[tutor.step];
  return st.allow ? st.allow()(from, to) : !st.hold;
}
function nextTutor() {
  tutor.step++; tutor.t = 0; tutor.advanceAt = 0;
  if (tutor.step >= tutorSteps.length) { endTutor(true); return; }
  const st = tutorSteps[tutor.step];
  st.enter?.();
  $('tutor-step').textContent = `TUTORIAL ${tutor.step + 1}/${tutorSteps.length} · ${st.hold ? '⏸ time stopped' : '▶ time running'}`;
  $('tutor-step').classList.toggle('run', !st.hold);
  $('tutor-text').textContent = st.text();
  $('tutor-ok').textContent = st.ok ?? 'Next';
  $('tutor-ok').classList.toggle('hidden', !st.ok || !!st.okAfter);
  for (const id of ['speed', 'clock']) $(id).classList.toggle('tutor-pulse', !!st.pulse?.includes(id));
  $('tutor').classList.remove('hidden');
  wheelFor = -2;   // re-render the build wheel (farm hint on / off)
  renderWheel();
}
function endTutor(done) {
  if (done) markTutorSeen();
  if (tutor && battle?.factions[1]) { battle.factions[1].think = 3; battle.factions[1].timer = 2; }   // the rival wakes up
  tutor = null;
  $('tutor').classList.add('hidden');
  for (const id of ['speed', 'clock']) $(id).classList.remove('tutor-pulse');
}
// player actions that finish a step: 'attack' (sent troops at the target), 'capture', 'build', 'route'
function tutorEvent(type) {
  if (!tutor || tutorSteps[tutor.step].id !== type) return;
  if (type === 'capture') tutor.advanceAt = tutor.t + 1.2;   // let the celebration play first
  else nextTutor();
}
function tutorTick(dt) {
  if (screen !== 'battle' || battle.state !== 'running') { endTutor(false); return; }
  const st = tutorSteps[tutor.step];
  tutor.t += dt;
  if (tutor.advanceAt && tutor.t >= tutor.advanceAt) { nextTutor(); return; }
  if (st.okAfter && tutor.t > st.okAfter) $('tutor-ok').classList.remove('hidden');
  // zoom steps: done once the camera is in (x1.8) / back out (x1.15)
  if (!tutor.advanceAt && ((st.id === 'zoomin' && cam.z >= 1.8) || (st.id === 'zoomout' && cam.z <= 1.15))) tutor.advanceAt = tutor.t + 0.4;
  // a step that waits for something that may not happen (lost fight ...) gets a way on
  if (!st.ok && !st.hold && tutor.t > 12) $('tutor-ok').classList.remove('hidden');
}
$('tutor-ok').onclick = () => { if (tutor) nextTutor(); };
$('tutor-skip').onclick = () => endTutor(true);
// feedback: opens the feedback form in a new tab
const feedbackUrl = 'https://forms.gle/KGM6LjwJGkVtBx3r5';
$('help-feedback').onclick = () => { track('feedback-open'); window.open(feedbackUrl, '_blank', 'noopener'); };
$('help-tutor').onclick = () => { $('help').classList.add('hidden'); withLoading(() => startTutorial(null)); };

// on-map hints: a finger sliding along the move to make, pulsing rings on the tiles to watch
function drawTutor(ctx, fs) {
  const fs0 = fs;
  if (!tutor) return;
  const st = tutorSteps[tutor.step], now = performance.now() / 1000;
  const ring = (sid, col) => {
    if (sid < 0) return;
    const s = tseg(sid), x = bv.sx(s.x), y = bv.sy(s.y), p = (now * 1.4) % 1;
    ctx.globalAlpha = 1 - p; ctx.lineWidth = 3; ctx.strokeStyle = col;
    ctx.beginPath(); ctx.arc(x, y, fs * (1.3 + 1.4 * p), 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = 1;
  };
  ctx.save();
  if (st.pinch) {
    // two fingertips spreading apart (zoom in) or closing (zoom out) in the middle of the screen,
    // on a loop, with arrowheads showing the direction. the canvas sits under the camera transform,
    // so the screen centre is mapped back into canvas px and sizes divided by the zoom
    const c = bv.canvas, wrap = $('battle-wrap'), fs = fs0 / cam.z;
    const x = (wrap.clientWidth / 2 - cam.x) / cam.z - c.offsetLeft, y = (wrap.clientHeight / 2 - cam.y) / cam.z - c.offsetTop;
    const ang = -0.55, ca = Math.cos(ang), sa = Math.sin(ang);
    const k = ((now * 0.6) % 1) / 0.75, e = Math.min(1, k) ** 2 * (3 - 2 * Math.min(1, k));
    const near = fs * 1.4, far = fs * 6, d = st.pinch > 0 ? near + (far - near) * e : far - (far - near) * e;
    ctx.globalAlpha = k > 1 ? Math.max(0, 1 - (k - 1) * 3) : 1;
    // guide: dashed track with arrowheads at the ends it moves toward
    ctx.setLineDash([8 / cam.z, 6 / cam.z]); ctx.lineWidth = 3 / cam.z; ctx.strokeStyle = 'rgba(255,215,106,0.85)';
    ctx.beginPath(); ctx.moveTo(x - ca * far, y - sa * far); ctx.lineTo(x + ca * far, y + sa * far); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffd76a';
    for (const sgn of [-1, 1]) {
      const r = st.pinch > 0 ? far + fs * 0.9 : near - fs * 0.2, dir = st.pinch > 0 ? sgn : -sgn;
      const tx = x + ca * r * sgn, ty = y + sa * r * sgn, hx = ca * dir, hy = sa * dir, w = fs * 0.7;
      ctx.beginPath(); ctx.moveTo(tx + hx * w, ty + hy * w); ctx.lineTo(tx - hy * w * 0.8, ty + hx * w * 0.8); ctx.lineTo(tx + hy * w * 0.8, ty - hx * w * 0.8); ctx.fill();
    }
    // fingertips: glowing pads with a pointing finger
    ctx.font = `${Math.round(fs * 2)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const sgn of [-1, 1]) {
      const fx = x + ca * d * sgn, fy = y + sa * d * sgn;
      ctx.fillStyle = 'rgba(255, 215, 106, 0.45)';
      ctx.beginPath(); ctx.arc(fx, fy, fs * 1.1, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 3 / cam.z; ctx.strokeStyle = '#fff';
      ctx.beginPath(); ctx.arc(fx, fy, fs * 1.1, 0, Math.PI * 2); ctx.stroke();
      ctx.fillText('👆', fx + fs * 0.4, fy + fs * 1.3);
    }
    ctx.globalAlpha = 1;
  }
  for (const id of st.ring?.() ?? []) ring(id, st.id === 'goal' ? `rgb(${colors[battle.factions[1].color]})` : '#ffd76a');
  if (st.finger) {
    const [from, to] = st.finger();
    ring(to, '#ffd76a');
    const a = tseg(from), b = tseg(to), x1 = bv.sx(a.x), y1 = bv.sy(a.y), x2 = bv.sx(b.x), y2 = bv.sy(b.y);
    const k = Math.min(1, ((now * 0.8) % 1) / 0.75), e = k * k * (3 - 2 * k);
    ctx.setLineDash([7, 6]); ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,215,106,0.8)';
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 + (x2 - x1) * e, y1 + (y2 - y1) * e); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `${Math.round(fs * 1.8)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('👆', x1 + (x2 - x1) * e + fs * 0.3, y1 + (y2 - y1) * e + fs * 0.9);
  }
  ctx.restore();
}

// ---------- frame loop: fixed-step simulation, draw every frame ----------
let last = performance.now(), acc = 0, uiTimer = 0;
// battle sounds: war cry when a fight starts, horns on captures that involve you, a marching beat
// while armies walk (louder for bigger armies), random sword clashes while fights last
let marchTimer = 0, clashTimer = 0, shoutCool = 0, alarmCool = 0;
function playBattleSounds(dt) {
  shoutCool -= dt; alarmCool -= dt;
  for (const e of battle.events.splice(0)) {
    if (e.type === 'fight' && shoutCool <= 0) { sfx.shout(Math.min(1, e.size / 150)); shoutCool = 0.35; }
    if (e.type === 'capture') { if (e.owner === 0 || e.prev === 0) sfx.capture(e.owner === 0); else sfx.captureFar(); }
    // one of your tiles is attacked: alarm bell + red rings on it
    if (e.type === 'fight' && e.prev === 0 && e.owner !== 0 && e.id !== undefined) {
      fxs.push({ kind: 'alert', id: e.id, born: performance.now() });
      if (alarmCool <= 0) { sfx.alarm(); alarmCool = 1.5; }
    }
    // you took a tile: cheer + confetti
    if (e.type === 'capture' && e.owner === 0 && e.id !== undefined) { sfx.cheer(); celebrate(e.id); tutorEvent('capture'); }
  }
  if (paused || battle.state !== 'running') return;
  const marching = battle.armies.filter((a) => !a.fight && !a.clash), fights = battle.armies.filter((a) => a.fight || a.clash).length;
  marchTimer -= dt;
  if (marching.length && marchTimer <= 0) {
    sfx.march(Math.min(1, marching.reduce((v, a) => v + a.n, 0) / 200));
    marchTimer = 0.42 / Math.sqrt(speed * rules.timeScale);
  }
  clashTimer -= dt;
  if (fights && clashTimer <= 0) { sfx.clash(); clashTimer = (0.09 + Math.random() * 0.25) / Math.min(3, fights); }
}

// runs at the monitor's refresh rate (60, 144 Hz ...): the sim advances in fixed steps,
// drawing interpolates between them (see acc in drawBattle)
// loading screen while a mode starts: show it at once (with a fresh tip), let it paint, then
// build the battle (map generation blocks for a moment); it stays at least loadMin seconds so
// the tip can be read, and the 3-2-1 countdown waits until it's gone
const loadMin = 1.1;
let loading = false;
function withLoading(start) {
  const tips = window.__tips ?? [];
  if (tips.length) $('ld-tip').textContent = '\u{1F4A1} ' + tips[Math.floor(Math.random() * tips.length)];
  $('loading').classList.add('on');
  loading = true;
  const t0 = performance.now();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    start();
    // hide after the first battle frame is drawn
    requestAnimationFrame(() => setTimeout(() => { $('loading').classList.remove('on'); loading = false; }, Math.max(0, loadMin * 1000 - (performance.now() - t0))));
  }));
}

// boot: the menu stays hidden behind the loading screen until its background battle has drawn
// its first frame and the game font is ready, so everything appears at once
let booting = document.documentElement.classList.contains('booting');
function bootDone() {
  if (!booting) return;
  booting = false;
  const fonts = document.fonts?.ready ?? Promise.resolve();
  Promise.race([fonts, new Promise((r) => setTimeout(r, 1500))])
    .then(() => requestAnimationFrame(() => document.documentElement.classList.remove('booting')));
}

// sharp zoom costs pixels: if frames get slow while the map renders above the screen's own
// density, lower the pixel budget (and re-render) until it keeps up; it never goes below native
let slowEma = 1 / 60, fpsCool = 0;
function guardFps(dt) {
  // not during the conquest zoom-out: its one-off load would read as slow frames and trigger a
  // full re-render (another stall) right as the new map appears
  if (boostLock) { slowEma = 1 / 60; return; }
  slowEma += (dt - slowEma) * 0.05;
  fpsCool -= dt;
  const base = window.devicePixelRatio || 1;
  if (fpsCool > 0 || slowEma < 0.024 || bv.dpr <= base * 1.01) return;
  bv.pxCap = (bv.pxCap ?? 4e6) * 0.7;
  bv.resize(); key = '';
  fpsCool = 2; slowEma = 1 / 60;
}

function frame(now) {
  requestAnimationFrame(frame);   // schedule first, so an error in one frame never stops the loop
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (screen === 'battle' && bv) guardFps(dt);
  if (screen === 'battle' && battle) {
    if (countdown > 0) {
      // 3-2-1: the map is live to look at, but nothing moves until it's over. it waits while
      // paused (e.g. the expedition zoom-out), so the first drum hits when the numbers appear
      if (!paused && !loading) {
        if (countdown === 3) sfx.drum(0);
        const before = Math.ceil(countdown);
        countdown = Math.max(0, countdown - dt);
        if (Math.ceil(countdown) !== before) {
          if (countdown > 0) sfx.drum(3 - Math.ceil(countdown));
          else goFlash = 1;
        }
      }
    } else if (!paused && battle.state === 'running' && !tutorHold()) {
      goFlash = Math.max(0, goFlash - dt * 1.1);
      acc += dt * speed * rules.timeScale;
      while (acc >= rules.step) { battle.step(rules.step); if (mode === 'idle') idle.autoTick(battle, rules.step); acc -= rules.step; }
      if (mode === 'idle') idleTick(dt);
    }
    // show the result card once, however the battle ended
    if (battle.state !== 'running' && !battle.endShown) { battle.endShown = true; endBattle(); }
    if (tutorWanted && countdown <= 0 && !loading) { tutorWanted = false; startTutor(); }
    if (tutor) tutorTick(dt);
    playBattleSounds(dt);
    drawBattle();
    uiTimer -= dt;
    if (uiTimer <= 0) { updatePanel(); uiTimer = 0.15; }
  } else if (screen === 'campaign') drawCampaign();
  else if (screen === 'menu') { drawMenu(dt); bootDone(); }
  else bootDone();
}
requestAnimationFrame(frame);
setPct(0.5);
setSpeed(1);

// audio: start on the first gesture, toggles remembered
addEventListener('pointerdown', initAudio, { capture: true });
// phones held upright: rotate the page by css (always landscape, no 'turn your phone' prompt).
// --sw / --sh = the real screen size, so the rotated page fills it exactly
function syncRotation() {
  const upright = matchMedia('(orientation: portrait) and (pointer: coarse)').matches;
  const root = document.documentElement;
  root.style.setProperty('--sw', innerWidth + 'px');
  root.style.setProperty('--sh', innerHeight + 'px');
  root.classList.toggle('rotated', upright);
  root.classList.toggle('compact', (upright ? innerWidth : innerHeight) < 500);   // short landscape: compact hud
  // pc first: the html ui (menu, hud, cards) is laid out for 1280x720 and zoomed up on bigger
  // windows (1920x1080 -> 1.5), so it keeps the same share of the screen. phones stay at 1
  uiK = +uiScale(upright);
  root.style.setProperty('--ui', uiK);
}
function uiScale(upright) {
  const w = upright ? innerHeight : innerWidth, h = upright ? innerWidth : innerHeight;
  return (Math.min(3, Math.max(1, Math.min(w / 1280, h / 720))) * settings.uiSize).toFixed(3);
}
syncRotation();
addEventListener('resize', syncRotation);
// phones: the first tap anywhere in the game goes fullscreen (browser bars hidden). browsers only
// allow this from a user gesture; unsupported (iphone safari) or refused requests are ignored
function goFullscreen() {
  const el = document.documentElement;
  if (!matchMedia('(pointer: coarse)').matches || document.fullscreenElement || !el.requestFullscreen) return;
  el.requestFullscreen({ navigationUI: 'hide' })
    .then(() => screen.orientation?.lock?.('landscape'))   // phones: landscape only
    .catch(() => {});
}
addEventListener('pointerup', goFullscreen, { capture: true });
addEventListener('keydown', initAudio, { capture: true });
function syncAudioButtons() {
  $('btn-sfx').classList.toggle('off', !audioPrefs.sfx);
  $('btn-music').classList.toggle('off', !audioPrefs.music);
  $('bar-music').classList.toggle('off', !audioPrefs.music);
}
$('btn-sfx').onclick = () => { setSfx(!audioPrefs.sfx); syncAudioButtons(); sfx.click(); };
$('btn-music').onclick = $('bar-music').onclick = () => { setMusic(!audioPrefs.music); syncAudioButtons(); };

// ---------- settings card ----------
// volumes (sliders; moving one also switches that sound back on), interface size, and in the
// desktop app fullscreen / window and quit (window.fogtideDesktop from desktop/preload.js)
const desk = window.fogtideDesktop ?? null;
for (const el of document.querySelectorAll('.desktop-only')) el.classList.toggle('hidden', !desk);
function paintSettings() {
  for (const [k, on, vol] of [['music', audioPrefs.music, audioPrefs.musicVol], ['sfx', audioPrefs.sfx, audioPrefs.sfxVol]]) {
    const v = on ? Math.round(vol * 100) : 0;
    $(`set-${k}`).value = v;
    $(`set-${k}-v`).textContent = v ? `${v}%` : 'off';
  }
  for (const b of $('set-ui').children) b.classList.toggle('on', +b.dataset.ui === settings.uiSize);
}
function paintDisplay(full) { for (const b of $('set-display').children) b.classList.toggle('on', (b.dataset.full === '1') === full); }
function openSettings() {
  paintSettings();
  if (desk) desk.isFullscreen().then(paintDisplay);
  $('settings').classList.remove('hidden');
}
$('btn-settings').onclick = $('bar-settings').onclick = openSettings;
$('set-done').onclick = () => $('settings').classList.add('hidden');
for (const k of ['music', 'sfx']) {
  $(`set-${k}`).oninput = (e) => {
    const v = +e.target.value / 100, on = v > 0;
    setVolume(k, on ? v : (k === 'music' ? audioPrefs.musicVol : audioPrefs.sfxVol));   // 0 = off, keeps the last level
    if (k === 'music' && on !== audioPrefs.music) setMusic(on);
    if (k === 'sfx' && on !== audioPrefs.sfx) setSfx(on);
    syncAudioButtons();
    paintSettings();
  };
}
$('set-sfx').onchange = () => sfx.click();   // sample of the new effect volume when the slider is let go
$('set-ui').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  settings.uiSize = +b.dataset.ui;
  saveSettings();
  syncRotation();
  dispatchEvent(new Event('resize'));   // map labels / layouts that size from the window
  paintSettings();
};
if (desk) {
  $('set-display').onclick = (e) => { const b = e.target.closest('button'); if (b) desk.setFullscreen(b.dataset.full === '1'); };
  desk.onFullscreen(paintDisplay);
  $('set-quit').onclick = () => desk.quit();
}
syncAudioButtons();
renderMenuStats();

// hooks for headless tests
// ?tune=1: live balance sliders; restart replays the current battle with the tuned values
initTune(() => { if (lastStart && screen === 'battle') startBattle(...lastStart); });

window.__fl = { tuneChanges, setSpeed, skipCountdown: () => { countdown = 0; goFlash = 0; }, setCam, get nextMap() { return nextMap; }, get tutor() { return tutor; }, endTutor, nextTutor, campaign, startSkirmish, startBattle, startExpedition, get expedition() { return expedition; }, startIdle, get idle() { return idle; }, buyUpgrade, get battle() { return battle; }, get view() { return bv; }, cview: cv, audioState, audioFiles };
initAnalytics();
initOffline();
