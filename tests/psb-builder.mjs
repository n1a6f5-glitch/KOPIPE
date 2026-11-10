// Builds synthetic PSB files (spec-faithful: name trie, strings table, offset tables) for testing.
// Tree nodes: {t:'obj', e:[[name,node],...]} {t:'col', i:[node,...]} {t:'str', s} {t:'int', v} {t:'null'} {t:'bool', v} {t:'float', v} {t:'double', v} {t:'res', v}
export const O = (e) => ({ t: 'obj', e }), C = (...i) => ({ t: 'col', i }), S = (s) => ({ t: 'str', s }), I = (v) => ({ t: 'int', v }), NUL = { t: 'null' };

const wFor = v => { let w = 1; while (v >= 2 ** (8 * w)) w++; return w; };
const le = (v, w) => { const o = []; for (let i = 0; i < w; i++) o.push(Math.floor(v / 2 ** (8 * i)) & 0xFF); return o; };
function arr(vals, minEl = 1) {
  const n = vals.length, el = Math.max(wFor(Math.max(0, ...vals)), minEl), cw = wFor(n);
  const o = [0xC + cw, ...le(n, cw), 0xC + el];
  for (const v of vals) o.push(...le(v, el));
  return o;
}
function buildTrie(sortedNames) {
  const root = { idx: 0, ch: -1, kids: new Map(), parent: null };
  for (const nm of sortedNames) {
    let n = root;
    for (const ch of [...Buffer.from(nm, 'utf8'), 0]) {
      if (!n.kids.has(ch)) n.kids.set(ch, { ch, kids: new Map(), parent: n });
      n = n.kids.get(ch);
    }
    n.term = nm;
  }
  const used = new Set([0]), queue = [root], base = new Map(); let maxIdx = 0;
  while (queue.length) {
    const n = queue.shift(); if (!n.kids.size) continue;
    let b = 1; const chs = [...n.kids.keys()];
    while (chs.some(c => used.has(b + c))) b++;
    base.set(n, b);
    for (const [c, k] of n.kids) { k.idx = b + c; used.add(k.idx); maxIdx = Math.max(maxIdx, k.idx); queue.push(k); }
  }
  const str1 = new Array(maxIdx + 1).fill(0), str2 = new Array(maxIdx + 1).fill(0), term = new Map();
  (function walk(n) { if (base.has(n)) str1[n.idx] = base.get(n); for (const k of n.kids.values()) { str2[k.idx] = n.idx; if (k.term !== undefined) term.set(k.term, k.idx); walk(k); } })(root);
  return { str1, str2, term };
}

export function buildPsb(root, { version = 2, chunks = [] } = {}) {
  const names = new Set(), strings = []; const sIdx = new Map();
  (function scan(n) { if (n.t === 'obj') n.e.forEach(([k, v]) => { names.add(k); scan(v); }); else if (n.t === 'col') n.i.forEach(scan); else if (n.t === 'str' && !sIdx.has(n.s)) { sIdx.set(n.s, strings.length); strings.push(n.s); } })(root);
  const sorted = [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const nameIdx = new Map(sorted.map((n, i) => [n, i]));
  const { str1, str2, term } = buildTrie(sorted);
  const str3 = sorted.map(n => term.get(n));
  const namesBytes = [...arr(str1), ...arr(str2), ...arr(str3)];
  const strW = Math.max(1, wFor(strings.length - 1));
  function enc(n) {
    switch (n.t) {
      case 'null': return [1];
      case 'bool': return [n.v ? 3 : 2];
      case 'str': return [0x14 + strW, ...le(sIdx.get(n.s), strW)];
      case 'res': return [0x18 + wFor(n.v), ...le(n.v, wFor(n.v))];
      case 'int': { if (n.v === 0) return [4]; let w = 1; while (n.v < -(2 ** (8 * w - 1)) || n.v >= 2 ** (8 * w - 1)) w++; return [4 + w, ...le(n.v < 0 ? n.v + 2 ** (8 * w) : n.v, w)]; }
      case 'float': { const b = Buffer.alloc(4); b.writeFloatLE(n.v); return [0x1E, ...b]; }
      case 'double': { const b = Buffer.alloc(8); b.writeDoubleLE(n.v); return [0x1F, ...b]; }
      case 'col': case 'obj': {
        const items = n.t === 'col' ? n.i : [...n.e].sort((a, b) => nameIdx.get(a[0]) - nameIdx.get(b[0])).map(e => e[1]);
        const kids = items.map(enc), offs = []; let cur = 0; kids.forEach(k => { offs.push(cur); cur += k.length; });
        const head = n.t === 'col' ? [0x20, ...arr(offs)] : [0x21, ...arr([...n.e].map(e => nameIdx.get(e[0])).sort((a, b) => a - b)), ...arr(offs)];
        return [...head, ...kids.flat()];
      }
    }
    throw new Error('bad node ' + n.t);
  }
  const entries = enc(root);
  const strOffs = []; let sc = 0; const sBytes = [];
  for (const s of strings) { strOffs.push(sc); const b = [...Buffer.from(s, 'utf8'), 0]; sBytes.push(...b); sc += b.length; }
  const strArr = arr(strOffs), chO = arr(chunks.reduce((a, c) => { a.push(a.length ? a[a.length - 1] + chunks[a.length - 1].length : 0); return a; }, [])), chL = arr(chunks.map(c => c.length));
  const oNames = 40, oEntries = oNames + namesBytes.length, oStrings = oEntries + entries.length, oSData = oStrings + strArr.length,
    oChO = oSData + sBytes.length, oChL = oChO + chO.length, oChD = oChL + chL.length;
  const h = Buffer.alloc(40); h.write('PSB\0', 0, 'latin1'); h.writeUInt16LE(version, 4); h.writeUInt16LE(0, 6);
  [oNames, oNames, oStrings, oSData, oChO, oChL, oChD, oEntries].forEach((v, i) => h.writeUInt32LE(v, 8 + i * 4));
  return new Uint8Array(Buffer.concat([h, Buffer.from(namesBytes), Buffer.from(entries), Buffer.from(strArr), Buffer.from(sBytes), Buffer.from(chO), Buffer.from(chL), ...chunks.map(c => Buffer.from(c))]));
}
