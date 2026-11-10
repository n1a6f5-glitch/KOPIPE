// End-to-end: import -> batch export -> "AI" translation -> apply -> repack -> re-import, for every engine, on the memory store.
import assert from 'node:assert/strict';
import { createMemoryStore, uid } from '../core/db.js';
import * as P from '../core/project.js';
import { importScript } from '../core/engines/index.js';
import * as B from '../core/backup.js';
import { buildPsb, O, C, S, I, NUL } from './psb-builder.mjs';
import { scnMdfWrap } from '../core/engines/scn.js';

let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log('  ok  ' + n); } catch (e) { fail++; console.log('FAIL  ' + n + '\n     ' + String(e.stack || e.message).split('\n').slice(0, 6).join('\n     ')); } };
const enc = s => new TextEncoder().encode(s);
const dec = b => new TextDecoder('utf-8').decode(b);

const KS = '*start|プロローグ\r\n#太郎\r\n「おはよう」[l][r]\r\n続き[p]\r\n\r\n#花子\r\nこんにちは[r]\r\n世界[p]\r\n';
const TXT = '【太郎】\n「やあ」\n【花子】\n「こんにちは」\n';
const ARTTXT = '*a\n[name Taro]\nこんにちは\n\n[name Hana]\nおはよう\n\n';
const AST = 'astver = 2.0\nastname = "ast"\nast = {\n\tblock_00000 = {\n\t\ttext = {\n\t\t\tja = {\n\t\t\t\t{ name = {"妃愛"}, "「では、いってまいります」", {"rt2"}, },\n\t\t\t},\n\t\t},\n\t},\n\tblock_00001 = {\n\t\ttext = {\n\t\t\tja = { { "ナレーション" }, },\n\t\t},\n\t},\n}\n';
const VJ = JSON.stringify([{ name: 'アキラ', message: '「おはよう」' }, { message: '地の文です。' }, { name: 'ミオ', message: '「やあ」' }]);
const psbT = (n, m) => C(S(n), S(n), S(m), NUL, I(0), NUL);
const SCN = buildPsb(O([['scenes', C(O([['title', S('t')], ['texts', C(psbT('太郎', 'こんにちは'), psbT('', 'ナレーション'), psbT('花子', 'おはよう'))]]))]]));

const CASES = [['a.ks', KS, 'ks'], ['b.txt', TXT, 'txt'], ['c.txt', ARTTXT, 'artemis-txt'], ['d.ast', AST, 'ast'], ['e.json', VJ, 'vntp']];

for (const [name, text, kind] of CASES) {
  await t(`${kind}: import -> batch -> translate -> apply -> repack -> reimport`, async () => {
    const st = createMemoryStore(), p = await P.createProject(st, 'x');
    const { file, count } = await P.addFile(st, p.id, name, enc(text)); assert.equal(file.kind, kind); assert.ok(count > 0, 'entries');
    const b = await P.exportBatch(st, p.id, { count: 999 }); assert.equal(b.count, count);
    // fake AI: prefix every body with "~" (keeps ids/names/tags)
    const ai = b.text.split('\n').map(l => /^(\d{6}\. (?:\([^)]*\)\s*|\[[^\]]*\]\s*)*)(.*)$/.exec(l) ? l.replace(/^(\d{6}\. (?:\([^)]*\)\s*|\[[^\]]*\]\s*)*)/, '$1~') : l).join('\n');
    const ap = await P.applyBatch(st, p.id, ai); assert.equal(ap.applied, count); assert.equal(ap.unknown.length, 0); assert.equal(ap.flagged, 0);
    const s = await P.stats(st, p.id); assert.equal(s.draft, count);
    const out = await P.repackFile(st, file.id); assert.equal(out.translated, count);
    const again = await importScript(name, out.bytes);
    assert.equal(again.entryCount, count, 'entry count stable after repack');
    assert.ok(again.lines.every(l => /\] ~/.test(l)), again.lines.join('\n'));
  });
}

await t('scn (plain + MDF): import -> apply -> repack -> reimport', async () => {
  for (const wrap of [false, true]) {
    const st = createMemoryStore(), p = await P.createProject(st, 'x');
    const bytes = wrap ? await scnMdfWrap(SCN) : SCN;
    const { file, count } = await P.addFile(st, p.id, 'x.scn', bytes); assert.equal(file.kind, 'scn'); assert.equal(count, 3);
    assert.ok(file.importLog && file.importLog.entries.length >= 6, 'SCN import log persisted on file');
    const es = await P.listEntries(st, p.id);
    for (const e of es) await P.setTranslation(st, e.id, { tgt: '~' + e.src, tgtName: e.name && e.name !== 'Narasi' ? 'N' + e.gid : '' });
    const out = await P.repackFile(st, file.id);
    assert.equal(out.verifyOk, true, 'SCN repack self-verified');
    assert.ok(out.log && out.log.entries.length >= 4, 'SCN export log returned');
    const again = await importScript('x.scn', out.bytes); assert.equal(again.entryCount, 3); assert.ok(again.lines.every(l => /\] ~/.test(l)), again.lines.join('\n'));
  }
});

await t('untranslated repack is byte-identical for text formats', async () => {
  for (const [name, text] of [['a.ks', KS], ['b.txt', TXT], ['c.txt', ARTTXT]]) {
    const st = createMemoryStore(), p = await P.createProject(st, 'x');
    const { file } = await P.addFile(st, p.id, name, enc(text));
    assert.equal(dec((await P.repackFile(st, file.id)).bytes), text, name);
  }
});

await t('tag guard flags mismatched <T#>; fixing it clears the flag', async () => {
  const st = createMemoryStore(), p = await P.createProject(st, 'x'); await P.addFile(st, p.id, 'a.ks', enc('ふふ[heart]ですね[p]\r\n'));
  const e = (await P.listEntries(st, p.id)).find(x => /<T\d+>/.test(x.src)); assert.ok(e, 'has tag entry');
  let r = await P.setTranslation(st, e.id, { tgt: 'tanpa tag' }); assert.equal(r.status, 'flag');
  r = await P.setTranslation(st, e.id, { tgt: e.src }); assert.equal(r.status, 'draft');
});

await t('global ids continue across files; batch export respects from/count/status; names applied', async () => {
  const st = createMemoryStore(), p = await P.createProject(st, 'x');
  const a = await P.addFile(st, p.id, 'b.txt', enc(TXT)), b = await P.addFile(st, p.id, 'e.json', enc(VJ));
  const es = await P.listEntries(st, p.id); assert.deepEqual(es.map(e => e.gid), [1, 2, 3, 4, 5]);
  const bt = await P.exportBatch(st, p.id, { from: 3, count: 2 }); assert.equal(bt.count, 2); assert.equal(bt.firstGid, 3);
  await P.setTranslation(st, es[0].id, { tgt: 'Halo', tgtName: 'Taro' });
  const out = await P.repackFile(st, a.file.id); assert.ok(dec(out.bytes).includes('【Taro】') && dec(out.bytes).includes('Halo'));
  assert.equal((await P.exportBatch(st, p.id, { count: 99 })).count, 4);
});

await t('deleteProject / removeFile clean everything', async () => {
  const st = createMemoryStore(), p = await P.createProject(st, 'x'); const { file } = await P.addFile(st, p.id, 'a.ks', enc(KS));
  await P.removeFile(st, file.id); assert.equal((await P.stats(st, p.id)).total, 0);
  assert.equal((await st.all('blobs')).length, 0, 'blobs cleaned on removeFile');
  await P.addFile(st, p.id, 'a.ks', enc(KS)); await P.deleteProject(st, p.id);
  assert.equal((await P.listProjects(st)).length, 0); assert.equal((await st.all('entries')).length, 0);
  assert.equal((await st.all('blobs')).length, 0, 'blobs cleaned on deleteProject');
});

await t('tagless batch strips edge tags; apply auto-reattaches; QC finds + fixes problems', async () => {
  const st = createMemoryStore(), p = await P.createProject(st, 'x'); await P.addFile(st, p.id, 'a.ks', enc('ふふ[heart]ですね[p]\r\n\r\n「やあ」[heart][p]\r\n'));
  const es = await P.listEntries(st, p.id); assert.ok(es.every(e => /<T\d+>/.test(e.src)), es.map(e => e.src).join('|'));
  const b = await P.exportBatch(st, p.id, { count: 9 }); assert.ok(b.text.includes('<T'), 'mid tag kept visible');
  const tl = await P.exportBatch(st, p.id, { count: 9, tagless: true });
  const ap = await P.applyBatch(st, p.id, tl.text.replace(/ふふ/, 'hehe').replace(/ですね/, ' ya'));
  assert.equal(ap.flagged, 0);
  for (const e of await P.listEntries(st, p.id)) assert.equal((e.tgt.match(/<T\d+>/g) || []).length, (e.src.match(/<T\d+>/g) || []).length);
  // a broken translation shows up in QC and fixTags repairs it
  const e0 = es[0]; await P.setTranslation(st, e0.id, { tgt: 'broken [t1] text "x' });
  const q = await P.qcRun(st, p.id); const bad = q.find(x => x.entry.id === e0.id); assert.ok(bad && bad.critical, JSON.stringify(q.map(x => x.issues.map(i => i.type))));
  assert.ok(await P.qcFixTags(st, p.id, [e0.id]) >= 1);
  assert.ok(!(await P.qcRun(st, p.id)).some(x => x.entry.id === e0.id && x.issues.some(i => i.type === 'tag' || i.type === 'tag_malformed')));
});

await t('glossary: reapply only touches untranslated entries; VNDB draft from mock characters', async () => {
  const st = createMemoryStore(), p = await P.createProject(st, 'x'); await P.addFile(st, p.id, 'b.txt', enc('【太郎】\n「やあ」\n【花子】\n「こんにちは」\n'));
  const es = await P.listEntries(st, p.id); await P.setTranslation(st, es[0].id, { tgt: 'Halo' });
  await P.setGlossary(st, p.id, { やあ: 'hei', こんにちは: 'halo' });
  assert.equal(await P.reapplyGlossary(st, p.id), 1);
  const after = await P.listEntries(st, p.id); assert.equal(after[0].src, '「やあ」'); assert.ok(after[1].src.includes('halo'), after[1].src);
  const names = await P.scanSpeakerNames(st, p.id); assert.deepEqual(names.sort(), ['太郎', '花子'].sort());
  const chars = [{ id: 'c1', name: 'Hanako Yamada', original: '山田 花子', aliases: [] }, { id: 'c2', name: 'Taro Suzuki', original: '鈴木 太郎' }];
  const v = await P.vndbGlossaryDraft(st, p.id, chars); assert.ok(v.matched >= 1, JSON.stringify(v)); assert.ok(Object.values(v.draft).some(x => /Hanako|Taro/.test(x)), JSON.stringify(v.draft));
});

await t('quote mode: 「 」 → " on repack (txt/json/ks-guarded), stored TL untouched', async () => {
  const st = createMemoryStore(), p = await P.createProject(st, 'x'); p.settings.quoteMode = 'ascii'; await st.put('projects', p);
  const a = await P.addFile(st, p.id, 'b.txt', enc('【太郎】\n「やあ」\n')), k = await P.addFile(st, p.id, 'a.ks', enc('「おはよう」[p]\r\n@sel01 text="はい"\r\n'));
  for (const e of await P.listEntries(st, p.id)) await P.setTranslation(st, e.id, { tgt: e.src.includes('「') ? '「Halo」' : 'Ya 「x」' });
  assert.ok(dec((await P.repackFile(st, a.file.id)).bytes).includes('"Halo"'));
  const ks = dec((await P.repackFile(st, k.file.id)).bytes); assert.ok(ks.includes('"Halo"[p]'), ks); assert.ok(ks.includes('text="Ya 「x」"'), ks);
  assert.equal((await P.listEntries(st, p.id))[0].tgt, '「Halo」');
  assert.equal(P.convertJpQuotes('「a」『b』', 'curly'), '“a”‘b’');
});

await t('undo apply restores previous translations/status exactly', async () => {
  const st = createMemoryStore(), p = await P.createProject(st, 'x'); await P.addFile(st, p.id, 'b.txt', enc(TXT));
  const es = await P.listEntries(st, p.id); await P.setTranslation(st, es[0].id, { tgt: 'Lama', status: 'done' });
  const before = await P.listEntries(st, p.id);
  const b = await P.exportBatch(st, p.id, { count: 9, onlyStatus: '' });
  const r = await P.applyBatch(st, p.id, b.text.replace(/\] /g, '] baru ')); assert.ok(r.canUndo);
  assert.notDeepEqual((await P.listEntries(st, p.id)).map(e => e.tgt), before.map(e => e.tgt));
  assert.equal(await P.undoApply(st, p.id), 2);
  const after = await P.listEntries(st, p.id); assert.deepEqual(after.map(e => [e.tgt, e.status]), before.map(e => [e.tgt, e.status]));
  assert.equal(await P.undoApply(st, p.id), 0);
});

await t('backup → restore (gzip + plain) gives identical project; original untouched', async () => {
  const st = createMemoryStore(), p = await P.createProject(st, 'Asli'); p.glossary = { 太郎: 'Taro' }; p.settings.quoteMode = 'curly'; await st.put('projects', p);
  const a = await P.addFile(st, p.id, 'a.ks', enc(KS), { path: 'scn/ch1/a.ks' }), s2 = await P.addFile(st, p.id, 'x.scn', SCN, { path: 'scn/ch2/x.scn' });
  for (const e of (await P.listEntries(st, p.id)).slice(0, 4)) await P.setTranslation(st, e.id, { tgt: 'TL ' + e.gid, status: 'done' });
  for (const gz of [true, false]) {
    const bytes = await B.exportProject(st, p.id, { gzip: gz }); if (gz) assert.equal(bytes[0], 0x1F);
    const st2 = createMemoryStore(), np = await B.importProject(st2, bytes);
    const p2 = await st2.get('projects', np); assert.deepEqual(p2.glossary, { 太郎: 'Taro' }); assert.equal(p2.settings.quoteMode, 'curly');
    const e1 = await P.listEntries(st, p.id), e2 = await P.listEntries(st2, np);
    assert.deepEqual(e2.map(e => [e.gid, e.src, e.tgt, e.status]), e1.map(e => [e.gid, e.src, e.tgt, e.status]));
    const f2 = await P.listFiles(st2, np); assert.equal(f2.length, 2);
    assert.equal(f2.find(f => f.name === 'a.ks').path, 'scn/ch1/a.ks');
    assert.equal(f2.find(f => f.name === 'x.scn').path, 'scn/ch2/x.scn');
    const o1 = await P.repackFile(st, a.file.id), o2 = await P.repackFile(st2, f2.find(f => f.name === 'a.ks').id);
    assert.deepEqual([...o2.bytes], [...o1.bytes]);
    const o3 = await P.repackFile(st, s2.file.id), o4 = await P.repackFile(st2, f2.find(f => f.name === 'x.scn').id);
    assert.deepEqual([...o4.bytes], [...o3.bytes]);
    assert.ok(e2.every(e => e.pid === np));
  }
  await assert.rejects(() => B.importProject(createMemoryStore(), enc('{"hello":1}')), /bukan file backup/i);
  assert.equal((await P.listProjects(st)).length, 1);
});

await t('exportTranslations lists only translated lines with translated names', async () => {
  const st = createMemoryStore(), p = await P.createProject(st, 'x'); await P.addFile(st, p.id, 'b.txt', enc(TXT));
  const es = await P.listEntries(st, p.id); await P.setTranslation(st, es[1].id, { tgt: 'Halo', tgtName: 'Hana' });
  const tx = await P.exportTranslations(st, p.id); assert.match(tx, /--- FILE: b\.txt ---\n000002\. \[Hana\] Halo\n$/);
});

// — Job A & Job B New Tests —
await t('cached counters match full recount() across all mutations + v0.4 lazy migration', async () => {
  const st = createMemoryStore(), p = await P.createProject(st, 'CounterTest');
  const f1 = await P.addFile(st, p.id, 'a.ks', enc('ふふ[heart]ですね[p]\r\n\r\n「やあ」[p]\r\n'));
  const f2 = await P.addFile(st, p.id, 'b.txt', enc(TXT));
  const assertCountersMatch = async label => {
    const cached = await P.stats(st, p.id);
    const filesBefore = await P.listFiles(st, p.id);
    const fileSum = { total: 0, todo: 0, draft: 0, done: 0, flag: 0 };
    for (const f of filesBefore) for (const k of Object.keys(fileSum)) fileSum[k] += f.stats[k] || 0;
    const recounted = await P.recount(st, p.id);
    assert.deepEqual(cached, recounted, 'project stats vs recount after ' + label);
    assert.deepEqual(fileSum, recounted, 'sum of file.stats vs recount after ' + label);
  };
  await assertCountersMatch('addFile');
  const es = await P.listEntries(st, p.id);
  await P.setTranslation(st, es[0].id, { tgt: 'tanpa tag' }); // flag
  await assertCountersMatch('setTranslation -> flag');
  await P.setTranslation(st, es[1].id, { tgt: 'Halo', status: 'done' }); // done
  await assertCountersMatch('setTranslation -> done');
  await P.qcFixTags(st, p.id, [es[0].id]); // flag -> draft
  await assertCountersMatch('qcFixTags -> draft');
  const b = await P.exportBatch(st, p.id, { onlyStatus: 'todo', count: 10 });
  await P.applyBatch(st, p.id, b.text.replace(/\] /g, '] ~'));
  await assertCountersMatch('applyBatch');
  await P.undoApply(st, p.id);
  await assertCountersMatch('undoApply');
  await P.removeFile(st, f2.file.id);
  await assertCountersMatch('removeFile');

  // Simulate v0.4 unmigrated project (no schemaVersion, no stats, inline file.bytes)
  const v04Pid = uid(), v04Fid = uid();
  await st.put('projects', { id: v04Pid, name: 'OldV04', createdAt: 1, updatedAt: 1, nextGid: 2, nextOrder: 2, glossary: {}, settings: {} });
  await st.put('files', { id: v04Fid, pid: v04Pid, name: 'old.txt', kind: 'txt', meta: { enc: 'utf-8' }, bytes: enc(TXT), tagStore: {}, order: 1, entryCount: 1 });
  await st.put('entries', { id: uid(), pid: v04Pid, fid: v04Fid, idx: '0', gid: 1, name: '太郎', src: '「やあ」', tgt: 'Halo', tgtName: 'Taro', status: 'done', kind: 'D' });
  const migStats = await P.stats(st, v04Pid);
  assert.deepEqual(migStats, { total: 1, todo: 0, draft: 0, done: 1, flag: 0 });
  const rawF = await st.get('files', v04Fid);
  assert.equal(rawF.bytes, undefined, 'inline bytes moved out of files record');
  const blob = await st.get('blobs', v04Fid);
  assert.ok(blob && blob.bytes.length > 0, 'bytes stored in blobs table');
});

await t('listEntriesPage + firstEntry + folder scope + folder batch import + dry-run', async () => {
  const st = createMemoryStore(), p = await P.createProject(st, 'FolderTest');
  const rawFolderItems = [
    { path: 'scn/ch01/scene10.txt', bytes: enc(TXT) },
    { path: 'scn/ch01/scene2.txt', bytes: enc(TXT) },
    { path: 'scn/ch02/sub/scene1.scn', bytes: SCN },
    { path: 'scn/config.json', bytes: enc('{"resolution":"1920x1080"}') }, // non-VNTP json -> skipped with reason
    { path: 'scn/bg/sky.png', bytes: new Uint8Array([1, 2, 3]) }, // non-script -> skipped
    { path: 'scn/broken.scn', bytes: new Uint8Array([9, 9, 9]) }, // corrupt -> error survived
  ];

  // Dry-run ("Uji folder") first: does not write to store
  const dry = await P.importFolderBatch(st, p.id, rawFolderItems, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.skippedNonScript, 1);
  assert.equal(dry.skippedNonVntpJson.length, 1);
  assert.equal(dry.errorCount, 1);
  assert.equal(dry.importedFiles, 3);
  assert.equal((await P.listFiles(st, p.id)).length, 0, 'dry-run leaves project untouched');

  // Real folder import
  const imp = await P.importFolderBatch(st, p.id, rawFolderItems);
  assert.equal(imp.importedFiles, 3);
  assert.equal(imp.errorCount, 1);
  const files = await P.listFiles(st, p.id);
  // Natural sort: scene2.txt before scene10.txt!
  assert.deepEqual(files.map(f => f.path), ['scn/ch01/scene2.txt', 'scn/ch01/scene10.txt', 'scn/ch02/sub/scene1.scn']);

  // Translate an entry in scene2.txt, then test re-import with 'skip' and 'update'
  const pg1 = await P.listEntriesPage(st, p.id, { folder: 'scn/ch01', offset: 0, limit: 2 });
  assert.equal(pg1.total, 4);
  assert.equal(pg1.items.length, 2);
  await P.setTranslation(st, pg1.items[0].id, { tgt: 'Terjemahan tetap', status: 'done' });

  const skipRun = await P.importFolderBatch(st, p.id, [{ path: 'scn/ch01/scene2.txt', bytes: enc(TXT) }], { onDuplicate: 'skip' });
  assert.equal(skipRun.skippedDuplicate.length, 1);

  const updTxt = '【太郎】\n「やあ」\n【花子】\n「新しいセリフ」\n';
  const updRun = await P.importFolderBatch(st, p.id, [{ path: 'scn/ch01/scene2.txt', bytes: enc(updTxt) }], { onDuplicate: 'update' });
  assert.equal(updRun.updatedFiles, 1);
  assert.equal(updRun.results[0].kept, 1, 'preserved 1 matching translation on update');
  const afterUpd = await P.listEntriesPage(st, p.id, { fid: files[0].id, offset: 0, limit: 10 });
  assert.equal(afterUpd.items[0].tgt, 'Terjemahan tetap');
  assert.equal(afterUpd.items[0].status, 'done');
  assert.equal(afterUpd.items[1].tgt, '');
  assert.equal(afterUpd.items[1].status, 'todo');

  const firstTodo = await P.firstEntry(st, p.id, { status: 'todo' });
  assert.equal(firstTodo.gid, 2);
});


await t('v0.5.3: exact EN/ID prompts, Markdown code-block stripping, Polish QC batch, no quote/overflow QC noise, and wrapSep rt2', async () => {
  const st = createMemoryStore(), p = await P.createProject(st, 'PromptWrapTest');
  await P.setGlossary(st, p.id, { 妃愛: 'Hiyori' });
  const { file } = await P.addFile(st, p.id, 'd.ast', enc(AST));
  const bEn = await P.exportBatch(st, p.id, { promptLang: 'en' });
  assert.match(bEn.text, /Translate the following Japanese Visual Novel script into natural, fluent English/);
  assert.match(bEn.text, /Wrap the entire translated output in a single Markdown code block/);
  assert.match(bEn.text, /--- FILE: d\.ast ---/);

  const bId = await P.exportBatch(st, p.id, { promptLang: 'id', stripAllTags: true });
  assert.match(bId.text, /Terjemahkan naskah Visual Novel Jepang berikut ke dalam Bahasa Indonesia/);

  // Applying a batch wrapped in a Markdown code block (```...```) with odd English quotes (>130 chars) must strip fences and NOT trigger quote/overflow QC
  const longText = "I'm sure this has 'odd single quotes and is a very long English translation line that exceeds ninety-five characters easily without being an error ".repeat(2);
  const aiOut = "```text\n" + bEn.rawText
    .replace(/000001\. \[[^\]]+\] .*$/m, `000001. [Hiyori] ${longText}`)
    .replace(/000002\. \([^)]+\) .*$/m, '000002. (Narasi) This still has 日本語テスト inside it') + "\n```";
  const ap = await P.applyBatch(st, p.id, aiOut);
  assert.equal(ap.applied, 2);
  assert.equal(ap.unreadable.length, 0, 'Markdown code block fences stripped without unreadable lines');

  const qcRes = await P.qcRun(st, p.id);
  assert.equal(qcRes.some(r => r.issues.some(i => i.type === 'overflow' || i.type === 'quote')), false, 'overflow and quote disabled in QC');
  assert.equal(qcRes.length, 1, 'only the leftover Japanese line is flagged in QC');

  // Export Polish QC batch (all translated lines paired with # JP: and Glossary) and apply polished output
  const polishBatch = await P.exportQcBatch(st, p.id, { targetMode: 'polish', from: 1, count: 50, promptLang: 'en' });
  assert.equal(polishBatch.count, 2);
  assert.match(polishBatch.text, /# JP:/);
  assert.doesNotMatch(bEn.text, /Glossary:/);
  const scnRuby = buildPsb(O([['scenes', C(O([['title', S('t')], ['texts', C(psbT('', '俺はカメラを[ruby text="パン"]振って'))]]))]]));
  const fScn = await P.addFile(st, p.id, 'lov.scn', scnRuby);
  const eScn = (await P.listEntries(st, p.id, { fid: fScn.file.id }))[0];
  await P.setTranslation(st, eScn.id, { tgt: 'Aku<T1>menggeser kamera secara horizontal' });
  const repScn = await P.repackFile(st, fScn.file.id);
  assert.equal(repScn.verifyOk, true, 'SCN ruby stripped cleanly and verified');
  const reScn = await importScript('lov.scn', repScn.bytes);
  assert.match(reScn.lines[0], /Aku menggeser kamera secara horizontal/, 'space preserved and ruby stripped on repack');
  const qcFixed = "```\n" + polishBatch.rawText.replace(/000002\. \(Narasi\) .*$/m, '000002. (Narasi) Clean polished narration without Japanese characters') + "\n```";
  const apQc = await P.applyBatch(st, p.id, qcFixed);
  assert.equal(apQc.applied, 2);
  assert.equal(apQc.unreadable.length, 0, '# JP: comments and Markdown fences stripped cleanly');
  assert.equal((await P.qcRun(st, p.id)).length, 0, 'all QC issues resolved');

  // Artemis .ast wrapWidth > 0 + wrapSep = 'rt2' produces {"rt2"} line-break nodes in repacked .ast
  const pReload = await st.get('projects', p.id);
  pReload.settings.wrapWidth = 25;
  pReload.settings.wrapSep = 'rt2';
  await st.put('projects', pReload);
  const rep = await P.repackFile(st, file.id);
  const astOut = dec(rep.bytes);
  assert.match(astOut, /\{"rt2"\}/, 'wrapped Artemis .ast uses {"rt2"} separator');
});

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
