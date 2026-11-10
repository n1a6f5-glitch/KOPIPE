// core/engines/vntp.js – VNTextPatch JSON ([{name?, message}, ...]). Ported from KOPIPE (runVntpExtract/runVntpRepack).
import { applyGls, maskTxtTags, wrapText, unmaskTags } from '../util.js';
import { isNarrationSpeaker } from '../batch.js';

// Label/bookmark noise: unnamed, short (≤40), not ending like a sentence, repeated ≥3× in a file -> keep the first, skip the rest.
const NOISE_END = /[。！？!?…♪ .]$/;
const NOISE_MIN_REPEAT = 3;
export function findVntpLabelNoise(data) {
  const freq = {};
  for (const e of data) {
    if (!e || typeof e !== 'object' || ('name' in e && e.name)) continue;
    if (typeof e.message !== 'string') continue;
    const t = e.message.trim();
    if (!t || t.length > 40 || NOISE_END.test(t)) continue;
    freq[t] = (freq[t] || 0) + 1;
  }
  const seen = {}, skip = new Set();
  Object.keys(freq).forEach(v => { if (freq[v] >= NOISE_MIN_REPEAT) seen[v] = 0; });
  data.forEach((e, j) => {
    if (!e || typeof e !== 'object' || ('name' in e && e.name)) return;
    const m = typeof e.message === 'string' ? e.message.trim() : '';
    if (m && (m in seen) && ++seen[m] > 1) skip.add(j);
  });
  return skip;
}

// data: parsed JSON array. Returns {lines:['[idx|name] masked'], tagStore:{idx:{tl}}, entryCount, skipped:[{idx,message}], hasName:{idx:bool}}
// idx = index in the JSON array (gaps are normal). opts.filter: apply the bookmark-noise filter (default false).
export function extractFromVntp(data, sg, opts = {}) {
  if (!Array.isArray(data)) throw new Error('JSON VNTP harus berupa array');
  const skip = opts.filter ? findVntpLabelNoise(data) : new Set();
  const lines = [], tagStore = {}, hasName = {}, skipped = [];
  let n = 0;
  data.forEach((e, idx) => {
    if (skip.has(idx)) { skipped.push({ idx, message: e.message }); return; }
    if (!e || typeof e !== 'object' || typeof e.message !== 'string' || !e.message.trim()) return;
    const rawN = e.name || 'Narasi';
    const name = sg.length ? applyGls(rawN, sg) : rawN;
    const message = sg.length ? applyGls(e.message, sg) : e.message;
    const mt = maskTxtTags(message);
    tagStore[idx] = { tl: mt.tl };
    hasName[idx] = !('name' in e && e.name);
    lines.push('[' + idx + '|' + name + '] ' + mt.masked);
    n++;
  });
  return { lines, tagStore, entryCount: n, skipped, hasName };
}

// translations: {idx:[name, maskedText]}. Returns the new array (input is not mutated) + count.
export function repackVntp(data, tagStore, translations, wrapWidth, nl) {
  if (!Array.isArray(data)) throw new Error('JSON VNTP harus berupa array');
  const out = data.map(e => (e && typeof e === 'object' ? { ...e } : e));
  let injected = 0;
  for (const idxStr of Object.keys(translations)) {
    const idx = parseInt(idxStr, 10);
    if (idx < 0 || idx >= out.length) continue;
    const entry = out[idx];
    if (!entry || !('message' in entry)) continue;
    const [newN, translated] = translations[idxStr];
    const tl = (tagStore[idxStr] && tagStore[idxStr].tl) || [];
    entry.message = unmaskTags(wrapText(translated, wrapWidth, nl), tl);
    if ('name' in entry && !isNarrationSpeaker(newN) && newN !== 'Dialog') entry.name = newN;
    injected++;
  }
  return { data: out, injected };
}
