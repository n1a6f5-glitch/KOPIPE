// core/project.js – project model on top of a store (core/db.js): import scripts, edit translations, batch export/apply, repack.
import { uid } from './db.js';
import { importScript, exportScript } from './engines/index.js';
import { LINE_RE, parseBatchUnified, formatBatchLine, formatFileHeader, padGlobalId, detectEntryKind, isNarrationSpeaker, isChoiceSpeaker } from './batch.js';
export { isNarrationSpeaker, isChoiceSpeaker };
import { sortGls } from './util.js';
import { analyzeTagSafety, stripTagsForAi, fixTags, validate, glossaryRules, CRIT_TYPES } from './qc.js';
import { matchVndb, buildGls } from './vndb.js';
import { createLog, summarizeLog, formatLog } from './log.js';

export const APP_VERSION = '1.2.1';
export const SCHEMA_VERSION = 2;
export const STATUS = ['todo', 'draft', 'done', 'flag'];
export const SCRIPT_EXTS = ['.ks', '.txt', '.ast', '.scn', '.json'];

export const DEFAULT_PROMPTS = {
  en: [
    'Translate the following Japanese Visual Novel script into natural, fluent English. Preserve the original meaning, character personalities, tone, and scene context.',
    'Formatting rules:',
    '- Preserve all --- FILE: ... --- headers and line IDs exactly.',
    '- Keep the original speaker prefix ([Name] or (Narasi)) unchanged.',
    '- Translate character dialogue naturally as spoken English, and narration as fluent narrative prose.',
    '- Maintain a strict 1:1 line correspondence. Never merge, split, reorder, or omit lines.',
    '- Preserve all control markers and formatting tags, including <BR>, <T1>, and similar markers, exactly as they appear.',
    '- Preserve quotation marks and dialogue formatting where applicable.',
    '- Output only the translated script. No explanations or additional commentary.',
    '- Wrap the entire translated output in a single Markdown code block. Do not use multiple code blocks.',
    'Interpret ambiguous expressions according to the surrounding context rather than translating them literally. Preserve subtext, implications, and character-specific speech patterns without adding meaning that isn\'t present in the original.'
  ].join('\n'),
  id: [
    'Terjemahkan naskah Visual Novel Jepang berikut ke dalam Bahasa Indonesia yang alami dan luwes. Pertahankan makna asli, kepribadian karakter, nada bicara, dan konteks adegan.',
    'Aturan format:',
    '- Pertahankan semua header --- FILE: ... --- dan nomor ID baris secara persis.',
    '- Jangan ubah prefix pembicara ([Nama] atau (Narasi)).',
    '- Terjemahkan dialog karakter secara alami layaknya percakapan lisan, dan narasi sebagai prosa naratif yang mengalir.',
    '- Pertahankan kesesuaian baris 1:1 secara ketat. Jangan menggabungkan, memecah, mengubah urutan, atau melewati baris mana pun.',
    '- Pertahankan semua penanda kontrol dan tag format, termasuk <BR>, <T1>, dan penanda serupa persis seperti aslinya.',
    '- Pertahankan tanda kutip dan format dialog sebagaimana mestinya.',
    '- Keluarkan hanya naskah hasil terjemahan. Tanpa penjelasan atau komentar tambahan.',
    '- Bungkus seluruh hasil terjemahan dalam satu blok kode Markdown tunggal (single Markdown code block). Jangan gunakan banyak blok kode.',
    'Tafsirkan ungkapan yang ambigu sesuai konteks kalimat di sekitarnya, bukan diterjemahkan secara harfiah kata per kata. Pertahankan subteks, implikasi, dan ciri khas gaya bicara tiap karakter tanpa menambahkan makna yang tidak ada di teks asli.'
  ].join('\n')
};

export const DEFAULT_QC_PROMPTS = {
  en: [
    'Review, polish, and edit the following translated Visual Novel script lines using the original Japanese source (`# JP:`) and Glossary as reference.',
    'Polishing & formatting rules:',
    '- Refine stiff, awkward, or overly literal translations into natural, fluent English while remaining faithful to the original Japanese meaning, subtext, and character voice.',
    '- Translate character dialogue ([Name]) as natural spoken English and narration ((Narasi)) as smooth narrative prose.',
    '- Enforce strict consistency with the provided Glossary for character names and terms, and translate any remaining untranslated Japanese text.',
    '- Preserve all --- FILE: ... --- headers, line IDs, speaker prefixes ([Name] or (Narasi)), and formatting tags (<BR>, <T1>, etc.) with a strict 1:1 line correspondence.',
    '- Do not include the `# JP:` or `# [QC ...]` reference comment lines in your output.',
    '- Output only the polished script lines with no explanations, wrapped in a single Markdown code block.'
  ].join('\n'),
  id: [
    'Tinjau, poles, dan perbaiki kualitas terjemahan naskah Visual Novel berikut dengan mengacu pada teks Jepang asli (`# JP:`) dan Kamus (Glossary).',
    'Aturan pemolesan & format:',
    '- Perhalus kalimat yang kaku, janggal, atau terlalu harfiah menjadi Bahasa Indonesia yang alami dan luwes tanpa mengubah makna asli, subteks, maupun ciri khas bicara karakter.',
    '- Pastikan dialog karakter ([Nama]) terdengar seperti percakapan lisan yang hidup dan narasi ((Narasi)) mengalir sebagai prosa naratif.',
    '- Pastikan konsistensi penuh dengan Kamus (Glossary) untuk nama karakter dan istilah, serta terjemahkan huruf Jepang yang masih tersisa.',
    '- Pertahankan semua header --- FILE: ... ---, nomor ID baris, prefix pembicara ([Nama] atau (Narasi)), dan tag format (<BR>, <T1>, dll.) secara persis 1:1.',
    '- Jangan sertakan baris komentar referensi `# JP:` atau `# [QC ...]` di dalam hasil akhir.',
    '- Keluarkan hanya baris terjemahan yang sudah dipoles tanpa komentar tambahan, dibungkus dalam satu blok kode Markdown tunggal.'
  ].join('\n')
};

function formatGlossaryForPrompt(glossary, text, lang) {
  const all = Object.entries(glossary || {}).filter(([k, v]) => k && v && v.trim());
  if (!all.length) return '';
  const matched = all.filter(([k, v]) => text.includes(k) || text.includes(v.trim()));
  const chosen = matched.length ? matched : all.slice(0, 150);
  return '\n\n' + (lang === 'id' ? 'Glossary / Kamus:' : 'Glossary:') + '\n' + chosen.map(([k, v]) => `- ${k} = ${v.trim()}`).join('\n');
}

export function fixTagSpacing(text) {
  if (!text) return '';
  return String(text).replace(/([A-Za-z0-9])((?:<T\d+>)+)(?=[A-Za-z0-9])/g, '$1 $2');
}

export function buildBatchPrompt(lang, { glossary = {}, batchText = '', customPrompt = '', includeGlossary = false } = {}) {
  if (!lang || lang === 'none' || !batchText) return batchText;
  const base = lang === 'custom'
    ? (customPrompt && customPrompt.trim() ? customPrompt.trim() : DEFAULT_PROMPTS.en)
    : (DEFAULT_PROMPTS[lang] || DEFAULT_PROMPTS.en);
  const glsBlock = includeGlossary ? formatGlossaryForPrompt(glossary, batchText, lang) : '';
  return `=== PROMPT AI ===\n${base}${glsBlock}\n=== NASKAH / SCRIPT ===\n${batchText}`;
}

export function buildQcPrompt(lang, { glossary = {}, qcText = '', customPrompt = '', includeGlossary = false } = {}) {
  if (!lang || lang === 'none' || !qcText) return qcText;
  const base = lang === 'custom'
    ? (customPrompt && customPrompt.trim() ? customPrompt.trim() : DEFAULT_QC_PROMPTS.en)
    : (DEFAULT_QC_PROMPTS[lang] || DEFAULT_QC_PROMPTS.en);
  const glsBlock = includeGlossary ? formatGlossaryForPrompt(glossary, qcText, lang) : '';
  return `=== PROMPT QC AI ===\n${base}${glsBlock}\n=== DAFTAR BARIS QC ===\n${qcText}`;
}

export function stripPromptHeader(text) {
  if (!text) return '';
  return String(text)
    .replace(/^=== PROMPT (?:QC )?AI ===[\s\S]*?=== (?:NASKAH \/ SCRIPT|DAFTAR BARIS QC) ===\r?\n?/i, '')
    .split(/\r?\n/)
    .filter(line => !/^\s*```/.test(line) && !/^\s*#\s*(?:\[QC\b|JP:)/i.test(line))
    .join('\n');
}

export function stripAllTagsForAi(text) {
  if (!text) return '';
  return String(text).replace(/<T\d+>/g, '').replace(/\s{2,}/g, ' ').trim();
}

const tagsOf = s => (s.match(/<T\d+>/g) || []).sort().join('');
const emptyStats = () => ({ total: 0, todo: 0, draft: 0, done: 0, flag: 0 });
const PUT_CHUNK = 2000;

const collator = new globalThis.Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// Per-store in-memory metadata cache for O(1) stats() and listFiles()
const _metaCache = new globalThis.WeakMap();
function getCache(store, pid) {
  let m = _metaCache.get(store);
  if (!m) { m = new Map(); _metaCache.set(store, m); }
  let c = m.get(pid);
  if (!c) { c = { proj: null, files: null }; m.set(pid, c); }
  return c;
}
function invalidateCache(store, pid) {
  const m = _metaCache.get(store);
  if (m) {
    if (pid) m.delete(pid);
    else m.clear();
  }
}

export function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim();
}

export function baseName(p) {
  const n = normPath(p);
  const idx = n.lastIndexOf('/');
  return idx >= 0 ? n.slice(idx + 1) : n;
}

export function dirName(p) {
  const n = normPath(p);
  const idx = n.lastIndexOf('/');
  return idx >= 0 ? n.slice(0, idx) : '';
}

// Natural path comparator keeping folder hierarchy grouped and sorting a2 before a10
export function naturalPathCompare(a, b) {
  const pa = normPath(a).split('/'), pb = normPath(b).split('/');
  const len = Math.min(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const isFileA = i === pa.length - 1, isFileB = i === pb.length - 1;
    if (isFileA !== isFileB) return isFileA ? 1 : -1;
    const c = collator.compare(pa[i], pb[i]);
    if (c !== 0) return c;
  }
  return pa.length - pb.length;
}

function applyStatDelta(statsObj, oldSt, newSt) {
  if (!statsObj || oldSt === newSt) return;
  if (oldSt && statsObj[oldSt] > 0) statsObj[oldSt]--;
  if (newSt && newSt in statsObj) statsObj[newSt]++;
}

async function putEntriesChunked(store, entries) {
  if (!entries.length) return;
  if (entries.length <= PUT_CHUNK) {
    await store.putMany('entries', entries);
    return;
  }
  for (let i = 0; i < entries.length; i += PUT_CHUNK) {
    await store.putMany('entries', entries.slice(i, i + PUT_CHUNK));
  }
}

export async function createProject(store, name, settings = {}) {
  const p = {
    id: uid(),
    name: name || 'New Project',
    schemaVersion: SCHEMA_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nextGid: 1,
    nextOrder: 1,
    stats: emptyStats(),
    glossary: {},
    settings: { fmt: 'v25b', batchSize: 100, wrapWidth: 0, wrapSep: 'auto', maxLen: 0, promptLang: 'en', qcPromptLang: 'en', ...settings }
  };
  await store.put('projects', p);
  const c = getCache(store, p.id);
  c.proj = p;
  c.files = [];
  return p;
}

export const listProjects = async store => (await store.all('projects')).sort((a, b) => b.updatedAt - a.updatedAt);

export async function deleteProject(store, pid) {
  invalidateCache(store, pid);
  await store.deleteWhere('entries', 'pid', pid);
  await store.deleteWhere('files', 'pid', pid);
  try { await store.deleteWhere('blobs', 'pid', pid); } catch (e) { /* ignore if old store */ }
  try { await store.delete('handles', pid); } catch (e) { /* ignore */ }
  await store.delete('projects', pid);
}

async function touch(store, p) {
  p.updatedAt = Date.now();
  await store.put('projects', p);
  getCache(store, p.id).proj = p;
}

// Full recount & lazy v1->v2 migration: splits inline file.bytes/tagStore into `blobs` table and rebuilds cached counters.
export async function recount(store, pid) {
  invalidateCache(store, pid);
  const p = await store.get('projects', pid);
  if (!p) return emptyStats();
  const files = await store.where('files', 'pid', pid);
  const entries = await store.where('entries', 'pid', pid);
  const fStats = new Map();
  for (const f of files) fStats.set(f.id, emptyStats());
  const pStats = emptyStats();
  for (const e of entries) {
    const st = STATUS.includes(e.status) ? e.status : 'todo';
    pStats.total++;
    pStats[st]++;
    const fs = fStats.get(e.fid);
    if (fs) { fs.total++; fs[st]++; }
  }
  const updatedFiles = [], newBlobs = [];
  for (const f of files) {
    const fs = fStats.get(f.id) || emptyStats();
    let changed = false;
    if (f.bytes !== undefined || f.tagStore !== undefined) {
      newBlobs.push({ id: f.id, pid, bytes: f.bytes, tagStore: f.tagStore || {} });
      delete f.bytes;
      delete f.tagStore;
      changed = true;
    }
    const np = normPath(f.path || f.name);
    if (f.path !== np) { f.path = np; changed = true; }
    if (f.entryCount !== fs.total || JSON.stringify(f.stats) !== JSON.stringify(fs)) {
      f.entryCount = fs.total;
      f.stats = fs;
      changed = true;
    }
    if (!f.logStatus) {
      f.logStatus = f.importLog ? summarizeLog(f.importLog) : (f.kind === 'scn' && fs.total === 0 ? 'warn' : 'ok');
      changed = true;
    }
    if (changed) updatedFiles.push(f);
  }
  if (newBlobs.length) await store.putMany('blobs', newBlobs);
  if (updatedFiles.length) await store.putMany('files', updatedFiles);
  p.stats = pStats;
  p.schemaVersion = SCHEMA_VERSION;
  await store.put('projects', p);
  const c = getCache(store, pid);
  c.proj = p;
  c.files = files.sort((a, b) => a.order - b.order).map(({ bytes: _b, tagStore: _t, ...f }) => ({ ...f, path: normPath(f.path || f.name), stats: f.stats || emptyStats() }));
  return { ...pStats };
}

export async function ensureMigrated(store, pid) {
  const c = getCache(store, pid);
  if (c.proj && c.proj.schemaVersion === SCHEMA_VERSION && c.proj.stats && typeof c.proj.stats.total === 'number') {
    return c.proj;
  }
  const p = await store.get('projects', pid);
  if (!p) return null;
  if (p.schemaVersion !== SCHEMA_VERSION || !p.stats || typeof p.stats.total !== 'number') {
    await recount(store, pid);
    return getCache(store, pid).proj || store.get('projects', pid);
  }
  c.proj = p;
  return p;
}

export async function getFileBlob(store, f) {
  if (!f) return null;
  if (f.bytes !== undefined && f.tagStore !== undefined) return { id: f.id, pid: f.pid, bytes: f.bytes, tagStore: f.tagStore };
  const b = await store.get('blobs', f.id);
  if (b) return b;
  return { id: f.id, pid: f.pid, bytes: f.bytes || new Uint8Array(0), tagStore: f.tagStore || {} };
}

// Import one script: extract with the project glossary, store original bytes + tagStore in `blobs`, metadata in `files`, entries in `entries`.
export async function addFile(store, pid, name, bytes, opts = {}) {
  const p = await ensureMigrated(store, pid); if (!p) throw new Error('Proyek tidak ada');
  const sg = sortGls(p.glossary || {});
  const relPath = normPath(opts.path || name);
  const bName = baseName(relPath) || name;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const log = opts.log || createLog({ cap: 500, meta: { name: bName, path: relPath, size: u8.length } });
  const ex = await importScript(bName, u8, { sg, ...opts, log });
  const fid = uid();
  const entries = [];
  for (const l of ex.lines) {
    const m = LINE_RE.exec(l); if (!m) continue;
    const body = m[4] || '', nm = m[2];
    entries.push({
      id: uid(), pid, fid, idx: m[1], gid: p.nextGid++,
      name: nm, src: body, tgt: '', tgtName: '', status: 'todo',
      kind: detectEntryKind(nm, body)
    });
  }
  if (ex.kind === 'scn' && entries.length === 0 && summarizeLog(log) === 'ok') {
    log.warn('entries', 'Berkas .scn menghasilkan 0 entri teks');
  }
  const fStats = { total: entries.length, todo: entries.length, draft: 0, done: 0, flag: 0 };
  const logJson = log.toJSON ? log.toJSON() : { entries: log.entries || [], status: summarizeLog(log) };
  const file = {
    id: fid, pid, name: bName, path: relPath, size: u8.length,
    kind: ex.kind, meta: ex.meta, order: p.nextOrder++,
    entryCount: entries.length, stats: fStats,
    logStatus: summarizeLog(logJson), importLog: logJson
  };
  await store.put('blobs', { id: fid, pid, bytes: new Uint8Array(u8), tagStore: ex.tagStore });
  await store.put('files', file);
  await putEntriesChunked(store, entries);
  p.stats.total += entries.length;
  p.stats.todo += entries.length;
  await touch(store, p);
  const c = getCache(store, pid);
  if (c.files) c.files.push({ ...file });
  return { file, count: entries.length, skipped: ex.skipped || [], log: logJson };
}

// Update an existing file's source bytes while preserving translations whose idx+src or src match
export async function updateFileSource(store, fid, bytes, opts = {}) {
  const f = await store.get('files', fid); if (!f) throw new Error('File tidak ada');
  const p = await ensureMigrated(store, f.pid); if (!p) throw new Error('Proyek tidak ada');
  const sg = sortGls(p.glossary || {});
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const log = opts.log || createLog({ cap: 500, meta: { name: f.name, path: f.path || f.name, size: u8.length } });
  const ex = await importScript(f.name, u8, { sg, ...opts, log });

  const oldEntries = await store.where('entries', 'fid', fid);
  oldEntries.sort((a, b) => a.gid - b.gid);
  const byIdx = new Map(oldEntries.map(e => [String(e.idx), e]));
  const bySrc = new Map();
  for (const e of oldEntries) {
    if (e.tgt && e.tgt.trim()) {
      const k = (e.name || '') + '\0' + e.src;
      if (!bySrc.has(k)) bySrc.set(k, []);
      bySrc.get(k).push(e);
    }
  }

  const oldFs = f.stats || emptyStats();
  p.stats.total = Math.max(0, p.stats.total - oldFs.total);
  for (const k of STATUS) p.stats[k] = Math.max(0, p.stats[k] - (oldFs[k] || 0));

  const newEntries = [];
  const fStats = emptyStats();
  let kept = 0;

  for (let i = 0; i < ex.lines.length; i++) {
    const m = LINE_RE.exec(ex.lines[i]); if (!m) continue;
    const idx = m[1], nm = m[2], body = m[4] || '';
    let match = byIdx.get(String(idx));
    if (!match || match.src !== body) {
      const list = bySrc.get((nm || '') + '\0' + body);
      if (list && list.length) match = list.shift();
      else if (match && (!match.tgt || !match.tgt.trim())) match = null;
    }
    const gid = (i < oldEntries.length) ? oldEntries[i].gid : p.nextGid++;
    let tgt = '', tgtName = '', status = 'todo', note;
    if (match && match.tgt && match.tgt.trim()) {
      tgt = match.tgt;
      tgtName = match.tgtName || '';
      status = match.status === 'done' ? 'done' : 'draft';
      if (!checkTags(body, tgt)) { status = 'flag'; note = 'tag <T#> tidak cocok'; }
      kept++;
    }
    const rec = { id: (match && match.id) || uid(), pid: f.pid, fid, idx, gid, name: nm, src: body, tgt, tgtName, status, kind: detectEntryKind(nm, body) };
    if (note) rec.note = note;
    newEntries.push(rec);
    fStats.total++;
    fStats[status]++;
  }

  if (ex.kind === 'scn' && newEntries.length === 0 && summarizeLog(log) === 'ok') {
    log.warn('entries', 'Berkas .scn menghasilkan 0 entri teks');
  }
  const logJson = log.toJSON ? log.toJSON() : { entries: log.entries || [], status: summarizeLog(log) };

  await store.deleteWhere('entries', 'fid', fid);
  await store.put('blobs', { id: fid, pid: f.pid, bytes: new Uint8Array(u8), tagStore: ex.tagStore });
  f.size = u8.length;
  f.kind = ex.kind;
  f.meta = ex.meta;
  f.entryCount = newEntries.length;
  f.stats = fStats;
  f.logStatus = summarizeLog(logJson);
  f.importLog = logJson;
  await store.put('files', f);
  await putEntriesChunked(store, newEntries);

  p.stats.total += fStats.total;
  for (const k of STATUS) p.stats[k] += fStats[k];
  await touch(store, p);
  getCache(store, f.pid).files = null;
  return { file: f, count: newEntries.length, kept, skipped: ex.skipped || [], log: logJson };
}

export async function removeAllFiles(store, pid) {
  const p = await ensureMigrated(store, pid);
  await store.deleteWhere("entries", "pid", pid);
  const files = await store.where("files", "pid", pid);
  for (const f of files) {
    try { await store.delete("blobs", f.id); } catch (e) { /* ignore */ }
  }
  await store.deleteWhere("files", "pid", pid);
  const c = getCache(store, pid);
  c.files = [];
  if (p) {
    p.stats = emptyStats();
    p.nextGid = 1;
    p.nextOrder = 1;
    delete p.lastUndo;
    await touch(store, p);
  }
}

export async function removeFile(store, fid) {
  const f = await store.get('files', fid);
  if (!f) return;
  const p = await ensureMigrated(store, f.pid);
  await store.deleteWhere('entries', 'fid', fid);
  try { await store.delete('blobs', fid); } catch (e) { /* ignore */ }
  await store.delete('files', fid);
  const c = getCache(store, f.pid);
  if (c.files) c.files = c.files.filter(x => x.id !== fid);
  if (p) {
    if (f.stats) {
      p.stats.total = Math.max(0, p.stats.total - (f.stats.total || 0));
      for (const k of STATUS) p.stats[k] = Math.max(0, p.stats[k] - (f.stats[k] || 0));
      await touch(store, p);
    } else {
      await recount(store, f.pid);
    }
  }
}

export const listFiles = async (store, pid) => {
  await ensureMigrated(store, pid);
  const c = getCache(store, pid);
  if (c.files) return c.files;
  const list = (await store.where('files', 'pid', pid))
    .sort((a, b) => a.order - b.order)
    .map(({ bytes: _b, tagStore: _t, ...f }) => ({ ...f, path: normPath(f.path || f.name), stats: f.stats || { total: f.entryCount || 0, todo: f.entryCount || 0, draft: 0, done: 0, flag: 0 } }));
  c.files = list;
  return list;
};

export function resolveScopeFids(files, { fid, folder, fids } = {}) {
  if (fids && fids.length) return fids;
  if (fid) return [fid];
  if (folder) {
    const prefix = normPath(folder).replace(/\/+$/, '') + '/';
    return files.filter(f => normPath(f.path || f.name).startsWith(prefix)).map(f => f.id);
  }
  return null;
}

export async function listEntries(store, pid, { fid, folder, fids, status, q } = {}) {
  let rfids = fids;
  if (!rfids && folder) {
    const files = await listFiles(store, pid);
    rfids = resolveScopeFids(files, { folder });
    if (rfids && !rfids.length) return [];
  }
  let es;
  if (fid) es = await store.where('entries', 'fid', fid);
  else if (rfids && rfids.length === 1) es = await store.where('entries', 'fid', rfids[0]);
  else {
    es = await store.where('entries', 'pid', pid);
    if (rfids && rfids.length) {
      const set = new Set(rfids);
      es = es.filter(e => set.has(e.fid));
    }
  }
  es.sort((a, b) => a.gid - b.gid);
  if (status) es = es.filter(e => e.status === status);
  if (q) {
    const n = q.trim().toLowerCase();
    if (n) {
      es = es.filter(e => {
        const isCh = e.kind === "C" || (e.name || "").toLowerCase() === "choice";
        const cleanSrc = (e.src || "").replace(/<T\d+>/g, "").replace(/<BR>/g, " ");
        const cleanTgt = (e.tgt || "").replace(/<T\d+>/g, "").replace(/<BR>/g, " ");
        const gidStr = e.gid ? `#${e.gid} #${String(e.gid).padStart(6, "0")}` : "";
        const hay = ((e.src || "") + " " + cleanSrc + " " + (e.tgt || "") + " " + cleanTgt + " " + (e.name || "") + " " + (e.tgtName || "") + " " + gidStr + (isCh ? " choice pilihan select" : "")).toLowerCase();
        return hay.includes(n);
      });
    }
  }
  return es;
}

export async function listEntriesPage(store, pid, { fid, folder, fids, status, q, offset = 0, limit = 50, gidFrom = 0 } = {}) {
  const p = await ensureMigrated(store, pid);
  if (!p) return { items: [], total: 0 };
  let rfids = fids;
  let files = null;
  if (folder && !rfids) {
    files = await listFiles(store, pid);
    rfids = resolveScopeFids(files, { folder });
    if (rfids && !rfids.length) return { items: [], total: 0 };
  }
  const singleFid = fid || (rfids && rfids.length === 1 ? rfids[0] : undefined);
  const multiFids = !singleFid && rfids && rfids.length > 1 ? rfids : undefined;

  let knownTotal = null;
  if (!q && !gidFrom) {
    if (!singleFid && !multiFids) {
      knownTotal = status ? (p.stats[status] || 0) : (p.stats.total || 0);
    } else if (singleFid) {
      if (!files) files = getCache(store, pid).files;
      const f = files ? files.find(x => x.id === singleFid) : await store.get('files', singleFid);
      if (f && f.stats) knownTotal = status ? (f.stats[status] || 0) : (f.stats.total || 0);
    } else if (multiFids) {
      if (!files) files = await listFiles(store, pid);
      const set = new Set(multiFids);
      knownTotal = files.filter(f => set.has(f.id)).reduce((acc, f) => acc + (f.stats ? (status ? (f.stats[status] || 0) : (f.stats.total || 0)) : 0), 0);
    }
  }
  return store.queryEntries(pid, {
    fid: singleFid,
    fids: multiFids,
    status: status || undefined,
    q: q || undefined,
    gidFrom,
    offset,
    limit,
    knownTotal
  });
}

export async function firstEntry(store, pid, { fid, folder, fids, status = 'todo', gidFrom = 0 } = {}) {
  const r = await listEntriesPage(store, pid, { fid, folder, fids, status, gidFrom, offset: 0, limit: 1 });
  return r.items[0] || null;
}

export async function stats(store, pid) {
  const p = await ensureMigrated(store, pid);
  return p && p.stats ? { ...p.stats } : emptyStats();
}

// Tag guard: translation must carry exactly the <T#> markers of the source, else it is flagged.
export function checkTags(src, tgt) { return !tgt || tagsOf(src) === tagsOf(tgt); }

export async function setTranslation(store, id, { tgt, tgtName, status, autoFix = false } = {}) {
  const e = await store.get('entries', id); if (!e) throw new Error('Entry tidak ada');
  const oldStatus = e.status;
  if (tgt !== undefined) e.tgt = fixTagSpacing(tgt);
  if (tgtName !== undefined) e.tgtName = tgtName;
  if (autoFix && e.tgt && e.tgt.trim()) {
    e.tgt = fixTags(e.src, e.tgt);
  }
  if (status) e.status = status;
  else if (tgt !== undefined) e.status = e.tgt.trim() ? (e.status === 'done' ? 'done' : 'draft') : 'todo';
  if (e.tgt && !checkTags(e.src, e.tgt)) { e.status = 'flag'; e.note = 'tag <T#> tidak cocok'; } else if (e.status === 'flag' && checkTags(e.src, e.tgt)) { e.status = 'draft'; delete e.note; }
  await store.put('entries', e);
  if (e.status !== oldStatus) {
    const [f, p] = await Promise.all([store.get('files', e.fid), ensureMigrated(store, e.pid)]);
    if (f && f.stats) {
      applyStatDelta(f.stats, oldStatus, e.status);
      await store.put('files', f);
      const cf = getCache(store, e.pid).files;
      if (cf) { const item = cf.find(x => x.id === f.id); if (item) item.stats = { ...f.stats }; }
    }
    if (p && p.stats) { applyStatDelta(p.stats, oldStatus, e.status); await touch(store, p); }
  }
  return e;
}

// Batch for an AI: next `count` entries (by global id) matching `onlyStatus`, grouped by file with headers.
export async function exportBatch(store, pid, { fmt, from = 1, count = 100, onlyStatus = 'todo', fid, folder, fids, tagless = true, stripAllTags = false, promptLang = 'none', customPrompt = '' } = {}) {
  const p = await ensureMigrated(store, pid); fmt = fmt || p.settings.fmt;
  const allFiles = await listFiles(store, pid);
  const files = new Map(allFiles.map(f => [f.id, f.path || f.name]));
  const rfids = resolveScopeFids(allFiles, { fid, folder, fids });
  const page = await listEntriesPage(store, pid, {
    fid: rfids && rfids.length === 1 ? rfids[0] : undefined,
    fids: rfids && rfids.length > 1 ? rfids : undefined,
    status: onlyStatus || undefined,
    gidFrom: from,
    offset: 0,
    limit: count
  });
  const es = page.items;
  const out = []; let cur = null;
  for (const e of es) {
    if (e.fid !== cur) { out.push(formatFileHeader(files.get(e.fid), fmt)); cur = e.fid; }
    const srcText = stripAllTags
      ? stripAllTagsForAi(e.src)
      : (tagless ? stripTagsForAi(e.src, analyzeTagSafety(e.src)) : e.src);
    out.push(formatBatchLine(padGlobalId(e.gid), e.name, srcText, e.kind, fmt));
  }
  const rawText = out.join('\n') + (out.length ? '\n' : '');
  const fullText = (promptLang && promptLang !== 'none' && out.length)
    ? buildBatchPrompt(promptLang, { glossary: p.glossary, batchText: rawText, customPrompt: customPrompt || p.settings.customPrompt })
    : rawText;
  return { text: fullText, rawText, count: es.length, firstGid: es[0] && es[0].gid, lastGid: es.length ? es[es.length - 1].gid : null };
}

// Export translated lines (by range/status OR from QC items) paired with `# JP:` reference + Glossary + Polishing Prompt
export async function exportQcBatch(store, pid, { fid, folder, fids, from = 1, count = 100, targetMode = 'issues', issueFilter = '', promptLang = 'en', customPrompt = '', stripAllTags = true, qcItems = null } = {}) {
  const p = await ensureMigrated(store, pid);
  const fmt = p.settings.fmt || 'v25b';
  const allFiles = await listFiles(store, pid);
  const files = new Map(allFiles.map(f => [f.id, f.path || f.name]));
  const out = [];
  let curFid = null;
  let totalExported = 0;
  let firstGid = null, lastGid = null;

  if (targetMode === 'polish' || targetMode === 'draft' || targetMode === 'done') {
    const statusFilter = targetMode === 'draft' ? 'draft' : targetMode === 'done' ? 'done' : undefined;
    const allMatching = await listEntries(store, pid, { fid, folder, fids, status: statusFilter });
    const slice = allMatching.filter(e => e.gid >= from && e.tgt && e.tgt.trim()).slice(0, count);
    for (const e of slice) {
      if (e.fid !== curFid) {
        out.push(formatFileHeader(files.get(e.fid), fmt));
        curFid = e.fid;
      }
      const cleanSrc = stripAllTags ? stripAllTagsForAi(e.src) : e.src;
      const cleanTgt = stripAllTags ? stripAllTagsForAi(e.tgt) : e.tgt;
      out.push(`# JP: ${cleanSrc}`);
      out.push(formatBatchLine(padGlobalId(e.gid), e.tgtName || e.name, cleanTgt, e.kind, fmt));
      if (firstGid === null) firstGid = e.gid;
      lastGid = e.gid;
      totalExported++;
    }
  } else {
    const rawList = qcItems || await qcRun(store, pid, { fid, folder, fids });
    const filtered = rawList.filter(r => {
      if (!issueFilter || issueFilter === 'all') return true;
      if (issueFilter === 'crit') return r.critical;
      if (issueFilter === 'tag') return r.issues.some(i => i.type === 'tag' || i.type === 'tag_malformed' || i.type === 'br');
      return r.issues.some(i => i.type === issueFilter);
    });
    for (const r of filtered) {
      const e = r.entry;
      if (e.fid !== curFid) {
        out.push(formatFileHeader(files.get(e.fid), fmt));
        curFid = e.fid;
      }
      const probDesc = r.issues.map(i => i.desc).join(' | ');
      const cleanSrc = stripAllTags ? stripAllTagsForAi(e.src) : e.src;
      const cleanTgt = stripAllTags ? stripAllTagsForAi(e.tgt) : e.tgt;
      out.push(`# [QC #${padGlobalId(e.gid)} | ${probDesc} | JP: ${cleanSrc}]`);
      out.push(formatBatchLine(padGlobalId(e.gid), e.tgtName || e.name, cleanTgt, e.kind, fmt));
      if (firstGid === null) firstGid = e.gid;
      lastGid = e.gid;
      totalExported++;
    }
  }
  const rawText = out.join('\n') + (out.length ? '\n' : '');
  const fullText = (promptLang && promptLang !== 'none' && totalExported)
    ? buildQcPrompt(promptLang, { glossary: p.glossary, qcText: rawText, customPrompt: customPrompt || p.settings.customQcPrompt })
    : rawText;
  return { text: fullText, rawText, count: totalExported, firstGid, lastGid };
}

// Apply a translated batch (any supported format). Matches by global id. Returns counts + problem lists.
export async function applyBatch(store, pid, text, { autofix = true } = {}) {
  const p = await ensureMigrated(store, pid);
  const pr = parseBatchUnified(stripPromptHeader(text), true);
  const all = new Map((await store.where('entries', 'pid', pid)).map(e => [e.gid, e]));
  const res = { applied: 0, flagged: 0, fixed: 0, unknown: [], unreadable: pr.unreadable || [] }, upd = [], snap = new Map();
  const fDeltas = new Map();
  for (const x of pr.ents) {
    const e = all.get(parseInt(x.idx, 10));
    if (!e) { res.unknown.push(x.idx); continue; }
    const prevSt = e.status;
    if (!snap.has(e.id)) snap.set(e.id, { id: e.id, tgt: e.tgt, tgtName: e.tgtName, status: e.status, note: e.note });
    e.tgt = fixTagSpacing(x.text || '');
    if (autofix && e.tgt.trim()) { const f = fixTags(e.src, e.tgt); if (f !== e.tgt.trim()) res.fixed++; e.tgt = f; }
    e.tgtName = isNarrationSpeaker(x.name) || isChoiceSpeaker(x.name) || x.name === 'Dialog' || x.name === e.name ? '' : x.name;
    if (!e.tgt.trim()) { e.status = 'todo'; }
    else if (!checkTags(e.src, e.tgt)) { e.status = 'flag'; e.note = 'tag <T#> tidak cocok'; res.flagged++; }
    else { e.status = e.status === 'done' ? 'done' : 'draft'; delete e.note; }
    if (prevSt !== e.status) {
      if (p && p.stats) applyStatDelta(p.stats, prevSt, e.status);
      if (!fDeltas.has(e.fid)) fDeltas.set(e.fid, []);
      fDeltas.get(e.fid).push([prevSt, e.status]);
    }
    res.applied++; upd.push(e);
  }
  await putEntriesChunked(store, upd);
  if (fDeltas.size) {
    const fUpd = [];
    for (const [fid, changes] of fDeltas) {
      const f = await store.get('files', fid);
      if (f && f.stats) {
        for (const [o, n] of changes) applyStatDelta(f.stats, o, n);
        fUpd.push(f);
      }
    }
    if (fUpd.length) {
      await store.putMany('files', fUpd);
      getCache(store, pid).files = null;
    }
  }
  if (p) { if (upd.length) p.lastUndo = { ts: Date.now(), items: [...snap.values()] }; await touch(store, p); }
  res.canUndo = !!upd.length;
  return res;
}

// Output-time quote conversion: 「 」 → " " / “ ”, 『 』 → ' ' / ‘ ’. Stored translations are never modified.
export function convertJpQuotes(text, mode) {
  if (!text || !mode || mode === 'keep') return text;
  const m = mode === 'curly' ? { '「': '“', '」': '”', '『': '‘', '』': '’' } : { '「': '"', '」': '"', '『': "'", '』': "'" };
  return text.replace(/[「」『』]/g, c => m[c]);
}

// Rebuild one script with the project's translations (only entries that have a target text).
// Always ensures <T#> control tags match `e.src` via `fixTags` so repacked game scripts never break even if tags were hidden/removed in UI.
export async function repackFile(store, fid, opts = {}) {
  const f = await store.get('files', fid); if (!f) throw new Error('File tidak ada');
  const blob = await getFileBlob(store, f);
  const es = await store.where('entries', 'fid', fid), trans = {};
  const p = await store.get('projects', f.pid), qm = p.settings.quoteMode || 'keep';
  // ks / Artemis .txt keep attribute values (sel01 text="...") safe: only lines whose SOURCE used 「 」 『 』 are converted there.
  const guarded = f.kind === 'ks' || f.kind === 'artemis-txt';
  for (const e of es) {
    if (e.tgt && e.tgt.trim()) {
      const spacedTgt = fixTagSpacing(e.tgt);
      const safeTgt = checkTags(e.src, spacedTgt) ? spacedTgt : fixTags(e.src, spacedTgt);
      trans[e.idx] = [e.tgtName || 'Narasi', (!guarded || /[「」『』]/.test(e.src)) ? convertJpQuotes(safeTgt, qm) : safeTgt];
    }
  }
  const log = opts.log || (f.kind === 'scn' ? createLog({ cap: 500, meta: { name: f.name, path: f.path || f.name, size: blob.bytes ? blob.bytes.length : 0, kind: f.kind } }) : null);
  let repackMeta = null;
  const bytes = await exportScript(
    { ...f, bytes: blob.bytes, tagStore: blob.tagStore },
    trans,
    {
      wrapWidth: p.settings.wrapWidth || 0,
      wrapSep: p.settings.wrapSep || 'auto',
      wrapSepCustom: p.settings.wrapSepCustom || '',
      rt2AsSpace: p.settings.wrapSep === 'rt2' || !!p.settings.rt2AsSpace,
      ...opts,
      log,
      verify: f.kind === 'scn',
      onRepackMeta: m => { repackMeta = m; }
    }
  );
  let exportLog = null;
  if (log) {
    exportLog = log.toJSON ? log.toJSON() : { entries: log.entries || [], status: summarizeLog(log) };
    if (!opts.skipSaveLog) {
      f.lastExportLog = exportLog;
      f.exportStatus = summarizeLog(exportLog);
      await store.put('files', f);
      getCache(store, f.pid).files = null;
    }
  }
  return {
    name: f.name,
    path: normPath(f.path || f.name),
    bytes,
    translated: Object.keys(trans).length,
    total: es.length,
    log: exportLog,
    verifyOk: repackMeta ? repackMeta.verifyOk !== false : true,
    verifyErrors: (repackMeta && repackMeta.verifyErrors) || [],
    warnings: (repackMeta && repackMeta.warnings) || []
  };
}

// ── Folder Batch Import & Dry-Run ("Uji folder") ─────────
export function filterAndSortFolderInputs(rawItems) {
  const supported = [], skippedNonScript = [], skippedByExt = {};
  for (const item of rawItems) {
    const relPath = normPath(item.path || item.webkitRelativePath || item.name || '');
    const bName = baseName(relPath);
    if (!bName || bName.startsWith('.')) continue;
    const dot = bName.lastIndexOf('.');
    const ext = dot >= 0 ? bName.slice(dot).toLowerCase() : '(tanpa ekstensi)';
    if (SCRIPT_EXTS.includes(ext)) {
      supported.push({ ...item, name: bName, path: relPath, ext });
    } else {
      skippedNonScript.push({ path: relPath, ext });
      skippedByExt[ext] = (skippedByExt[ext] || 0) + 1;
    }
  }
  supported.sort((a, b) => naturalPathCompare(a.path, b.path));
  return { supported, skippedNonScript, skippedByExt };
}

export async function importFolderBatch(store, pid, rawItems, opts = {}) {
  const {
    txtHint = 'auto',
    vntpFilter = false,
    onDuplicate = 'update',
    dryRun = false,
    onProgress,
    signal
  } = opts;
  const p = dryRun ? (await store.get('projects', pid)) : (await ensureMigrated(store, pid));
  if (!p && !dryRun) throw new Error('Proyek tidak ada');
  const sg = sortGls((p && p.glossary) || {});
  const { supported, skippedNonScript, skippedByExt } = filterAndSortFolderInputs(rawItems);
  const existingFiles = (!dryRun && p) ? await listFiles(store, pid) : [];
  const existingByPath = new Map(existingFiles.map(f => [normPath(f.path || f.name), f]));

  const summary = {
    dryRun,
    totalCandidates: rawItems.length,
    totalSupported: supported.length,
    importedFiles: 0,
    updatedFiles: 0,
    skippedNonScript: skippedNonScript.length,
    skippedByExt,
    skippedNonVntpJson: [],
    skippedDuplicate: [],
    zeroEntryFiles: [],
    okCount: 0,
    warnCount: 0,
    errorCount: 0,
    totalEntries: 0,
    aborted: false,
    results: []
  };

  for (let i = 0; i < supported.length; i++) {
    if (signal && signal.aborted) {
      summary.aborted = true;
      break;
    }
    const item = supported[i];
    if (onProgress) onProgress({ index: i + 1, total: supported.length, path: item.path, name: item.name });
    await new Promise(r => setTimeout(r, 0));
    if (signal && signal.aborted) {
      summary.aborted = true;
      break;
    }

    const existing = existingByPath.get(item.path);
    if (!dryRun && existing && onDuplicate === 'skip') {
      summary.skippedDuplicate.push(item.path);
      summary.results.push({ path: item.path, name: item.name, status: 'skipped', reason: 'duplikat (dilewati)', entryCount: existing.entryCount });
      continue;
    }

    let bytes;
    try {
      if (item.bytes) bytes = item.bytes instanceof Uint8Array ? item.bytes : new Uint8Array(item.bytes);
      else if (typeof item.getBytes === 'function') bytes = new Uint8Array(await item.getBytes());
      else if (item.file && typeof item.file.arrayBuffer === 'function') bytes = new Uint8Array(await item.file.arrayBuffer());
      else if (typeof item.arrayBuffer === 'function') bytes = new Uint8Array(await item.arrayBuffer());
      else throw new Error('Tidak dapat membaca isi berkas');
    } catch (readErr) {
      summary.errorCount++;
      const log = createLog({ cap: 50, meta: { name: item.name, path: item.path } });
      log.error('file', 'Gagal membaca berkas: ' + readErr.message);
      summary.results.push({ path: item.path, name: item.name, status: 'error', error: readErr.message, entryCount: 0, log: log.toJSON() });
      continue;
    }

    const log = createLog({ cap: 500, meta: { name: item.name, path: item.path, size: bytes.length } });
    try {
      if (dryRun) {
        const ex = await importScript(item.name, bytes, { sg, txtHint, vntpFilter, log });
        if (ex.kind === 'scn' && ex.entryCount === 0 && summarizeLog(log) === 'ok') {
          log.warn('entries', 'Berkas .scn menghasilkan 0 entri teks');
        }
        const logJson = log.toJSON();
        const st = summarizeLog(logJson);
        if (ex.entryCount === 0) summary.zeroEntryFiles.push(item.path);
        if (st === 'error') summary.errorCount++;
        else if (st === 'warn' || ex.entryCount === 0) summary.warnCount++;
        else summary.okCount++;
        summary.importedFiles++;
        summary.totalEntries += ex.entryCount;
        summary.results.push({ path: item.path, name: item.name, kind: ex.kind, status: st === 'ok' && ex.entryCount === 0 ? 'warn' : st, entryCount: ex.entryCount, log: logJson });
      } else if (existing && onDuplicate === 'update') {
        const r = await updateFileSource(store, existing.id, bytes, { txtHint, vntpFilter, log });
        const st = r.file.logStatus || summarizeLog(r.log);
        if (r.count === 0) summary.zeroEntryFiles.push(item.path);
        if (st === 'error') summary.errorCount++;
        else if (st === 'warn' || r.count === 0) summary.warnCount++;
        else summary.okCount++;
        summary.updatedFiles++;
        summary.totalEntries += r.count;
        summary.results.push({ id: r.file.id, path: item.path, name: item.name, kind: r.file.kind, status: st === 'ok' && r.count === 0 ? 'warn' : st, entryCount: r.count, kept: r.kept, log: r.log });
      } else {
        const r = await addFile(store, pid, item.name, bytes, { path: item.path, txtHint, vntpFilter, log });
        existingByPath.set(item.path, r.file);
        const st = r.file.logStatus || summarizeLog(r.log);
        if (r.count === 0) summary.zeroEntryFiles.push(item.path);
        if (st === 'error') summary.errorCount++;
        else if (st === 'warn' || r.count === 0) summary.warnCount++;
        else summary.okCount++;
        summary.importedFiles++;
        summary.totalEntries += r.count;
        summary.results.push({ id: r.file.id, path: item.path, name: item.name, kind: r.file.kind, status: st === 'ok' && r.count === 0 ? 'warn' : st, entryCount: r.count, log: r.log });
      }
    } catch (err) {
      if (err && err.notVntp) {
        summary.skippedNonVntpJson.push({ path: item.path, reason: err.message });
        summary.results.push({ path: item.path, name: item.name, status: 'skipped', reason: err.message, entryCount: 0 });
      } else {
        log.error('import', 'Gagal mengimpor berkas: ' + err.message, { error: err.message });
        const logJson = log.toJSON();
        summary.errorCount++;
        summary.results.push({ path: item.path, name: item.name, status: 'error', error: err.message, entryCount: 0, log: logJson });
      }
    }
  }
  return summary;
}

export function formatFolderSummary(summary, projName = 'KOPIPE') {
  const lines = [
    `=== KOPIPE v1.0.0 — Folder ${summary.dryRun ? 'Dry-Run' : 'Import'} Summary ===`,
    `Project              : ${projName}`,
    `Timestamp            : ${new Date().toISOString()}`,
    `Supported files      : ${summary.totalSupported} (of ${summary.totalCandidates} files in folder)`,
    `Processed            : ${summary.importedFiles} new, ${summary.updatedFiles} updated (${summary.totalEntries} total lines)`,
    `Status               : ${summary.okCount} OK · ${summary.warnCount} Warnings · ${summary.errorCount} Errors · ${summary.zeroEntryFiles.length} 0-line files`,
    `Skipped non-script   : ${summary.skippedNonScript} files (${Object.entries(summary.skippedByExt || {}).map(([k, v]) => `${k}:${v}`).join(', ') || '-'})`,
    `Skipped non-VN JSON  : ${(summary.skippedNonVntpJson || []).length} files`,
    `Skipped duplicates   : ${(summary.skippedDuplicate || []).length} files`,
    '----------------------------------------------------------------------',
    'Files:'
  ];
  for (const r of summary.results || []) {
    const tag = (r.status || 'ok').toUpperCase().padEnd(7, ' ');
    const extra = r.error ? ` — ERROR: ${r.error}` : r.reason ? ` — ${r.reason}` : r.kept != null ? ` (${r.kept} TL kept)` : '';
    lines.push(`  [${tag}] ${r.path} (${r.entryCount || 0} lines)${extra}`);
  }
  const prob = (summary.results || []).filter(r => r.log && (r.status === 'error' || r.status === 'warn' || r.entryCount === 0));
  if (prob.length) {
    lines.push('\n======================================================================');
    lines.push(`Detailed Log for Flagged / Warning Files (${prob.length} files):`);
    lines.push('======================================================================\n');
    for (const r of prob) {
      lines.push(formatLog(r.log, { path: r.path, name: r.name, kind: r.kind, entryCount: r.entryCount }));
      lines.push('');
    }
  }
  return lines.join('\n') + '\n';
}

// ── QC (Paged / Chunked Cancelable, Overflow & Odd Quotes Disabled) ───
export async function qcRun(store, pid, { fid, folder, fids, maxLen = 0, onProgress, signal, chunkSize = 500 } = {}) {
  const p = await ensureMigrated(store, pid), rules = glossaryRules(p.glossary), ml = maxLen || 0;
  const out = [];
  let offset = 0;
  let total = (p && p.stats && p.stats.total) || 0;
  while (true) {
    if (signal && signal.aborted) return out;
    const pg = await listEntriesPage(store, pid, { fid, folder, fids, offset, limit: chunkSize });
    total = pg.total;
    if (!pg.items.length) break;
    for (let i = 0; i < pg.items.length; i++) {
      const e = pg.items[i];
      if (!e.tgt || !e.tgt.trim()) continue;
      const issues = validate({ text: e.src, name: e.name }, { text: e.tgt, name: e.tgtName || e.name }, { maxLen: ml, rules })
        .filter(x => x.type !== 'overflow' && x.type !== 'quote');
      if (issues.length) out.push({ entry: e, issues, critical: issues.some(x => CRIT_TYPES.includes(x.type)) });
    }
    offset += pg.items.length;
    if (onProgress) onProgress({ done: offset, total, issues: out.length });
    if (offset >= total || pg.items.length < chunkSize) break;
    await new Promise(r => setTimeout(r, 0));
    if (signal && signal.aborted) return out;
  }
  if (onProgress) onProgress({ done: total, total, issues: out.length });
  return out;
}

// Auto-repair tags/<BR> for the given entry ids (or every translated entry with a tag/br issue).
export async function qcFixTags(store, pid, ids) {
  const p = await ensureMigrated(store, pid);
  const idSet = ids ? new Set(ids) : null;
  const es = (await listEntries(store, pid)).filter(e => e.tgt && e.tgt.trim() && (!idSet || idSet.has(e.id))), upd = [];
  const fDeltas = new Map();
  for (const e of es) {
    const f = fixTags(e.src, e.tgt);
    if (f !== e.tgt) {
      const prevSt = e.status;
      e.tgt = f;
      if (e.status === 'flag' && checkTags(e.src, e.tgt)) { e.status = 'draft'; delete e.note; }
      if (prevSt !== e.status) {
        if (p && p.stats) applyStatDelta(p.stats, prevSt, e.status);
        if (!fDeltas.has(e.fid)) fDeltas.set(e.fid, []);
        fDeltas.get(e.fid).push([prevSt, e.status]);
      }
      upd.push(e);
    }
  }
  await putEntriesChunked(store, upd);
  if (fDeltas.size) {
    const fUpd = [];
    for (const [fid, changes] of fDeltas) {
      const f = await store.get('files', fid);
      if (f && f.stats) {
        for (const [o, n] of changes) applyStatDelta(f.stats, o, n);
        fUpd.push(f);
      }
    }
    if (fUpd.length) {
      await store.putMany('files', fUpd);
      getCache(store, pid).files = null;
    }
  }
  if (p && upd.length) await touch(store, p);
  return upd.length;
}

// ── Glossary / VNDB ─────────────────────────────────────
export async function scanSpeakerNames(store, pid) {
  const freq = {};
  for (const e of await listEntries(store, pid)) { const n = (e.name || '').trim(); if (n && !isNarrationSpeaker(n) && !isChoiceSpeaker(n) && n !== 'Dialog') freq[n] = (freq[n] || 0) + 1; }
  return Object.keys(freq).sort((a, b) => freq[b] - freq[a]);
}

// chars = VNDB character list (from fetchVndb). Returns a glossary DRAFT merged over the project's glossary (existing keys win).
export async function vndbGlossaryDraft(store, pid, chars) {
  const p = await ensureMigrated(store, pid), names = await scanSpeakerNames(store, pid);
  const matches = matchVndb(names, chars), draft = buildGls(names, matches, p.glossary || {});
  return { draft, matched: Object.keys(matches).filter(n => matches[n] && !matches[n].skip).length, total: names.length, ambiguous: Object.keys(matches).filter(n => matches[n] && matches[n].skip) };
}

export async function setGlossary(store, pid, glossary) { const p = await ensureMigrated(store, pid); p.glossary = glossary; await touch(store, p); }

// Re-extract every file with the current glossary and refresh SRC/name of entries that have NO translation yet
// (translated entries are never touched). Returns the number of refreshed entries.
export async function reapplyGlossary(store, pid) {
  const p = await ensureMigrated(store, pid), sg = sortGls(p.glossary || {}); let changed = 0;
  for (const f of await store.where('files', 'pid', pid)) {
    const blob = await getFileBlob(store, f);
    const hint = f.kind === 'artemis-txt' ? 'artemis' : f.kind === 'txt' ? 'kirikiri' : 'auto';
    const ex = await importScript(f.name, blob.bytes, { sg, txtHint: hint, vntpFilter: !!(f.meta && f.meta.filter) });
    const es = new Map((await store.where('entries', 'fid', f.id)).map(e => [e.idx, e])), upd = [];
    for (const l of ex.lines) {
      const m = LINE_RE.exec(l); if (!m) continue;
      const e = es.get(m[1]); if (!e || (e.tgt && e.tgt.trim()) || e.status !== 'todo') continue;
      const body = m[4] || '';
      if (e.src !== body || e.name !== m[2]) { e.src = body; e.name = m[2]; upd.push(e); if (ex.tagStore[m[1]]) blob.tagStore[m[1]] = ex.tagStore[m[1]]; }
    }
    if (upd.length) {
      await putEntriesChunked(store, upd);
      await store.put('blobs', blob);
      changed += upd.length;
    }
  }
  return changed;
}

// ── Undo / export ───────────────────────────────────────
export async function undoApply(store, pid) {
  const p = await ensureMigrated(store, pid); if (!p || !p.lastUndo) return 0;
  const cur = new Map((await store.where('entries', 'pid', pid)).map(e => [e.id, e])), upd = [];
  const fDeltas = new Map();
  for (const o of p.lastUndo.items) {
    const e = cur.get(o.id); if (!e) continue;
    const prevSt = e.status;
    e.tgt = o.tgt; e.tgtName = o.tgtName; e.status = o.status;
    if (o.note) e.note = o.note; else delete e.note;
    if (prevSt !== e.status) {
      if (p.stats) applyStatDelta(p.stats, prevSt, e.status);
      if (!fDeltas.has(e.fid)) fDeltas.set(e.fid, []);
      fDeltas.get(e.fid).push([prevSt, e.status]);
    }
    upd.push(e);
  }
  await putEntriesChunked(store, upd);
  if (fDeltas.size) {
    const fUpd = [];
    for (const [fid, changes] of fDeltas) {
      const f = await store.get('files', fid);
      if (f && f.stats) {
        for (const [o, n] of changes) applyStatDelta(f.stats, o, n);
        fUpd.push(f);
      }
    }
    if (fUpd.length) {
      await store.putMany('files', fUpd);
      getCache(store, pid).files = null;
    }
  }
  const n = upd.length; delete p.lastUndo; await touch(store, p); return n;
}

// Full translation export in batch format with the translated text (handy for sharing / re-importing via Batch → Terapkan).
export async function exportTranslations(store, pid, { fmt } = {}) {
  const p = await ensureMigrated(store, pid); fmt = fmt || p.settings.fmt;
  const files = new Map((await listFiles(store, pid)).map(f => [f.id, f.path || f.name])), out = []; let cur = null;
  for (const e of await listEntries(store, pid)) {
    if (!e.tgt || !e.tgt.trim()) continue;
    if (e.fid !== cur) { out.push(formatFileHeader(files.get(e.fid), fmt)); cur = e.fid; }
    out.push(formatBatchLine(padGlobalId(e.gid), e.tgtName || e.name, e.tgt, e.kind, fmt));
  }
  return out.join('\n') + (out.length ? '\n' : '');
}

export function buildFindRegex(findText, { regex = false, matchCase = false, exactMatch = false } = {}) {
  if (!findText) return null;
  let pat = regex ? String(findText) : String(findText).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (exactMatch) {
    pat = `(?<![A-Za-z0-9_])(?:${pat})(?![A-Za-z0-9_])`;
  }
  try {
    return new RegExp(pat, matchCase ? "g" : "gi");
  } catch (e) {
    return null;
  }
}

export function applyCasePreserving(match, replaceText) {
  if (!replaceText) return "";
  const hasCase = match.toUpperCase() !== match.toLowerCase();
  if (!hasCase) return replaceText;
  if (match.length > 1 && match === match.toUpperCase()) return replaceText.toUpperCase();
  const f0 = match.charAt(0);
  if (f0 === f0.toUpperCase() && f0 !== f0.toLowerCase()) {
    return replaceText.charAt(0).toUpperCase() + replaceText.slice(1);
  }
  if (f0 === f0.toLowerCase() && f0 !== f0.toUpperCase()) {
    return replaceText.charAt(0).toLowerCase() + replaceText.slice(1);
  }
  return replaceText;
}

export function replaceSafeSegments(rawText, re, replaceText = "", { preserveCase = false } = {}) {
  if (!rawText || !re) return { out: rawText || "", count: 0 };
  const parts = String(rawText).split(/(<T\d+>|<BR>)/g);
  let count = 0;
  for (let i = 0; i < parts.length; i += 2) {
    if (!parts[i]) continue;
    re.lastIndex = 0;
    parts[i] = parts[i].replace(re, m => {
      if (!m) return m;
      count++;
      return preserveCase ? applyCasePreserving(m, replaceText) : replaceText;
    });
  }
  return { out: fixTagSpacing(parts.join("")), count };
}

export function countSafeMatches(rawText, re) {
  if (!rawText || !re) return 0;
  const parts = String(rawText).split(/(<T\d+>|<BR>)/g);
  let count = 0;
  for (let i = 0; i < parts.length; i += 2) {
    if (!parts[i]) continue;
    re.lastIndex = 0;
    const m = parts[i].match(re);
    if (m) count += m.length;
  }
  return count;
}

// Mass Find & Replace across entries (supports Regex, Case Sensitive, Preserve Case, Exact Match, Translated Only, Target Field, Excluded IDs, and Undo)
export async function replaceInTranslations(store, pid, {
  findText,
  replaceText = "",
  fid,
  folder,
  fids,
  targetField = "tgt",
  regex = false,
  matchCase = false,
  preserveCase = false,
  exactMatch = false,
  translatedOnly = false,
  excludeIds = null
} = {}) {
  const re = buildFindRegex(findText, { regex, matchCase, exactMatch });
  if (!re) return { replacedEntries: 0, occurrences: 0, canUndo: false };
  const p = await ensureMigrated(store, pid);
  const es = await listEntries(store, pid, { fid, folder, fids });
  const exSet = excludeIds ? new Set(excludeIds) : null;
  const upd = [], snap = [];
  let occurrences = 0;

  for (const e of es) {
    if (exSet && exSet.has(e.id)) continue;
    if (translatedOnly && (!e.tgt || !e.tgt.trim())) continue;

    if (targetField === "speaker") {
      const curSpk = e.tgtName || e.name || "";
      if (!curSpk) continue;
      const r = replaceSafeSegments(curSpk, re, replaceText, { preserveCase });
      if (!r.count || r.out === curSpk) continue;
      snap.push({ id: e.id, tgt: e.tgt, tgtName: e.tgtName, status: e.status, note: e.note });
      occurrences += r.count;
      e.tgtName = r.out;
      upd.push(e);
    } else {
      if (!e.tgt || !e.tgt.trim()) continue;
      const r = replaceSafeSegments(e.tgt, re, replaceText, { preserveCase });
      if (!r.count || r.out === e.tgt) continue;
      snap.push({ id: e.id, tgt: e.tgt, tgtName: e.tgtName, status: e.status, note: e.note });
      occurrences += r.count;
      e.tgt = r.out;
      upd.push(e);
    }
  }
  if (upd.length) {
    await putEntriesChunked(store, upd);
    if (p) {
      p.lastUndo = { ts: Date.now(), items: snap };
      await touch(store, p);
    }
  }
  return { replacedEntries: upd.length, occurrences, canUndo: upd.length > 0 };
}

// Globally set speaker translation across project glossary and all matching entries
export async function renameSpeakerGlobally(store, pid, rawName, translatedName) {
  if (!rawName) return 0;
  const p = await ensureMigrated(store, pid);
  const cleanTgt = (translatedName || "").trim();
  p.glossary = p.glossary || {};
  if (cleanTgt) p.glossary[rawName] = cleanTgt;
  else delete p.glossary[rawName];
  await touch(store, p);
  const all = await store.where("entries", "pid", pid);
  const upd = [];
  for (const e of all) {
    if (e.name === rawName || (cleanTgt && e.name === cleanTgt)) {
      if (e.tgtName !== cleanTgt) {
        e.tgtName = cleanTgt;
        upd.push(e);
      }
    }
  }
  if (upd.length) await putEntriesChunked(store, upd);
  await reapplyGlossary(store, pid);
  return upd.length;
}

// Re-parse all stored files in IndexedDB using the updated parser while keeping all existing translations
export async function reparseStoredFiles(store, pid, { onProgress } = {}) {
  const files = await listFiles(store, pid);
  let updatedFiles = 0, addedLines = 0, keptLines = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (onProgress) onProgress({ index: i + 1, total: files.length, name: f.path || f.name });
    await new Promise(r => setTimeout(r, 0));
    const blob = await getFileBlob(store, f);
    if (!blob || !blob.bytes || !blob.bytes.length) continue;
    const oldCount = f.entryCount || 0;
    const hint = f.kind === "artemis-txt" ? "artemis" : f.kind === "txt" ? "kirikiri" : "auto";
    const r = await updateFileSource(store, f.id, blob.bytes, { txtHint: hint, vntpFilter: !!(f.meta && f.meta.vntpFilter) });
    updatedFiles++;
    addedLines += Math.max(0, r.count - oldCount);
    keptLines += r.kept || 0;
  }
  await recount(store, pid);
  return { updatedFiles, addedLines, keptLines };
}
