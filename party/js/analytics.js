// anonymous play counter: GoatCounter (no cookies, no personal data, no consent banner needed).
// counts page views plus a few game events (modes started, tutorial, wins, conquest stages) and
// js errors players hit.
// off while code is empty, and never on localhost (tests)
const code = 'fogfront';   // goatcounter site code (kept from the game's old name): https://fogfront.goatcounter.com

// the developer's own devices: opening the game once with ?test (test buttons) or ?nocount marks
// this browser as not counted (goatcounter's own 'skipgc' flag), so testing doesn't skew the stats
try { if (/[?&](test|nocount)(=|&|$)/.test(location.search)) localStorage.setItem('skipgc', 't'); } catch { /* storage blocked */ }
const skipped = () => { try { return localStorage.getItem('skipgc') === 't'; } catch { return false; } };
const on = () => !!code && !/^(localhost|127\.)/.test(location.hostname) && !skipped();

export function initAnalytics() {
  if (!on()) return;
  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://gc.zgo.at/count.js';
  s.dataset.goatcounter = `https://${code}.goatcounter.com/count`;
  s.onload = () => { for (const n of queue.splice(0)) send(n); };
  document.head.appendChild(s);
  // js errors players hit, as events ('error-<file>:<line> <message>'), so bugs show up on the
  // dashboard: each distinct error once per visit, at most 5 per visit
  const seen = new Set();
  const report = (msg, file = '', line = 0) => {
    const where = file ? `${String(file).split('/').pop().split('?')[0]}:${line}` : 'promise';
    const name = `error-${where} ${String(msg).replace(/\s+/g, ' ')}`.slice(0, 90);
    if (seen.has(name) || seen.size >= 5) return;
    seen.add(name);
    track(name);
  };
  addEventListener('error', (e) => report(e.message, e.filename, e.lineno));
  addEventListener('unhandledrejection', (e) => report(e.reason?.message ?? e.reason));
}

// events sent before the counter script has loaded wait here
const queue = [];
const send = (name) => { try { window.goatcounter.count({ path: `event/${name}`, title: name, event: true }); } catch { /* blocked */ } };

// one game event, e.g. track('conquest-stage-3')
export function track(name) {
  if (!on()) return;
  if (window.goatcounter?.count) send(name); else if (queue.length < 20) queue.push(name);
}
