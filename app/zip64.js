// ZIP reading and writing for .mnt projects, with ZIP64 (D-66): no 4 GB
// limit on the project or on any file in it.
//
// ZipWriter streams entries out in order (write(chunk) may return a promise,
// so a disk writer can hold it back). Entries are stored, not compressed —
// media is already compressed, and it keeps saving fast. Each entry is
// followed by a data descriptor (CRC worked out while streaming), and the
// central directory at the end carries ZIP64 fields wherever a size or an
// offset passes 4 GB.
//
// ZipReader reads only the index, then hands out entries as slices of the
// file (no copy); deflated entries (projects saved before D-65) are inflated.
const Zip64 = (() => {
  const MAX32 = 0xffffffff;

  // CRC-32, slicing-by-8 (fast enough for gigabytes).
  const T = (() => {
    const t = new Uint32Array(8 * 256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    for (let n = 0; n < 256; n++) for (let k = 1; k < 8; k++) t[k * 256 + n] = (t[(k - 1) * 256 + n] >>> 8) ^ t[t[(k - 1) * 256 + n] & 255];
    return t;
  })();
  function crc32(crc, u) {
    let c = ~crc >>> 0, i = 0;
    const n8 = u.length - (u.length % 8);
    for (; i < n8; i += 8) {
      c ^= u[i] | (u[i + 1] << 8) | (u[i + 2] << 16) | (u[i + 3] << 24);
      c = T[1792 + (c & 255)] ^ T[1536 + ((c >>> 8) & 255)] ^ T[1280 + ((c >>> 16) & 255)] ^ T[1024 + (c >>> 24)]
        ^ T[768 + u[i + 4]] ^ T[512 + u[i + 5]] ^ T[256 + u[i + 6]] ^ T[u[i + 7]];
    }
    for (; i < u.length; i++) c = T[(c ^ u[i]) & 255] ^ (c >>> 8);
    return ~c >>> 0;
  }

  // Little-endian byte builder.
  class Bytes {
    constructor(n) { this.u = new Uint8Array(n); this.v = new DataView(this.u.buffer); this.p = 0; }
    u16(x) { this.v.setUint16(this.p, x, true); this.p += 2; return this; }
    u32(x) { this.v.setUint32(this.p, x >>> 0, true); this.p += 4; return this; }
    u64(x) { this.v.setUint32(this.p, x % 0x100000000, true); this.v.setUint32(this.p + 4, Math.floor(x / 0x100000000), true); this.p += 8; return this; }
    raw(b) { this.u.set(b, this.p); this.p += b.length; return this; }
  }

  function dosTime(d) {
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  class ZipWriter {
    constructor(write) { this.write = write; this.offset = 0; this.entries = []; this.when = dosTime(new Date()); }

    async out(u) { this.offset += u.length; await this.write(u); }

    // data: Uint8Array or Blob / File (streamed).
    async add(name, data, onProgress) {
      const nameBytes = new TextEncoder().encode(name);
      const size = data instanceof Blob ? data.size : data.length;
      const big = size >= MAX32;
      const offset = this.offset;
      const h = new Bytes(30 + nameBytes.length + (big ? 20 : 0));
      h.u32(0x04034b50).u16(big ? 45 : 20).u16(0x0808).u16(0)       // stored; sizes in the data descriptor; UTF-8 name
        .u16(this.when.time).u16(this.when.date).u32(0).u32(big ? MAX32 : 0).u32(big ? MAX32 : 0)
        .u16(nameBytes.length).u16(big ? 20 : 0).raw(nameBytes);
      if (big) h.u16(1).u16(16).u64(0).u64(0);
      await this.out(h.u);
      let crc = 0, written = 0;
      if (data instanceof Blob) {
        const reader = data.stream().getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          crc = crc32(crc, value);
          written += value.length;
          await this.out(value);
          if (onProgress) onProgress(value.length);
        }
      } else {
        crc = crc32(0, data);
        written = data.length;
        await this.out(data);
        if (onProgress) onProgress(data.length);
      }
      if (written !== size) throw new Error(`${name}: read ${written} of ${size} bytes — the file changed or couldn't be read.`);
      const dd = new Bytes(big ? 24 : 16);
      dd.u32(0x08074b50).u32(crc);
      if (big) dd.u64(size).u64(size); else dd.u32(size).u32(size);
      await this.out(dd.u);
      this.entries.push({ nameBytes, crc, size, offset });
    }

    async finish() {
      const cdStart = this.offset;
      let any64 = false;
      for (const e of this.entries) {
        const bigSize = e.size >= MAX32, bigOff = e.offset >= MAX32;
        const ex = (bigSize ? 16 : 0) + (bigOff ? 8 : 0);
        any64 = any64 || bigSize || bigOff;
        const c = new Bytes(46 + e.nameBytes.length + (ex ? 4 + ex : 0));
        c.u32(0x02014b50).u16(45).u16(ex ? 45 : 20).u16(0x0808).u16(0)
          .u16(this.when.time).u16(this.when.date).u32(e.crc)
          .u32(bigSize ? MAX32 : e.size).u32(bigSize ? MAX32 : e.size)
          .u16(e.nameBytes.length).u16(ex ? 4 + ex : 0).u16(0).u16(0).u16(0).u32(0)
          .u32(bigOff ? MAX32 : e.offset).raw(e.nameBytes);
        if (ex) {
          c.u16(1).u16(ex);
          if (bigSize) c.u64(e.size).u64(e.size);
          if (bigOff) c.u64(e.offset);
        }
        await this.out(c.u);
      }
      const cdSize = this.offset - cdStart, n = this.entries.length;
      const need64 = any64 || n >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32;
      if (need64) {
        const z64At = this.offset;
        const z = new Bytes(56 + 20);
        z.u32(0x06064b50).u64(44).u16(45).u16(45).u32(0).u32(0).u64(n).u64(n).u64(cdSize).u64(cdStart);
        z.u32(0x07064b50).u32(0).u64(z64At).u32(1);
        await this.out(z.u);
      }
      const e = new Bytes(22);
      e.u32(0x06054b50).u16(0).u16(0).u16(need64 ? 0xffff : n).u16(need64 ? 0xffff : n)
        .u32(need64 ? MAX32 : cdSize).u32(need64 ? MAX32 : cdStart).u16(0);
      await this.out(e.u);
      return this.offset;
    }
  }

  // ---- reading ----------------------------------------------------------------

  const big64 = (dv, p) => dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 0x100000000;

  async function open(file) {
    const tailLen = Math.min(file.size, 65557 + 20);
    const tailStart = file.size - tailLen;
    const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
    const tv = new DataView(tail.buffer);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error(`${file.name} isn't a BSSMNT project.`);
    let count = tv.getUint16(eocd + 10, true), cdSize = tv.getUint32(eocd + 12, true), cdOff = tv.getUint32(eocd + 16, true);
    if (count === 0xffff || cdSize === MAX32 || cdOff === MAX32) {
      // ZIP64: the locator sits just before the end record.
      const loc = eocd - 20;
      if (loc < 0 || tv.getUint32(loc, true) !== 0x07064b50) throw new Error(`${file.name}: damaged project index (ZIP64).`);
      const z64At = big64(tv, loc + 8);
      const zv = new DataView(await file.slice(z64At, z64At + 56).arrayBuffer());
      if (zv.getUint32(0, true) !== 0x06064b50) throw new Error(`${file.name}: damaged project index (ZIP64).`);
      count = big64(zv, 32); cdSize = big64(zv, 40); cdOff = big64(zv, 48);
    }
    const cd = new Uint8Array(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const cv = new DataView(cd.buffer);
    const dec = new TextDecoder();
    const entries = new Map();
    for (let i = 0, p = 0; i < count && p + 46 <= cd.length; i++) {
      if (cv.getUint32(p, true) !== 0x02014b50) break;
      const nlen = cv.getUint16(p + 28, true), elen = cv.getUint16(p + 30, true), clen = cv.getUint16(p + 32, true);
      let csize = cv.getUint32(p + 20, true), usize = cv.getUint32(p + 24, true), offset = cv.getUint32(p + 42, true);
      // ZIP64 extra field: the 8-byte values for whichever fields overflowed.
      for (let x = p + 46 + nlen, end = x + elen; x + 4 <= end;) {
        const id = cv.getUint16(x, true), sz = cv.getUint16(x + 2, true);
        if (id === 1) {
          let q = x + 4;
          if (usize === MAX32) { usize = big64(cv, q); q += 8; }
          if (csize === MAX32) { csize = big64(cv, q); q += 8; }
          if (offset === MAX32) { offset = big64(cv, q); q += 8; }
        }
        x += 4 + sz;
      }
      entries.set(dec.decode(cd.subarray(p + 46, p + 46 + nlen)), { method: cv.getUint16(p + 10, true), csize, usize, offset });
      p += 46 + nlen + elen + clen;
    }
    const locate = async (name) => {
      const en = entries.get(name);
      if (!en) return null;
      const lh = new DataView(await file.slice(en.offset, en.offset + 30).arrayBuffer());
      const start = en.offset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      return { blob: file.slice(start, start + en.csize), method: en.method };
    };
    const inflate = async (u) => (await VendorLoader.zip()).inflateSync(u);   // old, compressed projects only
    return {
      file,
      names: () => Array.from(entries.keys()),
      has: (name) => entries.has(name),
      size: (name) => (entries.get(name) || {}).usize,
      async bytes(name) {
        const r = await locate(name);
        if (!r) return null;
        const u = new Uint8Array(await r.blob.arrayBuffer());
        return r.method === 8 ? inflate(u) : u;
      },
      async blob(name, type = '') {
        const r = await locate(name);
        if (!r) return null;
        if (r.method === 0) return r.blob;
        return new Blob([await inflate(new Uint8Array(await r.blob.arrayBuffer()))], { type });
      },
    };
  }

  return { ZipWriter, open, crc32 };
})();

// Temporary files in the browser's private disk area (OPFS), for browsers
// without a save dialog (Firefox): big projects and exports are written to
// disk there first, then downloaded from that file — never held in memory.
const TempDisk = {
  PREFIX: 'bssmnt-tmp-',

  async dir() {
    try { return navigator.storage && navigator.storage.getDirectory ? await navigator.storage.getDirectory() : null; }
    catch (e) { return null; }
  },

  // A fresh temp file with a writer; older temp files are removed first.
  // Throws a clear error when the browser can't give enough space.
  async create(ext, bytesNeeded = 0) {
    const dir = await this.dir();
    if (!dir) return null;
    await this.cleanup(dir);
    if (bytesNeeded && navigator.storage.estimate) {
      let est = await navigator.storage.estimate();
      if (est.quota - est.usage < bytesNeeded * 1.05 && navigator.storage.persist) {
        try { await navigator.storage.persist(); est = await navigator.storage.estimate(); } catch (e) { /* asked */ }
      }
      if (est.quota - est.usage < bytesNeeded * 1.05) {
        const gb = (b) => (b / 1e9).toFixed(1);
        throw new Error(`The browser only allows ${gb(est.quota - est.usage)} GB of working space here and this needs ${gb(bytesNeeded)} GB. Use Chrome or Edge for files this size (they save straight to your disk).`);
      }
    }
    const name = `${this.PREFIX}${Date.now()}.${ext}`;
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    return { name, handle, writable };
  },

  async cleanup(dir) {
    dir = dir || await this.dir();
    if (!dir || !dir.entries) return;
    try {
      for await (const [name] of dir.entries()) if (name.startsWith(this.PREFIX)) await dir.removeEntry(name).catch(() => {});
    } catch (e) { /* nothing to clean */ }
  },
};
