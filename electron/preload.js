// Desktop-only bridge (D-73): lets the page ask the launcher to convert
// media browsers can't play (ASF / WMV / WMA) with the bundled FFmpeg.
// The page gets no file system or Node access, only these calls.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bssmntDesktop', {
  // kind: 'video' (MP4, H.264 + AAC) or 'audio' (M4A, AAC). Resolves to
  // { url, name, type, cached } — url is served by the launcher.
  convert: (fileOrPath, kind, id) => ipcRenderer.invoke('bssmnt:convert', typeof fileOrPath === 'string' ? fileOrPath : webUtils.getPathForFile(fileOrPath), kind, id),
  onConvertProgress: (fn) => ipcRenderer.on('bssmnt:convert-progress', (e, p) => fn(p)),
  // Real file paths (D-74): where a file the user added lives on disk, and
  // reopening a file from that path (linked media in projects). Read-only.
  pathFor: (file) => { try { return webUtils.getPathForFile(file) || null; } catch (e) { return null; } },
  openPath: (p) => ipcRenderer.invoke('bssmnt:open', p),
});
