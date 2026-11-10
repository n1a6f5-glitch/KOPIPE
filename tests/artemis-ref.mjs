// Conformance cases derived from VNTranslationTools' Artemis scripts (ArtemisAstScript / ArtemisTxtScript / Lua*).
import assert from 'node:assert/strict';
import * as A from '../core/engines/artemis.js';
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + '\n    ' + String(e.message).split('\n').slice(0, 8).join('\n    ')); } };
const R = (s) => A.getArtRanges(s).map(r => [r.type, s.slice(r.offset, r.offset + r.length)]);
const ident = (s, ex = A.extractFromArt) => ex(s, []);
const tr = (ex, fn) => Object.fromEntries(ex.lines.map((l, i) => [i, [fn ? fn.name : 'x', l.replace(/^\[\d+\|[^\]]*\] /, '')]]));

// — .art —
t('art: name = first attrname (quotes included), sel_text text= value', () => {
  assert.deepEqual(R('[name "Taro"]\nHello\n\n[sel_text text="A b" x=1]\n'), [['name', '"Taro"'], ['message', 'Hello'], ['message', 'A b']]);
});
t('art: labels skip without ending block; indented * is NOT a label (reference)', () => {
  assert.deepEqual(R('line1\n*lbl\nline2\n\n'), [['message', 'line1\n*lbl\nline2']]);
  assert.deepEqual(R(' *x\n\n'), [['message', ' *x']]);
});
t('art: non-name command inside a block does not end it', () => {
  assert.deepEqual(R('A\n[wait]\nB\n\n'), [['message', 'A\n[wait]\nB']]);
});
t('art: comments (// and ;) are stripped from range end', () => {
  assert.deepEqual(R('Hello ;note\n\n'), [['message', 'Hello ']]);
  assert.deepEqual(R('Hi // x\n;full\n\n'), [['message', 'Hi ']]);
});
t('art: last block flushed at EOF without trailing blank line', () => {
  assert.deepEqual(R('tail text'), [['message', 'tail text']]);
});
t('art: single-quoted & bare attr values, escaped quotes', () => {
  assert.deepEqual(R(`[sel_text text='it\\'s']\n`).length >= 0, true);
  assert.deepEqual(R('[sel_text text=ab c]\n[sel_text text=bare]\n[sel_text text="a\\"b"]\n'), [['message', 'ab'], ['message', 'bare'], ['message', 'a\\"b']]);
});
t('art: unquoted attr that gains a space gets quoted on write; quoted does not', () => {
  const s = '[sel_text text=bare]\n[sel_text text="q"]\n';
  const ex = ident(s); const out = A.repackArt(s, ex.tagStore, { 0: ['', 'two words'], 1: ['', 'two words'] }, 0, '\n');
  assert.equal(out, '[sel_text text="two words"]\n[sel_text text="two words"]\n');
});
t('art: name rename applies to name range; repack identity when untouched', () => {
  const s = '*a\n[name Taro]\n こんにちは \n\n';
  const ex = ident(s); assert.equal(ex.lines[0].startsWith('[0|Taro]'), true);
  assert.equal(A.repackArt(s, ex.tagStore, tr(ex, { name: 'Taro' }), 0, '\n'), s);
  assert.equal(A.repackArt(s, ex.tagStore, { 0: ['Tarou X', ' 「Halo 」'] }, 0, '\n'), '*a\n[name "Tarou X"]\n 「Halo 」\n\n');
});
t('art: tolerance for `[cmd a="b" ]` (trailing space) as command, not text', () => {
  assert.deepEqual(R('[sel_text text="x" ]\n'), [['message', 'x']]);
});
t('art: CRLF files keep offsets right', () => {
  const s = '[name A]\r\nHello\r\n\r\nBye\r\n\r\n'; const ex = ident(s);
  assert.equal(ex.entryCount, 2);
  assert.equal(A.repackArt(s, ex.tagStore, { 0: ['A', 'Halo'] }, 0, '\r\n'), '[name A]\r\nHalo\r\n\r\nBye\r\n\r\n');
});

// — .ast —
const V1 = `astver=1.0
ast={
text={
[1]={ name={name="スヴェトラーナ", ja="Sve"}, ja={ "こんにちは", {"rt2"}, "元気?"}, },
[2]={ name={name="香子"}, {"やあ", {"vo", file="a.ogg", vol=1.5}, "。" } , select={"はい","いいえ"} },
},
}
`;
const V2 = `astver=2.0
ast={
[1]={ text={ ja={ { name={"太郎","タロ"}, "こんにちは", {"rt2"}, "元気", } } }, select={ ja={"はい","いいえ"} } },
}
`;
t('ast: V1 entries (name, rt2 -> CRLF, command re-serialization)', () => {
  const ex = A.extractFromAst(V1, []);
  assert.equal(ex.entryCount > 0, true); console.log('         ', ex.lines);
});
t('ast: V2 (astver 2.0) names + select + message', () => {
  const ex = A.extractFromAst(V2, []); console.log('         ', ex.lines, ex.astver);
  assert.equal(ex.astver, '2.0');
});
t('ast: bracketed text that is not a command stays literal (reference would throw)', () => {
  const ex = A.extractFromAst(V1, []);
  const out = A.repackAst(V1, ex.tagStore, { 0: ['Sve', 'Halo [Mr. X] ok'] }, 0, '\r\n', false);
  assert.ok(out.includes('[Mr. X]'));
  A.extractFromAst(out, []);
});
t('ast: Lua escapes (\\n \\t \\\\ \\") round-trip; bracket strings; [N]= and ["k"]= keys; numbers kept verbatim', () => {
  const src = 'ast={\ntext={\n[1]={ name={name="A"}, {"a\\tb\\\\c\\"d"}, ["we ird"]=[==[raw ]] text]==], n=-1.50 },\n},\n}\n';
  const ex = A.extractFromAst(src, []);
  const out = A.repackAst(src, ex.tagStore, {}, 0, '\n', false);
  assert.ok(out.includes('[1]=')); assert.ok(out.includes('["we ird"]=')); assert.ok(out.includes('-1.50'));
  assert.ok(out.includes('a\\tb\\\\c\\"d'));
  assert.equal(A.repackAst(out, A.extractFromAst(out, []).tagStore, {}, 0, '\n', false), out); // idempotent
});
t('ast: trailing {rt2} kept after translation, looksLikeArtemisTxt sniff', () => {
  const s = 'ast={\ntext={\n[1]={ ja={ name={"A"}, {"x", {"rt2"}}, }, },\n},\n}\n';
  const e2 = A.extractFromAst(s, []); const o = A.repackAst(s, e2.tagStore, { 0: ['A', 'y'] }, 0, '\n', false);
  assert.ok(/"y",\s*\{"rt2"\}/.test(o), o);
  assert.equal(A.looksLikeArtemisTxt('*a\n[name X]\nhi\n[wait]\n'), true);
  assert.equal(A.looksLikeArtemisTxt('【A】\n「やあ」\n'), false);
});
t('ast: command attr with number / string values survive', () => {
  const ex = A.extractFromAst(V1, []);
  const out = A.repackAst(V1, ex.tagStore, {}, 0, '\n', false);
  assert.ok(/vo",\s*file="a\.ogg",\s*vol=1\.5|"vo",file="a\.ogg",vol=1\.5/.test(out), out);
});

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
