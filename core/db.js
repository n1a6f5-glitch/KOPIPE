// core/db.js – storage adapters with one async API: IndexedDB (browser) and in-memory (tests / fallback).
// Tables: projects(id) · files(id, pid) · blobs(id, pid) · entries(id, pid, fid) · handles(id).
const DB_VERSION = 2;
const TABLES = {
  projects: [],
  files: ['pid'],
  blobs: ['pid'],
  entries: ['pid', 'fid'],
  handles: []
};
const ENTRY_COMPOUND_INDEXES = [
  ['pid_gid', ['pid', 'gid']],
  ['fid_gid', ['fid', 'gid']],
  ['pid_status_gid', ['pid', 'status', 'gid']]
];

export function uid() {
  return (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function buildSearchHaystack(e) {
  const isCh = e.kind === 'C' || (e.name || '').toLowerCase() === 'choice';
  const rawSrc = e.src || '';
  const rawTgt = e.tgt || '';
  const cleanSrc = rawSrc.indexOf('<') >= 0 ? rawSrc.replace(/<T\d+>/g, '').replace(/<BR>/g, ' ').replace(/\s{2,}/g, ' ') : '';
  const cleanTgt = rawTgt.indexOf('<') >= 0 ? rawTgt.replace(/<T\d+>/g, '').replace(/<BR>/g, ' ').replace(/\s{2,}/g, ' ') : '';
  const gidStr = e.gid ? `#${e.gid} #${String(e.gid).padStart(6, '0')}` : '';
  return (
    rawSrc + ' ' + cleanSrc + ' ' +
    rawTgt + ' ' + cleanTgt + ' ' +
    (e.name || '') + ' ' + (e.tgtName || '') + ' ' +
    gidStr + (isCh ? ' choice pilihan select' : '')
  ).toLowerCase();
}

function matchEntryFilter(e, { fid, fidSet, status, qLow, gidFrom }) {
  if (fid && e.fid !== fid) return false;
  if (fidSet && !fidSet.has(e.fid)) return false;
  if (status && e.status !== status) return false;
  if (gidFrom && e.gid < gidFrom) return false;
  if (qLow) {
    const hay = buildSearchHaystack(e);
    if (!hay.includes(qLow)) return false;
  }
  return true;
}

export function createMemoryStore() {
  const t = { projects: new Map(), files: new Map(), blobs: new Map(), entries: new Map(), handles: new Map() };
  const clone = v => (v === undefined ? v : structuredClone(v));
  return {
    kind: 'memory',
    async get(table, id) { return clone(t[table].get(id)); },
    async put(table, rec) { t[table].set(rec.id, clone(rec)); return rec.id; },
    async putMany(table, recs) { for (const r of recs) t[table].set(r.id, clone(r)); },
    async delete(table, id) { t[table].delete(id); },
    async all(table) { return [...t[table].values()].map(clone); },
    async where(table, field, value) { return [...t[table].values()].filter(r => r[field] === value).map(clone); },
    async deleteWhere(table, field, value) { for (const [k, r] of [...t[table]]) if (r[field] === value) t[table].delete(k); },
    async queryEntries(pid, opts = {}) {
      const { fid, fids, status, q, gidFrom = 0, offset = 0, limit = 0, knownTotal } = opts;
      const fidSet = fids && fids.length ? new Set(fids) : null;
      const qLow = q ? q.trim().toLowerCase() : '';
      const all = [];
      for (const r of t.entries.values()) {
        if (r.pid !== pid) continue;
        if (matchEntryFilter(r, { fid, fidSet, status, qLow, gidFrom })) all.push(r);
      }
      all.sort((a, b) => a.gid - b.gid);
      const total = knownTotal != null && !qLow && !gidFrom ? knownTotal : all.length;
      const slice = limit > 0 ? all.slice(offset, offset + limit) : (offset > 0 ? all.slice(offset) : all);
      return { items: slice.map(clone), total };
    }
  };
}

export function createIdbStore(name = 'kopipe') {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const rq = indexedDB.open(name, DB_VERSION);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      const tx = rq.transaction;
      for (const [tb, idx] of Object.entries(TABLES)) {
        const os = db.objectStoreNames.contains(tb) ? tx.objectStore(tb) : db.createObjectStore(tb, { keyPath: 'id' });
        idx.forEach(f => { if (!os.indexNames.contains(f)) os.createIndex(f, f); });
      }
      const eos = tx.objectStore('entries');
      for (const [iname, keyPath] of ENTRY_COMPOUND_INDEXES) {
        if (!eos.indexNames.contains(iname)) eos.createIndex(iname, keyPath);
      }
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  }));
  const run = async (tables, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(tables, mode); let out;
      Promise.resolve(fn(tx)).then(v => { out = v; }, rej);
      tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
  };
  const rq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    kind: 'indexeddb',
    get: (tb, id) => run([tb], 'readonly', tx => rq(tx.objectStore(tb).get(id))),
    put: (tb, rec) => run([tb], 'readwrite', tx => rq(tx.objectStore(tb).put(rec))),
    putMany: (tb, recs) => run([tb], 'readwrite', tx => { const os = tx.objectStore(tb); recs.forEach(r => os.put(r)); }),
    delete: (tb, id) => run([tb], 'readwrite', tx => rq(tx.objectStore(tb).delete(id))),
    all: tb => run([tb], 'readonly', tx => rq(tx.objectStore(tb).getAll())),
    where: (tb, f, v) => run([tb], 'readonly', tx => rq(tx.objectStore(tb).index(f).getAll(v))),
    deleteWhere: (tb, f, v) => run([tb], 'readwrite', tx => new Promise((res, rej) => {
      const c = tx.objectStore(tb).index(f).openKeyCursor(IDBKeyRange.only(v)); const os = tx.objectStore(tb);
      c.onsuccess = () => { const cur = c.result; if (cur) { os.delete(cur.primaryKey); cur.continue(); } else res(); };
      c.onerror = () => rej(c.error);
    })),
    queryEntries: (pid, opts = {}) => run(['entries'], 'readonly', tx => new Promise((res, rej) => {
      const { fid, fids, status, q, gidFrom = 0, offset = 0, limit = 0, knownTotal } = opts;
      const fidSet = fids && fids.length ? new Set(fids) : null;
      const qLow = q ? q.trim().toLowerCase() : '';
      const os = tx.objectStore('entries');

      // Fast indexed cursor path when no text filter or multi-file set filter is needed
      const canUseDirectIndex = !qLow && !fidSet && (
        (!fid && !status && os.indexNames.contains('pid_gid')) ||
        (!fid && status && os.indexNames.contains('pid_status_gid')) ||
        (fid && !status && os.indexNames.contains('fid_gid'))
      );

      if (canUseDirectIndex && limit > 0 && knownTotal != null) {
        let idx, range;
        if (!fid && !status) {
          idx = os.index('pid_gid');
          range = IDBKeyRange.bound([pid, gidFrom || 0], [pid, Number.MAX_SAFE_INTEGER]);
        } else if (!fid && status) {
          idx = os.index('pid_status_gid');
          range = IDBKeyRange.bound([pid, status, gidFrom || 0], [pid, status, Number.MAX_SAFE_INTEGER]);
        } else {
          idx = os.index('fid_gid');
          range = IDBKeyRange.bound([fid, gidFrom || 0], [fid, Number.MAX_SAFE_INTEGER]);
        }
        const items = [];
        let advanced = offset <= 0;
        const req = idx.openCursor(range);
        req.onsuccess = () => {
          const cur = req.result;
          if (!cur) { res({ items, total: knownTotal }); return; }
          if (!advanced) { advanced = true; cur.advance(offset); return; }
          items.push(cur.value);
          if (items.length < limit) cur.continue();
          else res({ items, total: knownTotal });
        };
        req.onerror = () => rej(req.error);
        return;
      }

      // Single bulk getAll() call on index (avoids 37,000+ sequential cursor IPC round-trips)
      let idx, range;
      if (fid && os.indexNames.contains('fid_gid')) {
        idx = os.index('fid_gid');
        range = IDBKeyRange.bound([fid, gidFrom || 0], [fid, Number.MAX_SAFE_INTEGER]);
      } else if (!fid && status && os.indexNames.contains('pid_status_gid')) {
        idx = os.index('pid_status_gid');
        range = IDBKeyRange.bound([pid, status, gidFrom || 0], [pid, status, Number.MAX_SAFE_INTEGER]);
      } else if (os.indexNames.contains('pid_gid')) {
        idx = os.index('pid_gid');
        range = IDBKeyRange.bound([pid, gidFrom || 0], [pid, Number.MAX_SAFE_INTEGER]);
      } else {
        idx = os.index('pid');
        range = IDBKeyRange.only(pid);
      }

      const req = idx.getAll(range);
      req.onsuccess = () => {
        const raw = req.result || [];
        const matched = [];
        for (let i = 0; i < raw.length; i++) {
          const val = raw[i];
          if (matchEntryFilter(val, { fid, fidSet, status, qLow, gidFrom })) {
            matched.push(val);
          }
        }
        const total = knownTotal != null && !qLow && !gidFrom ? knownTotal : matched.length;
        const items = limit > 0 ? matched.slice(offset, offset + limit) : (offset > 0 ? matched.slice(offset) : matched);
        res({ items, total });
      };
      req.onerror = () => rej(req.error);
    })),
  };
}

export async function createStore(name) {
  try { if (globalThis.indexedDB) { const s = createIdbStore(name); await s.all('projects'); return s; } } catch (e) { /* private mode etc. */ }
  return createMemoryStore();
}
