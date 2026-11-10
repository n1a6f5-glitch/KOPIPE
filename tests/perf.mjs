// Browser performance benchmark & regression gate on a 22,024-entry project across 100 .scn files (5 MB blobs).
// Verifies: (1) tab switch <= 100ms on 1x CPU and <= 300ms on 4x CPU throttle, (2) bounded DOM card count,
// (3) O(1) single-card status toggle & header update, (4) jump to #gid on 22,024 entries.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)(
  fs.existsSync('/opt/npm-tools/node_modules/playwright') ? '/opt/npm-tools/node_modules/playwright' : 'playwright'
);

const root = path.resolve('.');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const srv = http.createServer((q, r) => {
  let p = path.join(root, decodeURIComponent(q.url.split('?')[0]));
  if (p.endsWith(path.sep) || q.url === '/') p = path.join(root, 'index.html');
  fs.readFile(p, (e, d) => {
    if (e) { r.writeHead(404); r.end(); }
    else { r.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' }); r.end(d); }
  });
}).listen(0);

const port = srv.address().port;
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
const pg = await ctx.newPage();
const errs = [];
pg.on('pageerror', e => errs.push(String(e)));

await pg.goto(`http://localhost:${port}/`);
await pg.waitForSelector('#view input');

const seedMs = await pg.evaluate(async () => {
  const t0 = performance.now();
  const { createStore, uid } = await import('./core/db.js');
  const P = await import('./core/project.js');
  const st = await createStore();
  const proj = await P.createProject(st, 'Senren Banka 22024');
  localStorage.setItem('kopipe.pid', proj.id);

  const files = [], blobs = [], entries = [];
  const pStats = { total: 0, todo: 0, draft: 0, done: 0, flag: 0 };
  let gid = 1;
  const dummyBytes = new Uint8Array(50000); // 50 KB per .scn file = 5 MB total binary payload

  for (let f = 0; f < 100; f++) {
    const fid = uid();
    const count = f < 24 ? 221 : 220; // 24*221 + 76*220 = 22,024 entries
    const fStats = { total: count, todo: 0, draft: 0, done: 0, flag: 0 };
    const relPath = `scn/ch${String(Math.floor(f / 10)).padStart(2, '0')}/scene_${String(f).padStart(3, '0')}.scn`;
    for (let i = 0; i < count; i++) {
      const stName = gid % 3 === 0 ? 'done' : gid % 5 === 0 ? 'draft' : gid % 17 === 0 ? 'flag' : 'todo';
      fStats[stName]++;
      pStats[stName]++;
      pStats.total++;
      entries.push({
        id: uid(), pid: proj.id, fid, idx: String(i), gid: gid++,
        name: i % 2 === 0 ? '芳乃' : 'Narasi',
        src: '「おはようございます！今日もいい天気ですね。」<T1>',
        tgt: stName === 'todo' ? '' : 'Selamat pagi! Hari ini cuacanya cerah sekali ya.<T1>',
        tgtName: stName === 'todo' ? '' : (i % 2 === 0 ? 'Yoshino' : ''),
        status: stName, kind: i % 2 === 0 ? 'D' : 'N'
      });
    }
    blobs.push({ id: fid, pid: proj.id, bytes: dummyBytes, tagStore: {} });
    files.push({
      id: fid, pid: proj.id, name: `scene_${String(f).padStart(3, '0')}.scn`, path: relPath,
      size: dummyBytes.length, kind: 'scn', meta: { mdf: false, strategy: 'shape-a' },
      order: f + 1, entryCount: count, stats: fStats, logStatus: 'ok',
      importLog: { entries: [{ t: 1.2, level: 'info', step: 'entries', msg: `${count} entri` }], status: 'ok' }
    });
  }
  proj.nextGid = gid;
  proj.nextOrder = 101;
  proj.stats = pStats;
  await st.put('projects', proj);
  await st.putMany('blobs', blobs);
  await st.putMany('files', files);
  for (let i = 0; i < entries.length; i += 2500) {
    await st.putMany('entries', entries.slice(i, i + 2500));
  }
  return Math.round(performance.now() - t0);
});
console.log(`  ok  seeded 22,024 entries across 100 .scn files (5 MB blobs) in ${seedMs} ms`);

await pg.reload();
await pg.waitForSelector('.card');

const cardCount = await pg.$$eval('.card', els => els.length);
assert.ok(cardCount > 0 && cardCount <= 50, `Expected <= 50 cards in DOM, got ${cardCount}`);
console.log(`  ok  Edit DOM bounded to ${cardCount} cards (out of 22,024 entries)`);

const tabSelectors = {
  Batch: 'textarea[readonly]',
  QC: '.chip',
  Kamus: 'textarea',
  Berkas: 'table',
  Setelan: 'input[type="number"]',
  Edit: '.card'
};

async function measureAllTabs() {
  const res = {};
  for (const [tab, sel] of Object.entries(tabSelectors)) {
    const ms = await pg.evaluate(async ({ tName, targetSel }) => {
      const btn = [...document.querySelectorAll('#nav button')].find(b => b.textContent.trim() === tName);
      const t0 = performance.now();
      btn.click();
      while (!document.querySelector('#view ' + targetSel)) {
        await new Promise(r => setTimeout(r, 2));
      }
      await new Promise(r => requestAnimationFrame(r));
      return Math.round(performance.now() - t0);
    }, { tName: tab, targetSel: sel });
    res[tab] = ms;
  }
  return res;
}

const desktopMs = await measureAllTabs();
console.log('  ok  1x CPU tab switch (ms):', JSON.stringify(desktopMs));
for (const [tab, ms] of Object.entries(desktopMs)) {
  assert.ok(ms <= 100, `1x CPU tab switch for ${tab} took ${ms}ms (> 100ms limit)`);
}

// Single-card status toggle on 22,024 entries
const toggleMs = await pg.evaluate(async () => {
  const before = document.querySelector('#prog').textContent;
  const btn = document.querySelector('.card button');
  const t0 = performance.now();
  btn.click();
  while (document.querySelector('#prog').textContent === before) {
    await new Promise(r => setTimeout(r, 2));
  }
  return Math.round(performance.now() - t0);
});
console.log(`  ok  single-card status toggle + header counter update: ${toggleMs} ms`);
assert.ok(toggleMs <= 100, `Single-card toggle took ${toggleMs}ms`);

// Jump to #15000 on 22,024 entries
await pg.fill('input[placeholder="#gid"]', '15000');
await pg.click('button:has-text("Lompat")');
await pg.waitForSelector('.card[data-gid="15000"]');
console.log('  ok  jump to #15000 on 22,024 entries');

// 4x CPU throttling benchmark
await pg.setCPUThrottlingRate(4);
const throttledMs = await measureAllTabs();
console.log('  ok  4x CPU throttle tab switch (ms):', JSON.stringify(throttledMs));
for (const [tab, ms] of Object.entries(throttledMs)) {
  assert.ok(ms <= 300, `4x CPU tab switch for ${tab} took ${ms}ms (> 300ms limit)`);
}

assert.deepEqual(errs, [], 'No page errors during perf benchmark');
await b.close();
srv.close();
console.log('PERF OK');
