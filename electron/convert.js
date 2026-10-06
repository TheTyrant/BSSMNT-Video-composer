// Converts media browsers can't decode (ASF / WMV / WMA) with the bundled
// FFmpeg (D-73). Results are cached under the app's data folder, keyed by
// the source path, size and date, so the same file converts only once.
const { app, ipcMain, protocol, net } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const SCHEME = 'bssmnt-media';

function ffmpegPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe');
  return require('ffmpeg-static');   // dev: from node_modules
}

function cacheDir() {
  const d = path.join(app.getPath('userData'), 'converted');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Must run before app ready.
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
}

function setup() {
  const dir = cacheDir();
  // Serves converted files only (no other paths).
  // c/<name> = converted file; f/<token> = a media file opened from its
  // saved path (linked media, D-74).
  const opened = new Map();
  protocol.handle(SCHEME, async (req) => {
    const u = new URL(req.url);
    const name = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    const file = u.host === 'f' ? opened.get(name) : path.join(dir, path.basename(name));
    if (!file || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(res.body, { status: res.status, headers });
  });

  // Reopen a linked media file from its saved path (media files only).
  const MEDIA = /\.(mp4|m4v|mov|webm|mkv|ogv|3gp|avi|asf|wmv|wma|mp3|wav|m4a|aac|ogg|oga|flac|opus|png|jpe?g|gif|webp|bmp|avif|mnt)$/i;
  ipcMain.handle('bssmnt:open', async (event, p) => {
    if (typeof p !== 'string' || !MEDIA.test(p)) return null;
    let st;
    try { st = fs.statSync(p); } catch (e) { return null; }
    if (!st.isFile()) return null;
    const token = crypto.randomBytes(12).toString('hex');
    opened.set(token, p);
    return { url: `${SCHEME}://f/${token}`, name: path.basename(p), size: st.size, lastModified: Math.round(st.mtimeMs) };
  });

  ipcMain.handle('bssmnt:convert', async (event, src, kind, id) => {
    if (!src || !fs.existsSync(src)) throw new Error('The original file could not be found on disk.');
    const st = fs.statSync(src);
    const key = crypto.createHash('sha1').update(`${src}|${st.size}|${st.mtimeMs}|${kind}`).digest('hex').slice(0, 10);
    const base = path.basename(src).replace(/\.[^.]+$/, '').replace(/[^\w.\- ()]+/g, '_');
    const ext = kind === 'audio' ? 'm4a' : 'mp4';
    const outName = `${base}-${key}.${ext}`;
    const out = path.join(dir, outName);
    const result = { url: `${SCHEME}://c/${encodeURIComponent(outName)}`, name: `${base}.${ext}`, type: kind === 'audio' ? 'audio/mp4' : 'video/mp4' };
    if (fs.existsSync(out)) return { ...result, cached: true };

    const tmp = out + '.part';
    const args = ['-hide_banner', '-nostdin', '-y', '-i', src];
    if (kind === 'audio') {
      args.push('-vn', '-c:a', 'aac', '-b:a', '192k');
    } else {
      // Keep the source's frame timing: screen recorders declare a 1000 fps
      // timebase, and constant-rate output would fill it with duplicates.
      args.push('-map', '0:v:0', '-map', '0:a:0?', '-fps_mode', 'vfr',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart');
    }
    args.push('-f', kind === 'audio' ? 'ipod' : 'mp4', tmp);

    await new Promise((resolve, reject) => {
      const p = spawn(ffmpegPath(), args, { windowsHide: true });
      let duration = 0, log = '';
      p.stderr.on('data', (d) => {
        const s = d.toString();
        log = (log + s).slice(-4000);
        const dm = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(s);
        if (dm) duration = +dm[1] * 3600 + +dm[2] * 60 + +dm[3];
        const tm = /time=(\d+):(\d+):(\d+\.\d+)/.exec(s);
        if (tm && duration > 0 && !event.sender.isDestroyed()) {
          const t = +tm[1] * 3600 + +tm[2] * 60 + +tm[3];
          event.sender.send('bssmnt:convert-progress', { id, pct: Math.min(99, Math.round((t / duration) * 100)) });
        }
      });
      p.on('error', reject);
      p.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Conversion failed (FFmpeg ${code}): ${log.split('\n').filter(Boolean).slice(-2).join(' ')}`));
      });
    }).catch((e) => { try { fs.unlinkSync(tmp); } catch (_) { /* none */ } throw e; });
    fs.renameSync(tmp, out);
    return { ...result, cached: false };
  });
}

module.exports = { registerScheme, setup };
