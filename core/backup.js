// core/backup.js – full project export/import as a single JSON (optionally gzipped) so users can back up outside IndexedDB.
import { uid } from './db.js';
import { getFileBlob, recount, normPath } from './project.js';

const FORMAT = 'kopipe-backup';
const LEGACY_FORMAT = 'kopipe-legacy-backup';
const b64enc = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const b64dec = str => { const s = atob(str), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
const pipe = async (b, st) => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(st)).arrayBuffer());

export async function exportProject(store, pid, { gzip = typeof CompressionStream !== 'undefined' } = {}) {
  const project = await store.get('projects', pid); if (!project) throw new Error('Project not found');
  const rawFiles = await store.where('files', 'pid', pid);
  const files = [];
  for (const f of rawFiles) {
    const blob = await getFileBlob(store, f);
    files.push({ ...f, path: normPath(f.path || f.name), bytes: b64enc(blob.bytes || new Uint8Array(0)), tagStore: blob.tagStore || {} });
  }
  const entries = await store.where('entries', 'pid', pid);
  const raw = new TextEncoder().encode(JSON.stringify({ format: FORMAT, version: 2, exportedAt: Date.now(), project, files, entries }));
  return gzip ? pipe(raw, new CompressionStream('gzip')) : raw;
}

export async function importProject(store, bytes) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (bytes[0] === 0x1F && bytes[1] === 0x8B) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Browser does not support DecompressionStream');
    bytes = await pipe(bytes, new DecompressionStream('gzip'));
  }
  let d; try { d = JSON.parse(new TextDecoder('utf-8').decode(bytes)); } catch (e) { throw new Error('Bukan file backup KOPIPE yang valid'); }
  if (!d || (d.format !== FORMAT && d.format !== LEGACY_FORMAT) || !d.project) throw new Error('Bukan file backup KOPIPE yang valid');
  const pid = uid(), fmap = new Map();
  const proj = { ...d.project, id: pid, name: d.project.name + (await store.get('projects', d.project.id) ? ' (pulih)' : ''), updatedAt: Date.now() };
  delete proj.lastUndo;
  await store.put('projects', proj);
  const fMeta = [], fBlobs = [];
  for (const f of d.files || []) {
    const fid = uid(); fmap.set(f.id, fid);
    const decoded = b64dec(f.bytes || '');
    const { bytes: _b, tagStore, ...rest } = f;
    fMeta.push({ ...rest, id: fid, pid, path: normPath(f.path || f.name) });
    fBlobs.push({ id: fid, pid, bytes: decoded, tagStore: tagStore || {} });
  }
  if (fBlobs.length) await store.putMany('blobs', fBlobs);
  if (fMeta.length) await store.putMany('files', fMeta);
  const entries = (d.entries || []).map(e => ({ ...e, id: uid(), pid, fid: fmap.get(e.fid) || e.fid }));
  for (let i = 0; i < entries.length; i += 2000) {
    await store.putMany('entries', entries.slice(i, i + 2000));
  }
  await recount(store, pid);
  return pid;
}
