// core/engines/index.js – one import/export interface over every engine.
//   importScript(name, bytes, opts) -> {kind, meta, lines:['[idx|name] masked'], tagStore, entryCount, skipped?}
//   exportScript(rec, translations, opts) -> Uint8Array    rec = {kind, meta, bytes, tagStore}
// translations = { localIdx: [name, maskedText] }
import { decodeKs, encodeKs, extractFromKs, repackKs } from './kirikiri.js';
import { parseTxtBlocks, extractFromTxt, repackTxt } from './txt.js';
import { extractFromArtemisTxt, looksLikeArtemisTxt, repackArt, extractFromAst, repackAst, detectAstLanguages, extractFromAstGeneric, repackAstGeneric } from './artemis.js';
import { extractFromScn, repackScn, scnMdfUnwrap, scnMdfWrap } from './scn.js';
import { extractFromVntp, repackVntp } from './vntp.js';
import { normLogger, hexHead, fnv1aHex } from '../log.js';

export const KIND_LABEL = {
  ks: 'Kirikiri .ks', txt: 'Kirikiri .txt', 'artemis-txt': 'Artemis .txt', ast: 'Artemis .ast', 'ast-generic': 'Artemis .ast (generik)',
  scn: 'Kirikiri .scn (PSB)', vntp: 'VNTP .json',
};
const hasBom = b => b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF;
const u8 = b => (b instanceof Uint8Array ? b : new Uint8Array(b));
const nowMs = () => (globalThis.performance ? globalThis.performance.now() : Date.now());

function encodeText(text, meta, opts) {
  let enc = meta.enc;
  if (opts.textOut === 'utf16le') enc = 'utf-16le';
  const out = encodeKs(text, enc);
  if (meta.bom && enc === 'utf-8') { const o = new Uint8Array(out.length + 3); o.set([0xEF, 0xBB, 0xBF]); o.set(out, 3); return o; }
  return out;
}

export function detectKind(name, text, hint = 'auto') {
  const low = name.toLowerCase();
  if (low.endsWith('.scn')) return 'scn';
  if (low.endsWith('.json')) return 'vntp';
  if (low.endsWith('.ast')) return 'ast';
  if (low.endsWith('.ks')) return 'ks';
  if (low.endsWith('.txt')) return hint === 'artemis' || (hint === 'auto' && looksLikeArtemisTxt(text)) ? 'artemis-txt' : 'txt';
  return null;
}

export function isVntpJsonData(data) {
  if (!Array.isArray(data)) return false;
  if (data.length === 0) return true;
  return data.some(x => x && typeof x === 'object' && !Array.isArray(x) && typeof x.message === 'string');
}

// Resolve multiline wrap separator (KOPIPE style: auto, \n, \r\n, [r], {"rt2"}, custom)
export function resolveWrapSep(kind, meta = {}, opts = {}) {
  if (opts.nl) return opts.nl;
  const mode = opts.wrapSep || 'auto';
  if (mode === 'auto') {
    if (kind === 'ast') return '\r\n';
    if (kind === 'ast-generic') return '\\n';
    if (kind === 'ks') return '[r]' + (meta.crlf ? '\r\n' : '\n');
    if (kind === 'txt' || kind === 'artemis-txt') return meta.crlf ? '\r\n' : '\n';
    return '\n';
  }
  if (mode === 'lf' || mode === '\\n') return '\n';
  if (mode === 'crlf' || mode === '\\r\\n') return '\r\n';
  if (mode === 'lit-n') return '\\n';
  if (mode === '[r]') return '[r]' + (meta.crlf ? '\r\n' : '\n');
  if (mode === '[n]') return '[n]';
  if (mode === '<br>') return '<br>';
  if (mode === 'rt2') return kind === 'ast' ? '\r\n' : '{"rt2"}';
  if (mode === 'custom' && opts.wrapSepCustom) {
    return String(opts.wrapSepCustom).replace(/\\r\\n/g, '\r\n').replace(/(?<!\\)\\n/g, '\n');
  }
  return '\n';
}

export async function importScript(name, bytes, opts = {}) {
  bytes = u8(bytes);
  const sg = opts.sg || [];
  const log = opts.log ? normLogger(opts.log) : null;
  const low = name.toLowerCase();
  if (low.endsWith('.scn')) {
    if (!log) {
      const u = await scnMdfUnwrap(bytes);
      const ex = extractFromScn(u.buf, sg);
      return { kind: 'scn', meta: { mdf: u.mdf, strategy: ex.strategy || null, txtHint: opts.txtHint, vntpFilter: !!opts.vntpFilter }, lines: ex.lines, tagStore: ex.tagStore, entryCount: ex.entryCount };
    }
    const hash = 'fnv1a:' + fnv1aHex(bytes);
    if (opts.log && opts.log.meta) Object.assign(opts.log.meta, { name, size: bytes.length, hash, kind: 'scn' });
    log.info('file', `Membaca berkas ${name} (${bytes.length} byte)`, { name, size: bytes.length, head16: hexHead(bytes, 16), hash });
    const t0 = nowMs();
    const u = await scnMdfUnwrap(bytes, { log });
    const unwrapMs = +(nowMs() - t0).toFixed(2);
    const ex = extractFromScn(u.buf, sg, { log, _fileLogged: true, name, unwrapMs });
    if (opts.log && opts.log.meta) Object.assign(opts.log.meta, { strategy: ex.strategy || null, entryCount: ex.entryCount });
    return { kind: 'scn', meta: { mdf: u.mdf, strategy: ex.strategy || null, hash, txtHint: opts.txtHint, vntpFilter: !!opts.vntpFilter }, lines: ex.lines, tagStore: ex.tagStore, entryCount: ex.entryCount };
  }
  if (low.endsWith('.json')) {
    let data;
    try {
      data = JSON.parse(new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, ''));
    } catch (e) {
      if (log) log.error('file', `JSON tidak valid: ${e.message}`, { name, size: bytes.length });
      throw new Error('JSON tidak valid: ' + e.message);
    }
    if (!isVntpJsonData(data)) {
      const msg = 'Bukan berkas VNTP JSON (harus berupa array berisi objek dengan field "message")';
      if (log) log.warn('file', msg, { name, size: bytes.length });
      const err = new Error(msg);
      err.notVntp = true;
      throw err;
    }
    const ex = extractFromVntp(data, sg, { filter: !!opts.vntpFilter });
    if (log) {
      log.info('file', `VNTP JSON ${name} (${bytes.length} byte) → ${ex.entryCount} entri`, { name, size: bytes.length, entryCount: ex.entryCount, skipped: (ex.skipped || []).length });
      if (opts.log && opts.log.meta) Object.assign(opts.log.meta, { name, size: bytes.length, kind: 'vntp', entryCount: ex.entryCount });
    }
    return { kind: 'vntp', meta: { filter: !!opts.vntpFilter, vntpFilter: !!opts.vntpFilter }, lines: ex.lines, tagStore: ex.tagStore, entryCount: ex.entryCount, skipped: ex.skipped };
  }
  const dec = decodeKs(bytes);
  const meta = { enc: dec.enc, bom: hasBom(bytes), crlf: dec.text.indexOf('\r\n') >= 0, txtHint: opts.txtHint || 'auto' };
  const kind = detectKind(name, dec.text, opts.txtHint);
  if (!kind) throw new Error('Ekstensi tidak dikenali: ' + name);
  let res;
  if (kind === 'ks') { const ex = extractFromKs(dec.text, sg); res = { kind, meta, ...pick(ex) }; }
  else if (kind === 'artemis-txt') { const ex = extractFromArtemisTxt(dec.text, sg); res = { kind, meta, ...pick(ex) }; }
  else if (kind === 'txt') { const pb = parseTxtBlocks(dec.text); const ex = extractFromTxt(pb.blocks, sg); return { kind, meta, ...pick(ex) }; }
  else {
    // ast: structural first, generic regex fallback when nothing found
    let ex = extractFromAst(dec.text, sg);
    if (ex.entryCount) res = { kind: 'ast', meta: { ...meta, astver: ex.astver || null }, ...pick(ex) };
    else {
      const langs = detectAstLanguages(dec.text), key = langs.includes('ja') ? 'ja' : langs[0];
      if (key) { ex = extractFromAstGeneric(dec.text, key, sg); res = { kind: 'ast-generic', meta: { ...meta, langKey: key }, ...pick(ex) }; }
      else res = { kind: 'ast', meta, lines: [], tagStore: {}, entryCount: 0 };
    }
  }
  if (log) {
    log.info('file', `${res.kind} ${name} (${bytes.length} byte, ${meta.enc}) → ${res.entryCount} entri`, { name, size: bytes.length, enc: meta.enc, kind: res.kind, entryCount: res.entryCount });
    if (opts.log && opts.log.meta) Object.assign(opts.log.meta, { name, size: bytes.length, kind: res.kind, entryCount: res.entryCount });
  }
  return res;
}
const pick = ex => ({ lines: ex.lines, tagStore: ex.tagStore, entryCount: ex.entryCount ?? ex.lines.length });

export async function exportScript(rec, translations, opts = {}) {
  const bytes = u8(rec.bytes), ww = opts.wrapWidth || 0, meta = rec.meta || {};
  const k = rec.kind;
  const nl = resolveWrapSep(k, meta, opts);
  const log = opts.log ? normLogger(opts.log) : null;
  if (k === 'scn') {
    if (!log && !opts.verify && !opts.onRepackMeta && !opts._corruptOutput) {
      const u = await scnMdfUnwrap(bytes);
      const r = repackScn(u.buf, rec.tagStore, translations, ww, nl);
      return u.mdf ? scnMdfWrap(r.buf) : r.buf;
    }
    if (opts.log && opts.log.meta) Object.assign(opts.log.meta, { name: rec.path || rec.name || 'script.scn', size: bytes.length, kind: 'scn' });
    const u = await scnMdfUnwrap(bytes, { log });
    const r = repackScn(u.buf, rec.tagStore, translations, ww, nl, { log, verify: opts.verify, _corruptOutput: opts._corruptOutput });
    const out = u.mdf ? await scnMdfWrap(r.buf, { log }) : r.buf;
    if (typeof opts.onRepackMeta === 'function') opts.onRepackMeta(r);
    return out;
  }
  if (k === 'vntp') {
    const data = JSON.parse(new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, ''));
    const r = repackVntp(data, rec.tagStore, translations, ww, nl);
    return new TextEncoder().encode(JSON.stringify(r.data, null, 2));
  }
  const dec = decodeKs(bytes);
  let out;
  if (k === 'ks') out = repackKs(dec.text, rec.tagStore, translations, ww, nl);
  else if (k === 'artemis-txt') out = repackArt(dec.text, rec.tagStore, translations, ww, nl);
  else if (k === 'txt') { out = repackTxt(parseTxtBlocks(dec.text).rawLines, rec.tagStore, translations, ww, nl); if (meta.crlf) out = out.replace(/\r?\n/g, '\r\n'); }
  else if (k === 'ast') {
    const useRt2Wrap = opts.wrapSep === 'rt2' || !!opts.rt2AsSpace;
    if (useRt2Wrap && ww > 0) {
      const cleanTrans = {};
      for (const [idx, val] of Object.entries(translations || {})) {
        cleanTrans[idx] = [val[0], String(val[1] || '').split('<BR>').join(' ').replace(/\s{2,}/g, ' ').trim()];
      }
      out = repackAst(dec.text, rec.tagStore, cleanTrans, ww, '\r\n', false);
    } else {
      out = repackAst(dec.text, rec.tagStore, translations, ww, nl, !!opts.rt2AsSpace);
    }
  }
  else if (k === 'ast-generic') out = repackAstGeneric(dec.text, rec.tagStore, translations, ww, nl, meta.langKey || 'ja');
  else throw new Error('Kind tidak dikenal: ' + k);
  return encodeText(out, { enc: meta.enc || dec.enc, bom: meta.bom }, opts);
}
