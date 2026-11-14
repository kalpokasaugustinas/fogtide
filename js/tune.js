// live tuning panel: open the game with ?tune=1 to get sliders for the balance numbers in config.js.
// changes write straight into the shared config objects, so everything read at runtime updates live;
// values marked ↻ are baked in when a battle starts (caps, growth, start troops) and need "restart round".
// tuned values persist in localStorage, but only apply while ?tune=1 is in the url (normal play = config.js).
import { rules, buildings, effects, traits, fogTwirl, testing } from './config.js?v=105';

const store_key = 'fogtide.tune';
const on = new URLSearchParams(location.search).get('tune') === '1';

// tunable values grouped like config.js: [path, min, max, step, needs restart]
const groups = {
  // testing helpers: 0-1 step 1 entries show as an on/off checkbox
  testing: [['testing.growth', 1, 10, 0.5], ['testing.autoPlay', 0, 1, 1]],
  rules: [
    ['rules.timeScale', 0.3, 2, 0.05], ['rules.armySpeed', 30, 200, 5], ['rules.startTroops', 0, 50, 1, true],
    ['rules.overCapDecay', 0, 5, 0.1], ['rules.fightAt', 0.3, 1, 0.05], ['rules.fightMin', 0, 5, 0.1],
    ['rules.fightMax', 0.5, 8, 0.1], ['rules.fightScale', 50, 600, 10], ['rules.troopsPerDot', 2, 20, 1],
    ['rules.routeEvery', 0.25, 5, 0.25], ['rules.routeMin', 1, 20, 1], ['rules.capMax', 100, 1000, 10, true],
    ['rules.capitalMargin', 1, 2, 0.05, true], ['rules.growthRate', 0.002, 0.03, 0.001, true],
    ['rules.fullRisk', 1, 1.6, 0.01], ['rules.gangUp', 1, 5, 0.1], ['rules.leaderSwitch', 1, 2, 0.05],
    ['rules.neutralRegrow', 0, 1, 0.05],
  ],
  'building costs': Object.keys(buildings).map((b) => [`buildings.${b}.cost`, 5, 150, 5]),
  effects: [
    ['effects.farmGrowth', 0, 2, 0.05], ['effects.hospitalGrowth', 0, 2, 0.05], ['effects.labGrowth', 0, 0.5, 0.01],
    ['effects.barracksAttack', 1, 3, 0.05], ['effects.fortDefense', 1, 3, 0.05],
  ],
  traits: [
    ['traits.highland.def', 0, 1, 0.05], ['traits.forest.def', 0, 1, 0.05],
    ['traits.river.growth', 0, 1, 0.05], ['traits.lakeside.growth', 0, 1, 0.05],
  ],
  'fog twirl': [
    ['fogTwirl.period', 60, 1200, 10], ['fogTwirl.counterPeriod', 60, 1200, 10], ['fogTwirl.counterAlpha', 0, 1, 0.05],
    ['fogTwirl.stormDark', 0, 1, 0.05], ['fogTwirl.stormIn', 0, 20, 0.5], ['fogTwirl.stormOut', 0, 20, 0.5], ['fogTwirl.colorFade', 0, 10, 0.5],
  ],
};

// path helpers: 'buildings.farm.cost' -> object buildings.farm, key 'cost'
const roots = { rules, buildings, effects, traits, fogTwirl, testing };
function target(path) {
  const parts = path.split('.'), key = parts.pop();
  return [parts.slice(1).reduce((o, p) => o[p], roots[parts[0]]), key];
}
const get = (path) => { const [o, k] = target(path); return o[k]; };
const set = (path, v) => { const [o, k] = target(path); o[k] = v; };

// remember config.js defaults before any override, for "reset" and for "copy changes"
const defaults = {};
for (const list of Object.values(groups)) for (const [path] of list) defaults[path] = get(path);

function loadSaved() { try { return JSON.parse(localStorage.getItem(store_key)) ?? {}; } catch { return {}; } }
function save(changes) { try { localStorage.setItem(store_key, JSON.stringify(changes)); } catch { /* storage blocked */ } }

// only the values that differ from config.js (what the user pastes back)
function changes() {
  const out = {};
  for (const path in defaults) if (get(path) !== defaults[path]) out[path] = get(path);
  return out;
}

// apply saved overrides at import time, before any battle reads the config
if (on) for (const [path, v] of Object.entries(loadSaved())) if (path in defaults && typeof v === 'number') set(path, v);

// builds the panel; onRestart restarts the current battle (or does nothing when none is running)
export function initTune(onRestart) {
  if (!on) return;
  const css = document.createElement('style');
  css.textContent = `
    #tune { position: fixed; left: 8px; top: 70px; z-index: 100; width: min(300px, calc(100% - 16px));
      background: #10202aee; color: #e8f0f2; border-radius: 10px;
      font: 12px system-ui, sans-serif; box-shadow: 0 4px 16px #0006; touch-action: auto; }
    #tune summary { padding: 8px 10px; cursor: pointer; font-weight: 700; user-select: none; }
    #tune .body { overflow-y: auto; padding: 0 10px 8px; max-height: calc(min(100vh, 100vw) - 170px); }
    #tune h4 { margin: 8px 0 4px; color: #ffd36b; font-size: 11px; text-transform: uppercase; }
    #tune .row { display: grid; grid-template-columns: 1fr 60px; gap: 2px 6px; align-items: center; margin-bottom: 6px; }
    #tune .row label { grid-column: 1 / 3; color: #b8c8cc; }
    #tune .row.changed label { color: #7fe0a0; font-weight: 700; }
    #tune .row.toggle label { display: flex; gap: 6px; align-items: center; cursor: pointer; }
    #tune input[type=range] { width: 100%; margin: 0; }
    #tune input[type=number] { width: 100%; background: #0008; color: inherit; border: 1px solid #fff3; border-radius: 4px; padding: 2px 4px; }
    #tune .btns { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid #fff2; }
    #tune button { flex: 1; padding: 8px 4px; border: 0; border-radius: 6px; background: #2f74d6; color: #fff; font-weight: 700; font-size: 12px; }
    #tune button.alt { background: #556; }
    #tune:not([open]) .btns { display: none; }
  `;
  document.head.appendChild(css);

  const panel = document.createElement('details');
  panel.id = 'tune';
  panel.innerHTML = '<summary>🎛️ tuning</summary><div class="body"></div>'
    + '<div class="btns"><button data-a="copy">copy changes</button><button data-a="restart">restart round</button><button data-a="reset" class="alt">reset</button></div>';
  const body = panel.querySelector('.body'), rows = [];

  for (const [title, list] of Object.entries(groups)) {
    body.insertAdjacentHTML('beforeend', `<h4>${title}</h4>`);
    for (const [path, min, max, step, restart] of list) {
      const row = document.createElement('div');
      row.className = 'row';
      // on/off values (0-1, step 1): one checkbox instead of a slider
      if (min === 0 && max === 1 && step === 1) {
        row.classList.add('toggle');
        row.innerHTML = `<label><input type="checkbox"> ${path.split('.').slice(1).join('.')}</label>`;
        const box = row.querySelector('input');
        const sync = () => { box.checked = !!get(path); row.classList.toggle('changed', get(path) !== defaults[path]); };
        box.onchange = () => { set(path, box.checked ? 1 : 0); save(changes()); sync(); dispatchEvent(new Event('tune')); };
        sync();
        rows.push(sync);
        body.appendChild(row);
        continue;
      }
      row.innerHTML = `<label>${path.split('.').slice(1).join('.')}${restart ? ' ↻' : ''}</label>`
        + `<input type="range" min="${min}" max="${max}" step="${step}"><input type="number" step="${step}">`;
      const [range, num] = row.querySelectorAll('input');
      // round to the step's decimals so floats like 0.30000000000000004 never show up
      const dec = (String(step).split('.')[1] ?? '').length;
      const sync = () => { range.value = num.value = get(path); row.classList.toggle('changed', get(path) !== defaults[path]); };
      const apply = (v) => { if (!Number.isFinite(v)) return; set(path, +v.toFixed(dec)); save(changes()); sync(); dispatchEvent(new Event('tune')); };
      range.oninput = () => apply(+range.value);
      num.onchange = () => apply(+num.value);   // number box can go outside the slider range
      sync();
      rows.push(sync);
      body.appendChild(row);
    }
  }

  panel.querySelector('.btns').onclick = async (e) => {
    const a = e.target.dataset?.a, btn = e.target;
    if (a === 'copy') {
      const text = JSON.stringify(changes());
      try { await navigator.clipboard.writeText(text); flash(btn, 'copied!'); }
      catch { prompt('copy these values', text); }   // clipboard needs https or localhost
    } else if (a === 'reset') {
      for (const path in defaults) set(path, defaults[path]);
      save({});
      rows.forEach((sync) => sync());
      dispatchEvent(new Event('tune'));
      flash(btn, 'done');
    } else if (a === 'restart') {
      onRestart?.();
    }
  };
  // keep taps on the panel from reaching the game canvas underneath
  for (const ev of ['pointerdown', 'pointerup', 'wheel', 'touchstart']) panel.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
  document.body.appendChild(panel);
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 1000);
}

export const tuneOn = on;
export { changes as tuneChanges };
