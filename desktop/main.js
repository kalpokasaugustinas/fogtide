// fogtide desktop app: electron main process. opens one window that runs the same files as the web
// version (index.html, js/, img/, audio/), served from a private app:// scheme instead of file://
// (chromium blocks es modules and module workers on file://).
//
// launch options (for debugging on the pc):
//   --game-dir=<folder>   serve the game from this folder instead of the bundled copy, e.g. the
//                         git working tree, so code changes show up on reload without a rebuild
//   --dev                 allow devtools (f12) and reload (f5 / ctrl+r)
//   --windowed            start in a window instead of fullscreen
//   --remote-debugging-port=9222   standard chromium flag, used by tools/desktop_check.py
// keys: f11 or alt+enter toggles fullscreen.
const { app, BrowserWindow, protocol, net, shell, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// command line flags (--name or --name=value)
const arg = (name) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
};
const dev = !!arg('dev');
// bundled game files sit next to this file (tools/build_desktop.py copies them in)
const gameDir = path.resolve(typeof arg('game-dir') === 'string' ? arg('game-dir') : __dirname);

// app:// must be registered before the app is ready: "standard" gives it normal origin/url rules
// (relative links, localStorage, module workers), "secure" counts it as https for web apis
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// window size/fullscreen remembered between runs (small json in the user data folder)
const stateFile = () => path.join(app.getPath('userData'), 'window.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}
function saveState(win, normal) {
  if (dev) return;                        // debug runs (--dev, often --windowed) never overwrite the player's setup
  try {
    const s = { fullscreen: win.isFullScreen(), maximized: win.isMaximized(), bounds: normal };
    fs.writeFileSync(stateFile(), JSON.stringify(s));
  } catch { /* not critical */ }
}

function createWindow() {
  const st = loadState();
  const b = st.bounds || { width: 1280, height: 720 };
  const win = new BrowserWindow({
    ...b,
    useContentSize: true,                 // width/height = game area, not the outer frame
    minWidth: 960,
    minHeight: 540,
    show: false,                          // shown once the first frame is ready (no white flash)
    backgroundColor: '#c3d1d2',           // same as the web manifest background
    title: 'Fogtide',
    icon: path.join(gameDir, 'img', 'icon-512.png'),
    autoHideMenuBar: true,
    webPreferences: {
      devTools: dev,
      contextIsolation: true,
      nodeIntegration: false,             // the game is plain web code, it never needs node
      sandbox: true,
      backgroundThrottling: false,        // idle mode keeps ticking while the window is in the background
      preload: path.join(__dirname, 'preload.js'),   // window.fogtideDesktop (settings: fullscreen, quit)
    },
  });
  // first run (or saved as fullscreen) starts fullscreen, like most steam games
  const full = arg('windowed') ? false : st.fullscreen ?? true;
  if (st.maximized && !full) win.maximize();
  win.once('ready-to-show', () => { win.setFullScreen(full); win.show(); });

  // links that open a new window (credits, privacy) go to the system browser instead
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // never navigate the game window away from the app itself
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });

  // keys handled before the page sees them
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const fullKey = input.key === 'F11' || (input.alt && input.key === 'Enter');
    if (fullKey) { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    if (dev && input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
    if (dev && (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r'))) { win.webContents.reloadIgnoringCache(); e.preventDefault(); }
  });

  // last plain-window position + game-area size (skipped while fullscreen/maximized), so the
  // window reopens the same size instead of growing by the frame each run
  let normal = st.bounds;
  const track = () => {
    if (win.isFullScreen() || win.isMaximized() || win.isMinimized()) return;
    const [x, y] = win.getPosition(), [width, height] = win.getContentSize();
    normal = { x, y, width, height };
  };
  win.on('resize', track);
  win.on('move', track);
  win.on('close', () => saveState(win, normal));
  // tell the page (settings card) when fullscreen changes, whatever changed it
  for (const ev of ['enter-full-screen', 'leave-full-screen']) win.on(ev, () => win.webContents.send('fullscreen:changed', win.isFullScreen()));
  win.loadURL('app://fogtide/index.html');
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);          // no file/edit menu bar
  // app://fogtide/<path> -> <gameDir>/<path>; the ?v=N build stamps are ignored (query string)
  protocol.handle('app', (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(gameDir, rel));
    // refuse anything outside the game folder (e.g. ../../)
    if (!file.startsWith(gameDir + path.sep)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  // settings card calls (desktop/preload.js)
  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);
  ipcMain.handle('fullscreen:get', (e) => winOf(e)?.isFullScreen() ?? false);
  ipcMain.handle('fullscreen:set', (e, on) => { winOf(e)?.setFullScreen(!!on); });
  ipcMain.handle('app:quit', () => app.quit());
  createWindow();
});

app.on('window-all-closed', () => app.quit());
