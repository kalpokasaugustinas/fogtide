// desktop app bridge: the game page gets window.fogtideDesktop with the few window controls the
// settings card needs (fullscreen on/off, quit). nothing else from electron/node reaches the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fogtideDesktop', {
  isFullscreen: () => ipcRenderer.invoke('fullscreen:get'),
  setFullscreen: (on) => ipcRenderer.invoke('fullscreen:set', !!on),
  // cb(on) whenever the window enters/leaves fullscreen (also via f11 / alt+enter)
  onFullscreen: (cb) => ipcRenderer.on('fullscreen:changed', (_e, on) => cb(on)),
  quit: () => ipcRenderer.invoke('app:quit'),
});
