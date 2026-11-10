// Deploy checks: (1) every module reachable from app.js is in the SW shell, (2) site works from a sub-path (GitHub Pages
// /<repo>/) and keeps working OFFLINE after the service worker took over.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const root = path.resolve('.');
const sw = fs.readFileSync('sw.js', 'utf8'), shell = [...sw.matchAll(/\.\/([^']+)/g)].map(m => m[1]);
const seen = new Set(); (function walk(f) { if (seen.has(f)) return; seen.add(f); const src = fs.readFileSync(f, 'utf8'); for (const m of src.matchAll(/from\s+'(\.[^']+)'/g)) walk(path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]))); })('app.js');
const missing = [...seen].filter(f => !shell.includes(f)); assert.deepEqual(missing, [], 'modules missing from sw.js SHELL: ' + missing);
for (const f of shell) if (f) assert.ok(fs.existsSync(f), 'SHELL lists missing file ' + f);
console.log('  ok  SW shell covers', seen.size, 'modules');

const { chromium } = createRequire(import.meta.url)(fs.existsSync('/opt/npm-tools/node_modules/playwright') ? '/opt/npm-tools/node_modules/playwright' : 'playwright');
const BASE = '/some-repo/';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]); if (!u.startsWith(BASE)) { r.writeHead(404); r.end(); return; } let p = path.join(root, u.slice(BASE.length)); if (p.endsWith(path.sep) || u === BASE) p = path.join(p, 'index.html'); fs.readFile(p, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); r.end(d); } }); }).listen(0);
const b = await chromium.launch(), ctx = await b.newContext(), pg = await ctx.newPage(), errs = [];
pg.on('pageerror', e => errs.push(String(e)));
await pg.goto(`http://localhost:${srv.address().port}${BASE}`);
await pg.evaluate(async () => { await navigator.serviceWorker.ready; });
await pg.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 8000 }).catch(() => {}); await pg.reload(); await pg.waitForFunction(() => !!navigator.serviceWorker.controller);
await pg.fill('#view input', 'Offline'); await pg.click('text=New Project'); await pg.waitForSelector('#nav button.on');
await ctx.setOffline(true);
await pg.reload(); await pg.waitForSelector('#nav button.on', { timeout: 8000 });
assert.match(await pg.textContent('#crumb'), /Offline/);
await pg.setInputFiles('.drop input', 'tests/fixtures/sample.ks'); await pg.waitForSelector('.card');
console.log('  ok  sub-path + offline reload + import while offline'); assert.deepEqual(errs, []);
await b.close(); srv.close(); console.log('DEPLOY OK');
