import fs0 from 'node:fs';
import { execFileSync as _ef } from 'node:child_process';
const HAVE_REF = fs0.existsSync('./tests/ref/dump');
const execFileSync = (...a) => _ef(...a);
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { buildPsb, O, C, S, I, NUL } from './psb-builder.mjs';
import { parsePsb, psbObjectsSize, psbObjName, psbObjValue, psbCollectionSize, psbColValue, psbStr, psbArrayGet } from '../core/engines/scn.js';
import { createLog, formatLog, summarizeLog } from '../core/log.js';
import { importScript, exportScript } from '../core/engines/index.js';

function fmt(psb, node, label, depth, out) {
  const pad = '  '.repeat(depth), L = label === null ? '' : /^\[\d+\]$/.test(label) ? label + ' ' : label + ' = ';
  switch (node.kind) {
    case 'objects': out.push(`${pad}${L}OBJ ${psbObjectsSize(node.obj)}`);
      for (let i = 0; i < psbObjectsSize(node.obj); i++) fmt(psb, psbObjValue(psb, node.obj, i), psbObjName(psb, node.obj, i), depth + 1, out); break;
    case 'collection': out.push(`${pad}${L}COL ${psbCollectionSize(node.col)}`);
      for (let i = 0; i < psbCollectionSize(node.col); i++) fmt(psb, psbColValue(psb, node.col, i), `[${i}]`, depth + 1, out); break;
    case 'string': out.push(`${pad}${L}STR #${node.index} "${psbStr(psb, node.index)}"`); break;
    case 'number': out.push(`${pad}${L}${node.numberType === 'integer' ? 'INT' : node.numberType.toUpperCase()} ${node.value}`); break;
    case 'bool': out.push(`${pad}${L}BOOL ${node.value ? 1 : 0}`); break;
    case 'null': out.push(`${pad}${L}NULL`); break;
    default: out.push(`${pad}${L}${node.kind}`);
  }
}
const tree = O([
  ['scenes', C(O([['title', S('こんにちは')], ['texts', C(C(S('A'), S('名前')), I(0), I(-1), I(300), I(-70000), I(2 ** 31), NUL)]]))],
  ['日本語名', I(5)], ['ab', S('x')], ['abc', S('y')], ['b', I(1)], ['label_z', S('')],
  ['f', { t: 'float', v: 1.5 }], ['d', { t: 'double', v: -2.25 }], ['t', { t: 'bool', v: true }],
]);
function check(tree, name, opts) {
  const buf = buildPsb(tree, opts); const f = `/tmp/${name}.psb`; fs.writeFileSync(f, buf);
  const psb = parsePsb(buf); const js = []; fmt(psb, psb.root, 'ROOT', 0, js);
  if (!HAVE_REF) { console.log('ok', name, '(JS only — C++ dumper not built)'); return; }
  const ref = execFileSync('./tests/ref/dump', [f]).toString().split('\n');
  const refRoot = ref.slice(ref.findIndex(l => l.startsWith('ROOT'))).filter(Boolean).map(l => l.replace(/^ROOT /, ''));
  const jsN = js.map(l => l.replace(/^ROOT = /, ''));
  assert.deepEqual(jsN.map(l => l.trim()), refRoot.map(l => l.replace(/^ROOT /, '').trim()), name);
  console.log('ok', name, jsN.length, 'nodes');
}
const small = O([['a', I(1)], ['b', S('x')]]);
check(small, 'small');
check(O([['日本語名', I(5)], ['ab', S('x')], ['abc', S('y')], ['b', I(1)], ['label_z', S('')], ['f', { t: 'float', v: 1.5 }], ['d', { t: 'double', v: -2.25 }], ['t', { t: 'bool', v: true }],
  ['ints', C(I(0), I(1), I(-1), I(127), I(128), I(-128), I(-129), I(32767), I(32768), I(-32768), I(-70000), I(2 ** 30))],
  ['sc', C(O([['texts', C(C(S('A'), S('名前'), I(0), NUL))], ['title', S('こんにちは')]]))]]), 'mixed');
// many strings -> 2-byte string indices; many names -> deep trie
const many = []; for (let i = 0; i < 300; i++) many.push(S('str' + i));
check(O([['list', C(...many)], ...Array.from({ length: 60 }, (_, i) => ['key_' + i + '_x', I(i)])]), 'wide');

// — extract -> repack round-trips —
import { extractFromScn, repackScn, scnMdfWrap, scnMdfUnwrap } from '../core/engines/scn.js';
const T = (n, nn, m) => C(S(n), S(nn), S(m), NUL, I(0), NUL);
const texts = C(T('太郎', 'Taro', 'こんにちは「世界」'), T('', '', 'ナレーション\n二行目'), T('花子', 'Hanako', 'おはよう'));
const scene = O([['title', S('t1')], ['texts', texts]]);
const game = O([['scenes', C(scene)], ['other', S('keep me')]]);
const plain = buildPsb(game);
function roundTrip(label, raw, wrap) {
  const ex = extractFromScn(raw, []);
  assert.equal(ex.entryCount, 3, label + ' entryCount');
  assert.match(ex.lines[0], /^\[0\|太郎\] /);
  const tr = { 0: ['Taro', 'Halo "dunia"'], 1: ['Narasi', 'Narasi baris dua'], 2: ['Hanako', 'Selamat pagi'] };
  const r = repackScn(raw, ex.tagStore, tr, wrap || 0, '\n');
  const out = r.buf, psbOut = (ex.xor ? undefined : out);
  return { ex, r, out, psbOut };
}
{
  const { r, out } = roundTrip('plain', plain);
  fs.writeFileSync('/tmp/rt.psb', out);
  if (HAVE_REF) { const ref = execFileSync('./tests/ref/dump', ['/tmp/rt.psb']).toString();
  assert.ok(ref.includes('Halo \\"dunia\\"'), 'C++ sees translated text');
  assert.ok(ref.includes('keep me'), 'other strings preserved'); }
  assert.ok(r.changed > 0);
  const ex2 = extractFromScn(out, []); assert.equal(ex2.entryCount, 3);
  console.log('ok plain round-trip; changed=' + r.changed, ex2.lines);
}
{ // single-key XOR obfuscation (k1=k2) must round-trip back to an XORed file with identical key
  const key = 0x5A, xo = plain.map(b => b ^ key);
  const ex = extractFromScn(xo, []); assert.equal(ex.entryCount, 3); assert.ok(ex.xor);
  const r = repackScn(xo, ex.tagStore, { 0: ['Taro', 'Halo'] }, 0, '\n');
  const back = extractFromScn(r.buf, []);
  assert.equal(back.entryCount, 3); assert.match(back.lines[0], /Halo/);
  console.log('ok xor round-trip');
}
{ // MDF wrapper
  const w = await scnMdfWrap(plain); const u = await scnMdfUnwrap(w);
  assert.ok(u.mdf); assert.deepEqual([...u.buf], [...plain]);
  console.log('ok mdf round-trip');
}

// — Job C: Detailed SCN Processing Log & Self-Verification Tests —
{
  // 1. Plain + XOR + MDF logging + byte-identical output vs no-logger path
  const logPlain = createLog();
  const exNoLog = await importScript('plain.scn', plain);
  const exWithLog = await importScript('plain.scn', plain, { log: logPlain });
  assert.deepEqual(exWithLog.lines, exNoLog.lines, 'logged extract lines identical to no-log');
  assert.deepEqual(exWithLog.tagStore, exNoLog.tagStore, 'logged tagStore identical to no-log');
  const steps = new Set(logPlain.entries.map(e => e.step));
  for (const reqStep of ['file', 'container', 'xor', 'psb', 'strategy', 'entries', 'timing']) {
    assert.ok(steps.has(reqStep), 'missing log step: ' + reqStep);
  }
  assert.equal(summarizeLog(logPlain), 'ok');
  const txt = formatLog(logPlain);
  assert.match(txt, /KOPIPE v1\.0\.0/);
  assert.match(txt, /shape-a/);

  const tr = { 0: ['Taro', 'Halo "dunia"'], 1: ['Narasi', 'Narasi baris dua'], 2: ['Hanako', 'Selamat pagi'] };
  const repNoLog = await exportScript({ kind: 'scn', meta: exNoLog.meta, bytes: plain, tagStore: exNoLog.tagStore }, tr);
  const logExport = createLog();
  let repMeta = null;
  const repWithLog = await exportScript({ kind: 'scn', meta: exWithLog.meta, bytes: plain, tagStore: exWithLog.tagStore }, tr, {
    log: logExport,
    onRepackMeta: m => { repMeta = m; }
  });
  assert.deepEqual([...repWithLog], [...repNoLog], 'logged export bytes identical to no-log export');
  assert.ok(repMeta && repMeta.verifyOk === true, 'self-verification succeeded');
  const expSteps = new Set(logExport.entries.map(e => e.step));
  for (const s of ['input', 'strings', 'wrap', 'rewrap', 'verify']) {
    assert.ok(expSteps.has(s), 'missing repack log step: ' + s);
  }
  console.log('ok SCN log plain + byte-identical vs no-log');
}

{
  // 2. MDF + XOR logging
  const mdfBytes = await scnMdfWrap(plain);
  const logMdf = createLog();
  const exMdf = await importScript('wrapped.scn', mdfBytes, { log: logMdf });
  assert.equal(exMdf.entryCount, 3);
  assert.ok(logMdf.entries.some(e => e.step === 'container' && e.data && e.data.mdf === true), 'logged MDF unwrap');

  const xo = plain.map(b => b ^ 0x33);
  const logXor = createLog();
  const exXor = extractFromScn(xo, [], { log: logXor, name: 'xor.scn' });
  assert.equal(exXor.entryCount, 3);
  assert.ok(logXor.entries.some(e => e.step === 'xor' && e.data && e.data.xor === true), 'logged XOR key');
  console.log('ok SCN log MDF + XOR');
}

{
  // 3. All 4 strategy shapes (shape-a, shape-d, gardroid-ks, gardroid-txt)
  // shape-d: scenes[0].texts[0] = [name, [[id, message, nil, backlog1, backlog2]]]
  const shapeDPsb = buildPsb(O([
    ['scenes', C(O([
      ['texts', C(
        C(S('アキラ'), C(C(I(1), S('こんにちは\\n世界'), NUL, S('こんにちは 世界'), S('log2'))))
      )]
    ]))]
  ]));
  const logD = createLog();
  const exD = extractFromScn(shapeDPsb, [], { log: logD });
  assert.equal(exD.strategy, 'shape-d');
  assert.equal(exD.entryCount, 1);
  assert.ok(logD.entries.some(e => e.step === 'strategy' && e.data && e.data.id === 'shape-a' && e.data.entriesFound === 0 && e.data.zeroReason));
  assert.ok(logD.entries.some(e => e.step === 'strategy' && e.data && e.data.id === 'shape-d' && e.data.chosen === true));

  // gardroid-ks (strategy B): root.block.text = [[cmd, [[lang0, "msg"]], [{name: "Hana"}]]]
  const shapeBPsb = buildPsb(O([
    ['block', O([
      ['text', C(
        C(I(0), C(C(I(0), S('やあ、元気？'))), C(O([['name', S('花子')]])))
      )]
    ])]
  ]));
  const logB = createLog();
  const exB = extractFromScn(shapeBPsb, [], { log: logB });
  assert.equal(exB.strategy, 'gardroid-ks');
  assert.equal(exB.entryCount, 1);

  // gardroid-txt (strategy C): root.block.lines = [[speakerStr, dummyNum, [[lang0, "msg"]]]]
  const shapeCPsb = buildPsb(O([
    ['block', O([
      ['lines', C(
        C(S('bg'), I(0), C(C(I(0), S('bg_sky')))), // junk command -> skipped
        C(S('ミオ'), I(0), C(C(I(0), S('いきましょう'))))
      )]
    ])]
  ]));
  const logC = createLog();
  const exC = extractFromScn(shapeCPsb, [], { log: logC });
  assert.equal(exC.strategy, 'gardroid-txt');
  assert.equal(exC.entryCount, 1);
  console.log('ok SCN log all 4 strategies (shape-a, shape-d, gardroid-ks, gardroid-txt)');
}

{
  // 4. Zero-entry file logs a warning, strategy that throws logs error + stack and continues, corrupted file logs error
  const noTextPsb = buildPsb(O([['config', O([['width', I(1280)], ['height', I(720)]])]]));
  const logZero = createLog();
  const exZero = extractFromScn(noTextPsb, [], { log: logZero });
  assert.equal(exZero.entryCount, 0);
  assert.equal(summarizeLog(logZero), 'warn', 'zero-entry SCN must summarize as warn');

  // Strategy that throws
  const logThrow = createLog();
  const exAfterThrow = extractFromScn(plain, [], {
    log: logThrow,
    strategies: [
      { id: 'broken-strat', label: 'strategi rusak', fn: () => { throw new Error('boom di dalam strategi'); } },
      { id: 'shape-a', label: 'shape-a', fn: p => extractFromScn(plain, []).lines.map((_, i) => ({ name: 'A', message: 'msg' + i, msgIdx: i })) }
    ]
  });
  assert.equal(exAfterThrow.entryCount, 3);
  const throwEntry = logThrow.entries.find(e => e.step === 'strategy' && e.level === 'warn' && /boom/.test(e.msg));
  assert.ok(throwEntry && throwEntry.data && throwEntry.data.stack, 'logged thrown strategy error + stack');

  // Corrupted file
  const logCorrupt = createLog();
  const badBytes = new Uint8Array(64); badBytes.fill(0xFE);
  assert.throws(() => extractFromScn(badBytes, [], { log: logCorrupt }));
  assert.equal(summarizeLog(logCorrupt), 'error');
  console.log('ok SCN log zero-entry warning, throwing strategy recovery, and corrupt file error');
}

{
  // 5. Self-verification catches corrupted repack output
  const ex = extractFromScn(plain, []);
  const logBadRepack = createLog();
  const badRep = repackScn(plain, ex.tagStore, { 0: ['Taro', 'Halo'] }, 0, '\n', {
    log: logBadRepack,
    _corruptOutput: buf => {
      // Corrupt PSB header magic so re-extraction fails
      const copy = new Uint8Array(buf);
      copy[36] = 0xFF; copy[37] = 0xFF;
      return copy;
    }
  });
  assert.equal(badRep.verifyOk, false, 'verifyOk must be false when output is corrupted');
  assert.ok(badRep.verifyErrors && badRep.verifyErrors.length > 0);
  assert.equal(summarizeLog(logBadRepack), 'error');
  assert.ok(badRep.warnings.some(w => /gagal diverifikasi/i.test(w)));
  console.log('ok SCN repack self-verification catches corrupted output');
}

{
  // 6. SCN Choices (selects[i].text, selectInfo.select[i].text, selectInfo.select[i].runLineStr)
  const choiceScene = O([
    ['title', S('scene_choice')],
    ['texts', C(
      T('ヒトミ', 'Hitomi', 'どうする？')
    )],
    ['selects', C(
      O([['text', S('　喉が壊れても…')], ['target', S('*01_01')]]),
      O([['text', S('　今は休む')], ['target', S('*01_02')]])
    )],
    ['selectInfo', O([
      ['select', C(
        O([['text', S('　喉が壊れても…')], ['runLineStr', S('[seladd text="　喉が壊れても…" target="*01_01"]')]]),
        O([['text', S('　今は休む')], ['runLineStr', S('[seladd text="　今は休む" target="*01_02"]')]])
      )]
    ])]
  ]);
  const choicePsb = buildPsb(O([['scenes', C(choiceScene)]]));
  const logCh = createLog();
  const exCh = extractFromScn(choicePsb, [], { log: logCh });
  assert.equal(exCh.entryCount, 3, '1 dialogue + 2 deduplicated choices');
  assert.equal(summarizeLog(logCh), 'ok', 'choice mirror slots must not trigger false sharedWithNonDialogue warning');
  assert.match(exCh.lines[1], /^\[1\|Narasi\] 　喉が壊れても…$/);
  assert.match(exCh.lines[2], /^\[2\|Narasi\] 　今は休む$/);

  const repLog = createLog();
  const repCh = repackScn(choicePsb, exCh.tagStore, {
    0: ['Hitomi', 'Apa yang harus kulakukan?'],
    1: ['Narasi', '　Meski tenggorokanku rusak…'],
    2: ['Narasi', '　Istirahat sekarang']
  }, 0, '\n', { log: repLog, verify: true });
  assert.equal(repCh.verifyOk, true, 'choice repack self-verification OK');
  assert.equal(summarizeLog(repLog), 'ok');

  // Verify all 3 places (selects[i].text, selectInfo.select[i].text, selectInfo.select[i].runLineStr) are updated in repacked PSB
  const parsedOut = parsePsb(repCh.buf);
  const outTree = [];
  fmt(parsedOut, parsedOut.root, 'ROOT', 0, outTree);
  const outText = outTree.join('\n');
  assert.ok(outText.includes('text = STR #') && outText.includes('"　Meski tenggorokanku rusak…"'), 'selects[0].text & selectInfo.select[0].text updated');
  assert.ok(outText.includes('[seladd text="　Meski tenggorokanku rusak…" target="*01_01"]'), 'selectInfo.select[0].runLineStr updated');
  assert.ok(outText.includes('[seladd text="　Istirahat sekarang" target="*01_02"]'), 'selectInfo.select[1].runLineStr updated');
  assert.ok(!outText.includes('喉が壊れても'), 'no untranslated choice 1 left in tree');
  assert.ok(!outText.includes('今は休む'), 'no untranslated choice 2 left in tree');

  if (HAVE_REF) {
    fs.writeFileSync('/tmp/rt-choice.psb', repCh.buf);
    const refDump = execFileSync('./tests/ref/dump', ['/tmp/rt-choice.psb']).toString();
    assert.ok(refDump.includes('Meski tenggorokanku rusak'), 'C++ reference dumper sees translated choice text');
    assert.ok(refDump.includes('[seladd text=\\"　Meski tenggorokanku rusak…\\" target=\\"*01_01\\"]'), 'C++ reference dumper sees translated runLineStr');
  }
  console.log('ok SCN choices (selects[i].text + selectInfo.select[i].text + selectInfo.select[i].runLineStr) round-trip');
}
