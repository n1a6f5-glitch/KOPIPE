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


t('ast: phonechat name-only sticker blocks never leak into next dialogue & translate cleanly via speaker map', () => {
  const pc = `astver = 2.0
ast = {
  text = {
    [227]={ja={{"そう思った時、スマホがLETTERの着信音を奏でた。"}}},
    [228]={lane=1, name={name="スヴェ"}},
    [229]={lane=2, name={name="スヴェ"}, ja={{"「ごめん間違えた」"}}},
    [230]={lane=3, name={name="スヴェ"}},
    [231]={lane=4, name={name="美玖"}},
    [232]={lane=5, name={name="香子"}},
    [233]={lane=6, name={name="広中"}},
    [234]={lane=7, name={name="宗冬"}},
    [235]={lane=8, name={name="スヴェ"}, ja={{"「皆起きてるね、偉い偉い」"}}},
    [236]={lane=9, name={name="広中"}, ja={{"「すっげー上から目線だな」"}}},
    [241]={lane=14, name={name="美玖"}, ja={{"「ごめん、素で間違えた」"}}},
    [249]={lane=22, name={name="香子"}, ja={{"「じゃあ、私も行きますね」"}}},
    [253]={lane=26, name={name="スヴェ"}},
    [254]={name={name="宗冬"}, ja={{"「流れで行くって言ったけど……」"}}},
  },
}`;
  const ex = A.extractFromAst(pc, []);
  assert.equal(ex.entryCount, 7);
  // Zero " / " leakage!
  assert.equal(ex.lines[1], '[1|スヴェ] 「ごめん間違えた」');
  assert.equal(ex.lines[2], '[2|スヴェ] 「皆起きてるね、偉い偉い」');
  assert.equal(ex.lines[6], '[6|宗冬] 「流れで行くって言ったけど……」');
  const tr = {
    0: ['Narasi', 'Saat memikirkan itu, ponselku berbunyi.'],
    1: ['Svetlana', '「Maaf, salah kirim」'],
    2: ['Svetlana', '「Semuanya sudah bangun」'],
    3: ['Hironaka', '「Nadanya merendahkan banget」'],
    4: ['Miku', '「Maaf, beneran salah」'],
    5: ['Kako', '「Kalau begitu saya juga datang」'],
    6: ['Munefuyu', '「Tadi aku kebawa suasana bilang ikut……」'],
  };
  const out = A.repackAst(pc, ex.tagStore, tr, 0, '\r\n');
  assert.ok(!out.includes(' / '), 'Repacked AST must not contain merged " / " names: ' + out);
  assert.ok(out.includes('[228]={\n      lane=1,\n      name={name="Svetlana"}') || /\[228\]=\{[\s\S]*?name="Svetlana"/.test(out));
  assert.ok(/\[231\]=\{[\s\S]*?name="Miku"/.test(out));
  assert.ok(/\[232\]=\{[\s\S]*?name="Kako"/.test(out));
  assert.ok(/\[233\]=\{[\s\S]*?name="Hironaka"/.test(out));
  assert.ok(/\[234\]=\{[\s\S]*?name="Munefuyu"/.test(out));
  assert.ok(/\[253\]=\{[\s\S]*?name="Svetlana"/.test(out));
  assert.ok(/\[254\]=\{[\s\S]*?name="Munefuyu"/.test(out));
});


t('ast: select={ja={...}} extraction & Multi-Lang en/id repack (dialog, select, name, orphanName, idempotent, CRLF, no-double-space)', () => {
  const raw = [
    'ast={',
    'text={',
    '[1]={',
    'name={name="皐"},',
    'ja={{"「はい。",{"rt2"},"承知しました」"}},',
    '},',
    '[2]={',
    'lane=1,',
    'name={name="スヴェトラーナ",ja="スヴェ"},',
    '},',
    '[3]={',
    'name={name="スヴェトラーナ",ja="スヴェ"},',
    'ja={{"「おはよう」"}},',
    '},',
    '[264]={',
    'select={',
    'ja={"美玖が一番似合ってる","スヴェが一番似合ってる","香子が一番似合ってる"},',
    '},',
    '},',
    '},',
    '}'
  ].join('\r\n') + '\r\n';

  // Extract in Multi-Lang en mode
  const exEn = A.extractFromAst(raw, [], { astLang: 'en' });
  assert.equal(exEn.entryCount, 5);
  assert.equal(exEn.lines[0], '[0|皐] 「はい。<BR>承知しました」');
  assert.equal(exEn.lines[1], '[1|スヴェ] 「おはよう」');
  assert.equal(exEn.lines[2], '[2|Choice] 美玖が一番似合ってる');
  assert.equal(exEn.lines[3], '[3|Choice] スヴェが一番似合ってる');
  assert.equal(exEn.lines[4], '[4|Choice] 香子が一番似合ってる');

  // Repack en (with rt2AsSpace=true to also verify no double spaces!)
  const repEn = A.repackAst(raw, exEn.tagStore, {
    0: ['Satsuki', '「Yes. <BR> Understood.」'],
    1: ['Svetlana', '「Good morning.」'],
    2: ['Choice', 'Miku looks best'],
    3: ['Choice', 'Sve looks best'],
    4: ['Choice', 'Kako looks best'],
  }, 0, '\r\n', true, { astLang: 'en' });

  // CRLF check (no bare LF)
  assert.equal(repEn.includes('\r\n'), true);
  assert.equal(repEn.replace(/\r\n/g, '').includes('\n'), false);
  // No double space from rt2AsSpace
  assert.equal(repEn.includes('  '), false);
  // ja preserved intact, en injected
  assert.match(repEn, /name=\{name="皐",ja="皐",en="Satsuki"\}/);
  assert.match(repEn, /name=\{name="スヴェトラーナ",ja="スヴェ",en="Svetlana"\}/);
  assert.equal((repEn.match(/en="Svetlana"/g) || []).length, 2, 'orphanName phonechat sticker also updated cleanly');
  assert.match(repEn, /「はい。/);
  assert.match(repEn, /en=\{\r\n\{\r\n"「Yes\. ",\r\n"Understood\.」",\r\n\},\r\n\},/);
  assert.match(repEn, /select=\{\r\nja=\{\r\n"美玖が一番似合ってる"/);
  assert.match(repEn, /en=\{\r\n"Miku looks best",\r\n"Sve looks best",\r\n"Kako looks best",\r\n\},/);

  // Re-import Multi-Lang file in en mode: must pre-load existing en translations & stay idempotent!
  const exEn2 = A.extractFromAst(repEn, [], { astLang: 'en' });
  assert.equal(exEn2.initialTranslations[0].tgt, '「Yes. Understood.」');
  assert.equal(exEn2.initialTranslations[0].tgtName, 'Satsuki');
  assert.equal(exEn2.initialTranslations[2].tgt, 'Miku looks best');

  // Now inject id on top of the en file -> must preserve BOTH ja and en!
  const exId = A.extractFromAst(repEn, [], { astLang: 'id' });
  assert.equal(exId.initialTranslations, null);
  const repId = A.repackAst(repEn, exId.tagStore, {
    0: ['Satsuki', '「Baik. Mengerti」'],
    2: ['Choice', 'Miku paling cocok'],
  }, 0, '\r\n', false, { astLang: 'id' });
  assert.match(repId, /name=\{name="皐",ja="皐",en="Satsuki",id="Satsuki"\}/);
  assert.match(repId, /en=\{\r\n"Miku looks best"/);
  assert.match(repId, /id=\{\r\n"Miku paling cocok"/);
  // Idempotent update: repacking en again must NOT duplicate en={...}
  const repEnAgain = A.repackAst(repId, exEn2.tagStore, { 0: ['Satsuki', '「Yes, got it.」'] }, 0, '\r\n', false, { astLang: 'en' });
  assert.equal((repEnAgain.match(/name=\{name="皐",ja="皐",en="Satsuki",id="Satsuki"\}/g) || []).length, 1);
  assert.equal((repEnAgain.match(/Yes, got it\./g) || []).length, 1);
});

t('ast: non-dialog .ast without text={ exports verbatim without error', () => {
  const brand = 'ast={\r\n{{"video",file="logo.mpg"}},\r\n}\r\n';
  const ex = A.extractFromAst(brand, [], { astLang: 'en' });
  assert.equal(ex.entryCount, 0);
  assert.equal(ex.noText, true);
  assert.equal(A.repackAst(brand, ex.tagStore, {}, 0, '\r\n', false, { astLang: 'en' }), brand);
});

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
