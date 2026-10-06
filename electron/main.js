// BSS MNT desktop launcher (D-70): the same app in its own window, with the
// Chromium engine it was tested against built in. It loads index.html from
// the app folder (the file:// path, D-64), so nothing needs a server or the
// internet.
const { app, BrowserWindow, session, shell, Menu, dialog } = require('electron');
const path = require('path');
const convert = require('./convert');   // ASF / WMV / WMA import (D-73)

convert.registerScheme();

// Media plays without a click first (tracks, previews), as in the browser
// version; exports keep running while the window is in the background.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const ROOT = path.join(__dirname, '..');

// What the app may use: microphone / line in (live mode), the file save and
// open dialogs, fullscreen, the pop-out window. Nothing else.
const ALLOWED = new Set(['media', 'fileSystem', 'fullscreen', 'clipboard-sanitized-write', 'window-management', 'pointerLock']);

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    title: 'BSS MNT',
    backgroundColor: '#17181B',
    icon: path.join(ROOT, 'electron', 'icon.png'),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.removeMenu();

  // The pop-out output window (window.open from the app) opens as its own
  // window, ready to drag to a projector; links to the web open in the
  // system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) { shell.openExternal(url); return { action: 'deny' }; }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 1280, height: 720, title: 'BSS MNT – Output', backgroundColor: '#000000', autoHideMenuBar: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
      },
    };
  });

  // Unsaved changes: the page asks before leaving. Electron would cancel the
  // close silently (the app couldn't be closed), so ask here instead (D-74).
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Close without saving', 'Cancel'], defaultId: 1, cancelId: 1,
      title: 'Unsaved changes', message: 'This project has unsaved changes.', detail: 'Close BSS MNT without saving them?',
    });
    if (choice === 0) e.preventDefault();   // = let the window close
  });

  win.loadFile(path.join(ROOT, 'index.html'));
  return win;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const s = session.defaultSession;
  s.setPermissionRequestHandler((wc, permission, callback) => callback(ALLOWED.has(permission)));
  s.setPermissionCheckHandler((wc, permission) => ALLOWED.has(permission));
  convert.setup();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
