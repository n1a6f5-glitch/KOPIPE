// core/zip.js – minimal ZIP writer (STORE, no compression) with nested path normalization + streaming Blob builder.
const T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

export function normZipPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

export function createZipWriter() {
  const enc = new TextEncoder(), parts = [], central = [];
  let off = 0, count = 0;
  const d = new Date();
  const dt = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1));
  const dd = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate());
  return {
    add(nameOrPath, rawBytes) {
      const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes || 0);
      const nm = enc.encode(normZipPath(nameOrPath));
      const crc = crc32(bytes), sz = bytes.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dt, true); lh.setUint16(12, dd, true); lh.setUint32(14, crc, true); lh.setUint32(18, sz, true); lh.setUint32(22, sz, true); lh.setUint16(26, nm.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), nm, bytes);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 0x0314, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dt, true); ch.setUint16(14, dd, true); ch.setUint32(16, crc, true); ch.setUint32(20, sz, true); ch.setUint32(24, sz, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
      central.push(new Uint8Array(ch.buffer), nm);
      off += 30 + nm.length + sz;
      count++;
    },
    chunks() {
      const cdSize = central.reduce((a, p) => a + p.length, 0), end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true); end.setUint16(8, count, true); end.setUint16(10, count, true); end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
      return [...parts, ...central, new Uint8Array(end.buffer)];
    },
    toBlob() {
      return new Blob(this.chunks(), { type: 'application/zip' });
    },
    toUint8Array() {
      const all = this.chunks(), out = new Uint8Array(all.reduce((a, p) => a + p.length, 0));
      let o = 0;
      for (const p of all) { out.set(p, o); o += p.length; }
      return out;
    }
  };
}

// files: [{name, path?, bytes:Uint8Array}] -> Uint8Array
export function zip(files) {
  const w = createZipWriter();
  for (const f of files) w.add(f.path || f.name, f.bytes);
  return w.toUint8Array();
}

// files: [{name, path?, bytes:Uint8Array}] -> Blob (avoids contiguous buffer copy for huge folder exports)
export function zipBlob(files) {
  const w = createZipWriter();
  for (const f of files) w.add(f.path || f.name, f.bytes);
  return w.toBlob();
}
