// sound effects + background music from recorded files in audio/ (credits: audio/CREDITS.md).
// sfx: short mp3 clips decoded into web audio buffers; a few cues stay synthesized (capture horns).
// music: playlists streamed through two <audio> decks that crossfade into each other.
// audio starts on the first tap/key (browser rule); on/off choices are remembered.

const pref_key = 'frontlines.audio';
const base = new URL('../audio/', import.meta.url);
const music_vol = 0.55, sfx_vol = 0.8;
const xfade = 3;   // seconds of overlap between two music tracks
let ctx = null, master, sfxBus, musicBus, noiseBuf, musicTimer = 0;
const prefs = loadPrefs();

function loadPrefs() {
  try { return { sfx: true, music: true, ...JSON.parse(localStorage.getItem(pref_key)) }; } catch { return { sfx: true, music: true }; }
}
function savePrefs() { try { localStorage.setItem(pref_key, JSON.stringify(prefs)); } catch { /* storage blocked */ } }

export const audioPrefs = prefs;

// create the audio graph on the first user gesture
export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.9;
  // gentle compressor so many overlapping effects never clip
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -16;
  comp.ratio.value = 4;
  master.connect(comp).connect(ctx.destination);
  sfxBus = ctx.createGain();
  sfxBus.gain.value = prefs.sfx ? sfx_vol : 0;
  sfxBus.connect(master);
  musicBus = ctx.createGain();
  musicBus.gain.value = prefs.music ? music_vol : 0;
  musicBus.connect(ctx.destination);   // music skips the compressor so sfx don't pump it
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  loadSamples();
  startMusic();
  // stop playing in a background tab
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { ctx.suspend(); for (const d of decks) d.el.pause(); }
    else { ctx.resume(); resumeDecks(); }
  });
}

export function setSfx(on) { prefs.sfx = on; savePrefs(); if (ctx) sfxBus.gain.setTargetAtTime(on ? sfx_vol : 0, ctx.currentTime, 0.05); }
export function setMusic(on) {
  prefs.music = on; savePrefs();
  if (!ctx) return;
  musicBus.gain.setTargetAtTime(on ? music_vol : 0, ctx.currentTime, 0.3);
  // pause the streams while music is off (saves data), pick up where they were when it's back
  if (on) resumeDecks(); else setTimeout(() => { if (!prefs.music) for (const d of decks) d.el.pause(); }, 1200);
}

// ---------- samples ----------
// name -> number of variants (files name0.mp3, name1.mp3, ...); 0 = a single file name.mp3
const sample_files = { click: 0, step: 3, build: 3, clash: 10, shout: 5, drums: 0 };
const buffers = {};

// fetch + decode every clip once; effects play as soon as their clip is ready
function loadSamples() {
  for (const [name, n] of Object.entries(sample_files)) {
    const files = n ? Array.from({ length: n }, (_, i) => `${name}${i}`) : [name];
    buffers[name] = [];
    for (const f of files) {
      fetch(new URL(`sfx/${f}.mp3`, base))
        .then((r) => r.arrayBuffer())
        .then((b) => new Promise((ok, fail) => ctx.decodeAudioData(b, ok, fail)))   // callback form for old safari
        .then((buf) => buffers[name].push(buf))
        .catch(() => { /* missing or undecodable clip: that effect stays silent */ });
    }
  }
}

// play a random variant of a clip; rate = pitch/speed, jitter = random rate spread
// offset = start this far into the clip; returns the source (so it can be stopped)
function play(name, { vol = 0.5, rate = 1, jitter = 0.08, when = 0, offset = 0 } = {}) {
  const list = buffers[name];
  if (!ctx || !list?.length) return;
  const src = ctx.createBufferSource(), g = ctx.createGain();
  src.buffer = list[Math.floor(Math.random() * list.length)];
  src.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * jitter);
  g.gain.value = vol;
  src.connect(g).connect(sfxBus);
  src.start(ctx.currentTime + when, offset);
  return src;
}

// ---------- synth building blocks (for the cues without a recording) ----------

// filtered noise burst
function noise({ when = 0, dur = 0.1, type = 'bandpass', freq = 1000, q = 1, vol = 0.3, attack = 0.005, bus = sfxBus, sweep = 0 }) {
  if (!ctx) return;
  const t = ctx.currentTime + when, src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  src.buffer = noiseBuf;
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
  if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(40, freq * sweep), t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(bus);
  src.start(t, Math.random() * 0.5, dur + 0.05);
}

// simple oscillator note with an envelope (optional lowpass and pitch glide)
function note({ when = 0, freq = 440, dur = 0.3, type = 'sine', vol = 0.2, attack = 0.01, glide = 0, cutoff = 0, bus = sfxBus }) {
  if (!ctx) return;
  const t = ctx.currentTime + when, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (glide) o.frequency.exponentialRampToValueAtTime(freq * glide, t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let out = o;
  if (cutoff) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff; out = o.connect(f); }
  out.connect(g).connect(bus);
  o.start(t);
  o.stop(t + dur + 0.05);
}

// ---------- effects ----------

let drumSrc = null;   // the countdown drum while it plays
export const sfx = {
  // one marching step on grass; size 0..1 (how many troops are on the move)
  march(size) { play('step', { vol: 0.1 + 0.3 * size, rate: 0.85, jitter: 0.12 }); },
  // war cry: a slice of a shouting crowd, louder for bigger fights
  shout(size) { play('shout', { vol: 0.25 + 0.45 * size, jitter: 0.06 }); },
  // sword clash: one of 10 recorded clashes, pitch varied so repeats don't stand out
  clash() { play('clash', { vol: 0.22, jitter: 0.12 }); },
  // horn when a tile changes hands: rising for you, falling when you lose one
  capture(mine) {
    const [a, b] = mine ? [196, 294] : [220, 147];
    note({ freq: a, type: 'sawtooth', vol: 0.08, dur: 0.28, attack: 0.03, cutoff: 1300 });
    note({ freq: b, type: 'sawtooth', vol: 0.09, dur: mine ? 0.55 : 0.45, attack: 0.03, when: 0.2, cutoff: 1300 });
    if (mine) noise({ type: 'lowpass', freq: 200, vol: 0.12, dur: 0.18, when: 0.2 });
  },
  // any tile changing hands between other factions: soft drum hit + distant low horn
  captureFar() {
    noise({ type: 'lowpass', freq: 130, vol: 0.09, dur: 0.22 });
    note({ freq: 147, type: 'sawtooth', vol: 0.03, dur: 0.35, attack: 0.04, cutoff: 700, when: 0.05 });
  },
  // alarm when one of your tiles is attacked: two quick bell strikes, high then lower
  alarm() {
    [988, 784].forEach((f, i) => {
      note({ freq: f, type: 'triangle', vol: 0.17, dur: 0.35, attack: 0.004, when: i * 0.14 });
      note({ freq: f * 2.76, type: 'sine', vol: 0.04, dur: 0.18, attack: 0.004, when: i * 0.14 });   // metallic overtone
    });
  },
  // capture celebration after the horn: a bright rising arpeggio with a sparkle on top
  cheer() {
    [523, 659, 784, 1047].forEach((f, i) => note({ freq: f, type: 'triangle', vol: 0.09, dur: 0.32, attack: 0.005, when: 0.32 + i * 0.07 }));
    noise({ type: 'highpass', freq: 6000, vol: 0.05, dur: 0.45, attack: 0.02, when: 0.32 });
  },
  // three hammer knocks on wood
  build() { for (let i = 0; i < 3; i++) play('build', { vol: 0.45, when: i * 0.13 }); },
  // countdown: the war drum recording runs under all three counts, so only count 0 starts it
  drum(i) { if (i === 0) drumSrc = play('drums', { vol: 0.7, jitter: 0 }); },
  // pause during the countdown: the drum stops; resume picks it up where the count is
  drumStop() { try { drumSrc?.stop(); } catch { /* already over */ } drumSrc = null; },
  drumFrom(sec) { this.drumStop(); drumSrc = play('drums', { vol: 0.7, jitter: 0, offset: sec }); },
  // perk picked: soft thump, a rising run of bells and a long sparkle
  perk() {
    noise({ type: 'lowpass', freq: 180, vol: 0.14, dur: 0.25 });
    [523, 659, 784, 1047, 1319].forEach((f, i) => note({ freq: f, type: 'triangle', vol: 0.1, dur: 0.45, attack: 0.005, when: 0.05 + i * 0.06 }));
    note({ freq: 2093, type: 'sine', vol: 0.05, dur: 0.8, attack: 0.01, when: 0.36 });
    noise({ type: 'highpass', freq: 7000, vol: 0.05, dur: 0.7, attack: 0.03, when: 0.3 });
  },
  click() { play('click', { vol: 0.5, jitter: 0.05 }); },
  // idle fog horn collected: a long low war-horn blow rising a fifth, with breath noise
  horn() {
    note({ freq: 110, type: 'sawtooth', vol: 0.1, dur: 0.5, attack: 0.08, cutoff: 900 });
    note({ freq: 165, type: 'sawtooth', vol: 0.12, dur: 0.9, attack: 0.1, when: 0.35, cutoff: 1100 });
    note({ freq: 82.5, type: 'triangle', vol: 0.1, dur: 1.2, attack: 0.1, when: 0.05 });
    noise({ type: 'bandpass', freq: 600, vol: 0.05, dur: 1.1, attack: 0.15 });
  },
};

// ---------- music ----------
// playlists of files in audio/music/. loop = keep going (next track, wrapping around);
// otherwise the track plays once (victory/defeat), then silence until the next setTrack.
const playlists = {
  menu: { files: ['menu-aphelion'], loop: true },
  battle: { files: ['game-forge', 'game-five-armies', 'game-heroic-demise', 'game-battle-theme-a'], loop: true },
  victory: { files: ['victory'], loop: false },
  defeat: { files: ['defeat'], loop: false },
};
// two decks: one playing, the other fading in the next track
const decks = [];
let list = 'menu', pos = 0, active = 0;
const nextPos = { battle: 0 };   // battle music rotates: each battle starts at the next track

// every audio url the game uses (for the smoke test), plus what's playing now
export function audioFiles() {
  const sfxUrls = Object.entries(sample_files).flatMap(([name, n]) => (n ? Array.from({ length: n }, (_, i) => `${name}${i}`) : [name]).map((f) => new URL(`sfx/${f}.mp3`, base).href));
  const musicUrls = Object.values(playlists).flatMap((pl) => pl.files.map((f) => new URL(`music/${f}.mp3`, base).href));
  return { sfx: sfxUrls, music: musicUrls };
}
export function audioState() {
  const d = decks[active];
  return { list, pos, ctx: ctx?.state ?? 'none', src: d?.el.src ?? '', playing: !!d && !d.el.paused, time: d?.el.currentTime ?? 0, loaded: Object.fromEntries(Object.entries(buffers).map(([k, v]) => [k, v.length])) };
}

function makeDeck() {
  const el = new Audio();
  el.preload = 'auto';
  el.crossOrigin = 'anonymous';
  const g = ctx.createGain();
  g.gain.value = 0;
  ctx.createMediaElementSource(el).connect(g).connect(musicBus);
  return { el, g, live: false };
}

function startMusic() {
  decks.push(makeDeck(), makeDeck());
  // unlock both decks inside the user gesture (ios only lets gesture-started elements play later)
  for (const d of decks) { d.el.src = new URL('sfx/click.mp3', base).href; d.el.play().then(() => d.el.pause(), () => {}); }
  playOn(list, pos, 1.5);
  clearInterval(musicTimer);
  musicTimer = setInterval(tickMusic, 250);
}

// start file #p of playlist name on the idle deck and crossfade the other one out over fade s
function playOn(name, p, fade) {
  const pl = playlists[name], t = ctx.currentTime;
  const out = decks[active], inn = decks[1 - active];
  active = 1 - active;
  out.live = false;
  out.g.gain.cancelScheduledValues(t);
  out.g.gain.setValueAtTime(out.g.gain.value, t);
  out.g.gain.linearRampToValueAtTime(0, t + fade);
  setTimeout(() => { if (!out.live) out.el.pause(); }, fade * 1000 + 100);
  inn.el.src = new URL(`music/${pl.files[p]}.mp3`, base).href;
  inn.live = true;
  inn.g.gain.cancelScheduledValues(t);
  inn.g.gain.setValueAtTime(0, t);
  inn.g.gain.linearRampToValueAtTime(1, t + fade);
  if (prefs.music && !document.hidden) inn.el.play().catch(() => {});
}

function resumeDecks() {
  if (!prefs.music) return;
  for (const d of decks) if (d.live && !d.el.ended) d.el.play().catch(() => {});
}

// switch playlists: quick crossfade into the new one
export function setTrack(name) {
  if (!playlists[name] || name === list) return;
  list = name;
  pos = 0;
  if (name in nextPos) { pos = nextPos[name]; nextPos[name] = (pos + 1) % playlists[name].files.length; }
  if (ctx) playOn(list, pos, 1.5);
}

// near the end of a looping track: crossfade into the next one in the playlist
function tickMusic() {
  const d = decks[active], pl = playlists[list];
  if (!ctx || !d.live || !pl.loop || !d.el.duration || d.el.paused) return;
  if (d.el.duration - d.el.currentTime < xfade) {
    pos = (pos + 1) % pl.files.length;
    playOn(list, pos, xfade);
  }
}
