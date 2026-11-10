// core/qc.js – QC checks + tag repair + tagless-AI helpers. Ported from KOPIPE (MT checker), decoupled from the UI.
import { isNarrationSpeaker } from './batch.js';

const MALFORMED_TAG_RE = /(?::<[Tt]\s*[-_]?(\d+)\s*>|\[[Tt]\s*[-_]?(\d+)\s*\]|\([Tt]\s*[-_]?(\d+)\s*\)|\{[Tt]\s*[-_]?(\d+)\s*\}|<[Tt]\s*[-_]?(\d+)(?:\s*>|\s*$))/gi;
const MALFORMED_BR_RE = /(?:<\s*br\s*\/?>|\[\s*br\s*\]|<\s*br\s*>)/gi;
const CJK_RE = /[\u3000-\u30FF\u4E00-\u9FFF\uFF00-\uFFEF]/g;

export function normalizeMalformedTags(s) {
  if (!s) return '';
  return s.replace(MALFORMED_TAG_RE, (_, p1, p2, p3, p4, p5) => '<T' + (p1 || p2 || p3 || p4 || p5) + '>').replace(MALFORMED_BR_RE, '<BR>');
}

// Lines whose tags are only at the edges are safe to strip for the AI; mid-sentence tags (ruby etc.) must stay visible.
export function analyzeTagSafety(src) {
  const s = (src || '').trim(), all = s.match(/<T\d+>/g) || [];
  if (!all.length) return { hasTags: false, hasMidTags: false, leadTags: [], tailTags: [] };
  const mid = s.replace(/^(?:<T\d+>)+/, '').replace(/(?:<T\d+>)+$/, '').match(/<T\d+>/g) || [];
  const leadM = s.match(/^(?:<T\d+>)+/), tailM = s.match(/(?:<T\d+>)+$/);
  return { hasTags: true, hasMidTags: mid.length > 0, leadTags: leadM ? leadM[0].match(/<T\d+>/g) : [], tailTags: tailM ? tailM[0].match(/<T\d+>/g) : [] };
}
export function stripTagsForAi(text, info) {
  if (!text) return '';
  if (info && info.hasMidTags) return text;
  return text.replace(/<T\d+>/g, '').replace(/\s{2,}/g, ' ').trim();
}

const tagList = s => (s.match(/<T\d+>/g) || []);
const tagCount = s => { const c = {}; tagList(s).forEach(t => { c[t] = (c[t] || 0) + 1; }); return c; };
const brCount = s => (s.match(/<BR>/g) || []).length;

export function tagDiff(src, tl) {
  const normTl = normalizeMalformedTags(tl), a = tagCount(src), b = tagCount(normTl), extra = [], missing = [], malformed = [];
  let mm; const re = new RegExp(MALFORMED_TAG_RE.source, 'g');
  while ((mm = re.exec(tl)) !== null) { if (!/^<T\d+>$/i.test(mm[0])) malformed.push(mm[0]); }
  let bm; const bre = new RegExp(MALFORMED_BR_RE.source, 'gi');
  while ((bm = bre.exec(tl)) !== null) { if (bm[0] !== '<BR>') malformed.push(bm[0]); }
  for (const t in b) for (let i = a[t] || 0; i < b[t]; i++) extra.push(t);
  for (const t in a) for (let i = b[t] || 0; i < a[t]; i++) missing.push(t);
  const srcSeq = tagList(src), tlSeq = tagList(normTl);
  const orderBad = !extra.length && !missing.length && srcSeq.join(',') !== tlSeq.join(',');
  const brSrc = brCount(src), brTl = brCount(normTl);
  return { extra, missing, malformed, orderBad, brDiff: brTl - brSrc, brSrc, brTl, srcSeq, tlSeq };
}

const cjkN = s => (s.match(CJK_RE) || []).length;
export function maxVisibleSegmentLen(s) {
  let max = 0; for (const seg of (s || '').replace(/<T\d+>/g, '').split('<BR>')) if (seg.length > max) max = seg.length; return max;
}

export function checkQuotesDetail(rawText, tlText) {
  const cnt = (str, re) => (str.match(re) || []).length;
  if (cnt(tlText, /「/g) !== cnt(tlText, /」/g)) return 'Kutip Jepang 「...」 tidak sepasang (' + cnt(tlText, /「/g) + ' vs ' + cnt(tlText, /」/g) + ')';
  if (cnt(tlText, /『/g) !== cnt(tlText, /』/g)) return 'Kutip Jepang 『...』 tidak sepasang (' + cnt(tlText, /『/g) + ' vs ' + cnt(tlText, /』/g) + ')';
  if (cnt(tlText, /“/g) !== cnt(tlText, /”/g)) return 'Kutip lengkung “...” tidak sepasang (' + cnt(tlText, /“/g) + ' vs ' + cnt(tlText, /”/g) + ')';
  const tlCurly = tlText.replace(/([A-Za-z0-9])’(?=[A-Za-z0-9])/g, '$1_').replace(/(?:^|[\s"'`\(\[]|’)(?=\d{2}s?\b|em\b|ol\b)/g, '$1_');
  const cOpen = cnt(tlCurly, /‘/g), cClose = cnt(tlCurly, /’/g);
  if (cOpen > 0 && cOpen !== cClose) return 'Kutip tunggal lengkung ‘...’ tidak sepasang';
  const dqTl = cnt(tlText, /"/g), dqRaw = cnt(rawText, /"/g);
  if (dqTl % 2 !== 0 && dqTl !== dqRaw) return 'Tanda kutip ganda (") berjumlah ganjil (' + dqTl + ' buah di TL)';
  const strip = s => s.replace(/([A-Za-z0-9]'[A-Za-z0-9])/g, '___').replace(/(?:^|[\s"'`\(\[])'(?:kan|tuk|lah|nya|an|in|on|un|em|ol|\d{2}s?)\b/gi, '___');
  const sqTl = cnt(strip(tlText), /'/g), sqRaw = cnt(strip(rawText), /'/g);
  if (sqTl % 2 !== 0 && sqTl !== sqRaw) return "Tanda kutip tunggal (') berjumlah ganjil (" + sqTl + " buah di TL)";
  return null;
}

// glossary object {src: tgt} -> rules [{src,tgt,re}]
export function glossaryRules(g) {
  const rules = [];
  for (const k of Object.keys(g || {})) {
    const v = (g[k] || '').trim(); if (!k || !v) continue;
    const e = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rules.push({ src: k, tgt: v, re: new RegExp(/^[A-Za-z0-9_]+$/.test(v) ? '\\b' + e + '\\b' : e, 'i') });
  }
  return rules;
}

export const CRIT_TYPES = ['tag', 'tag_malformed', 'br', 'jepang'];
export const ISSUE_LABEL = { tag: 'TAG <Tn>', tag_malformed: 'TAG CACAT', br: '<BR> BEDA', quote: 'KUTIP GANJIL', overflow: 'TEKS TERLALU PANJANG', jepang: 'KARAKTER JEPANG', name: 'NAMA BEDA', gls: 'KAMUS HILANG' };

// raw = {text, name}; tl = {text, name}; opts = {maxLen, rules}. Returns [{type, desc,...}] (empty TL -> no issues).
export function validate(raw, tl, opts = {}) {
  const out = [];
  if (!tl.text || !tl.text.trim()) return out;
  const d = tagDiff(raw.text, tl.text);
  if (d.malformed.length) out.push({ type: 'tag_malformed', desc: 'Format tag salah ketik: ' + d.malformed.join(', ') });
  if (d.extra.length || d.missing.length || d.orderBad) {
    const parts = [];
    if (d.missing.length) parts.push('tag ' + d.missing.join(', ') + ' belum terpasang di TL');
    if (d.extra.length) parts.push('tag ' + d.extra.join(', ') + ' berlebih di TL');
    if (d.orderBad) parts.push('urutan tag terbalik (SRC: ' + d.srcSeq.join('') + ' vs TL: ' + d.tlSeq.join('') + ')');
    out.push({ type: 'tag', desc: 'Tag <Tn>: ' + parts.join('; ') + '.' });
  }
  if (d.brDiff !== 0) out.push({ type: 'br', desc: 'Jumlah ganti baris <BR> berbeda (SRC: ' + d.brSrc + ' vs TL: ' + d.brTl + ')' });
  const q = checkQuotesDetail(raw.text, tl.text); if (q) out.push({ type: 'quote', desc: q + '.' });
  const maxLen = opts.maxLen === undefined ? 95 : opts.maxLen, vis = maxVisibleSegmentLen(tl.text);
  if (maxLen > 0 && vis > maxLen) out.push({ type: 'overflow', desc: 'Panjang teks ' + vis + ' karakter (batas ' + maxLen + ')' });
  const ns = cjkN(raw.text), nt = cjkN(tl.text);
  if ((ns >= 3 && nt > 0.5 * ns) || nt >= 4) out.push({ type: 'jepang', desc: 'Masih ada ' + nt + ' karakter Jepang di dalam terjemahan.' });
  if (tl.name && raw.name && tl.name !== raw.name && !(isNarrationSpeaker(tl.name) && isNarrationSpeaker(raw.name)) && opts.checkName) out.push({ type: 'name', desc: 'Nama pembicara berubah dari "' + raw.name + '" menjadi "' + tl.name + '"' });
  if (opts.rules && opts.rules.length) {
    const missed = opts.rules.filter(g => raw.text.includes(g.src) && !g.re.test(tl.text)).map(g => g.src + ' → ' + g.tgt);
    if (missed.length) out.push({ type: 'gls', desc: 'Istilah kamus di SRC belum terlihat di TL: ' + missed.join(', ') });
  }
  return out;
}

// Reattach lead/tail/mid <Tn>, drop extras, sync <BR>, normalize malformed tags.
export function fixTags(src, tl) {
  tl = normalizeMalformedTags(tl);
  const sc = tagCount(src), seen = {};
  let out = tl.replace(/<T\d+>/g, m => { seen[m] = (seen[m] || 0) + 1; return seen[m] > (sc[m] || 0) ? '' : m; }).replace(/\s{2,}/g, ' ').trim();
  const leadMatch = src.match(/^(?:<T\d+>)+/), tailMatch = src.match(/(?:<T\d+>)+$/);
  const leadTags = leadMatch ? leadMatch[0].match(/<T\d+>/g) : [];
  const tailTags = (tailMatch && (!leadMatch || tailMatch.index > 0)) ? tailMatch[0].match(/<T\d+>/g) : [];
  const oc = tagCount(out), addLead = [], addTail = [], need = {};
  for (const t in sc) need[t] = (sc[t] || 0) - (oc[t] || 0);
  for (const t of leadTags) { if (need[t] > 0) { addLead.push(t); need[t]--; } }
  for (const t of tailTags) { if (need[t] > 0) { addTail.push(t); need[t]--; } }
  for (const t in need) { while (need[t] > 0) { addTail.unshift(t); need[t]--; } }
  if (addLead.length && addTail.length && /^["'“].*["'”]$/.test(out)) out = out.slice(1, -1).trim();
  if (addLead.length) out = addLead.join('') + out;
  if (addTail.length) out = out + addTail.join('');
  const srcSeq = tagList(src), outSeq = tagList(out);
  if (srcSeq.length === outSeq.length && srcSeq.join(',') !== outSeq.join(',')) { let i = 0; out = out.replace(/<T\d+>/g, () => srcSeq[i++]); }
  const brSrc = brCount(src), brOut = brCount(out);
  if (brOut > brSrc) { let keep = brSrc; out = out.replace(/<BR>/g, () => (keep-- > 0 ? '<BR>' : ' ')); }
  else if (brOut < brSrc) { for (let i = 0; i < brSrc - brOut; i++) out += '<BR>'; }
  return out.replace(/\s{2,}/g, ' ').trim();
}
