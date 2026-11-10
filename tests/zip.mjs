import fs from 'node:fs'; import { execFileSync } from 'node:child_process'; import assert from 'node:assert/strict';
import { zip, zipBlob, createZipWriter, crc32, normZipPath } from '../core/zip.js';
assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
assert.equal(normZipPath('\\scn\\ch01//a.scn'), 'scn/ch01/a.scn');
const z = zip([
  { name: 'a/日本語.txt', bytes: new TextEncoder().encode('halo') },
  { path: 'scn\\sub/ch01/scene10.scn', name: 'scene10.scn', bytes: new TextEncoder().encode('isi-scn') },
  { name: 'b.bin', bytes: new Uint8Array([0, 1, 2, 255]) },
  { name: 'empty', bytes: new Uint8Array(0) }
]);
fs.writeFileSync('/tmp/t.zip', z);
const out = execFileSync('unzip', ['-t', '/tmp/t.zip']).toString(); assert.match(out, /No errors/);
assert.equal(execFileSync('unzip', ['-p', '/tmp/t.zip', 'a/日本語.txt']).toString(), 'halo');
assert.equal(execFileSync('unzip', ['-p', '/tmp/t.zip', 'scn/sub/ch01/scene10.scn']).toString(), 'isi-scn');
const blob = zipBlob([{ path: 'x/y/z.txt', bytes: new TextEncoder().encode('ok') }]);
assert.ok(blob.size > 30);
const w = createZipWriter(); w.add('dir/f.txt', new TextEncoder().encode('tes'));
assert.equal(w.toUint8Array().length > 30, true);
console.log('zip ok');
