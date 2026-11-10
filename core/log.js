// core/log.js – Structured processing log for script import/export (especially PSB/MDF/XOR .scn).
// Pure ES module, zero dependencies, safe in browser & Node.

const nowMs = () => (globalThis.performance ? globalThis.performance.now() : Date.now());

export function hexHead(bytes, n = 16) {
  if (!bytes || !bytes.length) return '';
  const lim = Math.min(n, bytes.length), out = [];
  for (let i = 0; i < lim; i++) out.push((bytes[i] < 16 ? '0' : '') + bytes[i].toString(16));
  return out.join(' ');
}

export function fnv1aHex(bytes) {
  if (!bytes) return '00000000';
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export async function sha256Hex(bytes) {
  try {
    if (globalThis.crypto && globalThis.crypto.subtle) {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const buf = await globalThis.crypto.subtle.digest('SHA-256', u8);
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (e) { /* fallback to fnv1a */ }
  return 'fnv1a:' + fnv1aHex(bytes);
}

export function sanitizeLogData(val, depth = 0) {
  if (val === undefined || val === null) return val;
  if (typeof val === 'number' || typeof val === 'boolean') return val;
  if (typeof val === 'bigint') return Number(val);
  if (typeof val === 'string') return val.length > 200 ? val.slice(0, 197) + '...' : val;
  if (val instanceof Uint8Array || ArrayBuffer.isView(val)) {
    const u8 = val instanceof Uint8Array ? val : new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
    return `Uint8Array(${u8.length})[${hexHead(u8, 16)}${u8.length > 16 ? ' ...' : ''}]`;
  }
  if (depth > 3) return '[nested]';
  if (Array.isArray(val)) {
    const slice = val.slice(0, 20).map(x => sanitizeLogData(x, depth + 1));
    if (val.length > 20) slice.push(`...(+${val.length - 20} lagi)`);
    return slice;
  }
  if (typeof val === 'object') {
    const out = {};
    const keys = Object.keys(val);
    for (let i = 0; i < Math.min(keys.length, 30); i++) {
      const k = keys[i];
      if (val[k] !== undefined) out[k] = sanitizeLogData(val[k], depth + 1);
    }
    if (keys.length > 30) out._moreKeys = keys.length - 30;
    return out;
  }
  return String(val);
}

export function createLog({ cap = 500, meta = {} } = {}) {
  const t0 = nowMs();
  const entries = [];
  let dropped = 0;
  let capped = false;

  function record(level, step, msg, data) {
    const lv = level || 'info';
    const t = Math.round((nowMs() - t0) * 100) / 100;
    if (entries.length >= cap) {
      capped = true;
      if (lv === 'debug' || lv === 'info') {
        dropped++;
        return;
      }
      // For warn/error when at cap, evict the oldest debug/info entry if possible so warnings/errors are never lost
      const evictIdx = entries.findIndex(e => e.level === 'debug' || e.level === 'info');
      if (evictIdx >= 0) {
        entries.splice(evictIdx, 1);
        dropped++;
      } else {
        dropped++;
        return;
      }
    }
    const rec = { t, level: lv, step: String(step || 'scn'), msg: String(msg || '') };
    if (data !== undefined) rec.data = sanitizeLogData(data);
    entries.push(rec);
  }

  const fn = (level, step, msg, data) => record(level, step, msg, data);
  fn.entries = entries;
  fn.meta = { ...meta };
  Object.defineProperty(fn, 'dropped', { get: () => dropped, enumerable: true });
  Object.defineProperty(fn, 'capped', { get: () => capped, enumerable: true });
  fn.info = (step, msg, data) => record('info', step, msg, data);
  fn.warn = (step, msg, data) => record('warn', step, msg, data);
  fn.error = (step, msg, data) => record('error', step, msg, data);
  fn.debug = (step, msg, data) => record('debug', step, msg, data);
  fn.toJSON = () => ({
    entries,
    dropped,
    capped,
    meta: fn.meta,
    status: summarizeLog(entries)
  });
  return fn;
}

export function normLogger(log) {
  if (!log) return null;
  if (typeof log.info === 'function' && typeof log.warn === 'function' && typeof log.error === 'function') {
    if (typeof log.debug !== 'function') log.debug = (s, m, d) => log.info(s, m, d);
    return log;
  }
  if (typeof log === 'function') {
    return {
      info: (s, m, d) => log('info', s, m, d),
      warn: (s, m, d) => log('warn', s, m, d),
      error: (s, m, d) => log('error', s, m, d),
      debug: (s, m, d) => log('debug', s, m, d),
    };
  }
  return null;
}

export function summarizeLog(log) {
  const list = Array.isArray(log) ? log : (log && Array.isArray(log.entries) ? log.entries : []);
  let hasWarn = false;
  for (let i = 0; i < list.length; i++) {
    const lv = list[i] && list[i].level;
    if (lv === 'error') return 'error';
    if (lv === 'warn') hasWarn = true;
  }
  return hasWarn ? 'warn' : 'ok';
}

function fmtDataLines(data) {
  if (data === undefined || data === null) return '';
  if (typeof data !== 'object' || Array.isArray(data)) return '\n    data=' + JSON.stringify(data);
  const keys = Object.keys(data);
  if (!keys.length) return '';
  return keys.map(k => `\n    ${k}=${typeof data[k] === 'string' ? data[k] : JSON.stringify(data[k])}`).join('');
}

export function formatLog(log, extraMeta = {}) {
  const list = Array.isArray(log) ? log : (log && Array.isArray(log.entries) ? log.entries : []);
  const m = { ...(log && log.meta ? log.meta : {}), ...extraMeta };
  const status = summarizeLog(list);
  const dropped = (log && log.dropped) || 0;
  const ua = m.ua || (globalThis.navigator && globalThis.navigator.userAgent) || 'Node.js';
  const lines = [
    '=== KOPIPE v1.0.0 — Log Proses Berkas ===',
    `waktu      : ${m.time || new Date().toISOString()}`,
    `ua         : ${ua}`,
    `berkas     : ${m.path || m.name || '-'}`,
    `jenis      : ${m.kind || 'scn'}`,
    `ukuran     : ${m.size != null ? m.size + ' byte' : '-'}`,
    `hash       : ${m.hash || '-'}`,
    `status     : ${status.toUpperCase()}${dropped ? ` (dropped=${dropped})` : ''}`,
  ];
  if (m.strategy !== undefined) lines.push(`strategi   : ${m.strategy || '-'}`);
  if (m.entryCount !== undefined) lines.push(`entri      : ${m.entryCount}`);
  lines.push('---------------------------------------------');
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const tStr = `+${Number(e.t || 0).toFixed(2)}ms`.padStart(10, ' ');
    const lv = String(e.level || 'info').toUpperCase().padEnd(5, ' ');
    const st = String(e.step || '-').padEnd(10, ' ');
    lines.push(`[${tStr}] [${lv}] [${st}] ${e.msg}${fmtDataLines(e.data)}`);
  }
  if (dropped > 0) {
    lines.push(`[   RINGBUFFER] ${dropped} baris debug/info dilewati karena batas kapasitas log.`);
  }
  return lines.join('\n') + '\n';
}
