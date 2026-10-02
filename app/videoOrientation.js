// Rotated phone videos (v2.2, D-54).
//
// Phones usually store portrait video as a landscape frame plus a "rotate
// 90°" flag in the file header. <video> and 2D-canvas drawing apply that
// flag, but Chrome's hardware-decoded path into WebGL (which p5 draws
// with) can skip it, so the picture arrives sideways while its size reads
// as portrait: rotated AND stretched. For videos that carry a rotation
// flag, frames are copied through a 2D canvas first (drawImage applies the
// rotation) and that canvas is what p5 draws. Unrotated videos are untouched.
const VideoOrientation = {
  // 0 / 90 / 180 / 270 from the first video track header (tkhd matrix) of an
  // MP4 / MOV / 3GP file. The header can be at the start or the end.
  async detect(file) {
    if (!file) return 0;
    const isIso = /\.(mp4|m4v|mov|3gp)$/i.test(file.name) || /mp4|quicktime|3gpp/.test(file.type);
    if (!isIso) return 0;
    const CHUNK = 8 << 20;
    const parts = [file.slice(0, Math.min(file.size, CHUNK))];
    if (file.size > CHUNK) parts.push(file.slice(file.size - CHUNK));
    for (const part of parts) {
      const rot = VideoOrientation.scan(new Uint8Array(await part.arrayBuffer()));
      if (rot != null) return rot;
    }
    return 0;
  },

  scan(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 4; i < b.length - 92; i++) {
      if (b[i] !== 0x74 || b[i + 1] !== 0x6b || b[i + 2] !== 0x68 || b[i + 3] !== 0x64) continue; // 'tkhd'
      const version = b[i + 4];
      const base = i + 8 + (version === 1 ? 32 : 20) + 16;   // matrix
      if (base + 44 > b.length) continue;
      const w = dv.getUint32(base + 36) / 65536, h = dv.getUint32(base + 40) / 65536;
      if (!(w > 0 && h > 0)) continue;                        // audio track
      const a = dv.getInt32(base) / 65536, c = dv.getInt32(base + 4) / 65536;
      const deg = Math.round(Math.atan2(c, a) * 180 / Math.PI);
      return ((deg % 360) + 360) % 360;
    }
    return null;
  },

  // A per-video 2D copy for p5 to draw. Long edge capped for speed.
  bridge(p, media, maxEdge = 1280) {
    const el = media.elt;
    let g = null;
    return {
      frame() {
        const vw = el.videoWidth, vh = el.videoHeight;
        if (!vw || !vh) return media;
        const s = Math.min(1, maxEdge / Math.max(vw, vh));
        const w = Math.round(vw * s), h = Math.round(vh * s);
        if (!g || g.width !== w || g.height !== h) {
          if (g) g.remove();
          g = p.createGraphics(w, h);
          g.pixelDensity(1);
        }
        g.drawingContext.drawImage(el, 0, 0, w, h);
        return g;
      },
      remove() { if (g) g.remove(); g = null; },
    };
  },
};
