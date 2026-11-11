// KOPIPE – Visual Novel Script Localization System. Vanilla DOM, no build step. All data lives in IndexedDB (core/db.js) via core/project.js.
import { createStore } from './core/db.js';
import * as P from './core/project.js';
import { KIND_LABEL } from './core/engines/index.js';
import { fetchVndb } from './core/vndb.js';
import { fixTags } from './core/qc.js';
import { wrapText } from './core/util.js';
import { createZipWriter } from './core/zip.js';
import { exportProject, importProject } from './core/backup.js';
import { formatLog, summarizeLog } from './core/log.js';

const $ = s => document.querySelector(s);
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v; else if (v === true) el.setAttribute(k, ''); else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
};
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
let toastT; const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600); };
const download = (name, bytesOrBlob, type = 'application/octet-stream') => {
  const blob = bytesOrBlob instanceof Blob ? bytesOrBlob : new Blob([bytesOrBlob], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
};
const copyText = async (txt) => {
  try { await navigator.clipboard.writeText(txt); return true; } catch (e) {
    const ta = h('textarea', { value: txt, style: 'position:fixed;opacity:0' }); document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e2) { /* ignore */ } ta.remove(); return ok;
  }
};

const STAT_LABEL = { todo: 'Untranslated', draft: 'Draft', done: 'Done', flag: 'Flagged' };
const KIND_BADGE = { dialog: 'Dialog', narasi: 'Narration', D: 'Dialog', N: 'Narration' };

function isEntryDialogue(entry) {
  if (!entry) return false;
  if (entry.name && !P.isNarrationSpeaker(entry.name)) return true;
  return entry.kind === 'dialog' || entry.kind === 'D';
}
const QC_TYPE_LABEL = {
  tag: 'Tag Mismatch',
  tag_malformed: 'Malformed Tag',
  br: 'Line Break (<BR>)',
  jepang: 'Untranslated JP',
  gls: 'Glossary Mismatch'
};
const TABS = [
  ['edit', '01 BACKLOG'],
  ['batch', '02 BATCH'],
  ['qc', '03 QC'],
  ['kamus', '04 GLOSSARY'],
  ['files', '05 ARCHIVE'],
  ['set', '06 CONFIG']
];

let store, proj = null, installEvt = null, qcAbort = null, swReg = null, updatePreviewFn = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (store && !proj) render(); });
const S = {
  tab: 'edit', scope: '', fid: '', folder: '', status: '', q: '', page: 1,
  batchFrom: null, batchStatus: 'todo',
  qcPage: 1, qcFilter: 'all', qcTargetMode: 'polish', qcFrom: 1,
  qcRev: 1, qcCache: null,
  fileFilter: '', vntpFilter: false, onlyTranslatedZip: false,
  showVnPreview: lsGet('kopipe.preview') === '1',
  theme: lsGet('kopipe.theme') || 'obsidian',
  collapsedDirs: new Set(), _dirsInit: false, lastSummary: null
};
document.documentElement.setAttribute('data-theme', S.theme);
const PAGE = 50;

function applyTheme(t) {
  S.theme = t || 'obsidian';
  lsSet('kopipe.theme', S.theme);
  document.documentElement.setAttribute('data-theme', S.theme);
}

function applyBgConfig() {
  const mode = lsGet('kopipe.bgMode') || 'default';
  const custom = lsGet('kopipe.bgCustom') || '';
  const dim = lsGet('kopipe.bgDim') || '0.72';
  const blur = lsGet('kopipe.bgBlur') || '0px';
  const stageH = lsGet('kopipe.stageH') || '280px';
  const bgPos = lsGet('kopipe.bgPos') || '22%';
  const rootStyle = document.documentElement.style;
  if (mode === 'none') rootStyle.setProperty('--bg-img', 'none');
  else if (mode === 'custom' && custom) rootStyle.setProperty('--bg-img', `url("${custom}")`);
  else rootStyle.setProperty('--bg-img', "url('icons/vn-bg.svg')");
  rootStyle.setProperty('--bg-dim', dim);
  rootStyle.setProperty('--bg-blur', blur);
  rootStyle.setProperty('--stage-h', stageH);
  rootStyle.setProperty('--bg-pos', bgPos);
}
applyBgConfig();

function markQcDirty() {
  S.qcRev++;
  S.qcCache = null;
}

function applyScope(val) {
  S.scope = val || '';
  if (!val) { S.fid = ''; S.folder = ''; }
  else if (val.startsWith('dir:')) { S.fid = ''; S.folder = val.slice(4); }
  else if (val.startsWith('fid:')) { S.fid = val.slice(4); S.folder = ''; }
  else { S.fid = val; S.folder = ''; }
}

function paintHeaderSync(s) {
  if (!proj || !s) { $('#crumb').textContent = ''; $('#prog').textContent = ''; $('#bar').firstChild.style.width = '0'; return; }
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  $('#crumb').textContent = '[ SCENE : ' + proj.name + ' ]';
  $('#crumb').title = 'Return to Project Select (Save / Load Slots)';
  $('#prog').textContent = `${s.done}/${s.total} · ${pct}%`;
  $('#bar').firstChild.style.width = pct + '%';
}

async function refreshHeader() {
  if (!proj) { paintHeaderSync(null); return; }
  if (proj.stats && typeof proj.stats.total === 'number') paintHeaderSync(proj.stats);
  const s = await P.stats(store, proj.id);
  if (proj) { proj.stats = s; paintHeaderSync(s); }
}

function mountNav() {
  const nav = $('#nav'); nav.hidden = !proj; nav.replaceChildren();
  if (!proj) return;
  for (const [id, label] of TABS) {
    nav.append(h('button', { class: S.tab === id ? 'on' : '', onclick: () => {
      if (qcAbort) { qcAbort.abort(); qcAbort = null; }
      S.tab = id; render();
    } }, label));
  }
}

async function render() {
  mountNav();
  if (proj && proj.stats) paintHeaderSync(proj.stats);
  else await refreshHeader();
  const v = $('#view'); v.replaceChildren();
  if (!proj) return renderHome(v);
  if (S.tab === 'edit') return renderEdit(v);
  if (S.tab === 'batch') return renderBatch(v);
  if (S.tab === 'qc') return renderQc(v);
  if (S.tab === 'kamus') return renderKamus(v);
  if (S.tab === 'files') return renderFiles(v);
  return renderSettings(v);
}

async function openProject(id) {
  if (qcAbort) { qcAbort.abort(); qcAbort = null; }
  proj = id ? await P.ensureMigrated(store, id) : null;
  if (id && !proj) return render();
  lsSet('kopipe.pid', id || '');
  applyScope(''); S.status = ''; S.q = ''; S.page = 1; S.qcPage = 1; S.tab = 'edit';
  S.batchFrom = null; S.batchStatus = 'todo'; S.qcCache = null;
  S.lastSummary = null; S.collapsedDirs = new Set(); S._dirsInit = false;
  if (proj && proj.stats && !proj.stats.total) S.tab = 'files';
  await render();
}
$('#crumb').onclick = () => openProject(null);

function buildScopePicker(files, onChange) {
  const dirs = new Map();
  for (const f of files) {
    const fs = f.stats || { total: f.entryCount || 0, todo: f.entryCount || 0 };
    const tr = Math.max(0, (fs.total || 0) - (fs.todo || 0));
    const d = P.dirName(f.path || f.name);
    if (d) {
      const parts = d.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const sub = parts.slice(0, i).join('/');
        const cur = dirs.get(sub) || { count: 0, tr: 0, total: 0 };
        cur.count++;
        cur.tr += tr;
        cur.total += fs.total || 0;
        dirs.set(sub, cur);
      }
    }
  }
  const sortedDirs = [...dirs.keys()].sort(P.naturalPathCompare);
  const sel = h('select', { onchange: e => { applyScope(e.target.value); S.batchFrom = null; onChange(); } });
  const populate = (filterStr = '') => {
    const flt = filterStr.trim().toLowerCase();
    const pStats = (proj && proj.stats) || { total: 0, todo: 0 };
    const pTr = Math.max(0, (pStats.total || 0) - (pStats.todo || 0));
    const pPct = pStats.total ? Math.round((pTr / pStats.total) * 100) : 0;
    sel.replaceChildren(h('option', { value: '' }, `All Files (${pPct}% · ${pTr}/${pStats.total || 0})`));
    for (const d of sortedDirs) {
      if (flt && !d.toLowerCase().includes(flt)) continue;
      const val = 'dir:' + d;
      const info = dirs.get(d);
      const dPct = info.total ? Math.round((info.tr / info.total) * 100) : 0;
      sel.append(h('option', { value: val, selected: S.scope === val }, `[${String(dPct).padStart(3, ' ')}%] [Dir] ${d}/ (${info.tr}/${info.total} · ${info.count} files)`));
    }
    for (const f of files) {
      const label = f.path || f.name;
      if (flt && !label.toLowerCase().includes(flt)) continue;
      const fs = f.stats || { total: f.entryCount || 0, todo: f.entryCount || 0 };
      const tr = Math.max(0, (fs.total || 0) - (fs.todo || 0));
      const pct = fs.total ? Math.round((tr / fs.total) * 100) : 0;
      sel.append(h('option', { value: f.id, selected: S.fid === f.id || S.scope === f.id }, `[${String(pct).padStart(3, ' ')}%] ${label} (${tr}/${fs.total || 0})`));
    }
  };
  populate('');
  if (files.length <= 8 && !sortedDirs.length) return [sel];
  const filterInp = h('input', { placeholder: 'Filter files...', style: 'width:140px', oninput: () => populate(filterInp.value) });
  return [sel, filterInp];
}

// — Home (VN Save / Load Data Slots) ———————————————————
async function renderHome(v) {
  const name = h('input', { placeholder: 'New project title (e.g. Senren Banka)', class: 'grow' });
  const create = async () => { const p = await P.createProject(store, name.value.trim() || 'New Project'); await openProject(p.id); };
  name.addEventListener('keydown', e => { if (e.key === 'Enter') create(); });
  const rin = h('input', { type: 'file', accept: '.gz,.json,.kopipe', hidden: true, onchange: async () => {
    const f = rin.files[0]; rin.value = ''; if (!f) return;
    try { const id = await importProject(store, new Uint8Array(await f.arrayBuffer())); toast('Project restored'); await openProject(id); } catch (e) { toast('Failed: ' + e.message); }
  }});
  v.append(
    h('div', { class: 'panel-card' },
      h('div', { class: 'panel-head' }, h('b', {}, 'SYSTEM // PROJECT DATA SELECT')),
      h('div', { class: 'row', style: 'margin-bottom:6px' }, name, h('button', { class: 'pri', onclick: create }, 'New Project')),
      h('div', { class: 'row', style: 'margin-bottom:0' },
        h('label', { class: 'dim', style: 'cursor:pointer;text-decoration:underline' }, rin, 'Load Backup File (.kopipe.gz / .json)...'),
        installEvt ? h('button', { class: 'sm', onclick: async () => { installEvt.prompt(); installEvt = null; render(); } }, 'Install App') : null
      )
    )
  );
  const ps = await P.listProjects(store);
  if (!ps.length) v.append(h('p', { class: 'dim' }, 'No project slots found. Create a new project above, then import script files (.ks, .txt, .ast, .scn, VNTP .json) or an entire folder.'));
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    const slotNum = `SLOT ${String(i + 1).padStart(2, '0')}`;
    const s = await P.stats(store, p.id), pct = s.total ? (s.done / s.total) * 100 : 0;
    const delBtn = h('button', {
      class: 'sm danger',
      title: `Delete project ${p.name}`,
      onclick: async e => {
        e.stopPropagation();
        if (confirm(`Delete project "${p.name}" (${s.total} lines) and all its files and translations?\n\nThis action cannot be undone.`)) {
          await P.deleteProject(store, p.id);
          toast(`Deleted "${p.name}"`);
          await render();
        }
      }
    }, 'Delete');
    v.append(h('div', { class: 'proj', onclick: () => openProject(p.id) },
      h('div', { style: 'flex:1;min-width:0' },
        h('div', { class: 'row', style: 'margin:0 0 4px;gap:8px' },
          h('span', { class: 'slot-no' }, slotNum),
          h('b', { style: 'font-size:14.5px' }, p.name),
          h('span', { class: 'dim', style: 'font-family:var(--mono);font-size:11px' }, new Date(p.updatedAt || p.createdAt || Date.now()).toLocaleDateString())
        ),
        h('div', { class: 'dim', style: 'font-family:var(--mono);font-size:11.5px' }, `LINES: ${s.total} · DONE: ${s.done} · DRAFT: ${s.draft} · TODO: ${s.todo}` + (s.flag ? ` · FLAGGED: ${s.flag}` : ''))
      ),
      h('div', { class: 'row', style: 'margin:0;flex-wrap:nowrap' },
        h('div', { class: 'meter' }, h('i', { style: `width:${pct}%` })),
        h('button', { class: 'sm pri', onclick: e => { e.stopPropagation(); openProject(p.id); } }, 'Load'),
        delBtn
      )
    ));
  }
}

// — 01 BACKLOG (Edit + Live VN Textbox Preview) ————————————
function srcNodes(src, hideTags = false) {
  if (hideTags) {
    const cleaned = P.stripAllTagsForAi(src);
    return [cleaned || src];
  }
  const out = []; let last = 0; const re = /<T\d+>/g; let m;
  while ((m = re.exec(src))) { if (m.index > last) out.push(src.slice(last, m.index)); out.push(h('span', { class: 'tag', 'data-tag': m[0], title: 'Click to insert into translation' }, m[0])); last = m.index + m[0].length; }
  if (last < src.length) out.push(src.slice(last)); return out;
}

function formatVnPreviewText(rawTgt, rawSrc) {
  const base = (rawTgt && rawTgt.trim()) ? P.stripAllTagsForAi(rawTgt) : P.stripAllTagsForAi(rawSrc);
  const withBr = String(base || '').split('<BR>').join('\n');
  const qm = (proj && proj.settings && proj.settings.quoteMode) || 'keep';
  const quoted = P.convertJpQuotes(withBr, qm);
  const ww = (proj && proj.settings && proj.settings.wrapWidth) || 0;
  if (ww > 0) {
    return quoted.split('\n').map(seg => wrapText(seg, ww, '\n')).join('\n');
  }
  return quoted;
}

async function renderEdit(v) {
  const files = await P.listFiles(store, proj.id);
  if (!files.length) { v.append(h('p', { class: 'dim' }, 'No files in archive. Open 05 ARCHIVE to import script files or a folder.')); return; }
  const rfids = P.resolveScopeFids(files, { fid: S.fid, folder: S.folder });
  const scopeCtrls = buildScopePicker(files, () => { S.page = 1; render(); });
  const q = h('input', { class: 'grow', placeholder: 'Search backlog text or speaker...', value: S.q });
  let qt; q.addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(() => { S.q = q.value; S.page = 1; list(); }, 220); });

  const stStats = proj.stats || { total: 0, todo: 0, draft: 0, done: 0, flag: 0 };
  const statusItems = [
    ['', `All (${stStats.total || 0})`],
    ['todo', `Untranslated (${stStats.todo || 0})`],
    ['draft', `Draft (${stStats.draft || 0})`],
    ['done', `Done (${stStats.done || 0})`],
    ['flag', `Flagged (${stStats.flag || 0})`]
  ];
  const hideTagsChk = h('input', { type: 'checkbox', checked: S.hideTagsInEdit, onchange: () => { S.hideTagsInEdit = hideTagsChk.checked; list(); } });
  const prevChk = h('input', { type: 'checkbox', checked: S.showVnPreview, onchange: () => {
    S.showVnPreview = prevChk.checked;
    lsSet('kopipe.preview', S.showVnPreview ? '1' : '0');
    previewWrap.hidden = !S.showVnPreview;
  } });

  const findInp = h('input', { placeholder: 'Find in translations...', style: 'width:190px' });
  const repInp = h('input', { placeholder: 'Replace with...', style: 'width:190px' });
  const caseChk = h('input', { type: 'checkbox' });
  const findResSpan = h('span', { class: 'dim', style: 'font-family:var(--mono)' }, '');
  const findBar = h('div', { class: 'prog-box row', hidden: !S.showFindReplace, style: 'margin-top:0;margin-bottom:10px' },
    findInp,
    repInp,
    h('label', { class: 'pill-chk' }, caseChk, 'Match case'),
    h('button', { class: 'pri sm', onclick: async () => {
      if (!findInp.value) return toast('Enter text to find');
      const r = await P.replaceInTranslations(store, proj.id, {
        findText: findInp.value,
        replaceText: repInp.value,
        fid: S.fid || undefined,
        folder: S.folder || undefined,
        matchCase: caseChk.checked
      });
      if (!r.replacedEntries) {
        findResSpan.textContent = '0 matches';
        return toast('No matching translations found');
      }
      markQcDirty();
      proj = await store.get('projects', proj.id);
      findResSpan.textContent = `Replaced ${r.occurrences} in ${r.replacedEntries} lines`;
      toast(`Replaced ${r.occurrences} occurrences across ${r.replacedEntries} lines`);
      await list();
    } }, 'Replace All'),
    h('button', { class: 'sm danger', onclick: async () => {
      const n = await P.undoApply(store, proj.id);
      if (!n) return toast('Nothing to undo');
      markQcDirty();
      proj = await store.get('projects', proj.id);
      findResSpan.textContent = `Reverted ${n} lines`;
      toast(`Reverted ${n} lines`);
      await refreshHeader();
      await list();
    } }, 'Undo'),
    findResSpan
  );

  const chips = h('div', { class: 'row' },
    statusItems.map(([k, l]) => h('button', { class: 'chip' + (S.status === k ? ' on' : ''), onclick: () => { S.status = k; S.page = 1; render(); } }, l)),
    h('button', { class: 'chip' + (S.q.toLowerCase() === 'choice' ? ' on' : ''), title: 'Filter only branching choice options (Choice / Pilihan)', onclick: () => { S.q = S.q.toLowerCase() === 'choice' ? '' : 'Choice'; S.page = 1; render(); } }, 'Choices'),
    h('button', { class: 'chip' + (S.showFindReplace ? ' on' : ''), style: 'margin-left:auto', onclick: () => { S.showFindReplace = !S.showFindReplace; findBar.hidden = !S.showFindReplace; } }, 'Find & Replace'),
    h('label', { class: 'pill-chk', title: 'Show live Visual Novel message box preview while editing' }, prevChk, 'VN Box Preview'),
    h('label', { class: 'pill-chk', title: 'Hide <T#> tags and reattach them automatically on save' }, hideTagsChk, 'Auto-tag')
  );

  // Live VN Textbox Preview element
  const vnPlate = h('span', { class: 'vn-nameplate' }, 'Speaker');
  const vnMeta = h('span', { class: 'vn-meta' }, 'LIVE MESSAGE WINDOW PREVIEW');
  const vnText = h('div', { class: 'vn-text' }, 'Select or type in any backlog line below to preview it inside the Visual Novel message box.');
  const vnSrcSub = h('div', { class: 'vn-src-sub' }, '');
  const previewWrap = h('div', { class: 'vn-preview-wrap', hidden: !S.showVnPreview },
    h('div', { class: 'vn-stage' },
      h('div', { class: 'vn-box' },
        h('div', { class: 'vn-top' }, vnPlate, vnMeta),
        vnText,
        vnSrcSub
      )
    )
  );

  updatePreviewFn = (entry, liveTgt, liveSpeaker) => {
    if (!entry) return;
    const isChoice = entry.kind === 'C' || (P.isChoiceSpeaker && P.isChoiceSpeaker(entry.name));
    const isDialog = !isChoice && isEntryDialogue(entry);
    const spk = isChoice ? 'CHOICE' : ((liveSpeaker && liveSpeaker.trim()) || entry.tgtName || (isDialog ? (entry.name && !P.isNarrationSpeaker(entry.name) ? entry.name : 'DIALOGUE') : 'NARRATION'));
    vnPlate.textContent = spk;
    vnPlate.className = 'vn-nameplate' + (isDialog ? '' : ' narasi');
    const formatted = formatVnPreviewText(liveTgt !== undefined ? liveTgt : entry.tgt, entry.src);
    vnText.textContent = (formatted || '') + ' ▾';
    const lines = (formatted || '').split('\n');
    const maxLine = lines.reduce((m, l) => Math.max(m, l.length), 0);
    const ww = proj.settings.wrapWidth || 0;
    vnMeta.textContent = `#${String(entry.gid).padStart(6, '0')} · ${lines.length} line${lines.length > 1 ? 's' : ''} · max ${maxLine} chars` + (ww ? ` (wrap: ${ww})` : '');
    vnSrcSub.textContent = `JP: ${P.stripAllTagsForAi(entry.src)}`;
  };

  const box = h('div');
  v.append(h('div', { class: 'row' }, ...scopeCtrls, q), chips, findBar, previewWrap, box);

  async function jumpToGid(targetGid) {
    if (!targetGid || targetGid < 1) return;
    const before = await P.listEntriesPage(store, proj.id, {
      fid: rfids && rfids.length === 1 ? rfids[0] : undefined,
      fids: rfids && rfids.length > 1 ? rfids : undefined,
      status: S.status || undefined,
      q: S.q || undefined,
      offset: 0,
      limit: 1,
      gidFrom: targetGid
    });
    if (!before.items.length) { toast(`Line #${targetGid} not found in current filter`); return; }
    if (!S.fid && !S.folder && !S.status && !S.q) {
      S.page = Math.max(1, Math.ceil(targetGid / PAGE));
    } else {
      const allMatching = await P.listEntries(store, proj.id, { fid: S.fid || undefined, folder: S.folder || undefined, status: S.status || undefined, q: S.q || undefined });
      const idx = allMatching.findIndex(e => e.gid >= targetGid);
      if (idx >= 0) S.page = Math.floor(idx / PAGE) + 1;
    }
    await list(before.items[0].gid);
  }

  async function list(focusGid = null) {
    const pgRes = await P.listEntriesPage(store, proj.id, {
      fid: rfids && rfids.length === 1 ? rfids[0] : undefined,
      fids: rfids && rfids.length > 1 ? rfids : undefined,
      status: S.status || undefined,
      q: S.q || undefined,
      offset: (S.page - 1) * PAGE,
      limit: PAGE
    });
    const total = pgRes.total;
    const totalPages = Math.max(1, Math.ceil(total / PAGE));
    if (S.page > totalPages) S.page = totalPages;

    const jumpInp = h('input', { type: 'number', min: 1, placeholder: '#ID', style: 'width:76px;padding:4px 8px;font-size:12px' });
    jumpInp.addEventListener('keydown', e => { if (e.key === 'Enter') jumpToGid(+jumpInp.value); });

    // Single header element as child #1 of `box` so `.card:nth-child(2)` is always the first card
    const topBar = h('div', { class: 'row', style: 'margin:4px 0 8px' },
      h('span', { class: 'dim', style: 'font-family:var(--mono)' }, `BACKLOG: ${total} LINES` + (totalPages > 1 ? ` · PAGE ${S.page}/${totalPages}` : '')),
      totalPages > 1 ? h('button', { class: 'sm', disabled: S.page <= 1, onclick: () => { if (S.page > 1) { S.page--; list(); } } }, 'Prev') : null,
      totalPages > 1 ? h('button', { class: 'sm', disabled: S.page >= totalPages, onclick: () => { if (S.page < totalPages) { S.page++; list(); } } }, 'Next') : null,
      total > PAGE ? jumpInp : null,
      total > PAGE ? h('button', { class: 'sm', onclick: () => jumpToGid(+jumpInp.value) }, 'Jump') : null
    );

    box.replaceChildren(topBar);
    if (pgRes.items.length && updatePreviewFn) updatePreviewFn(pgRes.items[0]);
    for (const e of pgRes.items) box.append(card(e));

    if (totalPages > 1) {
      box.append(h('div', { class: 'row', style: 'justify-content:space-between;margin-top:10px' },
        h('button', { class: 'sm', disabled: S.page <= 1, onclick: () => { S.page--; list(); window.scrollTo(0, 0); } }, 'Prev Page'),
        h('span', { class: 'dim', style: 'font-family:var(--mono)' }, `PAGE ${S.page} / ${totalPages}`),
        h('button', { class: 'sm', disabled: S.page >= totalPages, onclick: () => { S.page++; list(); window.scrollTo(0, 0); } }, 'Next Page')
      ));
    }
    if (focusGid) {
      const targetEl = box.querySelector(`.card[data-gid="${focusGid}"] textarea`);
      if (targetEl) { targetEl.focus(); targetEl.scrollIntoView({ block: 'center' }); }
    }
  }
  await list();
}

function card(e) {
  let timer, cur = e;
  const hasTags = /<T\d+>/.test(e.src);
  const isChoice = e.kind === 'C' || (P.isChoiceSpeaker && P.isChoiceSpeaker(e.name));
  const isDialog = !isChoice && isEntryDialogue(e);
  const st = h('span', { class: 'st' }, STAT_LABEL[e.status] || e.status);
  const note = h('div', { class: 'note' }, e.note || '');
  const ta = h('textarea', {
    placeholder: isChoice ? 'Choice button translation...' : (isDialog ? 'Dialogue translation...' : 'Narration translation...'),
    rows: Math.max(2, Math.min(6, Math.ceil(e.src.length / 48)))
  });
  ta.value = S.hideTagsInEdit && hasTags ? P.stripAllTagsForAi(e.tgt) : e.tgt;
  const nm = (e.name && e.name !== 'Narasi' && !isChoice) ? h('input', { class: 'nm', placeholder: 'Speaker: ' + e.name, value: e.tgtName }) : null;
  const doneBtn = h('button', { class: 'sm' }, '');
  const el = h('div', { class: 'card s-' + e.status, 'data-gid': e.gid });
  const paint = r => {
    cur = r;
    el.className = 'card s-' + r.status;
    st.textContent = STAT_LABEL[r.status] || r.status;
    note.textContent = r.note || '';
    doneBtn.textContent = r.status === 'done' ? 'Reopen' : 'Done';
  };
  const save = async (extra = {}) => {
    clearTimeout(timer);
    const updated = await P.setTranslation(store, e.id, {
      tgt: ta.value,
      tgtName: nm ? nm.value.trim() : undefined,
      autoFix: S.hideTagsInEdit || !!extra.autoFix,
      ...extra
    });
    markQcDirty();
    paint(updated);
    await refreshHeader();
  };
  ta.addEventListener('focus', () => { if (updatePreviewFn) updatePreviewFn(cur, ta.value, nm ? nm.value : ''); });
  ta.addEventListener('input', () => {
    if (updatePreviewFn) updatePreviewFn(cur, ta.value, nm ? nm.value : '');
    clearTimeout(timer);
    timer = setTimeout(save, 600);
  });
  ta.addEventListener('blur', () => {
    const cmp = S.hideTagsInEdit && hasTags ? P.stripAllTagsForAi(cur.tgt) : cur.tgt;
    if (ta.value !== cmp) save();
  });
  if (nm) {
    nm.addEventListener('input', () => { if (updatePreviewFn) updatePreviewFn(cur, ta.value, nm.value); });
    nm.addEventListener('change', () => save());
  }
  doneBtn.onclick = () => save({ status: cur.status === 'done' ? 'draft' : 'done', autoFix: true });
  ta.addEventListener('keydown', async ev => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      await save({ status: ta.value.trim() ? 'done' : undefined, autoFix: true });
      const nx = el.nextElementSibling;
      if (nx && nx.querySelector('textarea')) { nx.querySelector('textarea').focus(); nx.scrollIntoView({ block: 'center' }); }
    }
  });
  const src = h('div', { class: 'src' }, srcNodes(e.src, S.hideTagsInEdit));
  src.addEventListener('click', ev => { const t = ev.target.dataset && ev.target.dataset.tag; if (t) { const p = ta.selectionStart ?? ta.value.length; ta.setRangeText(t, p, ta.selectionEnd ?? p, 'end'); ta.focus(); ta.dispatchEvent(new Event('input')); } });
  const kClass = isChoice ? 'k-choice' : (isDialog ? 'k-dialog' : 'k-narasi');
  const kLabel = isChoice ? 'Choice' : (isDialog ? 'Dialog' : 'Narration');
  const fixTagBtn = (!S.hideTagsInEdit && hasTags) ? h('button', {
    class: 'sm',
    title: 'Automatically reattach <T#> tags from source',
    onclick: async () => {
      ta.value = fixTags(e.src, ta.value || '');
      await save({ autoFix: true });
      toast('Tags reattached');
    }
  }, 'Fix Tags') : null;
  if (nm) nm.hidden = true;
  const spkEl = (e.name && e.name !== 'Narasi' && !isChoice) ? h('span', {
    class: 'spk-badge',
    style: 'cursor:pointer',
    title: 'Click to set translated speaker name across project (Glossary)',
    onclick: async () => {
      const curName = cur.tgtName || (proj.glossary && proj.glossary[e.name]) || e.name;
      const nextName = prompt(`Set translated name for speaker "${e.name}" across the entire project:`, curName);
      if (nextName === null) return;
      const n = await P.renameSpeakerGlobally(store, proj.id, e.name, nextName);
      markQcDirty();
      proj = await store.get('projects', proj.id);
      cur.tgtName = nextName.trim();
      spkEl.textContent = cur.tgtName && cur.tgtName !== e.name ? `${e.name} → ${cur.tgtName}` : e.name;
      if (updatePreviewFn) updatePreviewFn(cur, ta.value, cur.tgtName);
      toast(`Speaker "${e.name}" → "${cur.tgtName || e.name}" (${n} lines updated)`);
    }
  }, (e.tgtName && e.tgtName !== e.name) ? `${e.name} → ${e.tgtName}` : e.name) : null;

  el.append(...[
    h('div', { class: 'h' },
      spkEl,
      h('span', { style: 'color:var(--ink)' }, `#${String(e.gid).padStart(6, '0')}`),
      h('span', { class: 'badge ' + kClass }, kLabel),
      st,
      fixTagBtn,
      h('button', { class: 'sm', onclick: async () => { toast((await copyText(P.stripAllTagsForAi(e.src))) ? 'Copied JP text' : 'Copy failed'); } }, 'Copy JP'),
      doneBtn
    ),
    src,
    ta,
    note
  ].filter(Boolean));
  paint(e); return el;
}

// — 02 BATCH ————————————————————————————————————————————
async function renderBatch(v) {
  const s = proj.stats || await P.stats(store, proj.id);
  if (!s.total) { v.append(h('p', { class: 'dim' }, 'No script lines yet. Import files first in 05 ARCHIVE.')); return; }
  const files = await P.listFiles(store, proj.id);
  const scopeCtrls = buildScopePicker(files, () => render());
  const rfids = P.resolveScopeFids(files, { fid: S.fid, folder: S.folder });
  const todo = await P.firstEntry(store, proj.id, {
    fid: rfids && rfids.length === 1 ? rfids[0] : undefined,
    fids: rfids && rfids.length > 1 ? rfids : undefined,
    status: 'todo'
  });

  const savedBatchSize = proj.settings.batchSize || 100;
  const startGid = S.batchFrom != null ? S.batchFrom : (todo ? todo.gid : 1);
  const from = h('input', {
    type: 'number',
    min: 1,
    value: startGid,
    onchange: () => { S.batchFrom = +from.value || 1; }
  });
  const count = h('input', {
    type: 'number',
    min: 1,
    max: 5000,
    value: savedBatchSize,
    onchange: () => {
      const val = Math.max(1, +count.value || 100);
      proj.settings.batchSize = val;
      store.put('projects', proj);
    }
  });
  const only = h('select', {
    onchange: () => { S.batchStatus = only.value; }
  }, [
    ['todo', `Untranslated (${s.todo || 0})`],
    ['draft', `Draft (${s.draft || 0})`],
    ['flag', `Flagged (${s.flag || 0})`],
    ['done', `Done (${s.done || 0})`],
    ['', `All Lines (${s.total || 0})`]
  ].map(([k, l]) => h('option', { value: k, selected: S.batchStatus === k }, l)));

  const tagModeSel = h('select', {}, [
    ['keep', 'Keep <T#> & <BR> tags (Default)'],
    ['edge', 'Strip edge <T#> tags only'],
    ['clean', 'Hide all <T#> tags & reattach automatically']
  ].map(([k, l]) => h('option', { value: k, selected: (proj.settings.tagMode || 'keep') === k }, l)));

  const curPromptLang = proj.settings.promptLang || 'en';
  const promptSel = h('select', {}, [
    ['en', 'English (Default)'],
    ['id', 'Indonesian (Default)'],
    ['custom', 'Custom Prompt'],
    ['none', 'No Prompt (Script Only)']
  ].map(([k, l]) => h('option', { value: k, selected: curPromptLang === k }, l)));

  const promptTa = h('textarea', {
    rows: 8,
    readonly: curPromptLang !== 'custom',
    style: 'margin-top:6px;font-size:12.5px',
    value: curPromptLang === 'custom'
      ? (proj.settings.customPrompt || P.DEFAULT_PROMPTS.en)
      : (P.DEFAULT_PROMPTS[curPromptLang] || P.DEFAULT_PROMPTS.en)
  });
  const promptBox = h('div', { class: 'prog-box', hidden: true, style: 'margin-bottom:10px' },
    h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:4px' },
      h('b', { style: 'font-size:12px;font-family:var(--mono)' }, 'TRANSLATION PROMPT'),
      h('div', { class: 'row', style: 'margin:0' },
        h('button', { class: 'sm', onclick: () => { promptTa.value = P.DEFAULT_PROMPTS.en; promptSel.value = 'en'; promptTa.readOnly = true; } }, 'Reset EN'),
        h('button', { class: 'sm', onclick: () => { promptTa.value = P.DEFAULT_PROMPTS.id; promptSel.value = 'id'; promptTa.readOnly = true; } }, 'Reset ID')
      )
    ),
    promptTa
  );
  promptSel.onchange = () => {
    const vSel = promptSel.value;
    promptTa.readOnly = vSel !== 'custom';
    if (vSel === 'en' || vSel === 'id') promptTa.value = P.DEFAULT_PROMPTS[vSel];
    else if (vSel === 'custom') { promptBox.hidden = false; if (!promptTa.value.trim()) promptTa.value = proj.settings.customPrompt || P.DEFAULT_PROMPTS.en; }
    proj.settings.promptLang = vSel;
    store.put('projects', proj);
  };

  const out = h('textarea', { rows: 9, readonly: true, placeholder: 'Click "Generate & Copy" to build the batch with prompt and copy it to your clipboard.' });
  const info = h('span', { class: 'badge' }, 'READY');
  let lastRawBatch = '', lastExportedEndGid = null;

  const make = async (includePrompt = true, advanceNext = false) => {
    if (advanceNext) {
      const step = Math.max(1, +count.value || 100);
      const nextStart = lastExportedEndGid ? (lastExportedEndGid + 1) : ((+from.value || 1) + step);
      from.value = nextStart;
      S.batchFrom = nextStart;
    }
    const pLang = includePrompt ? promptSel.value : 'none';
    const tMode = tagModeSel.value;
    const bCount = Math.max(1, +count.value || 100);
    const bFrom = Math.max(1, +from.value || 1);
    S.batchFrom = bFrom;
    S.batchStatus = only.value;
    proj.settings.batchSize = bCount;
    proj.settings.tagMode = tMode;
    proj.settings.promptLang = promptSel.value;
    if (promptSel.value === 'custom') proj.settings.customPrompt = promptTa.value;
    await store.put('projects', proj);

    const b = await P.exportBatch(store, proj.id, {
      from: bFrom,
      count: bCount,
      onlyStatus: only.value,
      fmt: proj.settings.fmt || 'v25b',
      tagless: tMode === 'edge',
      stripAllTags: tMode === 'clean',
      fid: S.fid || undefined,
      folder: S.folder || undefined,
      promptLang: pLang,
      customPrompt: promptTa.value
    });
    lastRawBatch = b.rawText;
    if (b.lastGid) lastExportedEndGid = b.lastGid;
    out.value = b.text;
    info.textContent = b.count ? `${b.count} LINES · #${b.firstGid}–#${b.lastGid}` : 'NO MATCH';
    if (b.count && (await copyText(b.text))) {
      toast(pLang === 'none' ? `Copied ${b.count} script lines` : `Copied Prompt (${pLang.toUpperCase()}) + ${b.count} lines`);
    }
  };

  const inp = h('textarea', { rows: 9, placeholder: 'Paste translated lines from AI here (Markdown code blocks and headers are stripped automatically).' });
  const res = h('div');
  const undoBtn = () => h('button', { class: 'sm danger', onclick: async () => {
    const n = await P.undoApply(store, proj.id);
    markQcDirty();
    proj = await store.get('projects', proj.id);
    toast(`Reverted ${n} lines`);
    await refreshHeader();
    res.replaceChildren(h('div', { class: 'dim' }, `Reverted ${n} lines.`));
  } }, 'Undo Last Apply');

  const applyText = async (txtToApply) => {
    if (!txtToApply || !txtToApply.trim()) return toast('Paste translated lines first');
    const r = await P.applyBatch(store, proj.id, txtToApply);
    markQcDirty();
    proj = await store.get('projects', proj.id);
    await refreshHeader();
    const nextTodo = await P.firstEntry(store, proj.id, {
      fid: rfids && rfids.length === 1 ? rfids[0] : undefined,
      fids: rfids && rfids.length > 1 ? rfids : undefined,
      status: 'todo'
    });
    if (nextTodo) {
      S.batchFrom = nextTodo.gid;
      from.value = nextTodo.gid;
    }
    res.replaceChildren(
      h('div', { class: 'ok', style: 'margin-top:8px;font-weight:600' }, `${r.applied} lines applied` + (r.fixed ? ` (${r.fixed} tags auto-fixed)` : '') + (r.flagged ? ` · ${r.flagged} flagged` : '')),
      r.unknown.length ? h('div', { class: 'warn' }, `Unknown IDs: ${r.unknown.slice(0, 12).join(', ')}${r.unknown.length > 12 ? ' ...' : ''}`) : null,
      r.unreadable.length ? h('div', { class: 'warn' }, `${r.unreadable.length} unreadable lines`) : null
    );
    if (r.applied) { inp.value = ''; toast(`Applied ${r.applied} lines`); res.append(undoBtn()); }
  };

  v.append(
    h('div', { class: 'panel-card' },
      h('div', { class: 'panel-head' },
        h('b', {}, '01 // EXPORT BATCH TO AI'),
        info
      ),
      h('div', { class: 'form-grid' },
        h('div', { class: 'field' }, h('span', {}, 'Scope'), ...scopeCtrls),
        h('div', { class: 'field' }, h('span', {}, 'Status Filter'), only),
        h('div', { class: 'field' }, h('span', {}, 'From Line (#ID)'), from),
        h('div', { class: 'field' }, h('span', {}, 'Batch Size'), count),
        h('div', { class: 'field' }, h('span', {}, 'Prompt'), promptSel),
        h('div', { class: 'field' }, h('span', {}, 'Tag Mode'), tagModeSel)
      ),
      h('div', { class: 'row' },
        h('button', { class: 'pri', onclick: () => make(true, false) }, 'Generate & Copy'),
        h('button', { title: 'Advance From Line (#ID) to the next batch and copy immediately (for parallel multi-tab AI translation)', onclick: () => make(true, true) }, 'Next Batch & Copy >>'),
        h('button', { class: 'sm', onclick: async () => {
          if (!lastRawBatch) await make(false);
          else { out.value = lastRawBatch; if (await copyText(lastRawBatch)) toast('Copied script lines only'); }
        } }, 'Copy Script Only'),
        h('button', { class: 'sm', onclick: () => { promptBox.hidden = !promptBox.hidden; } }, 'View / Edit Prompt')
      ),
      out,
      promptBox
    ),
    h('div', { class: 'panel-card' },
      h('div', { class: 'panel-head' },
        h('b', {}, '02 // APPLY AI TRANSLATION'),
        proj.lastUndo ? h('span', { class: 'dim', style: 'font-family:var(--mono)' }, 'LAST: ' + new Date(proj.lastUndo.ts).toLocaleTimeString()) : null
      ),
      inp,
      h('div', { class: 'row', style: 'margin-top:10px;margin-bottom:0' },
        h('button', { class: 'pri', onclick: () => applyText(inp.value) }, 'Apply'),
        h('button', { onclick: async () => {
          try {
            const clip = await navigator.clipboard.readText();
            inp.value = clip;
            await applyText(clip);
          } catch (e) { toast('Clipboard permission denied — paste manually then click Apply'); }
        } }, 'Paste & Apply'),
        h('button', { class: 'sm', onclick: async () => {
          try { inp.value = await navigator.clipboard.readText(); toast('Pasted from clipboard'); } catch (e) { toast('Clipboard permission denied'); }
        } }, 'Paste'),
        proj.lastUndo ? undoBtn() : null
      ),
      res
    )
  );
}

// — Log Viewer Modal ——————————————————————————————————
function openLogModal(fileObj, preferExport = false) {
  const existing = $('#log-modal'); if (existing) existing.remove();
  let mode = (preferExport && fileObj.lastExportLog) ? 'export' : 'import';
  let levelFilter = '';

  const bg = h('div', { id: 'log-modal', class: 'modal-bg', onclick: e => { if (e.target === bg) bg.remove(); } });
  const modal = h('div', { class: 'modal' });
  const head = h('div', { class: 'modal-h' });
  const body = h('div', { class: 'modal-b' });

  const renderModal = () => {
    const activeLog = (mode === 'export' && fileObj.lastExportLog) ? fileObj.lastExportLog : (fileObj.importLog || { entries: [] });
    const entries = activeLog.entries || [];
    const status = summarizeLog(entries);
    const meta = { path: fileObj.path || fileObj.name, name: fileObj.name, kind: fileObj.kind, size: fileObj.size, entryCount: fileObj.entryCount, ...(activeLog.meta || {}) };

    head.replaceChildren(
      h('span', { class: 'dot ' + status }),
      h('b', {}, fileObj.path || fileObj.name),
      h('span', { class: 'badge' }, status.toUpperCase()),
      fileObj.lastExportLog ? h('button', { class: 'chip' + (mode === 'import' ? ' on' : ''), onclick: () => { mode = 'import'; renderModal(); } }, 'Import Log') : null,
      fileObj.lastExportLog ? h('button', { class: 'chip' + (mode === 'export' ? ' on' : ''), onclick: () => { mode = 'export'; renderModal(); } }, 'Repack Log') : null,
      h('span', { style: 'margin-left:auto' }),
      [['', 'All'], ['info', 'Info'], ['warn', 'Warn'], ['error', 'Error']].map(([lv, lb]) =>
        h('button', { class: 'chip' + (levelFilter === lv ? ' on' : ''), onclick: () => { levelFilter = lv; renderModal(); } }, lb)
      ),
      h('button', { class: 'sm', onclick: async () => {
        const txt = formatLog(activeLog, meta);
        toast((await copyText(txt)) ? 'Log copied' : 'Copy failed');
      } }, 'Copy Log'),
      h('button', { class: 'sm pri', onclick: () => {
        const txt = formatLog(activeLog, meta);
        download((fileObj.name || 'scn') + '.log.txt', new TextEncoder().encode(txt), 'text/plain;charset=utf-8');
      } }, 'Download (.txt)'),
      h('button', { class: 'sm danger', onclick: () => bg.remove() }, 'Close')
    );

    body.replaceChildren();
    const filtered = levelFilter ? entries.filter(e => e.level === levelFilter) : entries;
    if (!filtered.length) {
      body.append(h('p', { class: 'dim' }, 'No log entries for this filter.'));
      return;
    }
    const groups = [];
    const byStep = new Map();
    for (const e of filtered) {
      const st = e.step || 'scn';
      if (!byStep.has(st)) {
        const g = { step: st, items: [] };
        byStep.set(st, g);
        groups.push(g);
      }
      byStep.get(st).items.push(e);
    }
    for (const g of groups) {
      const stepStatus = summarizeLog(g.items);
      const det = h('details', { class: 'log-step', open: true },
        h('summary', {}, h('span', { class: 'dot ' + stepStatus }), `[${g.step}] (${g.items.length})`)
      );
      for (const item of g.items) {
        const cls = item.level === 'error' ? 'err' : item.level === 'warn' ? 'warn' : '';
        const dataText = item.data ? '\n  ' + Object.entries(item.data).map(([k, val]) => `${k}=${typeof val === 'string' ? val : JSON.stringify(val)}`).join(' · ') : '';
        det.append(h('div', { class: 'log-line ' + cls }, `[+${Number(item.t || 0).toFixed(2)}ms] [${String(item.level).toUpperCase()}] ${item.msg}${dataText}`));
      }
      body.append(det);
    }
  };

  renderModal();
  modal.append(head, body);
  bg.append(modal);
  document.body.append(bg);
}

// — 05 ARCHIVE (Files & Folder Workflow) ————————————————
const repackOpts = () => ({
  textOut: 'keep',
  wrapSep: proj.settings.wrapSep || 'auto',
  wrapSepCustom: proj.settings.wrapSepCustom || '',
  rt2AsSpace: (proj.settings.wrapSep === 'rt2') || !!proj.settings.rt2AsSpace
});

async function collectDroppedItems(dataTransfer) {
  if (dataTransfer.items && dataTransfer.items.length) {
    const entries = [];
    for (let i = 0; i < dataTransfer.items.length; i++) {
      const it = dataTransfer.items[i];
      if (it.webkitGetAsEntry) {
        const en = it.webkitGetAsEntry();
        if (en) entries.push(en);
      }
    }
    if (entries.some(e => e.isDirectory)) {
      const out = [];
      async function walkEntry(ent, prefix) {
        if (ent.isFile) {
          const file = await new Promise((res, rej) => ent.file(res, rej));
          const relPath = prefix ? `${prefix}/${file.name}` : file.name;
          out.push({ name: file.name, path: relPath, file });
        } else if (ent.isDirectory) {
          const reader = ent.createReader();
          const subPrefix = prefix ? `${prefix}/${ent.name}` : ent.name;
          while (true) {
            const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
            if (!batch || !batch.length) break;
            for (const child of batch) await walkEntry(child, subPrefix);
          }
        }
      }
      const singleRootDir = entries.length === 1 && entries[0].isDirectory;
      for (const ent of entries) {
        await walkEntry(ent, singleRootDir ? '' : '');
      }
      return { items: out, isFolder: true };
    }
  }
  const files = [...(dataTransfer.files || [])];
  const hasRel = files.some(f => f.webkitRelativePath && f.webkitRelativePath.includes('/'));
  return {
    items: files.map(f => ({
      name: f.name,
      path: f.webkitRelativePath ? stripTopFolder(f.webkitRelativePath) : f.name,
      file: f
    })),
    isFolder: hasRel
  };
}

function stripTopFolder(relPath) {
  const norm = P.normPath(relPath);
  const slash = norm.indexOf('/');
  return slash >= 0 ? norm.slice(slash + 1) : norm;
}

async function addSingleOrMultiFiles(fileList, opts) {
  const existingFiles = await P.listFiles(store, proj.id);
  const existingByPath = new Map(existingFiles.map(x => [P.normPath(x.path || x.name), x]));
  let n = 0;
  for (const f of fileList) {
    try {
      const rel = P.normPath(f.webkitRelativePath ? stripTopFolder(f.webkitRelativePath) : (f.path || f.name));
      const buf = f.file ? await f.file.arrayBuffer() : await f.arrayBuffer();
      const ex = existingByPath.get(rel);
      if (ex) {
        const r = await P.updateFileSource(store, ex.id, new Uint8Array(buf), opts);
        n += r.count;
        toast(`${f.name}: updated (${r.count} lines, ${r.kept} kept)`);
      } else {
        const r = await P.addFile(store, proj.id, f.name, new Uint8Array(buf), { ...opts, path: rel });
        n += r.count;
        toast(`${f.name}: ${r.count} lines` + (r.skipped.length ? ` (-${r.skipped.length} noise)` : ''));
      }
    } catch (e) { toast(`${f.name}: ${e.message}`); console.error(e); }
  }
  markQcDirty();
  proj = await P.ensureMigrated(store, proj.id);
  if (n && fileList.length === 1) S.tab = 'edit';
  await render();
}

async function runFolderBatchUI(rawItems, opts, progHolder) {
  const ac = new AbortController();
  progHolder.replaceChildren();
  const barInner = h('i', { style: 'width:0%' });
  const label = h('span', { class: 'dim' }, 'Preparing folder files...');
  const cancelBtn = h('button', { class: 'sm danger', onclick: () => ac.abort() }, 'Cancel');
  const box = h('div', { class: 'prog-box' },
    h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:6px' }, label, cancelBtn),
    h('div', { class: 'meter', style: 'width:100%' }, barInner)
  );
  progHolder.append(box);

  const summary = await P.importFolderBatch(store, proj.id, rawItems, {
    ...opts,
    txtHint: 'auto',
    onDuplicate: 'update',
    signal: ac.signal,
    onProgress: ({ index, total, path }) => {
      const pct = total ? Math.round((index / total) * 100) : 0;
      barInner.style.width = pct + '%';
      label.textContent = `${opts.dryRun ? '[Dry-Run] ' : ''}${index}/${total} · ${path}`;
    }
  });
  S.lastSummary = summary;
  markQcDirty();
  proj = await P.ensureMigrated(store, proj.id);
  await render();
}

async function writeFilesToDirectory(filesToExport, progHolder) {
  if (typeof window.showDirectoryPicker !== 'function') {
    toast('File System Access API not supported in this browser — use Download All (.zip)');
    return;
  }
  let dirHandle = null;
  try {
    const saved = await store.get('handles', proj.id);
    if (saved && saved.dirHandle) {
      const perm = await saved.dirHandle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') dirHandle = saved.dirHandle;
    }
  } catch (e) { /* ignore */ }
  if (!dirHandle) {
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
      await store.put('handles', { id: proj.id, dirHandle, updatedAt: Date.now() });
    } catch (e) { return; }
  }
  if (!S.writeSubfolder) {
    if (!confirm('Write directly to the selected folder without an "output/" subfolder? Existing files with the same name will be overwritten.')) return;
  }
  let rootTarget = dirHandle;
  if (S.writeSubfolder) {
    rootTarget = await dirHandle.getDirectoryHandle('output', { create: true });
  }
  const ac = new AbortController();
  const label = h('span', { class: 'dim' }, 'Writing files...');
  const cancelBtn = h('button', { class: 'sm danger', onclick: () => ac.abort() }, 'Cancel');
  progHolder.replaceChildren(h('div', { class: 'prog-box row', style: 'justify-content:space-between' }, label, cancelBtn));

  let written = 0, verifyFails = 0;
  for (let i = 0; i < filesToExport.length; i++) {
    if (ac.signal.aborted) break;
    const f = filesToExport[i];
    label.textContent = `Writing ${i + 1}/${filesToExport.length} · ${f.path || f.name}`;
    await new Promise(r => setTimeout(r, 0));
    const r = await P.repackFile(store, f.id, repackOpts());
    if (r.verifyOk === false) { verifyFails++; continue; }
    const parts = P.normPath(r.path || r.name).split('/');
    let curDir = rootTarget;
    for (let d = 0; d < parts.length - 1; d++) {
      curDir = await curDir.getDirectoryHandle(parts[d], { create: true });
    }
    const fh = await curDir.getFileHandle(parts[parts.length - 1], { create: true });
    const writable = await fh.createWritable();
    await writable.write(r.bytes);
    await writable.close();
    written++;
  }
  progHolder.replaceChildren();
  toast(`${written} files written to ${S.writeSubfolder ? 'output/' : 'folder'}` + (verifyFails ? ` (${verifyFails} failed verification skipped)` : ''));
  await render();
}

async function exportFilesAsZip(targetFiles, zipName, progHolder) {
  if (!targetFiles.length) return toast('No files to export');
  const writer = createZipWriter();
  const verifyWarnFiles = [];
  if (progHolder && targetFiles.length > 5) {
    const label = h('span', { class: 'dim' }, 'Building ZIP...');
    progHolder.replaceChildren(h('div', { class: 'prog-box' }, label));
    for (let i = 0; i < targetFiles.length; i++) {
      const f = targetFiles[i];
      label.textContent = `Repacking ${i + 1}/${targetFiles.length} · ${f.path || f.name}`;
      if (i % 5 === 0) await new Promise(r => setTimeout(r, 0));
      const r = await P.repackFile(store, f.id, repackOpts());
      if (r.verifyOk === false) verifyWarnFiles.push(f.path || f.name);
      writer.add(r.path || r.name, r.bytes);
    }
    progHolder.replaceChildren();
  } else {
    for (const f of targetFiles) {
      const r = await P.repackFile(store, f.id, repackOpts());
      if (r.verifyOk === false) verifyWarnFiles.push(f.path || f.name);
      writer.add(r.path || r.name, r.bytes);
    }
  }
  download(zipName, writer.toBlob(), 'application/zip');
  if (verifyWarnFiles.length) {
    toast(`Warning: ${verifyWarnFiles.length} files failed self-verification`);
  } else {
    toast(`Exported ${targetFiles.length} files (.zip)`);
  }
}

async function renderFiles(v) {
  const flt = h('input', { type: 'checkbox', checked: S.vntpFilter, onchange: () => { S.vntpFilter = flt.checked; } });
  const progHolder = h('div');

  const input = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => {
    const list = [...input.files]; input.value = '';
    if (!list.length) return;
    addSingleOrMultiFiles(list, { txtHint: 'auto', vntpFilter: flt.checked });
  } });

  const dirInput = h('input', { type: 'file', webkitdirectory: true, multiple: true, hidden: true, onchange: () => {
    const list = [...dirInput.files].map(f => ({
      name: f.name,
      path: f.webkitRelativePath ? stripTopFolder(f.webkitRelativePath) : f.name,
      file: f
    }));
    dirInput.value = '';
    if (!list.length) return;
    runFolderBatchUI(list, { vntpFilter: flt.checked, dryRun: false }, progHolder);
  } });

  const dryDirInput = h('input', { type: 'file', webkitdirectory: true, multiple: true, hidden: true, onchange: () => {
    const list = [...dryDirInput.files].map(f => ({
      name: f.name,
      path: f.webkitRelativePath ? stripTopFolder(f.webkitRelativePath) : f.name,
      file: f
    }));
    dryDirInput.value = '';
    if (!list.length) return;
    runFolderBatchUI(list, { vntpFilter: flt.checked, dryRun: true }, progHolder);
  } });

  const drop = h('label', { class: 'drop' }, input,
    h('div', {}, h('b', {}, 'Drop script files or a folder here'), ' or click to browse'),
    h('div', { class: 'dim' }, '.ks · .txt (auto Kirikiri / Artemis) · .ast · .scn · VNTP .json')
  );
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async e => {
    e.preventDefault(); drop.classList.remove('over');
    const { items, isFolder } = await collectDroppedItems(e.dataTransfer);
    if (!items.length) return;
    if (isFolder || items.length > 3) {
      await runFolderBatchUI(items, { vntpFilter: flt.checked, dryRun: false }, progHolder);
    } else {
      await addSingleOrMultiFiles(items, { txtHint: 'auto', vntpFilter: flt.checked });
    }
  });

  v.append(
    drop,
    h('div', { class: 'row' },
      h('button', { class: 'pri', onclick: () => dirInput.click() }, 'Select Folder'),
      h('button', { onclick: () => input.click() }, 'Add Files'),
      h('button', { onclick: () => dryDirInput.click(), title: 'Test all files in a folder and view logs without saving' }, 'Dry-Run Folder'),
      h('label', { class: 'pill-chk', style: 'margin-left:auto', title: 'For VNTP .json files: skip repeated chapter/bookmark labels (3+ occurrences)' }, flt, 'Filter repeated bookmarks (VNTP .json)'),
      dirInput, dryDirInput
    ),
    progHolder
  );

  if (S.lastSummary) {
    const sm = S.lastSummary;
    const firstProb = (sm.results || []).find(r => r.log && (r.status === 'error' || r.status === 'warn' || r.entryCount === 0));
    v.append(h('div', { class: 'prog-box' },
      h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:4px' },
        h('b', {}, sm.dryRun ? 'Folder Dry-Run Summary (Not Saved)' : 'Folder Import Summary'),
        h('div', { class: 'row', style: 'margin:0' },
          firstProb ? h('button', { class: 'sm', onclick: () => openLogModal({ name: firstProb.name, path: firstProb.path, kind: firstProb.kind || 'scn', entryCount: firstProb.entryCount, importLog: firstProb.log }) }, 'View First Flagged Log') : null,
          h('button', { class: 'sm pri', onclick: () => {
            const txt = P.formatFolderSummary(sm, proj.name);
            download((proj.name.replace(/[^\w.-]+/g, '_') || 'kopipe') + '_folder_summary.txt', new TextEncoder().encode(txt), 'text/plain;charset=utf-8');
          } }, 'Download Summary (.txt)'),
          h('button', { class: 'sm', onclick: () => { S.lastSummary = null; render(); } }, 'Close')
        )
      ),
      h('div', { class: 'dim' },
        `${sm.importedFiles} new · ${sm.updatedFiles} updated · ${sm.totalEntries} lines · `,
        h('span', { class: 'ok' }, `${sm.okCount} OK`), ' · ',
        h('span', { class: 'warn' }, `${sm.warnCount} warnings (${sm.zeroEntryFiles.length} empty)`), ' · ',
        h('span', { class: 'err' }, `${sm.errorCount} failed`),
        sm.skippedNonScript ? ` · ${sm.skippedNonScript} non-script skipped` : '',
        sm.skippedNonVntpJson && sm.skippedNonVntpJson.length ? ` · ${sm.skippedNonVntpJson.length} non-VNTP JSON skipped` : ''
      )
    ));
  }

  const files = await P.listFiles(store, proj.id);
  if (!files.length) return;

  const filterInput = h('input', { class: 'grow', placeholder: 'Filter files or folder paths...', value: S.fileFilter });
  const tableHolder = h('div');

  const renderFileTree = () => {
    const fltStr = S.fileFilter.trim().toLowerCase();
    const shownFiles = fltStr ? files.filter(f => (f.path || f.name).toLowerCase().includes(fltStr)) : files;
    const tbody = h('tbody');

    const groups = new Map();
    for (const f of shownFiles) {
      const dir = P.dirName(f.path || f.name) || '';
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push(f);
    }
    const hasFolders = [...groups.keys()].some(Boolean);
    if (hasFolders && files.length > 30 && !S._dirsInit) {
      S._dirsInit = true;
      const dKeys = [...groups.keys()].filter(Boolean);
      for (let i = 1; i < dKeys.length; i++) S.collapsedDirs.add(dKeys[i]);
    }

    for (const [dir, gFiles] of groups) {
      if (hasFolders && dir) {
        const isCollapsed = S.collapsedDirs.has(dir);
        let dirDone = 0, dirTotal = 0;
        for (const f of gFiles) {
          const fs = f.stats || { total: f.entryCount || 0, todo: f.entryCount || 0 };
          dirTotal += fs.total || 0;
          dirDone += (fs.total || 0) - (fs.todo || 0);
        }
        tbody.append(h('tr', { class: 'folder-hdr', onclick: () => {
          if (S.collapsedDirs.has(dir)) S.collapsedDirs.delete(dir);
          else S.collapsedDirs.add(dir);
          renderFileTree();
        } },
          h('td', {}, `${isCollapsed ? '+' : '−'} ${dir}/`, h('span', { class: 'dim', style: 'font-weight:normal;margin-left:8px' }, `${gFiles.length} files · ${dirDone}/${dirTotal} translated`)),
          h('td', { style: 'text-align:right;white-space:nowrap', onclick: e => e.stopPropagation() },
            h('button', { class: 'sm', onclick: () => { applyScope('dir:' + dir); S.page = 1; S.tab = 'edit'; render(); } }, 'Open in Backlog'), ' ',
            h('button', { class: 'sm', onclick: () => exportFilesAsZip(gFiles, `${dir.replace(/[^\w.-]+/g, '_')}_repack.zip`, progHolder) }, 'ZIP Folder')
          )
        ));
        if (isCollapsed) continue;
      }

      for (const f of gFiles) {
        const fs = f.stats || { total: f.entryCount || 0, todo: f.entryCount || 0 };
        const tr = Math.max(0, (fs.total || 0) - (fs.todo || 0));
        const dotStatus = f.exportStatus === 'error' || f.logStatus === 'error' ? 'error'
          : (f.exportStatus === 'warn' || f.logStatus === 'warn' || (f.kind === 'scn' && fs.total === 0)) ? 'warn' : 'ok';

        tbody.append(h('tr', {},
          h('td', { style: hasFolders && dir ? 'padding-left:24px' : '' },
            h('span', { class: 'dot ' + dotStatus, title: `Log status: ${dotStatus.toUpperCase()}` }),
            h('b', {}, f.name),
            f.path && f.path !== f.name ? h('span', { class: 'dim', style: 'margin-left:6px' }, f.path) : null,
            h('div', { class: 'dim' }, `${KIND_LABEL[f.kind] || f.kind} · ${tr}/${f.entryCount} translated` + (f.meta && f.meta.strategy ? ` · ${f.meta.strategy}` : ''))
          ),
          h('td', { style: 'text-align:right;white-space:nowrap' },
            h('button', { class: 'sm', onclick: async () => {
              const fullFile = await store.get('files', f.id);
              openLogModal(fullFile || f, false);
            } }, 'Log'), ' ',
            h('button', { class: 'sm', onclick: async () => {
              try {
                const r = await P.repackFile(store, f.id, repackOpts());
                if (r.verifyOk === false) {
                  toast('Repack failed verification — check log');
                  const fullFile = await store.get('files', f.id);
                  openLogModal(fullFile || f, true);
                  return;
                }
                download(r.name, r.bytes);
                toast(`${r.name}: ${r.translated} lines`);
                renderFileTree();
              } catch (e) { toast('Failed: ' + e.message); console.error(e); }
            } }, 'Repack'), ' ',
            h('button', { class: 'sm danger', onclick: async () => {
              if (confirm(`Remove ${f.path || f.name} and its translations?`)) {
                await P.removeFile(store, f.id);
                markQcDirty();
                proj = await P.ensureMigrated(store, proj.id);
                await render();
              }
            } }, 'Delete')
          )
        ));
      }
    }
    tableHolder.replaceChildren(h('table', {}, tbody));
  };

  filterInput.addEventListener('input', () => { S.fileFilter = filterInput.value; renderFileTree(); });
  renderFileTree();

  const onlyTransChk = h('input', { type: 'checkbox', checked: S.onlyTranslatedZip, onchange: () => { S.onlyTranslatedZip = onlyTransChk.checked; } });
  const subChk = h('input', { type: 'checkbox', checked: S.writeSubfolder, onchange: () => { S.writeSubfolder = subChk.checked; } });
  const hasFsApi = typeof window.showDirectoryPicker === 'function';

  const getExportTargets = () => S.onlyTranslatedZip
    ? files.filter(f => f.stats && (f.stats.total - f.stats.todo) > 0)
    : files;

  v.append(
    h('div', { class: 'panel-card', style: 'padding:10px 12px;margin-bottom:10px' },
      h('div', { class: 'row', style: 'margin-bottom:0' },
        h('button', { class: 'pri', onclick: () => exportFilesAsZip(getExportTargets(), (proj.name.replace(/[^\w.-]+/g, '_') || 'kopipe') + '_repack.zip', progHolder) }, 'Download All (.zip)'),
        h('button', {
          disabled: !hasFsApi,
          title: hasFsApi ? 'Write repacked files directly to disk folder' : 'Browser does not support File System Access API; use Download All (.zip)',
          onclick: () => writeFilesToDirectory(getExportTargets(), progHolder)
        }, 'Write to Folder'),
        h('button', { onclick: async () => {
          const t = await P.exportTranslations(store, proj.id);
          if (!t) return toast('No translations yet');
          download((proj.name.replace(/[^\w.-]+/g, '_') || 'kopipe') + '_translations.txt', new TextEncoder().encode(t), 'text/plain');
        } }, 'Export Translations (.txt)'),
        h('button', {
          title: 'Re-extract all already-uploaded files with the latest parser (e.g. to pull new SCN choices) without re-uploading or losing translations',
          onclick: async () => {
            if (!files.length) return toast('No files to re-parse');
            const bar = h('div', { class: 'prog-fill' });
            const lbl = h('span', {}, 'Re-parsing stored files...');
            progHolder.replaceChildren(h('div', { class: 'prog-box' }, lbl, h('div', { class: 'prog-bar' }, bar)));
            try {
              const r = await P.reparseStoredFiles(store, proj.id, {
                onProgress: p => {
                  lbl.textContent = `Re-parsing (${p.index}/${p.total}): ${p.name}`;
                  bar.style.width = `${Math.round((p.index / p.total) * 100)}%`;
                }
              });
              markQcDirty();
              proj = await P.ensureMigrated(store, proj.id);
              toast(`Re-parsed ${r.updatedFiles} files (+${r.addedLines} new choice/lines, ${r.keptLines} translations kept)`);
              await render();
            } catch (err) {
              toast('Re-parse failed: ' + err.message);
            }
          }
        }, 'Re-parse All Files'),
        h('label', { class: 'pill-chk', style: 'margin-left:auto' }, onlyTransChk, 'Translated files only'),
        hasFsApi ? h('label', { class: 'pill-chk' }, subChk, 'Write to output/') : null,
        h('button', {
          class: 'danger sm',
          title: 'Delete all script files and their translations from this project',
          onclick: async () => {
            if (!files.length) return toast('No files to delete');
            if (confirm(`Warning: Delete all ${files.length} script files and their translations from project "${proj.name}"?\n\nThis action cannot be undone.`)) {
              await P.removeAllFiles(store, proj.id);
              markQcDirty();
              proj = await P.ensureMigrated(store, proj.id);
              toast(`All ${files.length} files deleted`);
              await render();
            }
          }
        }, 'Delete All Files')
      )
    ),
    files.length > 4 ? h('div', { class: 'row' }, filterInput) : null,
    tableHolder
  );
}

async function storageInfo(p) {
  const parts = [];
  parts.push(p.settings.lastBackup ? 'Last backup: ' + new Date(p.settings.lastBackup).toLocaleString() : 'Never backed up');
  try {
    if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); parts.push(`Storage: ${(e.usage / 1048576).toFixed(1)} MB used`); }
    if (navigator.storage && navigator.storage.persisted) parts.push((await navigator.storage.persisted()) ? 'Persistent storage: yes' : 'Persistent storage: no');
  } catch (e) { /* ignore */ }
  return parts.join(' · ');
}

// — 06 CONFIG (VN System Config Screen with Auto-Save & Themes) ————————————
async function renderSettings(v) {
  const s = proj.settings, name = h('input', { value: proj.name, style: 'width:240px' });
  const wrap = h('input', { type: 'number', min: 0, value: s.wrapWidth || 0, style: 'width:110px' });
  const bs = h('input', { type: 'number', min: 1, value: s.batchSize || 100, style: 'width:110px' });
  let curWrapSep = s.wrapSep || (s.rt2AsSpace ? 'rt2' : 'auto');
  let curQm = s.quoteMode || 'keep';

  const wrapCustom = h('input', {
    placeholder: 'Custom separator (e.g. [n], <br>, %r;)',
    value: s.wrapSepCustom || '',
    style: (curWrapSep === 'custom' ? 'width:220px;display:inline-block' : 'display:none')
  });

  const save = async (silent = false) => {
    proj.name = name.value.trim() || proj.name;
    Object.assign(proj.settings, {
      wrapWidth: +wrap.value || 0,
      wrapSep: curWrapSep,
      wrapSepCustom: wrapCustom.value,
      rt2AsSpace: curWrapSep === 'rt2',
      batchSize: Math.max(1, +bs.value || 100),
      textOut: 'keep',
      quoteMode: curQm,
      maxLen: 0
    });
    await store.put('projects', proj);
    await refreshHeader();
    if (!silent) toast('System config saved');
  };

  name.onchange = () => save();
  wrap.onchange = () => save();
  bs.onchange = () => save();
  wrapCustom.onchange = () => save();

  const themeGroup = h('div', { class: 'opt-group' });
  const paintThemes = () => {
    themeGroup.replaceChildren(
      ...[['obsidian', 'Obsidian Gold'], ['navy', 'VN Navy Glass'], ['crimson', 'Crimson Night']].map(([k, lbl]) =>
        h('button', {
          class: 'chip' + (S.theme === k ? ' on' : ''),
          onclick: () => { applyTheme(k); paintThemes(); toast(`Theme: ${lbl}`); }
        }, lbl)
      )
    );
  };
  paintThemes();

  const sepGroup = h('div', { class: 'opt-group' });
  const paintSeps = () => {
    sepGroup.replaceChildren(
      ...[
        ['auto', 'Auto (Engine Default)'],
        ['lf', '\\n (LF)'],
        ['crlf', '\\r\\n (CRLF)'],
        ['[r]', '[r] (Kirikiri)'],
        ['rt2', '{"rt2"} (Artemis .ast)'],
        ['custom', 'Custom']
      ].map(([k, lbl]) =>
        h('button', {
          class: 'chip' + (curWrapSep === k ? ' on' : ''),
          onclick: () => {
            curWrapSep = k;
            wrapCustom.style.display = k === 'custom' ? 'inline-block' : 'none';
            paintSeps();
            save();
          }
        }, lbl)
      )
    );
  };
  paintSeps();

  const qmGroup = h('div', { class: 'opt-group' });
  const paintQm = () => {
    qmGroup.replaceChildren(
      ...[
        ['keep', 'Keep 「 」 『 』'],
        ['ascii', 'ASCII " " / \' \''],
        ['curly', 'Curly “ ” / ‘ ’']
      ].map(([k, lbl]) =>
        h('button', {
          class: 'chip' + (curQm === k ? ' on' : ''),
          onclick: () => { curQm = k; paintQm(); save(); }
        }, lbl)
      )
    );
  };
  paintQm();

  const stor = h('div', { class: 'dim', style: 'font-family:var(--mono);margin-top:8px' }, '...');
  storageInfo(proj).then(t => { stor.textContent = t; });

  v.append(
    h('div', { class: 'panel-card' },
      h('div', { class: 'panel-head' }, h('b', {}, 'SYSTEM // ENVIRONMENT & REPACK CONFIG')),
      h('div', { class: 'cfg-row' },
        h('div', {}, h('div', { class: 'cfg-lbl' }, 'Interface Theme'), h('div', { class: 'cfg-sub' }, 'Visual Novel system color scheme')),
        themeGroup
      ),
      (() => {
        let bgMode = lsGet('kopipe.bgMode') || 'default';
        const bgGroup = h('div', { class: 'opt-group' });
        const bgInp = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: () => {
          const f = bgInp.files && bgInp.files[0];
          if (!f) return;
          const reader = new FileReader();
          reader.onload = () => {
            lsSet('kopipe.bgCustom', String(reader.result || ''));
            lsSet('kopipe.bgMode', 'custom');
            bgMode = 'custom';
            applyBgConfig();
            paintBg();
            toast('Full-screen wallpaper applied!');
          };
          reader.readAsDataURL(f);
        } });
        let stageH = lsGet('kopipe.stageH') || '280px';
        let bgPos = lsGet('kopipe.bgPos') || '22%';
        const dimSlider = h('input', {
          type: 'range', min: '0.20', max: '0.92', step: '0.03',
          value: lsGet('kopipe.bgDim') || '0.72',
          title: 'Wallpaper Dim / Darkness',
          style: 'width:105px;padding:0',
          oninput: () => { lsSet('kopipe.bgDim', dimSlider.value); applyBgConfig(); }
        });
        const blurSlider = h('input', {
          type: 'range', min: '0', max: '14', step: '1',
          value: parseInt(lsGet('kopipe.bgBlur') || '0', 10),
          title: 'Wallpaper Blur',
          style: 'width:90px;padding:0',
          oninput: () => { lsSet('kopipe.bgBlur', blurSlider.value + 'px'); applyBgConfig(); }
        });
        const paintBg = () => {
          bgGroup.replaceChildren(
            h('button', { class: 'chip' + (bgMode === 'default' ? ' on' : ''), onclick: () => { bgMode = 'default'; lsSet('kopipe.bgMode', 'default'); applyBgConfig(); paintBg(); toast('Default anime wallpaper applied'); } }, 'Default Anime Scene'),
            h('button', { class: 'chip' + (bgMode === 'custom' ? ' on' : ''), onclick: () => bgInp.click() }, 'Upload Custom Wallpaper / CG...'),
            h('button', { class: 'chip' + (bgMode === 'none' ? ' on' : ''), onclick: () => { bgMode = 'none'; lsSet('kopipe.bgMode', 'none'); applyBgConfig(); paintBg(); toast('Wallpaper disabled'); } }, 'Solid Background (Off)'),
            bgInp
          );
        };
        paintBg();
        const hGroup = h('div', { class: 'opt-group' });
        const paintH = () => {
          hGroup.replaceChildren(
            ...[['190px', 'Compact (190px)'], ['280px', 'Normal (280px)'], ['380px', 'Theater (380px)']].map(([v, lbl]) =>
              h('button', { class: 'chip' + (stageH === v ? ' on' : ''), onclick: () => { stageH = v; lsSet('kopipe.stageH', v); applyBgConfig(); paintH(); } }, lbl)
            )
          );
        };
        paintH();
        const posGroup = h('div', { class: 'opt-group' });
        const paintPos = () => {
          posGroup.replaceChildren(
            ...[['12%', 'Top Focus'], ['28%', 'Center Focus'], ['55%', 'Bottom Focus']].map(([v, lbl]) =>
              h('button', { class: 'chip' + (bgPos === v ? ' on' : ''), onclick: () => { bgPos = v; lsSet('kopipe.bgPos', v); applyBgConfig(); paintPos(); } }, lbl)
            )
          );
        };
        paintPos();
        return [
          h('div', { class: 'cfg-row' },
            h('div', {}, h('div', { class: 'cfg-lbl' }, 'Full-Screen VN Wallpaper'), h('div', { class: 'cfg-sub' }, 'Artwork displayed across the entire app background')),
            bgGroup
          ),
          h('div', { class: 'cfg-row' },
            h('div', {}, h('div', { class: 'cfg-lbl' }, 'Wallpaper Dimming & Blur'), h('div', { class: 'cfg-sub' }, 'Adjust darkness (left) and softness/blur (right) so backlog text is always readable')),
            h('div', { class: 'row', style: 'margin:0;gap:12px' },
              h('div', { class: 'row', style: 'margin:0;gap:6px' }, h('span', { class: 'dim' }, 'Darkness:'), dimSlider),
              h('div', { class: 'row', style: 'margin:0;gap:6px' }, h('span', { class: 'dim' }, 'Blur:'), blurSlider)
            )
          ),
          h('div', { class: 'cfg-row' },
            h('div', {}, h('div', { class: 'cfg-lbl' }, 'Wallpaper Vertical Alignment'), h('div', { class: 'cfg-sub' }, 'Align image vertically so character face or scene focus stays centered')),
            posGroup
          ),
          h('div', { class: 'cfg-row' },
            h('div', {}, h('div', { class: 'cfg-lbl' }, 'VN Box Preview Stage Height'), h('div', { class: 'cfg-sub' }, 'Height of the simulation stage when [VN Box Preview] checkbox is enabled')),
            hGroup
          )
        ];
      })(),
      h('div', { class: 'cfg-row' },
        h('div', {}, h('div', { class: 'cfg-lbl' }, 'Project Title'), h('div', { class: 'cfg-sub' }, 'Displayed in scene header and exported archives')),
        name
      ),
      h('div', { class: 'cfg-row' },
        h('div', {}, h('div', { class: 'cfg-lbl' }, 'Default Batch Size'), h('div', { class: 'cfg-sub' }, 'Number of lines exported per batch in 02 BATCH and 03 QC')),
        bs
      ),
      h('div', { class: 'cfg-row' },
        h('div', {}, h('div', { class: 'cfg-lbl' }, 'Message Box Wrap Width'), h('div', { class: 'cfg-sub' }, 'Characters per line on repack & live preview (0 = disabled)')),
        wrap
      ),
      h('div', { class: 'cfg-row' },
        h('div', {}, h('div', { class: 'cfg-lbl' }, 'Multiline Break Mode'), h('div', { class: 'cfg-sub' }, 'Line break code inserted on automatic wrap (.ast uses standard repack unless {"rt2"} is selected)')),
        h('div', { class: 'row', style: 'margin:0' }, sepGroup, wrapCustom)
      ),
      h('div', { class: 'cfg-row' },
        h('div', {}, h('div', { class: 'cfg-lbl' }, 'Dialogue Quote Style'), h('div', { class: 'cfg-sub' }, 'Converted at repack time; stored translations remain untouched')),
        qmGroup
      ),
      h('div', { class: 'row', style: 'margin-top:12px;margin-bottom:0' },
        h('button', { class: 'pri', onclick: () => save(false) }, 'Save Settings')
      )
    ),
    h('div', { class: 'panel-card' },
      h('div', { class: 'panel-head' }, h('b', {}, 'SYSTEM // DATA BACKUP & MAINTENANCE')),
      h('p', { class: 'dim', style: 'margin-top:0' }, 'All project data is stored locally in this browser. Export backups regularly.'),
      h('div', { class: 'row' },
        h('button', { onclick: async () => { const b = await exportProject(store, proj.id); download((proj.name.replace(/[^\w.-]+/g, '_') || 'kopipe') + '_' + new Date().toISOString().slice(0, 10) + '.kopipe.gz', b, 'application/gzip'); proj.settings.lastBackup = Date.now(); await store.put('projects', proj); toast('Backup downloaded'); stor.textContent = await storageInfo(proj); } }, 'Backup Project (.kopipe.gz)'),
        h('button', { onclick: async () => {
          if (!swReg) return toast('Service Worker not active in this session');
          toast('Checking for updates...');
          try {
            await swReg.update();
            if (swReg.waiting) {
              toast('New version found, reloading...');
              swReg.waiting.postMessage('SKIP_WAITING');
              setTimeout(() => location.reload(), 500);
            } else {
              toast('Already on the latest version (KOPIPE v1.0.0)');
            }
          } catch (e) { toast('Update check failed'); }
        } }, 'Check for Updates'),
        h('button', { class: 'danger', style: 'margin-left:auto', onclick: async () => { if (confirm(`Delete project "${proj.name}" and all its data?`)) { await P.deleteProject(store, proj.id); await openProject(null); } } }, 'Delete Project')
      ),
      stor
    )
  );
}

// — 03 QC (Translation Polish Batch + Cached Issue Scanner) ————————
async function renderQc(v) {
  if (qcAbort) qcAbort.abort();
  const ac = new AbortController();
  qcAbort = ac;

  const files = await P.listFiles(store, proj.id);
  const scopeCtrls = buildScopePicker(files, () => { S.qcPage = 1; render(); });

  const savedBatchSize = proj.settings.batchSize || 100;
  const targetSel = h('select', { onchange: () => { S.qcTargetMode = targetSel.value; } }, [
    ['polish', 'All Translated Lines (Polish & Edit)'],
    ['draft', 'Draft Lines Only'],
    ['done', 'Done Lines Only'],
    ['issues', 'Flagged QC Issues Only']
  ].map(([k, l]) => h('option', { value: k, selected: S.qcTargetMode === k }, l)));

  const qcFromInp = h('input', {
    type: 'number',
    min: 1,
    value: S.qcFrom || 1,
    onchange: () => { S.qcFrom = Math.max(1, +qcFromInp.value || 1); }
  });
  const qcCountInp = h('input', {
    type: 'number',
    min: 1,
    max: 5000,
    value: savedBatchSize,
    onchange: () => {
      const val = Math.max(1, +qcCountInp.value || 100);
      proj.settings.batchSize = val;
      store.put('projects', proj);
    }
  });

  const curQcLang = proj.settings.qcPromptLang || 'en';
  const qcLangSel = h('select', {}, [
    ['en', 'English Polish Prompt'],
    ['id', 'Indonesian Polish Prompt'],
    ['custom', 'Custom Prompt']
  ].map(([k, l]) => h('option', { value: k, selected: curQcLang === k }, l)));

  const qcPromptTa = h('textarea', {
    rows: 6,
    readonly: curQcLang !== 'custom',
    style: 'margin-top:6px;font-size:12.5px',
    value: curQcLang === 'custom'
      ? (proj.settings.customQcPrompt || P.DEFAULT_QC_PROMPTS.en)
      : (P.DEFAULT_QC_PROMPTS[curQcLang] || P.DEFAULT_QC_PROMPTS.en)
  });
  const qcPromptBox = h('div', { class: 'prog-box', hidden: true },
    h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:4px' },
      h('b', { style: 'font-size:12px;font-family:var(--mono)' }, 'QC / POLISH PROMPT'),
      h('div', { class: 'row', style: 'margin:0' },
        h('button', { class: 'sm', onclick: () => { qcPromptTa.value = P.DEFAULT_QC_PROMPTS.en; qcLangSel.value = 'en'; qcPromptTa.readOnly = true; } }, 'Reset EN'),
        h('button', { class: 'sm', onclick: () => { qcPromptTa.value = P.DEFAULT_QC_PROMPTS.id; qcLangSel.value = 'id'; qcPromptTa.readOnly = true; } }, 'Reset ID')
      )
    ),
    qcPromptTa
  );
  qcLangSel.onchange = () => {
    const vSel = qcLangSel.value;
    qcPromptTa.readOnly = vSel !== 'custom';
    if (vSel === 'en' || vSel === 'id') qcPromptTa.value = P.DEFAULT_QC_PROMPTS[vSel];
    else { qcPromptBox.hidden = false; }
    proj.settings.qcPromptLang = vSel;
    store.put('projects', proj);
  };

  const qcOutTa = h('textarea', { rows: 6, readonly: true, hidden: true, style: 'margin-top:8px', placeholder: 'Generated QC / Polish batch will appear here.' });
  const qcPasteTa = h('textarea', { rows: 6, placeholder: 'Paste polished lines from AI here...' });
  const qcApplyBox = h('div', { class: 'prog-box', hidden: true },
    qcPasteTa,
    h('div', { class: 'row', style: 'margin-top:8px;margin-bottom:0' },
      h('button', { class: 'pri sm', onclick: async () => {
        if (!qcPasteTa.value.trim()) return toast('Paste polished lines first');
        const r = await P.applyBatch(store, proj.id, qcPasteTa.value);
        markQcDirty();
        proj = await store.get('projects', proj.id);
        await refreshHeader();
        toast(`Applied ${r.applied} polished lines`);
        render();
      } }, 'Apply Polished Lines'),
      h('button', { class: 'sm', onclick: async () => {
        try {
          const clip = await navigator.clipboard.readText();
          qcPasteTa.value = clip;
          const r = await P.applyBatch(store, proj.id, clip);
          markQcDirty();
          proj = await store.get('projects', proj.id);
          await refreshHeader();
          toast(`Applied ${r.applied} polished lines`);
          render();
        } catch (e) { toast('Clipboard permission denied — paste manually'); }
      } }, 'Paste & Apply')
    )
  );

  const qcBatchInfo = h('span', { class: 'badge' }, 'POLISH & QC');
  let currentRes = [];

  const polishCard = h('div', { class: 'panel-card' },
    h('div', { class: 'panel-head' },
      h('b', {}, 'AI TRANSLATION POLISH & QC BATCH'),
      qcBatchInfo
    ),
    h('div', { class: 'form-grid' },
      h('div', { class: 'field' }, h('span', {}, 'Scope'), ...scopeCtrls),
      h('div', { class: 'field' }, h('span', {}, 'Target Lines'), targetSel),
      h('div', { class: 'field' }, h('span', {}, 'From Line (#ID)'), qcFromInp),
      h('div', { class: 'field' }, h('span', {}, 'Batch Size'), qcCountInp),
      h('div', { class: 'field' }, h('span', {}, 'Prompt'), qcLangSel)
    ),
    h('div', { class: 'row', style: 'margin-bottom:0' },
      h('button', { class: 'pri', onclick: async () => {
        const bFrom = Math.max(1, +qcFromInp.value || 1);
        const bCount = Math.max(1, +qcCountInp.value || 100);
        S.qcFrom = bFrom;
        S.qcTargetMode = targetSel.value;
        proj.settings.batchSize = bCount;
        proj.settings.qcPromptLang = qcLangSel.value;
        if (qcLangSel.value === 'custom') proj.settings.customQcPrompt = qcPromptTa.value;
        await store.put('projects', proj);

        const qBatch = await P.exportQcBatch(store, proj.id, {
          fid: S.fid || undefined,
          folder: S.folder || undefined,
          from: bFrom,
          count: bCount,
          targetMode: targetSel.value,
          issueFilter: S.qcFilter,
          qcItems: targetSel.value === 'issues' ? currentRes : null,
          promptLang: qcLangSel.value,
          customPrompt: qcPromptTa.value,
          stripAllTags: false
        });
        if (!qBatch.count) return toast('No matching translated lines found');
        qcOutTa.hidden = false;
        qcOutTa.value = qBatch.text;
        qcBatchInfo.textContent = `${qBatch.count} LINES · #${qBatch.firstGid}–#${qBatch.lastGid}`;
        if (qBatch.lastGid) {
          S.qcFrom = qBatch.lastGid + 1;
          qcFromInp.value = S.qcFrom;
        }
        if (await copyText(qBatch.text)) {
          toast(`Copied QC Prompt + ${qBatch.count} lines`);
          qcApplyBox.hidden = false;
        }
      } }, 'Generate & Copy QC Batch'),
      h('button', { class: 'sm', onclick: () => { qcApplyBox.hidden = !qcApplyBox.hidden; } }, 'Paste Polished Output'),
      h('button', { class: 'sm', onclick: () => { qcPromptBox.hidden = !qcPromptBox.hidden; } }, 'View / Edit Prompt')
    ),
    qcOutTa,
    qcPromptBox,
    qcApplyBox
  );

  const fixBtn = h('button', { class: 'sm', onclick: async () => {
    const ids = (S.fid || S.folder) ? (await P.listEntries(store, proj.id, { fid: S.fid || undefined, folder: S.folder || undefined })).map(e => e.id) : undefined;
    const n = await P.qcFixTags(store, proj.id, ids);
    markQcDirty();
    proj = await store.get('projects', proj.id);
    await refreshHeader();
    toast(`Auto-fixed tags on ${n} lines`);
    render();
  } }, 'Auto-Fix Tags');

  const rescanBtn = h('button', { class: 'sm', onclick: () => { markQcDirty(); render(); } }, 'Rescan');
  const chipHolder = h('div', { class: 'row', style: 'margin:0' });
  const bodyBox = h('div');

  v.append(
    polishCard,
    h('div', { class: 'row', style: 'justify-content:space-between' }, chipHolder, h('div', { class: 'row', style: 'margin:0' }, fixBtn, rescanBtn)),
    bodyBox
  );

  const cacheKey = `${proj.id}|${S.scope}|${S.qcRev}`;
  if (S.qcCache && S.qcCache.key === cacheKey) {
    currentRes = S.qcCache.res;
  } else {
    bodyBox.replaceChildren(h('p', { class: 'dim' }, 'Scanning translations...'));
    const totalEntries = (proj.stats && proj.stats.total) || 0;
    if (totalEntries > 500) {
      await new Promise(r => setTimeout(r, 0));
      if (ac.signal.aborted) return;
    }
    const res = await P.qcRun(store, proj.id, {
      fid: S.fid || undefined,
      folder: S.folder || undefined,
      signal: ac.signal,
      onProgress: ({ done, total, issues }) => {
        if (total > 500 && done < total) {
          bodyBox.replaceChildren(h('div', { class: 'prog-box row', style: 'justify-content:space-between' },
            h('span', { class: 'dim' }, `Scanning ${done}/${total} lines (${issues} flagged)...`),
            h('button', { class: 'sm danger', onclick: () => ac.abort() }, 'Cancel')
          ));
        }
      }
    });
    if (ac.signal.aborted) return;
    currentRes = res;
    S.qcCache = { key: cacheKey, res };
  }

  const filterList = (mode) => {
    if (!mode || mode === 'all') return currentRes;
    if (mode === 'crit') return currentRes.filter(r => r.critical);
    if (mode === 'tag') return currentRes.filter(r => r.issues.some(i => i.type === 'tag' || i.type === 'tag_malformed' || i.type === 'br'));
    return currentRes.filter(r => r.issues.some(i => i.type === mode));
  };

  const paintResults = () => {
    const cntJp = filterList('jepang').length;
    const cntTag = filterList('tag').length;
    const cntGls = filterList('gls').length;

    const filters = [
      ['all', `All Flagged (${currentRes.length})`],
      ['jepang', `Untranslated JP (${cntJp})`],
      ['gls', `Glossary (${cntGls})`],
      ['tag', `Tags / <BR> (${cntTag})`]
    ];
    chipHolder.replaceChildren(
      ...filters.map(([k, lbl]) => h('button', {
        class: 'chip' + (S.qcFilter === k ? ' on' : ''),
        onclick: () => { S.qcFilter = k; S.qcPage = 1; paintResults(); }
      }, lbl))
    );

    const shown = filterList(S.qcFilter);
    bodyBox.replaceChildren();
    if (!shown.length) {
      bodyBox.append(h('p', { class: 'dim' }, currentRes.length ? 'No lines match this filter.' : 'No automated issues found. Use the AI Polish panel above to refine translation flow.'));
      return;
    }
    const totalPages = Math.max(1, Math.ceil(shown.length / PAGE));
    if (S.qcPage > totalPages) S.qcPage = totalPages;
    if (totalPages > 1) {
      bodyBox.append(h('div', { class: 'row' },
        h('span', { class: 'dim' }, `${shown.length} lines · Page ${S.qcPage}/${totalPages}`),
        h('button', { class: 'sm', disabled: S.qcPage <= 1, onclick: () => { S.qcPage--; paintResults(); } }, 'Prev'),
        h('button', { class: 'sm', disabled: S.qcPage >= totalPages, onclick: () => { S.qcPage++; paintResults(); } }, 'Next')
      ));
    }
    const start = (S.qcPage - 1) * PAGE;
    for (const r of shown.slice(start, start + PAGE)) {
      const c = card(r.entry);
      c.prepend(h('div', { style: 'margin-bottom:6px' }, r.issues.map(i => h('div', { class: i.type === 'gls' ? 'warn' : 'note', style: 'font-size:12px;font-weight:500' }, `${QC_TYPE_LABEL[i.type] || i.type}: ${i.desc}`))));
      bodyBox.append(c);
    }
  };
  paintResults();
}

// — 04 GLOSSARY —————————————————————————————————————————
const glsToText = g => Object.entries(g || {}).map(([k, x]) => k + '=' + x).join('\n');
const textToGls = t => { const g = {}; for (const l of t.split('\n')) { const i = l.indexOf('='); if (i > 0 && l.slice(0, i).trim()) g[l.slice(0, i).trim()] = l.slice(i + 1).trim(); } return g; };
async function renderKamus(v) {
  const ta = h('textarea', { rows: 12, placeholder: 'source=translation (one per line)\n太郎=Taro' }); ta.value = glsToText(proj.glossary);
  const info = h('div', { class: 'dim' });
  const save = async () => { proj.glossary = textToGls(ta.value); await P.setGlossary(store, proj.id, proj.glossary); markQcDirty(); proj = await store.get('projects', proj.id); toast('Glossary saved'); };
  const vn = h('input', { placeholder: 'VNDB ID (e.g. v17 or 17)', style: 'width:180px' });
  const fetchBtn = h('button', { onclick: async () => {
    const id = vn.value.replace(/[^0-9]/g, ''); if (!id) return toast('Enter a VNDB ID first');
    info.textContent = 'Fetching characters from VNDB...';
    try {
      const chars = await fetchVndb(id); proj.glossary = textToGls(ta.value);
      const r = await P.vndbGlossaryDraft(store, proj.id, chars); ta.value = glsToText(r.draft);
      info.textContent = `${chars.length} VNDB characters · ${r.matched}/${r.total} speaker names matched` + (r.ambiguous.length ? ` · ambiguous: ${r.ambiguous.join(', ')}` : '') + ' — review and click Save.';
    } catch (e) { info.textContent = 'Failed: ' + e.message; info.className = 'err'; }
  } }, 'Fetch from VNDB');
  const scan = h('button', { onclick: async () => { const names = await P.scanSpeakerNames(store, proj.id), g = textToGls(ta.value); let n = 0; for (const x of names) if (!(x in g)) { g[x] = ''; n++; } ta.value = glsToText(g); info.textContent = `${names.length} speaker names · ${n} added.`; } }, 'Scan Speaker Names');
  const reapply = h('button', { onclick: async () => { await save(); const n = await P.reapplyGlossary(store, proj.id); toast(`Updated ${n} untranslated lines`); } }, 'Save & Apply to Untranslated Lines');
  v.append(
    h('div', { class: 'panel-card' },
      h('div', { class: 'panel-head' }, h('b', {}, 'DICTIONARY // GLOSSARY & CHARACTER NAMES')),
      h('p', { class: 'dim', style: 'margin-top:0' }, 'Glossary terms are automatically substituted in untranslated JP source lines and verified during QC.'),
      ta,
      h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { class: 'pri', onclick: save }, 'Save'), reapply, scan),
      h('div', { class: 'row', style: 'margin-bottom:0' }, vn, fetchBtn),
      info
    )
  );
}

(async () => {
  store = await createStore();
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* ignore */ }
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloading) { reloading = true; location.reload(); }
    });
    navigator.serviceWorker.register('./sw.js').then(reg => {
      swReg = reg;
      const offer = w => {
        const btn = $('#upd');
        btn.hidden = false;
        btn.textContent = 'UPDATE';
        btn.onclick = () => {
          btn.disabled = true;
          btn.textContent = 'RELOADING...';
          toast('Updating KOPIPE...');
          try { w.postMessage('SKIP_WAITING'); } catch (e) { /* ignore */ }
          setTimeout(() => { if (!reloading) { reloading = true; location.reload(); } }, 600);
        };
      };
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        if (w) w.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) {
            toast('Update available — click UPDATE in the top-right corner');
            offer(w);
          }
        });
      });
    }).catch(() => {});
  }
  await openProject(lsGet('kopipe.pid') || null);
})();
