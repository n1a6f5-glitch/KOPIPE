// Conformance cases from VNTranslationTools' KirikiriKsScript.cs.
import assert from 'node:assert/strict';
import { getKsRanges, extractFromKs, repackKs } from '../core/engines/kirikiri.js';
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + '\n    ' + String(e.message).split('\n').slice(0, 8).join('\n    ')); } };
const E = (s) => extractFromKs(s, []);
const body = (l) => l.replace(/^\[\d+\|[^\]]*\] /, '');
const R = (s) => getKsRanges(s).map(r => [r.type, s.slice(r.offset, r.offset + r.length)]);

t('multi-line paragraph merges into ONE entry ([r] -> <BR>, hard newline dropped)', () => {
  const s = 'こんにちは[r]\r\n元気?[p]\r\n';
  const e = E(s); assert.equal(e.entryCount, 1); assert.equal(body(e.lines[0]), 'こんにちは<BR>元気?');
  assert.equal(repackKs(s, e.tagStore, { 0: ['', 'Hello<BR>there'] }, 0), 'Hello[r]\r\nthere[p]\r\n');
});
t('blank line separates entries; LF-only files merge too', () => {
  assert.equal(E('あ\r\n\r\nい\r\n').entryCount, 2);
  assert.equal(E('あ[r]\nい[p]\n').entryCount, 1);
});
t('non-allowed inline cmd ([l]) splits the segment; lone [r] after it is dropped', () => {
  const s = 'こんにちは[l][r]\r\n次[p]\r\n';
  assert.deepEqual(R(s), [['message', 'こんにちは'], ['message', '次']]);
});
t('ruby -> base text (reading dropped); char=N and default 1', () => {
  assert.equal(body(E('[ruby text="きょう" char=2]今日は[p]\r\n').lines[0]), '今日は');
  assert.equal(body(E('[ruby text="あ"]亜x[p]\r\n').lines[0]), '亜x');
});
t('attr values only count when they contain Japanese (target=*lbl, t="Ei" skipped)', () => {
  assert.deepEqual(R('@sel01 target=*lbl text="はい"\r\n'), [['message', 'はい']]);
  assert.deepEqual(R('@nm t="Ei"\r\n'), []);
  assert.deepEqual(R('@nm t="太郎"\r\nこん\r\n'), [['name', '太郎'], ['message', 'こん']]);
});
t('# names, 【name】 inline, [nm t=..] inline, [ns]...[nse] typing', () => {
  assert.deepEqual(R('#太郎\r\n「やあ」\r\n'), [['name', '太郎'], ['message', '「やあ」']]);
  assert.deepEqual(R('[【花子】]「こんにちは」[p]\r\n').map(x => x[0]), ['name', 'message']);
  assert.deepEqual(R('[nm t="太郎"]「やあ」[p]\r\n'), [['name', '太郎'], ['message', '「やあ」']]);
  assert.deepEqual(R('[ns]太郎[nse]「やあ」[p]\r\n'), [['name', '太郎'], ['message', '「やあ」']]);
});
t('iscript / macro blocks skipped; comments skipped', () => {
  assert.deepEqual(R('[iscript]\r\nあいう\r\n[endscript]\r\n;コメント\r\n本文\r\n'), [['message', '本文']]);
});
t('quoted attr containing ] does not break inline command detection', () => {
  assert.deepEqual(R('[nm t="太郎]あ"]\r\n'), [['name', '太郎]あ']]);
});
t('rewind-bookmark labels (@lr / *x|y / @mr) skipped; normal labels extracted', () => {
  assert.deepEqual(R('@lr\r\n*a|章タイトル\r\n@mr\r\n'), []);
  assert.deepEqual(R('*a|章タイトル\r\n'), [['message', '章タイトル']]);
});
t('untouched entries are byte-identical after repack; names renamed; CRLF kept', () => {
  const s = '#太郎\r\n「やあ」[l][r]\r\n続き[p]\r\n\r\n#花子\r\nおはよう[p]\r\n';
  const e = E(s);
  assert.equal(repackKs(s, e.tagStore, {}, 0), s);
  const out = repackKs(s, e.tagStore, { 2: ['Hanako', 'Selamat pagi'] }, 0);
  assert.equal(out, '#太郎\r\n「やあ」[l][r]\r\n続き[p]\r\n\r\n#Hanako\r\nSelamat pagi[p]\r\n');
});
t('wrap: breaks become [r] + newline in the file\'s newline style', () => {
  const s = 'あ[p]\n'; const e = E(s);
  assert.equal(repackKs(s, e.tagStore, { 0: ['', 'aaa bbb ccc'] }, 7), 'aaa bbb[r]\nccc[p]\n');
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
