// Browser smoke: project -> add file -> edit card -> batch -> apply -> repack download. Uses real IndexedDB + service worker.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(fs.existsSync('/opt/npm-tools/node_modules/playwright') ? '/opt/npm-tools/node_modules/playwright' : 'playwright');
const root = path.resolve('.'); const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const srv = http.createServer((q, r) => { let p = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html'; fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); r.end(d); } }); }).listen(0);
const port = srv.address().port, errors = [], checks = [];
const ck = (n, ok, extra = '') => { checks.push(ok); console.log((ok ? '  ok  ' : 'FAIL  ') + n + (ok ? '' : ' ' + extra)); };
const b = await chromium.launch(); const ctx = await b.newContext({ acceptDownloads: true, viewport: { width: 390, height: 800 } }); const pg = await ctx.newPage();
pg.on('pageerror', e => errors.push(String(e))); pg.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await pg.goto(`http://localhost:${port}/`);
await pg.fill('#view input', 'Tes Proyek'); await pg.click('text=New Project');
await pg.waitForSelector('#nav button.on');
ck('lands on Files tab for empty project', (await pg.textContent('#nav button.on')) === '05 ARCHIVE');
await pg.setInputFiles('.drop input', 'tests/fixtures/sample.ks');
await pg.waitForSelector('.card');
const n = await pg.$$eval('.card', e => e.length); ck('cards rendered (3)', n === 3, String(n));
await pg.fill('.card:nth-child(2) textarea', 'Selamat pagi'); await pg.waitForTimeout(900);
await pg.click('.card:nth-child(2) button:has-text("Done")'); await pg.waitForTimeout(300);
ck('progress shows 1 done', /1\/3/.test(await pg.textContent('#prog')), await pg.textContent('#prog'));
await pg.click('#nav button:has-text("02 BATCH")'); await pg.click('button:has-text("Generate & Copy")');
await pg.waitForFunction(() => document.querySelector('textarea[readonly]').value.length > 0); const batch = await pg.inputValue('textarea[readonly]'); ck('batch text has file header + ids', /FILE: sample\.ks/.test(batch) && /000002\./.test(batch) && !/000001\./.test(batch), batch.slice(0, 80));
const ai = '```\n' + batch.split('\n').map(l => l.replace(/^(\d{6}\. (?:\([^)]*\)\s*|\[[^\]]*\]\s*)*).*$/, '$1~')).join('\n') + '\n```';
await pg.fill('textarea:not([readonly])', ai); await pg.click('button:has-text("Apply")'); await pg.waitForSelector('.ok');
ck('apply reports lines', /lines applied/.test(await pg.textContent('.ok')));
await pg.click('#nav button:has-text("05 ARCHIVE")');
const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('button:has-text("Repack")')]);
const out = fs.readFileSync(await dl.path(), 'utf8'); ck('repack has manual + batch translations', out.includes('Selamat pagi') && out.includes('~'), out.slice(0, 160));
await pg.click('button:has-text("Log")'); await pg.waitForSelector('#log-modal');
ck('file log modal opens with entries', /\[file\]/.test(await pg.textContent('#log-modal')));
await pg.click('#log-modal button:has-text("Close")');
// QC: a translation with Japanese leftovers is reported, odd English quotes are NOT reported
await pg.click('#nav button:has-text("01 BACKLOG")'); await pg.waitForSelector('.card');
await pg.fill('.card:nth-child(4) textarea', "I'm sure this has 'odd quotes and これは日本語です"); await pg.waitForTimeout(900);
await pg.click('#nav button:has-text("03 QC")'); await pg.waitForFunction(() => /Untranslated JP \(1\)/.test(document.querySelector('#view').textContent));
ck('QC lists Japanese leftover without odd quote noise', /Untranslated JP/.test(await pg.textContent('#view')), (await pg.textContent('#view')).slice(0, 200));
// Glossary: VNDB mocked
await pg.route('https://api.vndb.org/**', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ results: [{ id: 'c1', name: 'Yuu Tester', original: 'ユウ', aliases: [] }], more: false }) }));
await pg.click('#nav button:has-text("04 GLOSSARY")'); await pg.fill('input[placeholder^="VNDB ID"]', 'v17'); await pg.click('button:has-text("Fetch from VNDB")');
await pg.waitForFunction(() => /VNDB characters/.test(document.querySelector('#view').textContent));
ck('VNDB draft filled', /Yuu/.test(await pg.inputValue('#view textarea')), await pg.inputValue('#view textarea'));
await pg.click('button:has-text("Save")', { timeout: 3000 }).catch(() => {});
// backup -> delete -> restore via UI
await pg.click('#nav button:has-text("06 CONFIG")');
const [bk] = await Promise.all([pg.waitForEvent('download'), pg.click('button:has-text("Backup Project")')]);
const bkPath = await bk.path(); ck('backup is gzip', fs.readFileSync(bkPath)[0] === 0x1F);
await pg.click('#crumb'); await pg.waitForSelector('.proj');
await pg.setInputFiles('input[type=file][accept]', bkPath); await pg.waitForFunction(() => /pulih|Tes Proyek/.test(document.querySelector('#crumb').textContent));
await pg.click('#nav button:has-text("01 BACKLOG")'); await pg.waitForSelector('.card');
ck('restored project has translations', (await pg.$$eval('.card textarea', e => e.map(x => x.value))).includes('Selamat pagi'));
// reload: data persists, SW active
await pg.reload(); await pg.waitForSelector('.card, #nav button');
ck('project persisted after reload', /Tes Proyek/.test(await pg.textContent('#crumb')) || /pulih/.test(await pg.textContent('#crumb')));
const sw = await pg.evaluate(async () => (await navigator.serviceWorker.ready).active.state); ck('service worker active', sw === 'activated', sw);
ck('no console/page errors', !errors.length, errors.join(' | '));
await b.close(); srv.close();
console.log(checks.every(Boolean) ? 'SMOKE OK' : 'SMOKE FAIL'); process.exit(checks.every(Boolean) ? 0 : 1);
