// core/engines/scn.js – Kirikiri M2/PSB .scn (plain, XOR dual-key, MDF). Ported from KOPIPE.
import { applyGls, maskTxtTags, wrapText, cfg } from '../util.js';
import { normLogger, hexHead, fnv1aHex } from '../log.js';
// ============================================================================
// KIRIKIRI .scn (M2/PSB binary format) – extract + repack (byte-patch). Supports plain and dual-key XOR-obfuscated PSB.
// Ported from Gardroid's PSBFILE/psb.hpp + psb.cpp (binary reader), validated
// byte-for-byte against a real .scn file. Dialogue-extraction shape below is
// specific to this game's compiled format: each scene's "texts" collection
// holds flat 6-tuples [nameJP, nameEN, message, voiceInfo, num, stateSnapshot] –
// this differs from Gardroid's own assumed nested-per-language shape, which
// this game's files don't use.
// ============================================================================
var PSB_T = {
  NONE:0, NULL:1, FALSE:2, TRUE:3,
  N0:4, N1:5, N2:6, N3:7, N4:8, N5:9, N6:10, N7:11, N8:12,
  ARR1:13, ARR2:14, ARR3:15, ARR4:16, ARR5:17, ARR6:18, ARR7:19, ARR8:20,
  STR1:21, STR2:22, STR3:23, STR4:24,
  RES1:25, RES2:26, RES3:27, RES4:28,
  FLOAT0:29, FLOAT:30, DOUBLE:31,
  COLLECTION:32, OBJECTS:33
};
var nowMs = function(){ return globalThis.performance ? globalThis.performance.now() : Date.now(); };
var hexByte = function(b){ return '0x' + ((b & 0xFF) < 16 ? '0' : '') + (b & 0xFF).toString(16); };

function psbReadLE(buf,pos,n){ var v=0; for(var i=0;i<n;i++) v |= buf[pos+i]<<(i*8); return v>>>0; }

function psbReadArrayBody(buf, typeByte, ptr){
  var n = typeByte - 0xC;
  var entryCount = psbReadLE(buf, ptr.pos, n); ptr.pos += n;
  var entryLenByte = buf[ptr.pos]; ptr.pos++;
  var entryLength = entryLenByte - 0xC;
  var dataStart = ptr.pos;
  ptr.pos += entryCount*entryLength;
  return {entryCount:entryCount, entryLength:entryLength, dataStart:dataStart};
}
function psbReadArray(buf, ptr){
  var typeByte = buf[ptr.pos]; ptr.pos++;
  return psbReadArrayBody(buf, typeByte, ptr);
}
function psbArrayGet(buf, arr, index){
  var v=0, p=arr.dataStart+index*arr.entryLength;
  for(var i=0;i<arr.entryLength;i++) v |= buf[p+i] << (i*8);
  return v>>>0;
}
function psbReadNumberBody(buf, type, ptr){
  if(type>=PSB_T.N0 && type<=PSB_T.N8){
    var n = type-4;
    var v = 0n;
    for(var i=0;i<n;i++) v |= BigInt(buf[ptr.pos+i]) << BigInt(i*8);
    ptr.pos += n;
    if(n>0){
      var mask = 1n << BigInt(n*8-1);
      if(v & mask){ v -= (1n << BigInt(n*8)); }
    }
    return {value:v, numberType:'integer'};
  }
  if(type===PSB_T.FLOAT){ var view=new DataView(buf.buffer,buf.byteOffset+ptr.pos,4); var f=view.getFloat32(0,true); ptr.pos+=4; return {value:f,numberType:'float'}; }
  if(type===PSB_T.FLOAT0){ return {value:0,numberType:'float'}; }
  if(type===PSB_T.DOUBLE){ var view2=new DataView(buf.buffer,buf.byteOffset+ptr.pos,8); var d=view2.getFloat64(0,true); ptr.pos+=8; return {value:d,numberType:'double'}; }
  return {value:0n,numberType:null};
}
function psbReadObjects(buf, ptr){
  var names = psbReadArray(buf, ptr);
  var offsets = psbReadArray(buf, ptr);
  var base = ptr.pos;
  return {names:names, offsets:offsets, base:base};
}
function psbReadCollection(buf, ptr){
  var offsets = psbReadArray(buf, ptr);
  var base = ptr.pos;
  return {offsets:offsets, base:base};
}
function psbObjectsSize(obj){ return obj.names.entryCount; }
function psbCollectionSize(col){ return col.offsets.entryCount; }
function psbUnpack(buf, ptr){
  var type = buf[ptr.pos]; ptr.pos++;
  if(type===PSB_T.NULL) return {kind:'null'};
  if(type===PSB_T.FALSE) return {kind:'bool', value:false};
  if(type===PSB_T.TRUE) return {kind:'bool', value:true};
  if((type>=PSB_T.N0 && type<=PSB_T.N8) || type===PSB_T.FLOAT || type===PSB_T.FLOAT0 || type===PSB_T.DOUBLE){
    var r = psbReadNumberBody(buf, type, ptr);
    return {kind:'number', value:r.value, numberType:r.numberType};
  }
  if(type>=PSB_T.ARR1 && type<=PSB_T.ARR8){
    var arr = psbReadArrayBody(buf, type, ptr);
    return {kind:'array', arr:arr};
  }
  if(type===PSB_T.COLLECTION){ return {kind:'collection', col:psbReadCollection(buf, ptr)}; }
  if(type===PSB_T.OBJECTS){ return {kind:'objects', obj:psbReadObjects(buf, ptr)}; }
  if(type>=PSB_T.RES1 && type<=PSB_T.RES4){
    var n = type - 0x18;
    var v = psbReadLE(buf, ptr.pos, n); ptr.pos += n;
    return {kind:'resource', chunkIndex:v};
  }
  if(type>=PSB_T.STR1 && type<=PSB_T.STR4){
    var n2 = type - 0x14;
    var idxOff2 = ptr.pos;
    var v2 = psbReadLE(buf, ptr.pos, n2); ptr.pos += n2;
    return {kind:'string', index:v2, byteOffset:idxOff2, byteWidth:n2};
  }
  ptr.pos--;
  return null;
}
function psbGetString(buf, stringsArr, stringsDataOffset, index){
  var off = psbArrayGet(buf, stringsArr, index);
  var start = stringsDataOffset + off, end = start;
  while(end < buf.length && buf[end] !== 0) end++;
  return new TextDecoder('utf-8', {ignoreBOM:true}).decode(buf.subarray(start, end));
}
function psbGetName(buf, str1, str2, str3, index){
  var a = psbArrayGet(buf, str3, index);
  var b = psbArrayGet(buf, str2, a);
  var bytes = [];
  while(true){
    var c = psbArrayGet(buf, str2, b);
    var d = psbArrayGet(buf, str1, c);
    var e = (b - d) & 0xFF;
    b = c;
    bytes.unshift(e);
    if(!b) break;
  }
  return new TextDecoder('utf-8', {ignoreBOM:true}).decode(new Uint8Array(bytes)); // psb.cpp keeps raw bytes; names may be UTF-8
}
function psbParseHeader(buf){
  return {
    signature: String.fromCharCode(buf[0],buf[1],buf[2],buf[3]),
    version: psbReadLE(buf,4,2), encrypt: psbReadLE(buf,6,2),
    offsetEncrypt: psbReadLE(buf,8,4), offsetNames: psbReadLE(buf,12,4),
    offsetStrings: psbReadLE(buf,16,4), offsetStringsData: psbReadLE(buf,20,4),
    offsetChunkOffsets: psbReadLE(buf,24,4), offsetChunkLengths: psbReadLE(buf,28,4),
    offsetChunkData: psbReadLE(buf,32,4), offsetEntries: psbReadLE(buf,36,4)
  };
}
function parsePsb(buf){
  var hdr = psbParseHeader(buf);
  var psb = { buf: buf, hdr: hdr };
  var ptr = {pos: hdr.offsetNames};
  psb.str1 = psbReadArray(buf, ptr); psb.str2 = psbReadArray(buf, ptr); psb.str3 = psbReadArray(buf, ptr);
  ptr = {pos: hdr.offsetStrings};
  psb.strings = psbReadArray(buf, ptr);
  psb.stringsDataOffset = hdr.offsetStringsData;
  ptr = {pos: hdr.offsetChunkOffsets};
  psb.chunkOffsets = psbReadArray(buf, ptr);
  ptr = {pos: hdr.offsetChunkLengths};
  psb.chunkLengths = psbReadArray(buf, ptr);
  psb.chunkDataOffset = hdr.offsetChunkData;
  ptr = {pos: hdr.offsetEntries};
  psb.root = psbUnpack(buf, ptr);
  return psb;
}
function psbName(psb, index){ return psbGetName(psb.buf, psb.str1, psb.str2, psb.str3, index); }
function psbStr(psb, index){ return psbGetString(psb.buf, psb.strings, psb.stringsDataOffset, index); }
function psbObjName(psb, obj, i){ return psbName(psb, psbArrayGet(psb.buf, obj.names, i)); }
function psbObjValue(psb, obj, i){
  var off = obj.base + psbArrayGet(psb.buf, obj.offsets, i);
  return psbUnpack(psb.buf, {pos: off});
}
function psbObjValueByName(psb, obj, name){
  for(var i=0;i<psbObjectsSize(obj);i++) if(psbObjName(psb,obj,i)===name) return psbObjValue(psb,obj,i);
  return undefined;
}
function psbColValue(psb, col, i){
  var off = col.base + psbArrayGet(psb.buf, col.offsets, i);
  return psbUnpack(psb.buf, {pos: off});
}
function psbResolve(psb, node){
  if(!node) return null;
  if(node.kind==='null') return null;
  if(node.kind==='bool') return node.value;
  if(node.kind==='number') return node.numberType==='integer' ? Number(node.value) : node.value;
  if(node.kind==='string') return psbStr(psb, node.index);
  return node;
}

// — Dialogue extraction: try multiple known shapes in order, use first that
// yields results. Strategy A = shape reverse-engineered from our own sample
// (scene.texts[i] = [nameJP, nameEN, message, voice, num, stateSnapshot]).
// Strategy B/C = ported from Gardroid's ScnKsLogic.hpp / ScnTxtLogic.hpp
// (nested per-language shape: key "texts"/"text"/"lines" holding tuples whose
// message lives inside a langList -> block -> string, C additionally filters
// known non-dialogue command names). —

function scnStrategyA(psb){
  var entries = [];
  if(!psb.root || psb.root.kind!=='objects') return entries;
  var scenesVal = psbObjValueByName(psb, psb.root.obj, 'scenes');
  if(!scenesVal || scenesVal.kind!=='collection') return entries;
  var sceneCount = psbCollectionSize(scenesVal.col);
  for(var si=0; si<sceneCount; si++){
    var scene = psbColValue(psb, scenesVal.col, si);
    if(scene.kind!=='objects') continue;
    var textsVal = psbObjValueByName(psb, scene.obj, 'texts');
    if(!textsVal || textsVal.kind!=='collection') continue;
    var tn = psbCollectionSize(textsVal.col);
    for(var ti=0; ti<tn; ti++){
      var tuple = psbColValue(psb, textsVal.col, ti);
      if(tuple.kind!=='collection') continue;
      if(psbCollectionSize(tuple.col)<3) continue;
      var nameNode = psbColValue(psb, tuple.col, 0);
      var name2Node = psbColValue(psb, tuple.col, 1);
      var msgNode = psbColValue(psb, tuple.col, 2);
      var name = nameNode.kind==='string' ? psbResolve(psb,nameNode) : '';
      var name2 = name2Node.kind==='string' ? psbResolve(psb,name2Node) : '';
      var msg = msgNode.kind==='string' ? psbResolve(psb,msgNode) : '';
      if(!msg) continue;
      var usedName = name || name2 || '';
      var usedNameIdx = name ? nameNode.index : (name2 ? name2Node.index : null);
      var usedNameNode = name ? nameNode : (name2 ? name2Node : null);
      entries.push({name: usedName, message: msg, nameIdx: usedNameIdx, msgIdx: msgNode.index,
        nameIdxOffset: usedNameNode ? usedNameNode.byteOffset : null, nameIdxWidth: usedNameNode ? usedNameNode.byteWidth : null,
        msgIdxOffset: msgNode.byteOffset, msgIdxWidth: msgNode.byteWidth, sceneIdx: si});
    }
  }
  return entries;
}

function scnGetStr(psb, node){ return node && node.kind==='string' ? psbResolve(psb,node) : ''; }

function scnStrategyB(psb){
  var entries = [];
  function getNameFromStruct(node){
    if(!node || node.kind!=='collection' || psbCollectionSize(node.col)<=0) return '';
    var vObj = psbColValue(psb, node.col, 0);
    if(vObj && vObj.kind==='objects'){
      var vName = psbObjValueByName(psb, vObj.obj, 'name');
      if(vName) return scnGetStr(psb,vName);
    }
    return '';
  }
  function processList(list){
    var LANG=0, n=psbCollectionSize(list.col);
    for(var i=0;i<n;i++){
      var val = psbColValue(psb, list.col, i);
      if(!val || val.kind!=='collection') continue;
      var params=val.col, psize=psbCollectionSize(params);
      var nameText='', messageText='', msgNode=null;
      if(psize>1){
        var v1=psbColValue(psb,params,1);
        if(v1 && v1.kind==='collection' && psbCollectionSize(v1.col)>LANG){
          var lVal=psbColValue(psb,v1.col,LANG);
          if(lVal && lVal.kind==='collection' && psbCollectionSize(lVal.col)>1){
            msgNode = psbColValue(psb,lVal.col,1);
            messageText = scnGetStr(psb, msgNode);
          }
        }
      }
      if(psize>2) nameText = getNameFromStruct(psbColValue(psb,params,2));
      if(messageText) entries.push({name:nameText, message:messageText,
        msgIdx: msgNode && msgNode.kind==='string' ? msgNode.index : undefined,
        msgIdxOffset: msgNode && msgNode.kind==='string' ? msgNode.byteOffset : undefined,
        msgIdxWidth: msgNode && msgNode.kind==='string' ? msgNode.byteWidth : undefined});
    }
  }
  function traverse(node, depth){
    if(!node || depth>20) return;
    if(node.kind==='objects'){
      var n=psbObjectsSize(node.obj);
      for(var i=0;i<n;i++){
        var key=psbObjName(psb,node.obj,i), val=psbObjValue(psb,node.obj,i);
        if(key==='texts'||key==='text'||key==='lines'){ if(val.kind==='collection') processList(val); }
        else if(val.kind==='objects'||val.kind==='collection') traverse(val, depth+1);
      }
    } else if(node.kind==='collection'){
      var n2=psbCollectionSize(node.col);
      for(var k=0;k<n2;k++) traverse(psbColValue(psb,node.col,k), depth+1);
    }
  }
  traverse(psb.root, 0);
  return entries;
}

var SCN_JUNK = new Set(['envupdate','face','bg','ef0','ef1','ef2','bgm','se','voice','pretrans','lock','unlock','motion','pose','select','jump','call','chapter','trans']);

function scnStrategyC(psb){
  var entries = [];
  function processList(list){
    var LANG=0, n=psbCollectionSize(list.col);
    for(var i=0;i<n;i++){
      var val = psbColValue(psb, list.col, i);
      if(!val || val.kind!=='collection') continue;
      var params=val.col, psize=psbCollectionSize(params);
      var name='', msg='', langList=null, msgNode=null;
      if(psize>2){ var v2=psbColValue(psb,params,2); if(v2 && v2.kind==='collection') langList=v2.col; }
      if(!langList && psize>1){ var v1=psbColValue(psb,params,1); if(v1 && v1.kind==='collection') langList=v1.col; }
      if(!langList) continue;
      if(psize>0) name = scnGetStr(psb, psbColValue(psb,params,0));
      if(name && SCN_JUNK.has(name)) continue;
      if(psbCollectionSize(langList) > LANG){
        var lVal=psbColValue(psb,langList,LANG);
        if(lVal && lVal.kind==='collection' && psbCollectionSize(lVal.col)>1){
          msgNode = psbColValue(psb,lVal.col,1);
          msg = scnGetStr(psb, msgNode);
        }
      }
      if(msg) entries.push({name: (name && name!=='@') ? name : '', message: msg,
        msgIdx: msgNode && msgNode.kind==='string' ? msgNode.index : undefined,
        msgIdxOffset: msgNode && msgNode.kind==='string' ? msgNode.byteOffset : undefined,
        msgIdxWidth: msgNode && msgNode.kind==='string' ? msgNode.byteWidth : undefined});
    }
  }
  function traverse(node, depth){
    if(!node || depth>20) return;
    if(node.kind==='objects'){
      var n=psbObjectsSize(node.obj);
      for(var i=0;i<n;i++){
        var key=psbObjName(psb,node.obj,i), val=psbObjValue(psb,node.obj,i);
        if(key==='texts'||key==='lines'){ if(val.kind==='collection') processList(val); }
        else if(val.kind==='objects'||val.kind==='collection') traverse(val, depth+1);
      }
    } else if(node.kind==='collection'){
      var n2=psbCollectionSize(node.col);
      for(var k=0;k<n2;k++) traverse(psbColValue(psb,node.col,k), depth+1);
    }
  }
  traverse(psb.root, 0);
  return entries;
}

// — XOR obfuscation layer (dual-key) ——————————————————————————————————————————
function scnHeaderPlausible(hb, len){
  var h=psbParseHeader(hb);
  if(h.version<1 || h.version>6) return false;
  if(h.offsetNames<36 || h.offsetNames>h.offsetEntries) return false;
  var chain=[h.offsetNames,h.offsetEntries,h.offsetStrings,h.offsetStringsData,h.offsetChunkOffsets,h.offsetChunkLengths,h.offsetChunkData];
  for(var i=1;i<chain.length;i++) if(chain[i]<chain[i-1]) return false;
  return chain[chain.length-1]<=len;
}
function scnHeaderRejectReason(hb, len){
  var h=psbParseHeader(hb);
  if(h.signature !== 'PSB\0') return 'magic bukan PSB\\0 (' + JSON.stringify(h.signature) + ')';
  if(h.version<1 || h.version>6) return 'versi PSB di luar 1..6 (version=' + h.version + ')';
  if(h.offsetNames<36 || h.offsetNames>h.offsetEntries) return 'offsetNames tidak valid (' + h.offsetNames + ' vs offsetEntries=' + h.offsetEntries + ')';
  var chain=[h.offsetNames,h.offsetEntries,h.offsetStrings,h.offsetStringsData,h.offsetChunkOffsets,h.offsetChunkLengths,h.offsetChunkData];
  for(var i=1;i<chain.length;i++) if(chain[i]<chain[i-1]) return 'urutan offset header mundur pada indeks ' + i + ' (' + chain[i] + ' < ' + chain[i-1] + ')';
  if(chain[chain.length-1]>len) return 'offsetChunkData (' + chain[chain.length-1] + ') melebihi ukuran berkas (' + len + ')';
  return 'ok';
}
function scnHeaderRepair(raw, k, len){
  var base=new Uint8Array(44); for(var i=0;i<44;i++) base[i]=raw[i]^k;
  if(scnHeaderPlausible(base,len)) return {hb:base, fix:[]};
  var p,q,hb;
  for(p=8;p<44;p++){
    if(!base[p]) continue;
    hb=new Uint8Array(base); hb[p]=0;
    if(scnHeaderPlausible(hb,len)) return {hb:hb, fix:[p]};
  }
  for(p=8;p<44;p++){
    if(!base[p]) continue;
    for(q=p+1;q<44;q++){
      if(!base[q]) continue;
      hb=new Uint8Array(base); hb[p]=0; hb[q]=0;
      if(scnHeaderPlausible(hb,len)) return {hb:hb, fix:[p,q]};
    }
  }
  return null;
}
function scnNamesOk(raw, ns, ne, ka, k2, b, loose, needSorted){
  function rd(p){ return raw[p]^(p<b?ka:k2); }
  function arr(p){
    var t=rd(p); if(t<0x0d||t>0x14) return null;
    var n=t-0xC, cnt=0;
    for(var i=0;i<n;i++) cnt+=rd(p+1+i)*Math.pow(256,i);
    var el=rd(p+1+n)-0xC; if(el<1||el>4) return null;
    var end=p+2+n+cnt*el; if(end>ne) return null;
    return {cnt:cnt, el:el, data:p+2+n, end:end};
  }
  function get(a,i){ var v=0; for(var j=0;j<a.el;j++) v+=rd(a.data+i*a.el+j)*Math.pow(256,j); return v; }
  var a1=arr(ns); if(!a1) return false;
  var a2=arr(a1.end); if(!a2) return false;
  var a3=arr(a2.end); if(!a3 || a3.end!==ne) return false;
  var prev=null, score=0, fails=0, tol=Math.max(2, Math.floor(a3.cnt*0.03));
  for(var n=0;n<a3.cnt;n++){
    var a=get(a3,n), nm='', okName=true;
    if(a>=a2.cnt) okName=false;
    else{
      var bb=get(a2,a), steps=0;
      while(true){
        if(bb>=a2.cnt){ okName=false; break; }
        var c=get(a2,bb); if(c>=a1.cnt){ okName=false; break; }
        var d=get(a1,c), ch=(bb-d)&0xFF;
        if(loose ? (ch<0x20||ch===0x7f) : (ch<0x20||ch>0x7e)){ okName=false; break; }
        nm=String.fromCharCode(ch)+nm;
        bb=c; if(!bb) break;
        if(++steps>512){ okName=false; break; }
      }
    }
    if(okName && needSorted && prev!==null && !(prev<nm)) okName=false;
    if(!okName){ if(++fails>tol) return false; continue; }
    if(needSorted) prev=nm;
    if(/^[A-Za-z_][A-Za-z0-9_]*$/.test(nm)) score++;
  }
  return score+1;
}
function scnHex(raw, n){ var o=[]; for(var i=0;i<Math.min(n,raw.length);i++) o.push((raw[i]<16?'0':'')+raw[i].toString(16)); return o.join(' '); }

function scnXorApply(raw, x){
  var out=new Uint8Array(raw.length);
  for(var i=0;i<raw.length;i++) out[i]=raw[i]^(i<x.ns ? x.k1 : (i<x.b ? x.ka : x.k2));
  if(x.fix) for(var f=0;f<x.fix.length;f++) out[x.fix[f]]=0;
  return out;
}
function scnXorEncode(plain, x, origRaw){
  var out=new Uint8Array(plain.length);
  for(var i=0;i<plain.length;i++) out[i]=plain[i]^(i<x.ns ? x.k1 : (i<x.b ? x.ka : x.k2));
  if(x.fix) for(var f=0;f<x.fix.length;f++) out[x.fix[f]]=origRaw[x.fix[f]];
  return out;
}
function scnVerify(raw, x){
  try{
    var psb=parsePsb(scnXorApply(raw,x));
    if(!psb.root || psb.root.kind!=='objects') return false;
    var n=psb.strings.entryCount, bad=0;
    for(var i=0;i<n;i++) if(psbStr(psb,i).indexOf('\uFFFD')>=0) bad++;
    return bad <= Math.max(1, n*0.01);
  }catch(err){ return false; }
}
function scnXorDetect(raw, opts){
  var log = opts && opts.log ? normLogger(opts.log) : null;
  if(!raw || raw.length<48){
    var smallErr = 'File terlalu kecil ('+(raw?raw.length:0)+' byte) buat PSB';
    if(log) log.error('xor', smallErr, { size: raw ? raw.length : 0 });
    throw new Error(smallErr);
  }
  var cands=[0, raw[3], raw[0]^0x50, raw[1]^0x53], seen={}, k1=-1, h=null, hfix=[], tried=[];
  for(var rp=0; rp<2 && k1<0; rp++){
    seen={};
    for(var ci=0;ci<cands.length;ci++){
      var k=cands[ci]; if(seen[k]) continue; seen[k]=1;
      var hb, fx=[];
      if(rp===0){
        hb=new Uint8Array(44); for(var i=0;i<44;i++) hb[i]=raw[i]^k;
        if(!scnHeaderPlausible(hb, raw.length)){
          if(log) tried.push({ pass: 0, key: hexByte(k), ok: false, reason: scnHeaderRejectReason(hb, raw.length) });
          continue;
        }
      } else {
        var magicOk = (raw[0]^k)===0x50 && (raw[1]^k)===0x53 && (raw[2]^k)===0x42;
        var rr = magicOk ? scnHeaderRepair(raw,k,raw.length) : null;
        if(!rr){
          if(log) tried.push({ pass: 1, key: hexByte(k), ok: false, reason: magicOk ? 'repair header 1-2 byte gagal' : 'magic PSB tidak cocok' });
          continue;
        }
        hb=rr.hb; fx=rr.fix;
      }
      k1=k; h=psbParseHeader(hb); hfix=fx;
      if(log) tried.push({ pass: rp, key: hexByte(k), ok: true, repairedOffsets: fx, validatedBytes: 40 });
      break;
    }
  }
  if(k1<0){
    if(raw[0]===0x6d && raw[1]===0x64 && raw[2]===0x66){
      var mdfErr = 'File berformat MDF (terkompres), bukan PSB langsung – belum didukung. 8 byte awal: '+scnHex(raw,8);
      if(log) log.error('xor', mdfErr, { head8: scnHex(raw, 8), tried: tried });
      throw new Error(mdfErr);
    }
    var hdrErr = 'Header PSB gak dikenali (8 byte awal: '+scnHex(raw,8)+', ukuran '+raw.length+')';
    if(log) log.error('xor', hdrErr, { head8: scnHex(raw, 8), size: raw.length, tried: tried });
    throw new Error(hdrErr);
  }
  if(k1===0 && !hfix.length){
    if(log) log.info('xor', 'Berkas PSB polos (tanpa XOR); 40 byte header tervalidasi', { xor: false, k1: '0x00', validatedHeaderBytes: 40, tried: tried });
    return null;
  }
  var ns=h.offsetNames, ne=h.offsetEntries;
  var k2=raw[ne]^PSB_T.OBJECTS;
  if(k2===k1){
    var singleRes = {k1:k1, ka:k1, k2:k1, ns:ns, b:raw.length, fix:hfix};
    if(log) log.info('xor', 'XOR kunci tunggal terdeteksi (' + hexByte(k1) + ')', { xor: true, mode: 'single-key', k1: hexByte(k1), ka: hexByte(k1), k2: hexByte(k1), ns: ns, b: raw.length, fix: hfix, validatedHeaderBytes: 40, tried: tried });
    return singleRes;
  }
  var kas=[k1];
  for(var t=0x0d;t<=0x14;t++){ var kk=raw[ns]^t; if(kas.indexOf(kk)<0) kas.push(kk); }
  if(kas.indexOf(k2)<0) kas.push(k2);
  var found=[], rejectedVerify=0;
  for(var pass=0; pass<3; pass++){
    for(var ki=0;ki<kas.length;ki++){
      for(var b=ns;b<=ne;b++){
        var sc=scnNamesOk(raw,ns,ne,kas[ki],k2,b,pass>=1,pass<2);
        if(sc) found.push({sc:sc, x:{k1:k1, ka:kas[ki], k2:k2, ns:ns, b:b, fix:hfix}});
      }
    }
    if(found.length){
      found.sort(function(p,q){ return q.sc-p.sc || p.x.b-q.x.b; });
      for(var fi=0;fi<Math.min(found.length,20);fi++){
        if(scnVerify(raw,found[fi].x)){
          var win = found[fi].x;
          if(log) log.info('xor', 'XOR dual-key terdeteksi (k1=' + hexByte(win.k1) + ', ka=' + hexByte(win.ka) + ', k2=' + hexByte(win.k2) + ', b=0x' + win.b.toString(16) + ')', {
            xor: true, mode: 'dual-key', k1: hexByte(win.k1), ka: hexByte(win.ka), k2: hexByte(win.k2),
            ns: win.ns, b: win.b, fix: win.fix, pass: pass, score: found[fi].sc, candidatesTried: tried, kaCandidates: kas.map(hexByte)
          });
          return win;
        }
        rejectedVerify++;
      }
    }
    found=[];
  }
  var xorFailMsg = 'File ter-XOR (key '+k1.toString(16)+'/'+k2.toString(16)+') tapi batas key gak ketemu. Header: names=0x'+ns.toString(16)+' entries=0x'+ne.toString(16)+' strings=0x'+h.offsetStrings.toString(16)+' ukuran='+raw.length+' – kirim file ini buat dianalisis';
  if(log) log.error('xor', xorFailMsg, {
    k1: hexByte(k1), k2: hexByte(k2), kaCandidates: kas.map(hexByte),
    offsetNames: ns, offsetEntries: ne, offsetStrings: h.offsetStrings,
    offsetStringsData: h.offsetStringsData, size: raw.length, rejectedVerify: rejectedVerify, tried: tried
  });
  throw new Error(xorFailMsg);
}

var SCN_PATCH_NAMES_D = false;
function scnMaskNl(msg){
  var tl=[],n=0;
  var re = cfg.maskJpQuotes ? /%[^;]+;|\[.*?\]|[「」『』]|\\n/g : /%[^;]+;|\[.*?\]|\\n/g;
  var masked=msg.replace(re,function(x){tl.push(x);return'<T'+(++n)+'>';});
  return {masked:masked, tl:tl};
}
function scnStrategyD(psb){
  var entries=[];
  if(!psb.root || psb.root.kind!=='objects') return entries;
  var scenesVal = psbObjValueByName(psb, psb.root.obj, 'scenes');
  if(!scenesVal || scenesVal.kind!=='collection') return entries;
  var sceneCount = psbCollectionSize(scenesVal.col);
  for(var si=0; si<sceneCount; si++){
    var scene = psbColValue(psb, scenesVal.col, si);
    if(!scene || scene.kind!=='objects') continue;
    var textsVal = psbObjValueByName(psb, scene.obj, 'texts');
    if(!textsVal || textsVal.kind!=='collection') continue;
    var tn = psbCollectionSize(textsVal.col);
    for(var ti=0; ti<tn; ti++){
      var tuple = psbColValue(psb, textsVal.col, ti);
      if(!tuple || tuple.kind!=='collection' || psbCollectionSize(tuple.col)<2) continue;
      var langs = psbColValue(psb, tuple.col, 1);
      if(!langs || langs.kind!=='collection' || psbCollectionSize(langs.col)<1) continue;
      var lang0 = psbColValue(psb, langs.col, 0);
      if(!lang0 || lang0.kind!=='collection' || psbCollectionSize(lang0.col)<2) continue;
      var msgNode = psbColValue(psb, lang0.col, 1);
      if(!msgNode || msgNode.kind!=='string') continue;
      var msg = psbResolve(psb, msgNode);
      if(!msg || !msg.trim()) continue;
      var nameNode = psbColValue(psb, tuple.col, 0);
      var name = nameNode && nameNode.kind==='string' ? psbResolve(psb,nameNode) : '';
      var logs=[], ln=psbCollectionSize(lang0.col);
      for(var li=3; li<Math.min(ln,5); li++){
        var lnode = psbColValue(psb, lang0.col, li);
        if(lnode && lnode.kind==='string') logs.push({idx:lnode.index, off:lnode.byteOffset, w:lnode.byteWidth});
      }
      entries.push({name:(name||'').trim(), message:msg,
        nameIdx: (SCN_PATCH_NAMES_D && nameNode && nameNode.kind==='string') ? nameNode.index : null,
        nameIdxOffset: nameNode && nameNode.kind==='string' ? nameNode.byteOffset : null, nameIdxWidth: nameNode && nameNode.kind==='string' ? nameNode.byteWidth : null,
        msgIdx: msgNode.index, msgIdxOffset: msgNode.byteOffset, msgIdxWidth: msgNode.byteWidth,
        logs: logs, nlLit: '\\n', sceneIdx: si});
    }
  }
  return entries;
}

var SCN_STRATEGIES = [
  {id:'shape-a', label:'shape kustom (VN sample pertama)', fn:scnStrategyA},
  {id:'shape-d', label:'texts[i][1][0][1] + backlog slots', fn:scnStrategyD},
  {id:'gardroid-ks', label:'Gardroid ScnKsLogic', fn:scnStrategyB},
  {id:'gardroid-txt',label:'Gardroid ScnTxtLogic', fn:scnStrategyC}
];

function diagnoseZeroStrategy(psb, stratId){
  if(!psb || !psb.root) return 'root PSB kosong';
  if(psb.root.kind !== 'objects') return 'root bukan OBJECTS (' + psb.root.kind + ')';
  if(stratId === 'shape-a' || stratId === 'shape-d'){
    var sc = psbObjValueByName(psb, psb.root.obj, 'scenes');
    if(!sc) return 'tidak ada koleksi "scenes" di root';
    if(sc.kind !== 'collection') return '"scenes" bukan COLLECTION (' + sc.kind + ')';
    var n = psbCollectionSize(sc.col);
    if(n === 0) return 'koleksi "scenes" kosong (0 elemen)';
    var withTexts = 0, missingScene = -1, nonColTuple = 0, shortTuple = 0, nonColTuple1 = 0, emptyMsg = 0;
    for(var i=0;i<n;i++){
      var s = psbColValue(psb, sc.col, i);
      if(!s || s.kind!=='objects'){ if(missingScene<0) missingScene=i; continue; }
      var tx = psbObjValueByName(psb, s.obj, 'texts');
      if(!tx || tx.kind!=='collection'){ if(missingScene<0) missingScene=i; continue; }
      withTexts++;
      var tn = psbCollectionSize(tx.col);
      for(var j=0;j<tn;j++){
        var tp = psbColValue(psb, tx.col, j);
        if(!tp || tp.kind!=='collection'){ nonColTuple++; continue; }
        var tsz = psbCollectionSize(tp.col);
        if(stratId === 'shape-a'){
          if(tsz < 3){ shortTuple++; continue; }
          var mNode = psbColValue(psb, tp.col, 2);
          if(mNode && mNode.kind === 'collection') nonColTuple1++;
          else emptyMsg++;
        } else {
          if(tsz < 2){ shortTuple++; continue; }
          var lNode = psbColValue(psb, tp.col, 1);
          if(!lNode || lNode.kind !== 'collection'){ nonColTuple1++; continue; }
          emptyMsg++;
        }
      }
    }
    if(!withTexts) return 'scene ' + (missingScene >= 0 ? missingScene : 0) + ' tidak punya koleksi "texts"';
    if(stratId === 'shape-a' && nonColTuple1 > 0) return 'tuple[2] bertipe COLLECTION, bukan string (bentuk bersarang)';
    if(stratId === 'shape-d' && nonColTuple1 > 0) return 'tuple[1] bukan COLLECTION bahasa';
    if(shortTuple > 0) return 'ukuran tuple di "texts" terlalu pendek (' + shortTuple + ' tuple)';
    if(emptyMsg > 0) return 'semua kandidat pesan kosong atau bukan string (' + emptyMsg + ' tuple)';
    return 'koleksi "texts" kosong di semua scene';
  }
  // gardroid-ks / gardroid-txt
  var foundKeys = 0, junkFiltered = 0;
  (function walk(node, d){
    if(!node || d>20) return;
    if(node.kind==='objects'){
      var sz=psbObjectsSize(node.obj);
      for(var i=0;i<sz;i++){
        var k=psbObjName(psb,node.obj,i), v=psbObjValue(psb,node.obj,i);
        if((k==='texts'||k==='lines'||(stratId==='gardroid-ks'&&k==='text')) && v && v.kind==='collection'){
          foundKeys++;
          var cn=psbCollectionSize(v.col);
          for(var c=0;c<cn;c++){
            var it=psbColValue(psb,v.col,c);
            if(it && it.kind==='collection' && psbCollectionSize(it.col)>0){
              var n0=scnGetStr(psb, psbColValue(psb,it.col,0));
              if(n0 && SCN_JUNK.has(n0)) junkFiltered++;
            }
          }
        } else if(v && (v.kind==='objects'||v.kind==='collection')) walk(v, d+1);
      }
    } else if(node.kind==='collection'){
      var csz=psbCollectionSize(node.col);
      for(var j=0;j<csz;j++) walk(psbColValue(psb,node.col,j), d+1);
    }
  })(psb.root, 0);
  if(!foundKeys) return 'tidak ada koleksi "texts"/"text"/"lines" di pohon PSB';
  if(junkFiltered > 0) return 'semua tuple terfilter sebagai perintah non-dialog (' + junkFiltered + ' tuple)';
  return 'struktur tuple[1..2][0][1] tidak cocok pada ' + foundKeys + ' koleksi';
}

function collectPsbTreeFacts(psb){
  var rootKeys = [], scenesCount = 0, scenesWithTexts = 0, samplePaths = [], strRefCounts = new Map();
  if(psb.root && psb.root.kind === 'objects'){
    var rsz = psbObjectsSize(psb.root.obj);
    for(var i=0;i<rsz;i++){
      var rk = psbObjName(psb, psb.root.obj, i);
      if(rootKeys.length < 30) rootKeys.push(rk);
    }
    var sc = psbObjValueByName(psb, psb.root.obj, 'scenes');
    if(sc && sc.kind === 'collection'){
      scenesCount = psbCollectionSize(sc.col);
      for(var si=0;si<scenesCount;si++){
        var s = psbColValue(psb, sc.col, si);
        if(s && s.kind === 'objects'){
          var tx = psbObjValueByName(psb, s.obj, 'texts');
          if(tx && tx.kind === 'collection') scenesWithTexts++;
        }
      }
    }
  }
  (function walk(node, pathStr, depth){
    if(!node || depth > 14) return;
    if(node.kind === 'string'){
      strRefCounts.set(node.index, (strRefCounts.get(node.index) || 0) + 1);
      if(samplePaths.length < 12 && pathStr) samplePaths.push(pathStr);
      return;
    }
    if(node.kind === 'objects'){
      var n = psbObjectsSize(node.obj);
      for(var i=0;i<n;i++){
        var k = psbObjName(psb, node.obj, i), v = psbObjValue(psb, node.obj, i);
        walk(v, pathStr ? pathStr + '.' + k : k, depth + 1);
      }
    } else if(node.kind === 'collection'){
      var n2 = psbCollectionSize(node.col);
      for(var j=0;j<n2;j++){
        walk(psbColValue(psb, node.col, j), j === 0 ? pathStr + '[0]' : '', depth + 1);
      }
    }
  })(psb.root, '', 0);
  return {
    rootKind: psb.root ? psb.root.kind : 'null',
    rootKeys: rootKeys,
    stringCount: psb.strings ? psb.strings.entryCount : 0,
    nameCount: psb.str3 ? psb.str3.entryCount : 0,
    chunkCount: psb.chunkOffsets ? psb.chunkOffsets.entryCount : 0,
    scenesCount: scenesCount,
    scenesWithTexts: scenesWithTexts,
    samplePaths: samplePaths,
    strRefCounts: strRefCounts
  };
}

function extractFromScn(buf, sg, opts){
  sg = sg || [];
  var log = opts && opts.log ? normLogger(opts.log) : null;
  var strats = (opts && opts.strategies) || SCN_STRATEGIES;
  if(!log && strats === SCN_STRATEGIES){
    // Fast zero-overhead path when no logger and default strategies
    var xor0 = scnXorDetect(buf);
    var psb0 = parsePsb(xor0 ? scnXorApply(buf, xor0) : buf);
    if(!psb0.root || psb0.root.kind!=='objects') throw new Error('Root bukan OBJECTS – file mungkin bukan .scn PSB yang valid');
    var rawEntries0 = [], usedStrategy0 = null;
    for(var i0=0; i0<SCN_STRATEGIES.length; i0++){
      var s0 = SCN_STRATEGIES[i0];
      try{ rawEntries0 = s0.fn(psb0); }catch(err){ rawEntries0 = []; }
      if(rawEntries0.length){ usedStrategy0 = s0; break; }
    }
    return finishScnExtract(rawEntries0, usedStrategy0, xor0, sg, null, null, null);
  }

  var tStart = nowMs();
  if(log && !(opts && opts._fileLogged)){
    log.info('file', 'Membaca berkas ' + ((opts && opts.name) || 'script.scn') + ' (' + (buf ? buf.length : 0) + ' byte)', {
      name: (opts && opts.name) || 'script.scn',
      size: buf ? buf.length : 0,
      head16: hexHead(buf, 16),
      hash: 'fnv1a:' + fnv1aHex(buf)
    });
  }
  var tXor0 = nowMs();
  var xor = scnXorDetect(buf, { log: log });
  var xorMs = +(nowMs() - tXor0).toFixed(2);

  var tParse0 = nowMs();
  var plainBuf = xor ? scnXorApply(buf, xor) : buf;
  var psb;
  try {
    psb = parsePsb(plainBuf);
  } catch (err) {
    if(log) log.error('container', 'Gagal mengurai struktur PSB: ' + err.message, { error: err.message });
    throw err;
  }
  if(!psb.root || psb.root.kind!=='objects'){
    var rootErr = 'Root bukan OBJECTS – file mungkin bukan .scn PSB yang valid';
    if(log) log.error('container', rootErr, { rootKind: psb.root ? psb.root.kind : null });
    throw new Error(rootErr);
  }
  var parseMs = +(nowMs() - tParse0).toFixed(2);

  if(log){
    var h = psb.hdr;
    log.info('container', 'PSB magic PSB\\0 pada offset 0 (v' + h.version + ', encrypt=' + h.encrypt + ')', {
      psbMagicOffset: 0,
      version: h.version,
      encryptFlag: h.encrypt,
      offsetEncrypt: h.offsetEncrypt,
      offsetNames: h.offsetNames,
      offsetEntries: h.offsetEntries,
      offsetStrings: h.offsetStrings,
      offsetStringsData: h.offsetStringsData,
      offsetChunkOffsets: h.offsetChunkOffsets,
      offsetChunkLengths: h.offsetChunkLengths,
      offsetChunkData: h.offsetChunkData
    });
    var facts = collectPsbTreeFacts(psb);
    log.info('psb', 'Fakta pohon PSB: ' + facts.stringCount + ' string, ' + facts.nameCount + ' nama, ' + facts.chunkCount + ' chunk, ' + facts.scenesCount + ' scene', {
      rootKind: facts.rootKind,
      rootKeys: facts.rootKeys,
      stringCount: facts.stringCount,
      nameCount: facts.nameCount,
      chunkCount: facts.chunkCount,
      scenesCount: facts.scenesCount,
      scenesWithTexts: facts.scenesWithTexts,
      samplePaths: facts.samplePaths
    });
  }

  var tStrat0 = nowMs();
  var rawEntries = [], usedStrategy = null;
  for(var i=0; i<strats.length; i++){
    var s = strats[i], ts0 = nowMs(), threw = null;
    try{ rawEntries = s.fn(psb) || []; }catch(err){ rawEntries = []; threw = err; }
    var dMs = +(nowMs() - ts0).toFixed(2);
    if(log){
      if(threw){
        var topStack = String(threw.stack || threw.message || threw).split('\n').slice(0, 4).join(' | ');
        log.warn('strategy', 'Strategi ' + s.id + ' (' + s.label + ') melempar error: ' + threw.message, {
          id: s.id, label: s.label, started: true, entriesFound: 0, durationMs: dMs, chosen: false,
          error: threw.message, stack: topStack
        });
      } else if(rawEntries.length > 0){
        log.info('strategy', 'Strategi ' + s.id + ' (' + s.label + ') dipilih → ' + rawEntries.length + ' entri (' + dMs + 'ms)', {
          id: s.id, label: s.label, started: true, entriesFound: rawEntries.length, durationMs: dMs, chosen: true
        });
      } else {
        var why0 = diagnoseZeroStrategy(psb, s.id);
        log.info('strategy', 'Strategi ' + s.id + ' (' + s.label + ') → 0 entri: ' + why0, {
          id: s.id, label: s.label, started: true, entriesFound: 0, durationMs: dMs, chosen: false, zeroReason: why0
        });
      }
    }
    if(rawEntries.length){ usedStrategy = s; break; }
  }
  var strategyMs = +(nowMs() - tStrat0).toFixed(2);
  if(log && !usedStrategy){
    log.warn('strategy', 'Semua strategi menghasilkan 0 entri dari berkas .scn ini', {
      chosen: null, tried: strats.map(function(x){ return x.id; })
    });
  }

  return finishScnExtract(rawEntries, usedStrategy, xor, sg, log, psb, {
    unwrapMs: (opts && opts.unwrapMs) || 0,
    xorMs: xorMs,
    parseMs: parseMs,
    strategyMs: strategyMs,
    tStart: tStart
  });
}

function finishScnExtract(rawEntries, usedStrategy, xor, sg, log, psb, timing){
  var tMask0 = log ? nowMs() : 0;
  var dialogIndent = {n:0, y:0};
  for(var pi0=0; pi0<rawEntries.length; pi0++){
    var m0 = rawEntries[pi0].message;
    if(!rawEntries[pi0].nlLit && m0 && m0.charAt(0)==='\u300c' && m0.indexOf('\n')>=0){
      var c0 = m0.split('\n').slice(1); dialogIndent.n++;
      if(c0.every(function(p){return p.charAt(0)==='\u3000';})) dialogIndent.y++;
    }
  }
  var useDialogIndent = dialogIndent.n>0 && dialogIndent.y===dialogIndent.n;
  var lines=[], tagStore={};
  var namedCount = 0, narrationCount = 0, realNlCount = 0, litNlCount = 0, backlogCount = 0, taggedCount = 0;
  var perScene = {}, msgSlotUse = new Map(), nameSlotUse = new Map(), ctrlWarn = [], longWarn = [], utf8Warn = [];

  for(var idx=0; idx<rawEntries.length; idx++){
    var e = rawEntries[idx];
    var rawName = e.name || 'Narasi';
    if(e.name && e.name.trim()) namedCount++; else narrationCount++;
    if(e.sceneIdx !== undefined) perScene[e.sceneIdx] = (perScene[e.sceneIdx] || 0) + 1;
    var name3 = sg.length ? applyGls(rawName,sg) : rawName;
    var msgSrc = e.message, nlReal = 0, nlIndent = '';
    if(!e.nlLit && msgSrc.indexOf('\n')>=0){
      var parts = msgSrc.split('\n'); nlReal = parts.length;
      realNlCount++;
      var allInd = parts.slice(1).every(function(p){return p.charAt(0)==='\u3000';});
      if(allInd) nlIndent = '\u3000';
      var joined = parts[0];
      for(var pj=1; pj<parts.length; pj++){
        var pp = allInd ? parts[pj].slice(1) : parts[pj];
        joined += (/^[A-Za-z0-9,.:!?]$/.test(joined.slice(-1)) && /^[A-Za-z0-9]/.test(pp) ? ' ' : '') + pp;
      }
      msgSrc = joined;
    } else if(!e.nlLit && useDialogIndent && msgSrc.charAt(0)==='\u300c') nlIndent = '\u3000';
    if(e.nlLit && msgSrc.indexOf('\\n') >= 0) litNlCount++;
    if(e.logs && e.logs.length) backlogCount++;
    var dialog = sg.length ? applyGls(msgSrc,sg) : msgSrc;
    var mt = e.nlLit ? scnMaskNl(dialog) : maskTxtTags(dialog);
    if(mt.tl && mt.tl.length) taggedCount++;
    tagStore[idx] = {tl:mt.tl, msgIdx:e.msgIdx, nameIdx:e.nameIdx, msgIdxOffset:e.msgIdxOffset, msgIdxWidth:e.msgIdxWidth};
    if(e.nameIdxOffset!=null){ tagStore[idx].nameIdxOffset = e.nameIdxOffset; tagStore[idx].nameIdxWidth = e.nameIdxWidth; }
    if(nlReal) tagStore[idx].nlReal = nlReal;
    if(nlIndent) tagStore[idx].nlIndent = nlIndent;
    if(e.logs) tagStore[idx].logs = e.logs;
    if(e.nlLit) tagStore[idx].nlLit = e.nlLit;
    lines.push('['+idx+'|'+name3+'] '+mt.masked);

    if(log){
      if(e.msgIdx != null){
        var mu = msgSlotUse.get(e.msgIdx) || [];
        mu.push(idx);
        msgSlotUse.set(e.msgIdx, mu);
      }
      if(e.nameIdx != null){
        var nu = nameSlotUse.get(e.nameIdx) || [];
        nu.push(idx);
        nameSlotUse.set(e.nameIdx, nu);
      }
      if(/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(e.message)) ctrlWarn.push(idx);
      if(e.message.indexOf('\uFFFD') >= 0) utf8Warn.push(idx);
      if(e.message.length > 500) longWarn.push({ idx: idx, len: e.message.length });
    }
  }

  if(log){
    var maskMs = +(nowMs() - tMask0).toFixed(2);
    var first5 = rawEntries.slice(0, 5).map(function(x, k){ return { idx: k, name: x.name || 'Narasi', text: x.message.slice(0, 80) }; });
    var last3 = rawEntries.length > 5 ? rawEntries.slice(-3).map(function(x, k){ return { idx: rawEntries.length - 3 + k, name: x.name || 'Narasi', text: x.message.slice(0, 80) }; }) : [];
    log.info('entries', 'Diekstrak ' + rawEntries.length + ' entri (' + namedCount + ' bernama, ' + narrationCount + ' narasi)', {
      total: rawEntries.length,
      named: namedCount,
      narration: narrationCount,
      realNewlineEntries: realNlCount,
      literalNewlineEntries: litNlCount,
      backlogSlotEntries: backlogCount,
      taggedEntries: taggedCount,
      dialogIndent: useDialogIndent,
      perSceneCounts: perScene,
      first5: first5,
      last3: last3
    });

    // Stage 7: Warnings that matter
    var dupMsgSlots = [];
    msgSlotUse.forEach(function(idxs, slot){ if(idxs.length > 1) dupMsgSlots.push({ slot: slot, entries: idxs }); });
    if(dupMsgSlots.length){
      log.warn('warnings', dupMsgSlots.length + ' slot string pesan dipakai bersama oleh beberapa entri (akan di-split saat repack)', { sharedMsgSlots: dupMsgSlots });
    }
    if(psb){
      var facts2 = collectPsbTreeFacts(psb), sharedNonText = [];
      msgSlotUse.forEach(function(idxs, slot){
        var totalRefs = facts2.strRefCounts.get(slot) || 0;
        if(totalRefs > idxs.length) sharedNonText.push({ slot: slot, entryRefs: idxs.length, totalTreeRefs: totalRefs });
      });
      if(sharedNonText.length){
        log.warn('warnings', sharedNonText.length + ' slot string pesan juga direferensikan node lain di luar dialog', { sharedWithNonDialogue: sharedNonText });
      }
    }
    if(usedStrategy && usedStrategy.id === 'shape-d' && !SCN_PATCH_NAMES_D){
      log.info('warnings', 'Strategi shape-d menonaktifkan patch nama pembicara secara bawaan (SCN_PATCH_NAMES_D=false) demi keamanan slot nama', { SCN_PATCH_NAMES_D: SCN_PATCH_NAMES_D });
    }
    if(ctrlWarn.length){
      log.warn('warnings', ctrlWarn.length + ' entri mengandung byte kontrol tak lazim', { entries: ctrlWarn });
    }
    if(utf8Warn.length){
      log.warn('warnings', utf8Warn.length + ' entri mengandung karakter pengganti UTF-8 (U+FFFD)', { entries: utf8Warn });
    }
    if(longWarn.length){
      log.warn('warnings', longWarn.length + ' entri memiliki teks sangat panjang (>500 karakter)', { entries: longWarn });
    }
    var totalMs = timing ? +(nowMs() - timing.tStart).toFixed(2) : maskMs;
    log.info('timing', 'Selesai dalam ' + totalMs + 'ms', {
      unwrapMs: timing ? timing.unwrapMs : 0,
      xorMs: timing ? timing.xorMs : 0,
      parseMs: timing ? timing.parseMs : 0,
      strategyMs: timing ? timing.strategyMs : 0,
      maskMs: maskMs,
      totalMs: totalMs
    });
  }

  return {lines:lines, tagStore:tagStore, entryCount:rawEntries.length, strategy: usedStrategy ? usedStrategy.id : null, xor:xor};
}

// — SCN REPACK ————————————————————————————————————————————————
function psbWriteLE32(arr, pos, v){
  arr[pos]   = v & 0xFF;
  arr[pos+1] = (v >>> 8) & 0xFF;
  arr[pos+2] = (v >>> 16) & 0xFF;
  arr[pos+3] = (v >>> 24) & 0xFF;
}

function psbByteWidthFor(maxVal){
  if(maxVal <= 0xFF) return 1;
  if(maxVal <= 0xFFFF) return 2;
  if(maxVal <= 0xFFFFFF) return 3;
  return 4;
}

function encodePsbArrayBytes(values){
  var n = values.length;
  var maxV = 0;
  for(var i=0;i<n;i++){ if(values[i] > maxV) maxV = values[i]; }
  var entryLength = psbByteWidthFor(maxV);
  var countWidth = psbByteWidthFor(n);
  var out = [];
  out.push(0xC + countWidth);
  for(var ci=0; ci<countWidth; ci++) out.push((n >>> (ci*8)) & 0xFF);
  out.push(0xC + entryLength);
  for(var vi=0; vi<n; vi++){
    var v = values[vi];
    for(var bi=0; bi<entryLength; bi++) out.push((v >>> (bi*8)) & 0xFF);
  }
  return new Uint8Array(out);
}

function psbRewriteEntries(buf, hdr, patchMap){
  var applied = new Set();
  function wFor(v){ var w=1; while(v>=Math.pow(256,w)) w++; return w; }
  function arrInfo(pos, end){
    var t=buf[pos];
    if(!(t>=PSB_T.ARR1 && t<=PSB_T.ARR8)) throw new Error('bukan array @'+pos);
    var cw=t-0xC, p=pos+1;
    if(p+cw+1>end) throw new Error('array kepotong');
    var n=psbReadLE(buf,p,cw); p+=cw;
    var elb=buf[p]; p++;
    if(!(elb>=PSB_T.ARR1 && elb<=PSB_T.ARR8)) throw new Error('lebar entry array ngaco');
    var el=elb-0xC;
    if(n*el>end-p) throw new Error('array melebihi container');
    var vals=[], i, j, v;
    for(i=0;i<n;i++){ v=0; for(j=0;j<el;j++) v+=buf[p+i*el+j]*Math.pow(256,j); vals.push(v); }
    return {n:n, el:el, cw:cw, vals:vals, end:p+n*el};
  }
  function encArr(vals, minLen, minCountW){
    var n=vals.length, maxV=0, i;
    for(i=0;i<n;i++) if(vals[i]>maxV) maxV=vals[i];
    var el=Math.max(wFor(maxV), minLen), cw=Math.max(wFor(n), minCountW);
    var out=[0xC+cw], ci, bi;
    for(ci=0;ci<cw;ci++) out.push((n>>>(ci*8))&0xFF);
    out.push(0xC+el);
    for(i=0;i<n;i++) for(bi=0;bi<el;bi++) out.push(Math.floor(vals[i]/Math.pow(256,bi))&0xFF);
    return new Uint8Array(out);
  }
  function concat(list){
    var t=0,i; for(i=0;i<list.length;i++) t+=list[i].length;
    var o=new Uint8Array(t), p=0; for(i=0;i<list.length;i++){ o.set(list[i],p); p+=list[i].length; }
    return o;
  }
  function container(pos, end, pm){
    var type=buf[pos], p=pos+1, namesRaw=null, ni=null;
    if(type===PSB_T.OBJECTS){ ni=arrInfo(p,end); namesRaw=buf.slice(p,ni.end); p=ni.end; }
    var oi=arrInfo(p,end);
    if(ni && ni.n!==oi.n) return null;
    var base=oi.end, span=end-base, uniq=[], seen={}, i;
    for(i=0;i<oi.vals.length;i++){
      var v=oi.vals[i];
      if(v>=span) return null;
      if(!seen[v]){ seen[v]=1; uniq.push(v); }
    }
    uniq.sort(function(x,y){return x-y;});
    var pre = uniq.length ? buf.slice(base, base+uniq[0]) : buf.slice(base, end);
    var chunks=[pre], cur=pre.length, newOff={};
    for(var j=0;j<uniq.length;j++){
      var s0=base+uniq[j], e0=(j+1<uniq.length) ? base+uniq[j+1] : end;
      var kb=node(s0, e0, pm);
      newOff[uniq[j]]=cur; chunks.push(kb); cur+=kb.length;
    }
    var offs=oi.vals.map(function(x){ return newOff[x]; });
    var head=[new Uint8Array([type])];
    if(namesRaw) head.push(namesRaw);
    head.push(encArr(offs, oi.el, oi.cw));
    return concat(head.concat(chunks));
  }
  function node(pos, end, pm){
    var type=buf[pos];
    if(type===PSB_T.OBJECTS || type===PSB_T.COLLECTION){
      var snap=new Set(applied);
      try{ var r=container(pos,end,pm); if(r) return r; }catch(e){}
      applied=snap;
      return buf.slice(pos,end);
    }
    if(type>=PSB_T.STR1 && type<=PSB_T.STR4 && pm.has(pos+1)){
      var w=type-0x14, idx=pm.get(pos+1);
      if(pos+1+w<=end){
        var nw=w; while(idx>=Math.pow(256,nw)) nw++;
        if(nw>4) throw new Error('index string > 4 byte');
        var ob=[0x14+nw]; for(var b=0;b<nw;b++) ob.push(Math.floor(idx/Math.pow(256,b))&0xFF);
        applied.add(pos+1);
        return concat([new Uint8Array(ob), buf.slice(pos+1+w, end)]);
      }
    }
    return buf.slice(pos,end);
  }
  var orig=buf.subarray(hdr.offsetEntries, hdr.offsetStrings);
  var ident=node(hdr.offsetEntries, hdr.offsetStrings, new Map());
  if(ident.length!==orig.length) throw new Error('rewrite tidak identik (panjang '+ident.length+' vs '+orig.length+')');
  for(var k=0;k<orig.length;k++) if(ident[k]!==orig[k]) throw new Error('rewrite tidak identik (byte '+k+')');
  applied=new Set();
  var res=node(hdr.offsetEntries, hdr.offsetStrings, patchMap);
  if(applied.size!==patchMap.size) throw new Error('patch tidak semua ter-apply ('+applied.size+'/'+patchMap.size+')');
  return res;
}

function scnIsRubyTag(tag){
  if(!tag) return false;
  return /^\[\s*ruby\b/i.test(tag) || /^%r(?:uby)?[,;]/i.test(tag) || /^\[[\u3040-\u30FF\u30FC\u4E00-\u9FFF\s]+\]$/.test(tag);
}

function scnUnmask(text, tl, label, warnings, lost){
  var used={};
  var spaced=String(text||'').replace(/([A-Za-z0-9])((?:<T\d+>)+)(?=[A-Za-z0-9])/g,'$1 $2');
  var out=spaced.replace(/<T(\d+)>/g,function(m,n){
    var i=parseInt(n,10)-1;
    if(i>=0 && i<tl.length){
      used[i]=1;
      if(scnIsRubyTag(tl[i])) return '';
      return tl[i];
    }
    warnings.push('Entry "'+label+'": <T'+n+'> gak ada di sumber (sumber cuma punya '+tl.length+' tag) – token dibuang. Cek hasil MT.');
    return '';
  }).replace(/  +/g,' ');
  var miss=[]; for(var j=0;j<tl.length;j++) if(!used[j] && !scnIsRubyTag(tl[j])) miss.push('<T'+(j+1)+'>');
  if(miss.length) lost.push(label+' '+miss.join(''));
  return out;
}

function scnWrapToLines(text, n, nl){
  if(n<=1) return text;
  var w = Math.ceil(text.length/n);
  for(; w<=text.length; w++){
    var words = text.split(' '), ls = [], cur = '';
    for(var i=0;i<words.length;i++){
      if(!cur){cur=words[i];continue}
      if((cur+' '+words[i]).length<=w) cur+=' '+words[i]; else {ls.push(cur);cur=words[i]}
    }
    if(cur) ls.push(cur);
    if(ls.length<=n) return ls.join(nl);
  }
  return text;
}

function scnIsMdf(b){ return b.length>8 && b[0]===0x6d && b[1]===0x64 && b[2]===0x66 && b[3]===0; }
async function scnPipe(bytes, stream){
  var res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}
async function scnMdfUnwrap(buf, opts){
  var log = opts && opts.log ? normLogger(opts.log) : null;
  if(!scnIsMdf(buf)){
    if(log) log.info('container', 'Magic MDF tidak ditemukan; berkas dibaca sebagai PSB langsung', { mdf: false, head8: scnHex(buf, 8) });
    return {buf:buf, mdf:false};
  }
  if(typeof DecompressionStream==='undefined') throw new Error('Browser gak support DecompressionStream (pakai Chrome/Edge/Firefox terbaru)');
  var t0 = log ? nowMs() : 0;
  var declared = psbReadLE(buf,4,4);
  var plain;
  try {
    plain = await scnPipe(buf.subarray(8), new DecompressionStream('deflate'));
  } catch (err) {
    if(log) log.error('container', 'MDF gagal didekompresi (zlib/deflate): ' + err.message, { mdf: true, compressedBytes: buf.length, declaredBytes: declared, error: err.message });
    throw err;
  }
  if(declared!==plain.length){
    var szErr = 'MDF: ukuran deklarasi '+declared+' != hasil dekompresi '+plain.length;
    if(log) log.error('container', szErr, { mdf: true, declaredBytes: declared, decompressedBytes: plain.length });
    throw new Error(szErr);
  }
  if(log){
    var dMs = +(nowMs() - t0).toFixed(2);
    log.info('container', 'MDF terdeteksi → dekompresi zlib OK (' + buf.length + ' → ' + plain.length + ' byte dalam ' + dMs + 'ms)', {
      mdf: true, compressedBytes: buf.length, decompressedBytes: plain.length, durationMs: dMs
    });
  }
  return {buf:plain, mdf:true};
}
async function scnMdfWrap(plain, opts){
  var log = opts && opts.log ? normLogger(opts.log) : null;
  if(typeof CompressionStream==='undefined') throw new Error('Browser gak support CompressionStream');
  var t0 = log ? nowMs() : 0;
  var z = await scnPipe(plain, new CompressionStream('deflate'));
  var out = new Uint8Array(8+z.length);
  out[0]=0x6d; out[1]=0x64; out[2]=0x66; out[3]=0; psbWriteLE32(out,4,plain.length); out.set(z,8);
  if(log){
    var dMs = +(nowMs() - t0).toFixed(2);
    log.info('rewrap', 'MDF dikompres ulang (' + plain.length + ' → ' + out.length + ' byte dalam ' + dMs + 'ms)', {
      mdf: true, plainBytes: plain.length, compressedBytes: out.length, durationMs: dMs
    });
  }
  return out;
}

function repackScn(origBuf, tagStore, translations, wrapWidth, nlStr, opts){
  var log = opts && opts.log ? normLogger(opts.log) : null;
  var res, fallbackUsed = false, fallbackReason = null;
  try{
    res = repackScnImpl(origBuf, tagStore, translations, wrapWidth, nlStr, true, log);
  } catch(e){
    if(e && e.psbRewrite){
      fallbackUsed = true;
      fallbackReason = e.message;
      if(log) log.warn('strings', 'Perluasan lebar indeks STR gagal (' + e.message + '); beralih ke fallback allowWiden=false', { fallback: 'allowWiden=false', reason: e.message });
      res = repackScnImpl(origBuf, tagStore, translations, wrapWidth, nlStr, false, log);
    } else {
      if(log) log.error('repack', 'Repack gagal: ' + e.message, { error: e.message });
      throw e;
    }
  }
  if(opts && typeof opts._corruptOutput === 'function'){
    res.buf = opts._corruptOutput(res.buf);
  }
  // Self-verification: when logger is active or opts.verify is requested, re-parse the repacked buffer and compare entry count & masked structure
  if(log || (opts && opts.verify)){
    var vRes = verifyRepackedScn(origBuf, res.buf, tagStore, translations, wrapWidth, log);
    res.verifyOk = vRes.ok;
    res.verifyErrors = vRes.errors;
    if(!vRes.ok){
      var vMsg = 'Hasil repack gagal diverifikasi — jangan dipakai (' + vRes.errors[0] + ')';
      res.warnings.push(vMsg);
    }
  }
  if(fallbackUsed) res.fallbackUsed = fallbackReason;
  return res;
}

function verifyRepackedScn(origBuf, outBuf, tagStore, translations, wrapWidth, log){
  var errors = [];
  var expectedCount = Object.keys(tagStore || {}).length;
  var reEx;
  try {
    reEx = extractFromScn(outBuf, []);
  } catch (err) {
    errors.push('Gagal mengurai ulang hasil repack: ' + err.message);
    if(log) log.error('verify', 'Hasil repack gagal diverifikasi — jangan dipakai: gagal mengurai ulang (' + err.message + ')', { verify: 'mismatch', error: err.message });
    return { ok: false, errors: errors };
  }
  if(reEx.entryCount !== expectedCount){
    var cntMsg = 'Jumlah entri berubah setelah repack (sebelum=' + expectedCount + ', sesudah=' + reEx.entryCount + ')';
    errors.push(cntMsg);
    if(log) log.error('verify', 'Hasil repack gagal diverifikasi — jangan dipakai: ' + cntMsg, { verify: 'mismatch', expectedCount: expectedCount, actualCount: reEx.entryCount });
    return { ok: false, errors: errors };
  }
  // Check each translated entry's masked tag count & non-empty body
  var tKeys = Object.keys(translations || {});
  for(var i=0; i<tKeys.length; i++){
    var k = tKeys[i], idx = parseInt(k, 10);
    var store = tagStore[k];
    var tr = translations[k];
    if(!store || !tr || !tr[1] || !tr[1].trim()) continue;
    var line = reEx.lines[idx] || '';
    var m = /^\[\d+\|([^\]]*)\] (.*)$/.exec(line);
    if(!m){
      errors.push('Entri #' + k + ' tidak terbaca saat ekstraksi ulang');
      break;
    }
    var reMasked = m[2];
    var origTags = (tr[1].match(/<T\d+>/g) || []).filter(function(t){
      var n = parseInt(t.slice(2, -1), 10) - 1;
      return n >= 0 && n < (store.tl ? store.tl.length : 0) && !scnIsRubyTag(store.tl[n]);
    });
    var reTags = reMasked.match(/<T\d+>/g) || [];
    if(reTags.length < origTags.length){
      errors.push('Entri #' + k + ' kehilangan tag setelah repack (diharapkan ' + origTags.length + ' tag, ditemukan ' + reTags.length + ')');
      break;
    }
  }
  if(errors.length){
    if(log) log.error('verify', 'Hasil repack gagal diverifikasi — jangan dipakai: ' + errors[0], { verify: 'mismatch', firstError: errors[0], totalErrors: errors.length });
    return { ok: false, errors: errors };
  }
  if(log) log.info('verify', 'Verifikasi mandiri OK: ' + reEx.entryCount + ' entri cocok & struktur tag utuh', { verify: 'ok', entryCount: reEx.entryCount });
  return { ok: true, errors: [] };
}

function repackScnImpl(origBuf, tagStore, translations, wrapWidth, nlStr, allowWiden, log){
  var xor = scnXorDetect(origBuf);
  var buf = xor ? scnXorApply(origBuf, xor) : origBuf;
  var psb = parsePsb(buf);
  if(!psb.root || psb.root.kind!=='objects') throw new Error('Root bukan OBJECTS – file .scn tidak valid');

  var stringCount = psb.strings.entryCount;
  var origIndexWidth = psb.strings.entryLength;
  var newVals = new Array(stringCount);
  for(var i=0;i<stringCount;i++) newVals[i] = psbStr(psb, i);

  var totalEntries = Object.keys(tagStore || {}).length;
  var tKeys = Object.keys(translations);
  var desired = [], tagWarn = [], tagLost = [], wrappedLines = 0, exceedingWidth = 0, skippedEmpty = 0;
  for(var ti=0; ti<tKeys.length; ti++){
    var idx = tKeys[ti];
    var store = tagStore[idx];
    if(!store) continue;
    var val = translations[idx];
    if(!val || !val[1] || !String(val[1]).trim()){ skippedEmpty++; continue; }
    var newName = val[0], translatedMasked = val[1];
    var tl = store.tl || [];
    var nlUse = store.nlLit || ('\n' + (store.nlIndent || ''));
    var wrapped = (store.nlReal && !(wrapWidth>0)) ? scnWrapToLines(translatedMasked, store.nlReal, nlUse) : wrapText(translatedMasked, wrapWidth||0, nlUse);
    if(wrapped !== translatedMasked) wrappedLines++;
    if(wrapWidth > 0){
      var segs = wrapped.split(nlUse);
      if(segs.some(function(sg){ return sg.replace(/<T\d+>/g, '').length > wrapWidth; })) exceedingWidth++;
    }
    var unmasked = scnUnmask(wrapped, tl, idx, tagWarn, tagLost);
    desired.push({idx:idx, store:store, text:unmasked, newName:newName});
  }

  var slotOwner = new Map();
  var extraSlots = [];
  var patches = [];
  var warnings = tagWarn.slice();
  if(tagLost.length) warnings.push(tagLost.length+' entry kehilangan tag <Tn> di terjemahan (kode/tanda kutip asli ikut hilang). Contoh: '+tagLost.slice(0,6).join(' | ')+(tagLost.length>6?' ...':'')+'. Pastikan MT menyalin semua <Tn>.');
  var changed = 0, splitCount = 0, nameSplit = 0, legacyName = 0, backlogPatched = 0, nameSlotMap = new Map(), nameWarn = [];

  function claim(slotIdx, off, w, text, entryIdx){
    if(slotIdx==null || slotIdx<0 || slotIdx>=baseCount) return false;
    var owner = slotOwner.get(slotIdx);
    if(!owner){
      newVals[slotIdx] = text;
      slotOwner.set(slotIdx, {text:text, ownerIdx:entryIdx});
      return true;
    }
    if(owner.text === text) return false;
    if(off==null || w==null){
      warnings.push('Entry "'+entryIdx+'" berbagi string slot #'+slotIdx+' dgn entry "'+owner.ownerIdx+'" tapi tidak ada byte-offset tersimpan (Kirikiri_Tags.json lama?) – pakai teks entry "'+owner.ownerIdx+'", extract ulang buat fix.');
      return false;
    }
    var newIndex = baseCount + extraSlots.length;
    var maxForWidth = Math.pow(256, w) - 1;
    var widen = false;
    if(newIndex > maxForWidth){
      if(allowWiden) widen = true; else {
        warnings.push('Entry "'+entryIdx+'" berbagi string slot #'+slotIdx+' dgn entry "'+owner.ownerIdx+'", tapi STR-node-nya cuma '+w+'-byte (max '+maxForWidth+') – gak muat dialihin ke slot baru. Pakai teks entry "'+owner.ownerIdx+'" (perlu Rebuild penuh buat fix ini, di luar scope Repack).');
        return false; }
    }
    extraSlots.push(text);
    patches.push({byteOffset:off, byteWidth:w, newIndex:newIndex, widen:widen});
    splitCount++;
    return true;
  }

  var baseCount = stringCount;

  for(var di=0; di<desired.length; di++){
    var d = desired[di], store = d.store;
    if(claim(store.msgIdx, store.msgIdxOffset, store.msgIdxWidth, d.text, d.idx)) changed++;
    var origMsg = (store.msgIdx!=null && store.msgIdx>=0 && store.msgIdx<baseCount) ? psbStr(psb, store.msgIdx) : null;
    if(store.logs && store.logs.length && d.text !== origMsg){
      var logText = d.text.replace(/%[^;]+;/g,'').split('\\n').join(' ').replace(/ {2,}/g,' ').trim();
      for(var lg=0; lg<store.logs.length; lg++){
        var L = store.logs[lg];
        if(claim(L.idx, L.off, L.w, logText, d.idx)) backlogPatched++;
      }
    }
    if(store.nameIdx!=null && store.nameIdx>=0 && store.nameIdx<baseCount &&
      d.newName && d.newName.trim() && d.newName.toLowerCase()!=='narasi' &&
      d.newName !== psbStr(psb, store.nameIdx)){
      if(store.nameIdxOffset!=null && store.nameIdxWidth!=null){
        var nIdx = nameSlotMap.get(d.newName);
        if(nIdx===undefined){ nIdx = baseCount + extraSlots.length; nameSlotMap.set(d.newName, nIdx); extraSlots.push(d.newName); }
        var nMax = Math.pow(256, store.nameIdxWidth) - 1, nWiden = false;
        if(nIdx > nMax){
          if(allowWiden) nWiden = true;
          else { nameWarn.push('Entry "'+d.idx+'": node nama 1-byte gak muat slot baru, nama dibiarkan asli.'); continue; }
        }
        patches.push({byteOffset:store.nameIdxOffset, byteWidth:store.nameIdxWidth, newIndex:nIdx, widen:nWiden});
        nameSplit++;
      } else {
        newVals[store.nameIdx] = d.newName;
        legacyName++;
      }
    }
  }
  nameWarn.forEach(function(w){ warnings.push(w); });
  if(legacyName) warnings.push(legacyName+' nama diubah in-place (Kirikiri_Tags.json lama). Slot nama bisa dipakai node lain (mis. nama sprite) – Extract ulang biar nama dipatch per-node.');
  for(var ei=0; ei<extraSlots.length; ei++) newVals.push(extraSlots[ei]);
  stringCount = newVals.length;

  var enc = new TextEncoder();
  var offsets = new Array(stringCount);
  var chunks = [];
  var cursor = 0;
  for(var si=0; si<stringCount; si++){
    offsets[si] = cursor;
    var bytes = enc.encode(newVals[si]==null ? '' : newVals[si]);
    chunks.push(bytes); chunks.push(new Uint8Array([0]));
    cursor += bytes.length + 1;
  }
  var stringsDataBytes = new Uint8Array(cursor);
  var wp = 0;
  for(var ci2=0; ci2<chunks.length; ci2++){ stringsDataBytes.set(chunks[ci2], wp); wp += chunks[ci2].length; }
  var stringsArrayBytes = encodePsbArrayBytes(offsets);

  var hdr = psb.hdr;
  var origStringsDataSize = hdr.offsetChunkOffsets - hdr.offsetStringsData;
  var needRewrite = patches.some(function(p){ return p.widen; });
  var head, widenedCount = 0;
  if(needRewrite){
    var pm = new Map(); patches.forEach(function(p){ pm.set(p.byteOffset, p.newIndex); if(p.widen) widenedCount++; });
    var ent;
    try{ ent = psbRewriteEntries(buf, hdr, pm); }
    catch(err){ err.psbRewrite = true; throw err; }
    head = new Uint8Array(hdr.offsetEntries + ent.length);
    head.set(buf.subarray(0, hdr.offsetEntries), 0);
    head.set(ent, hdr.offsetEntries);
  } else {
    head = buf.slice(0, hdr.offsetStrings);
  }
  var tail = buf.slice(hdr.offsetChunkOffsets);

  if(!needRewrite) for(var pi=0; pi<patches.length; pi++){
    var p = patches[pi];
    for(var bi=0; bi<p.byteWidth; bi++) head[p.byteOffset+bi] = (p.newIndex >>> (bi*8)) & 0xFF;
  }

  var newOffsetStrings = head.length;
  var newOffsetStringsData = newOffsetStrings + stringsArrayBytes.length;
  var newOffsetChunkOffsets = newOffsetStringsData + stringsDataBytes.length;
  var chunkOffsetsLen = hdr.offsetChunkLengths - hdr.offsetChunkOffsets;
  var newOffsetChunkLengths = newOffsetChunkOffsets + chunkOffsetsLen;
  var chunkLengthsLen = hdr.offsetChunkData - hdr.offsetChunkLengths;
  var newOffsetChunkData = newOffsetChunkLengths + chunkLengthsLen;

  psbWriteLE32(head, 16, newOffsetStrings);
  psbWriteLE32(head, 20, newOffsetStringsData);
  psbWriteLE32(head, 24, newOffsetChunkOffsets);
  psbWriteLE32(head, 28, newOffsetChunkLengths);
  psbWriteLE32(head, 32, newOffsetChunkData);

  var out = new Uint8Array(head.length + stringsArrayBytes.length + stringsDataBytes.length + tail.length);
  var p = 0;
  out.set(head, p); p += head.length;
  out.set(stringsArrayBytes, p); p += stringsArrayBytes.length;
  out.set(stringsDataBytes, p); p += stringsDataBytes.length;
  out.set(tail, p); p += tail.length;

  var finalBuf = xor ? scnXorEncode(out, xor, origBuf) : out;

  if(log){
    var untran = Math.max(0, totalEntries - desired.length);
    log.info('input', 'Input repack: ' + desired.length + '/' + totalEntries + ' entri diterjemahkan (' + untran + ' dilewati)', {
      entryCount: totalEntries, translatedCount: desired.length, skippedUntranslated: untran,
      msgPatched: changed, namePatched: nameSplit + legacyName, backlogPatched: backlogPatched
    });
    log.info('strings', 'Rebuild tabel string: ' + baseCount + ' → ' + stringCount + ' string (data ' + origStringsDataSize + ' → ' + stringsDataBytes.length + ' byte)', {
      oldStringCount: baseCount, newStringCount: stringCount,
      oldStringsDataBytes: origStringsDataSize, newStringsDataBytes: stringsDataBytes.length,
      offsetStringsShift: newOffsetStrings - hdr.offsetStrings,
      offsetChunkDataShift: newOffsetChunkData - hdr.offsetChunkData,
      nameTrieTouched: false,
      origIndexWidth: origIndexWidth,
      newIndexWidth: psbByteWidthFor(Math.max(0, stringCount - 1)),
      widenedNodes: widenedCount,
      treeRewritten: needRewrite,
      allowWiden: allowWiden
    });
    log.info('wrap', 'Statistik wrap (wrapWidth=' + (wrapWidth || 0) + '): ' + wrappedLines + ' baris di-wrap, ' + exceedingWidth + ' melebihi batas', {
      wrapWidth: wrapWidth || 0, linesWrapped: wrappedLines, linesExceedingWidth: exceedingWidth
    });
    if(xor){
      log.info('rewrap', 'XOR diterapkan ulang (k1=' + hexByte(xor.k1) + ', ka=' + hexByte(xor.ka) + ', k2=' + hexByte(xor.k2) + ')', {
        xor: true, k1: hexByte(xor.k1), ka: hexByte(xor.ka), k2: hexByte(xor.k2)
      });
    } else {
      log.info('rewrap', 'Tanpa XOR (PSB polos)', { xor: false });
    }
    for(var wi=0; wi<warnings.length; wi++){
      log.warn('repack', warnings[wi]);
    }
  }

  return {buf: finalBuf, changed: changed, splitCount: splitCount, nameSplit: nameSplit, backlogPatched: backlogPatched, widened: widenedCount, warnings: warnings};
}

export { extractFromScn, repackScn, scnMdfUnwrap, scnMdfWrap, scnXorDetect, scnXorApply, scnXorEncode, parsePsb, PSB_T, psbUnpack, psbObjectsSize, psbObjName, psbObjValue, psbCollectionSize, psbColValue, psbStr, psbResolve, psbArrayGet };
