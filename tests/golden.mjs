// Core engine verification suite: verifies util, batch, kirikiri (.ks), txt, artemis (.txt/.ast), scn, vntp, and qc modules.
import assert from 'node:assert/strict';
import * as util from '../core/util.js';
import * as batch from '../core/batch.js';
import * as ks from '../core/engines/kirikiri.js';
import * as txt from '../core/engines/txt.js';
import * as art from '../core/engines/artemis.js';
import * as scn from '../core/engines/scn.js';
import * as vntp from '../core/engines/vntp.js';
import * as qc from '../core/qc.js';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log('  ok  ' + name);
  } catch (e) {
    fail++;
    console.log('FAIL  ' + name + '\n     ' + String(e.message).split('\n').slice(0, 6).join('\n     '));
  }
};

const KS = [
  '*start|Prolog', '@nm t="Ei"', '「おはよう、[ruby text="ともだち"]友達」[l][r]', '[r]', ';comment',
  '@lr', '*lbl|Dup', '@mr', '#Yuu', 'これはナレーション。[l][r]', '[nm t="Mio"]「行こう！」[p]', '@sel01 text="はい"', ''
].join('\r\n');
const TXT = ['【アキラ】', '「やあ」', '', '地の文です。', '', '【ミオ】', '%f;やっほー'].join('\n');
const ART = ['*scene1', '[name 太郎]', 'こんにちは', '', '地の文その一', '地の文その二', '', '[sel_text text="選ぶ" ]', ''].join('\n');
const AST = `ast={
text={
[1]={name={name="スヴェトラーナ", ja="Sve"}, ja={ "こんにちは", {"rt2"}, "元気?" }, },
[2]={name={name="香子"}, {"やあ"} },
},
}
`;
const sgN = util.sortGls({ 'ともだち': 'teman', 'こんにちは': 'halo' });

function trans(extracted) {
  const tr = {};
  extracted.lines.forEach((ln, i) => {
    if (!ln) return;
    const m = ln.match(/^\[(\d+)\|([^\]]+)\] (.*)$/);
    tr[m ? m[1] : i] = [m ? m[2] : 'Narasi', m ? '«' + m[3] + '»' : '«' + ln + '»'];
  });
  return tr;
}

t('util: sortGls orders longest keys first', () => {
  assert.deepEqual(sgN, [['こんにちは', 'halo'], ['ともだち', 'teman']]);
});
t('util: maskTxtTags masks bracketed and % tags', () => {
  const m = util.maskTxtTags('a [ruby text="x"] b');
  assert.equal(m.masked, 'a <T1> b');
  assert.deepEqual(m.tl, ['[ruby text="x"]']);
});
t('util: unmaskTags restores masked tags', () => {
  assert.equal(util.unmaskTags('a <T1> b', ['[x]']), 'a [x] b');
});

t('ks: extract + repack round-trip', () => {
  const a = ks.extractFromKs(KS, sgN);
  assert.ok(a.entryCount >= 4);
  const out = ks.repackKs(KS, a.tagStore, trans(a), 0, '[l][r]');
  assert.ok(out.includes('«'));
});

t('txt: extract + repack round-trip', () => {
  const pb = txt.parseTxtBlocks(TXT);
  const a = txt.extractFromTxt(pb.blocks, sgN);
  assert.equal(a.lines.length, 3);
  const out = txt.repackTxt(pb.rawLines, a.tagStore, trans(a), 0, '\n');
  assert.ok(out.includes('«'));
});

t('artemis: extract + repack round-trip', () => {
  const a = art.extractFromArt(ART, sgN);
  assert.equal(a.lines.length, 3);
  const out = art.repackArt(ART, a.tagStore, trans(a), 0, '\n');
  assert.ok(out.includes('«'));
});

t('ast: extract + repack round-trip', () => {
  const a = art.extractFromAst(AST, sgN);
  assert.ok(a.entryCount > 0, 'ast entries found');
  for (const noRt2 of [false, true]) {
    const out = art.repackAst(AST, a.tagStore, trans(a), 0, '\r\n', noRt2);
    assert.ok(out.includes('«'));
  }
});

t('ast-generic: extract + repack round-trip', () => {
  const g = 'x={\n ja={ {"halo dunia"} },\n ja={ {"kedua"} },\n}';
  assert.ok(art.detectAstLanguages(g).includes('ja'));
  const a = art.extractFromAstGeneric(g, 'ja', sgN);
  assert.equal(a.entryCount, 2);
  const out = art.repackAstGeneric(g, a.tagStore, trans(a), 0, '\n', 'ja');
  assert.ok(out.includes('«halo dunia»'));
});

t('scn: module loads & rejects non-PSB with a clear error', () => {
  assert.equal(typeof scn.extractFromScn, 'function');
  assert.throws(() => scn.extractFromScn(new Uint8Array(64), []), /PSB|Header|XOR|kecil/i);
});

t('batch: convertExtractedLinesToV25 preserves text and speaker format', () => {
  const lines = ['[0|Ei] 「こんにちは」', '[1|Narasi] 地の文<T1>'];
  const out = batch.convertExtractedLinesToV25(lines, 'a.ks', { val: 0 }, 'v25b', {});
  assert.deepEqual(out, ['000000. [Ei] 「こんにちは」', '000001. (Narasi) 地の文<T1>']);
});

t('end-to-end: extract -> batch -> parse -> resolve -> repack round-trips text', () => {
  const ex = ks.extractFromKs(KS, sgN), g = { val: 0 }, gm = {};
  const lines = batch.convertExtractedLinesToV25(ex.lines, 'a.ks', g, 'v25b', gm);
  assert.ok(lines.every(l => /\S$/.test(l)), 'no empty bodies');
  const parsed = batch.parseBatchUnified('--- FILE: a.ks ---\n' + lines.join('\n'), true);
  const tr = batch.resolveTranslationsForRepack(parsed.ents, { 'a.ks': { kind: 'ks', tags: ex.tagStore } }, gm)['a.ks'];
  assert.equal(Object.keys(tr).length, ex.entryCount);
  const out = ks.repackKs(KS, ex.tagStore, tr, 0, '[l][r]');
  assert.ok(out.includes('おはよう') || out.includes('ともだち'), 'untranslated JP text survives round-trip');
});

t('ks: decodeKs detects UTF-8 without BOM and Shift-JIS', () => {
  const u8 = new TextEncoder().encode('「おはよう」[l][r]\n');
  const d = ks.decodeKs(u8.buffer.slice(u8.byteOffset, u8.byteLength));
  assert.equal(d.enc, 'utf-8');
  assert.equal(d.text, '「おはよう」[l][r]\n');
  const sjis = new Uint8Array([0x82, 0xA0, 0x82, 0xA2]);
  const d2 = ks.decodeKs(sjis.buffer);
  assert.equal(d2.enc, 'shift-jis');
  assert.equal(d2.text, 'あい');
  const ascii = new TextEncoder().encode('@r\n');
  assert.equal(ks.decodeKs(ascii.buffer.slice(0)).enc, 'shift-jis');
});

const VJ = [
  { name: 'アキラ', message: '「おはよう」[1]' }, { message: '第一章' }, { message: '地の文です。' }, { message: '第一章' },
  { message: '第一章' }, { name: '', message: 'ナレーション' }, { message: '  ' }, { name: 'ミオ', message: '「やあ」' }, { x: 1 }, { message: 'はい' },
];
t('vntp: noise filter detects repeated bookmark labels', () => {
  const a = vntp.findVntpLabelNoise(VJ);
  assert.ok(a.size >= 1);
});
t('vntp: extract/repack preserves structure without mutating input', () => {
  for (const filter of [false, true]) {
    const before = JSON.stringify(VJ);
    const ex = vntp.extractFromVntp(VJ, sgN, { filter });
    assert.ok(ex.entryCount >= 4);
    const tr = Object.fromEntries(ex.lines.map(l => {
      const m = /^\[(\d+)\|([^\]]+)\] (.*)$/s.exec(l);
      return [m[1], [m[2] === 'Narasi' ? 'Narasi' : 'Name' + m[1], 'T ' + m[3] + ' x y z']];
    }));
    const r = vntp.repackVntp(VJ, ex.tagStore, tr, 8, '\n').data;
    assert.equal(r.length, VJ.length);
    assert.equal(JSON.stringify(VJ), before);
  }
});

const QC_CASES = [
  ['<T1>こんにちは<T2>', '<T1>"Halo"<T2>'], ['<T1>こんにちは<T2>', 'Halo'], ['A<T1>B<T2>C', 'A<T2>B<T1>C'], ['A<BR>B', 'A B'], ['A<BR>B', 'a<br>b'],
  ['<T1>x', '[T1] y'], ['「いらっしゃい」', 'Selamat datang 「ya」'], ['hello', '"it\'s a "test'], ['これは日本語です', 'これは日本語です'], ['abc', 'x'.repeat(120)],
  ['<T1>あ<T2>', '(T1) aaa'], ['A<T1>B', 'A B <T1> <T1> C'], ['あ<BR>い', 'a<BR>b<BR>c'],
];
t('qc: tagDiff, normalizeMalformedTags, and fixTags repair tags accurately', () => {
  for (const [a, b] of QC_CASES) {
    const fixed = qc.fixTags(a, b);
    const diff = qc.tagDiff(a, fixed);
    assert.equal(diff.missing.length, 0);
    assert.equal(diff.extra.length, 0);
    assert.equal(diff.orderBad, false);
    assert.equal(diff.brDiff, 0);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
