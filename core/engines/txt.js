// core/engines/txt.js – Kirikiri-style plain .txt (【name】 blocks). Ported from KOPIPE.
import { applyGls, maskTxtTags, wrapText, unmaskTags } from '../util.js';
function parseTxtBlocks(text) {
  let rawLines = text.split('\n').map(l => l.replace(/\r$/, ''));
  let blocks = [];
  let currentName = null;
  let currentNameAbsIdx = -1;

  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i].trim();
    if (!line) {
      currentName = null;
      continue;
    }
    if (line.startsWith(';') || line.startsWith('[') || line.startsWith('@') || line.startsWith('*')) {
      continue;
    }
    let nameMatch = line.match(/^【(.*?)】$/);
    if (nameMatch) {
      currentName = nameMatch[1];
      currentNameAbsIdx = i;
      continue;
    }
    blocks.push({
      lineIdx: i,
      name: currentName,
      nameAbsIdx: currentNameAbsIdx,
      text: rawLines[i]
    });
  }
  return { rawLines, blocks };
}

function extractFromTxt(blocks, sg) {
  let lines = [], tagStore = {};
  for (let i = 0; i < blocks.length; i++) {
    let b = blocks[i];
    let rawName = b.name || 'Narasi';
    let name = sg.length ? applyGls(rawName, sg) : rawName;
    let dialog = sg.length ? applyGls(b.text, sg) : b.text;
    let mt = maskTxtTags(dialog);
    tagStore[b.lineIdx] = { tl: mt.tl, nameAbsIdx: b.nameAbsIdx, originalName: b.name };
    lines.push('[' + b.lineIdx + '|' + name + '] ' + mt.masked);
  }
  return { lines, tagStore };
}

function repackTxt(rawLines, tagStore, translations, wrapWidth, nlStr) {
  let repMap = new Map();
  let tKeys = Object.keys(translations);

  for (let ti = 0; ti < tKeys.length; ti++) {
    let lStr = tKeys[ti];
    let lineIdx = parseInt(lStr, 10);
    let store = tagStore[String(lineIdx)];
    if (!store) continue;

    let val = translations[lStr];
    let newName = val[0], translatedMasked = val[1];
    let tl = store.tl || [];

    let unmasked = unmaskTags(wrapText(translatedMasked, wrapWidth, nlStr), tl);
    let origLine = rawLines[lineIdx] || '';
    let matchWhite = origLine.match(/^(\s*)/);
    let leading = matchWhite ? matchWhite[1] : '';

    repMap.set(lineIdx, leading + unmasked);

    let nameAbsIdx = store.nameAbsIdx;
    if (nameAbsIdx >= 0 && store.originalName !== null && newName && newName.toLowerCase() !== 'narasi' && newName.toLowerCase() !== 'narration') {
      let oldNameLine = rawLines[nameAbsIdx] || '';
      let nameLead = oldNameLine.match(/^(\s*)/) ? oldNameLine.match(/^(\s*)/)[1] : '';
      repMap.set(nameAbsIdx, nameLead + '【' + newName + '】');
    }
  }

  return rawLines.map((l, i) => repMap.has(i) ? repMap.get(i) : l).join('\n');
}

export { parseTxtBlocks, extractFromTxt, repackTxt };
