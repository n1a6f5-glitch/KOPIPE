// core/batch.js – batch line format, unified parser, translation resolver. Ported from KOPIPE.
// ============================================================================
// P0 & P2 – UNIFIED MULTI-FORMAT PARSER & FORMATTER (KOPIPE + v2.4 Legacy)
// ============================================================================
var FILE_HDR = /^(?:---\s*(?:START\s+)?FILE\s*:\s*(.+?)\s*---|@FILE\s*:\s*(.+?))$/i;
var LINE_RE = /^\[(\d+)\|(?:([^\]|]*))(?:\|([DNdnCc]))?\]\s?(.*)$/s;
var LINE_RE_V25_NAR = /^(\d{1,7})\.\s*\((?:narasi|narration|n)\)\s*(.*)$/is;
var LINE_RE_V25_BRK = /^(\d{1,7})\.\s*\[([^\]]+)\]\s*(.*)$/s;
var LINE_RE_V25_COL = /^(\d{1,7})\.\s*([^""「\n]{1,35})\:\s*(["“「].*)$/s;
var LINE_RE_V25_GEN = /^(\d{1,7})\.\s+(.*)$/s;

function isChoiceSpeaker(name){
  var n = (name || '').toLowerCase().trim();
  return n === 'choice' || n === 'pilihan' || n === '[choice]' || n === '(choice)' || n === '(pilihan)';
}

function isNarrationSpeaker(name){
  var n = (name || '').toLowerCase();
  return !n || n === 'narasi' || n === 'narration' || n === 'narrator' || n === '(narasi)';
}

function detectEntryKind(name, rawText){
  if(isChoiceSpeaker(name)) return 'C';
  if(!isNarrationSpeaker(name)) return 'D';
  var clean = (rawText || '').replace(/^(?:<T\d+>|\s)+/, '');
  if(/^["“「『]/.test(clean)) return 'D';
  return 'N';
}

function padGlobalId(num){
  return String(num).padStart(6, '0');
}

function formatFileHeader(fname, fmtMode){
  if(fmtMode === 'v24') return '@FILE: ' + fname;
  return '--- FILE: ' + fname + ' ---';
}

// Format a single line in v2.5 Option B, v2.5 Option A, or v2.4 Legacy
function formatBatchLine(idStr, name, text, kind, fmtMode){
  var spk = (name || '').trim();
  var isNar = isNarrationSpeaker(spk);
  var k = kind || detectEntryKind(spk, text);
  var body = (text || '').replace(/[\r\n]+/g, ' ').trim();

  if(fmtMode === 'v24'){
    return '[' + idStr + '|' + (isNar ? 'Narasi' : spk) + '] ' + body;
  }
  if(fmtMode === 'v25a'){
    return '[' + idStr + '|' + (isNar ? 'Narasi' : spk) + '|' + k + '] ' + body;
  }
  // Default: v25b -> 000123. [Ei] "teks" or 000124. (Narasi) teks
  if(k === 'N' && isNar){
    return idStr + '. (Narasi) ' + body;
  }
  var dispName = isNar ? 'Dialog' : spk;
  return idStr + '. [' + dispName + '] ' + body;
}

// Naming pattern for output batch files
function buildBatchFilename(num, filesInBatch, pattern){
  var numStr = String(num).padStart(2, '0');
  if(pattern === 'naskah') return 'Naskah_' + numStr + '.txt';
  if(pattern === 'legacy') return 'MT_Batch_' + numStr + '.txt';
  // desc: Batch_01__script01.ks_dsb.txt
  var cleanNames = (filesInBatch || []).map(function(f){
    return f.replace(/[^a-zA-Z0-9._-]/g, '_');
  }).filter(Boolean);
  if(!cleanNames.length) return 'Batch_' + numStr + '.txt';
  if(cleanNames.length === 1) return 'Batch_' + numStr + '_' + cleanNames[0] + '.txt';
  return 'Batch_' + numStr + '_' + cleanNames[0] + '_dsb.txt';
}

// Unified lenient parser for both batch files and AI responses
function parseBatchUnified(text, allowAiMultiline){
  var items=[], ents=[], unreadable=[];
  var cur='';
  var rawLines = (text || '').replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').split('\n');

  function cleanMdLine(s){
    return s.trim()
      .replace(/^\*{1,2}(---.*---)\*{1,2}$/, '$1')
      .replace(/^\*{1,2}(@FILE:.*)\*{1,2}$/i, '$1')
      .replace(/^>+\s*/, '');
  }

  for(var idxLine=0; idxLine<rawLines.length; idxLine++){
    var rawL = rawLines[idxLine];
    var line = cleanMdLine(rawL);
    if(!line) continue;
    if(/^```/.test(line)) continue;

    // 1. Check File Header (--- FILE: x --- or @FILE: x)
    var hm = FILE_HDR.exec(line);
    if(hm){
      cur = (hm[1] || hm[2] || '').trim();
      items.push({t:'hdr', file:cur, line:line});
      continue;
    }

    // Skip standalone SRC:/RAW: helper lines when parsing AI output
    if(allowAiMultiline && /^\s*(?:SRC|RAW)\s*:/i.test(line)) continue;

    // 2. Try parsing line entry in any supported format
    var parsed = null;

    // Format Pipe: [000123|Name|D] text or [12|Name] text
    var mPipe = LINE_RE.exec(line);
    if(mPipe){
      parsed = {
        idx: mPipe[1],
        name: mPipe[2].trim() || 'Narasi',
        kind: mPipe[3] ? mPipe[3].toUpperCase() : null,
        text: mPipe[4] !== undefined ? mPipe[4] : ''
      };
    }

    // Format v2.5 B Narration: 000123. (Narasi) text
    if(!parsed){
      var mNar = LINE_RE_V25_NAR.exec(line);
      if(mNar){
        parsed = { idx: mNar[1], name: 'Narasi', kind: 'N', text: mNar[2] || '' };
      }
    }

    // Format v2.5 B Bracket Speaker: 000123. [Name] text
    if(!parsed){
      var mBrk = LINE_RE_V25_BRK.exec(line);
      if(mBrk){
        var spk = mBrk[2].trim();
        var isN = isNarrationSpeaker(spk);
        parsed = { idx: mBrk[1], name: isN ? 'Narasi' : spk, kind: isN ? 'N' : 'D', text: mBrk[3] || '' };
      }
    }

    // Format v2.5 Colon Speaker: 000123. Name: "text"
    if(!parsed){
      var mCol = LINE_RE_V25_COL.exec(line);
      if(mCol){
        parsed = { idx: mCol[1], name: mCol[2].trim(), kind: 'D', text: mCol[3] || '' };
      }
    }

    // Format Generic Numbered: 000123. text
    if(!parsed){
      var mGen = LINE_RE_V25_GEN.exec(line);
      if(mGen){
        parsed = { idx: mGen[1], name: '', kind: null, text: mGen[2] || '' };
      }
    }

    if(parsed){
      var body = parsed.text;
      if(allowAiMultiline){
        body = body.replace(/^\s*(?:TL|ID|FIX)\s*:\s*/i, '');
        if(!body.trim()){
          while(idxLine+1 < rawLines.length){
            var nxt = cleanMdLine(rawLines[idxLine+1]);
            if(!nxt){ idxLine++; continue; }
            if(/^(?:SRC|RAW)\s*:/i.test(nxt)){ idxLine++; continue; }
            if(/^(?:TL|ID|FIX)\s*:/i.test(nxt)){
              body = nxt.replace(/^(?:TL|ID|FIX)\s*:\s*/i, '');
              idxLine++;
              break;
            }
            if(!FILE_HDR.test(nxt) && !LINE_RE.test(nxt) && !/^\d{1,7}\.\s/.test(nxt)){
              body = nxt;
              idxLine++;
              break;
            }
            break;
          }
        }
      }
      var normIdxInt = String(parseInt(parsed.idx, 10));
      var spkName = parsed.name || 'Narasi';
      var e = {
        t: 'ent',
        file: cur,
        idx: parsed.idx,
        idxNum: normIdxInt,
        name: spkName,
        kind: parsed.kind || detectEntryKind(spkName, body),
        text: body,
        key: cur ? (cur + '|' + normIdxInt) : ('|' + normIdxInt)
      };
      items.push(e);
      ents.push(e);
    } else {
      var reason = 'Tidak memiliki nomor baris [idx|Nama] atau NNNN. di awal baris';
      if(/^\d/.test(line)) reason = 'Nomor baris tidak diikuti titik/kurung siku sesuai format';
      else if(/^\[/.test(line)) reason = 'Kurung siku pembuka tidak memiliki pasangan "|Nama]"';
      items.push({t:'raw', line:rawL, lineNo:idxLine+1, reason:reason});
      unreadable.push({lineNo:idxLine+1, line:rawL.trim(), reason:reason});
    }
  }
  return {items:items, ents:ents, unreadable:unreadable};
}

// Parse raw extracted lines array ("[0|Name] text", ...) from low-level engine extractors
function convertExtractedLinesToV25(rawLines, fileName, globalCounterRef, fmtMode, fileGlobalMap){
  var outLines = [];
  for(var i=0; i<rawLines.length; i++){
    var m = LINE_RE.exec(rawLines[i]);
    if(!m) continue;
    var localIdx = m[1];
    var name = m[2] || 'Narasi';
    var text = m[4] !== undefined ? m[4] : '';
    var gId = globalCounterRef.val++;
    if(fileGlobalMap){
      if(!fileGlobalMap[fileName]) fileGlobalMap[fileName] = {};
      fileGlobalMap[fileName][localIdx] = gId;
    }
    outLines.push(formatBatchLine(padGlobalId(gId), name, text, detectEntryKind(name, text), fmtMode));
  }
  return outLines;
}

function resolveTranslationsForRepack(parsedEntries, allTags, fileGlobalMap){
  var trans = {};
  var localSeqPerFile = {};

  for(var i=0; i<parsedEntries.length; i++){
    var e = parsedEntries[i];
    var targetFile = e.file;
    var targetLocalIdx = e.idxNum;

    if(!targetFile && Object.keys(allTags).length === 1){
      targetFile = Object.keys(allTags)[0];
    }

    if(targetFile && fileGlobalMap && fileGlobalMap[targetFile]){
      var gToLocal = fileGlobalMap[targetFile];
      if(e.idxNum in gToLocal){
        targetLocalIdx = String(gToLocal[e.idxNum]);
      }
    } else if(targetFile && allTags && allTags[targetFile]){
      var fMeta = allTags[targetFile];
      var fTags = fMeta.tags || fMeta;
      if(!(targetLocalIdx in fTags) && (e.idx.length >= 5)){
        // Sequential fallback within file if globalMap wasn't found
        var seq = localSeqPerFile[targetFile] || 0;
        var sortedKeys = Object.keys(fTags).filter(function(k){ return /^\d+$/.test(k); }).sort(function(a,b){ return parseInt(a,10) - parseInt(b,10); });
        if(seq < sortedKeys.length) targetLocalIdx = sortedKeys[seq];
        localSeqPerFile[targetFile] = seq + 1;
      }
    }

    if(!targetFile) continue;
    if(!trans[targetFile]) trans[targetFile] = {};
    trans[targetFile][targetLocalIdx] = [e.name, e.text];
  }
  return trans;
}

export { FILE_HDR, LINE_RE, isNarrationSpeaker, isChoiceSpeaker, detectEntryKind, padGlobalId, formatFileHeader, formatBatchLine, buildBatchFilename, parseBatchUnified, convertExtractedLinesToV25, resolveTranslationsForRepack };
