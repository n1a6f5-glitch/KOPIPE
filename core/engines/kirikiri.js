// core/engines/kirikiri.js – Kirikiri .ks parser (VNTextPatch port). Ported from KOPIPE.
import { applyGls, maskTxtTags, wrapText, unmaskTags } from '../util.js';
// ============================================================================
// KS Parser – handles Shift-JIS and UTF-16 LE/BE
// ============================================================================
function decodeKs(buf){
  var b=new Uint8Array(buf);
  if(b.length>=2&&b[0]===0xFF&&b[1]===0xFE)return{text:new TextDecoder('utf-16le').decode(buf),enc:'utf-16le'};
  if(b.length>=2&&b[0]===0xFE&&b[1]===0xFF)return{text:new TextDecoder('utf-16be').decode(buf),enc:'utf-16be'};
  if(b.length>=3&&b[0]===0xEF&&b[1]===0xBB&&b[2]===0xBF)return{text:new TextDecoder('utf-8').decode(buf),enc:'utf-8'};
  // DEVIATION from KOPIPE: valid non-ASCII UTF-8 without BOM is decoded as UTF-8 (v2.5 assumed Shift-JIS and garbled it).
  var hasHigh=false; for(var i=0;i<b.length;i++){ if(b[i]>0x7F){hasHigh=true;break} }
  if(hasHigh){ try{ return{text:new TextDecoder('utf-8',{fatal:true}).decode(buf),enc:'utf-8'}; }catch(e){} }
  return{text:new TextDecoder('shift-jis').decode(buf),enc:'shift-jis'};
}
function encodeKs(text,enc){
  if(enc=='utf-16le'){
    var buf=new ArrayBuffer(2+text.length*2),v=new DataView(buf);
    v.setUint8(0,0xFF);v.setUint8(1,0xFE);
    for(var i=0;i<text.length;i++)v.setUint16(2+i*2,text.charCodeAt(i),true);
    return new Uint8Array(buf);
  }
  if(enc=='utf-16be'){
    var buf2=new ArrayBuffer(2+text.length*2),v2=new DataView(buf2);
    v2.setUint8(0,0xFE);v2.setUint8(1,0xFF);
    for(var j=0;j<text.length;j++)v2.setUint16(2+j*2,text.charCodeAt(j),false);
    return new Uint8Array(buf2);
  }
  return new TextEncoder().encode(text);
}

// — Kirikiri KS – GENERAL parser (ported from VNTextPatch KirikiriKsScript.cs) —
// Sequential range-based: no stored line-indices – extraction & repack both walk
// getKsRanges() fresh, in the same deterministic order, matching translations by
// position only (same principle VNTextPatch itself uses for its own JSON pipeline).
var KS_NAME_COMMANDS = ['nm','set_title','speaker','Talk','talk','cn','name','名前'];
var KS_ENTER_NAME_COMMANDS = ['ns'];
var KS_EXIT_NAME_COMMANDS = ['nse'];
var KS_MESSAGE_COMMANDS = ['sel01','sel02','sel03','sel04','AddSelect','ruby'];
var KS_ALLOWED_INLINE = ['r','ruby','ruby_c','heart','mruby','・','★'];

// Scan "name[=value] name2=value2 ..." tokens. Records both NAME and VALUE spans
// (Artemis needs the name span; Kirikiri needs the value span).
function scanAttrs(str, pos, stopChar){
  var attrs=[], n=str.length;
  while(pos<n){
    while(pos<n && str[pos]===' ') pos++;
    if(pos>=n) break;
    if(stopChar!=null && str[pos]===stopChar) break;
    var nameStart=pos;
    while(pos<n && str[pos]!=='=' && str[pos]!==' ' && !(stopChar!=null && str[pos]===stopChar)) pos++;
    var nameEnd=pos;
    var name=str.slice(nameStart,nameEnd);
    if(!name) break;
    var valStart=-1,valEnd=-1,quoted=false;
    if(pos<n && str[pos]==='='){
      pos++;
      if(pos<n && (str[pos]==='"'||str[pos]==="'")){
        var q=str[pos]; pos++;
        valStart=pos;
        while(pos<n && str[pos]!==q){ if(str[pos]==='\\') pos++; pos++; }
        valEnd=pos;
        if(pos<n) pos++;
        quoted=true;
      } else {
        valStart=pos;
        while(pos<n && str[pos]!==' ' && !(stopChar!=null && str[pos]===stopChar)) pos++;
        valEnd=pos;
      }
    }
    attrs.push({name:name,nameStart:nameStart,nameEnd:nameEnd,valStart:valStart,valEnd:valEnd,quoted:quoted});
    pos=Math.max(pos, valEnd>=0?valEnd:nameEnd);
  }
  return{attrs:attrs,endPos:pos};
}

// Split script into lines, tracking absolute offset of each line's start.
function ksSplitLines(script){
  var lines=[],pos=0;
  while(true){
    var nl=script.indexOf('\n',pos);
    if(nl===-1){lines.push({text:script.slice(pos),offset:pos});break}
    lines.push({text:script.slice(pos,nl),offset:pos});
    pos=nl+1;
  }
  return lines;
}

// — Attribute grammar, mirroring KirikiriKsScript's regexes:
// line command  ^\s*@(?<command>[^ ]+)(?: +(?<attrname>[^= ]+)(?: *= *(?<attrvalue>"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^" ]*))?)*
// inline cmd    \[(?<command>[^\] ]+)(?: +(?<attrname>[^\]= ]+)(?: *= *(?<attrvalue>"..."|'...'|[^\]" ]*))?)* *\]
// inline=true excludes ']' from names/bare values. Returns {attrs:[{name,valStart,valEnd,quoted}], end}.
function ksReadQuoted(str,i,q){
  var j=i+1,n=str.length;
  while(j<n){ if(str[j]==='\\'&&str[j+1]===q){ j+=2; continue; } if(str[j]===q) return j+1; j++; }
  j=i+1; while(j<n&&str[j]!==q) j++;
  return j<n ? j+1 : -1;
}

function ksReadAttrs(str,i,inline){
  var n=str.length, attrs=[];
  while(true){
    var save=i; while(i<n&&str[i]===' ') i++;
    if(i===save) break;
    var ns=i; while(i<n && str[i]!=='=' && str[i]!==' ' && !(inline&&str[i]===']')) i++;
    if(i===ns){ i=save; break; }
    var at={name:str.slice(ns,i),valStart:-1,valEnd:-1,quoted:false};
    var j=i; while(j<n&&str[j]===' ') j++;
    if(str[j]==='='){
      j++; while(j<n&&str[j]===' ') j++;
      var ve=-1;
      if(str[j]==='"'||str[j]==="'"){ ve=ksReadQuoted(str,j,str[j]); if(ve>=0){ at.valStart=j+1; at.valEnd=ve-1; at.quoted=true; } }
      if(ve<0){ ve=j; while(ve<n && str[ve]!=='"' && str[ve]!=="'" && str[ve]!==' ' && !(inline&&str[ve]===']')) ve++; at.valStart=j; at.valEnd=ve; }
      i=ve;
    }
    attrs.push(at);
  }
  return {attrs:attrs,end:i};
}
function ksParseInline(str,i){ // str[i]==='[' -> {index,length,command,cmdStart,attrs} | null
  var n=str.length, cs=i+1, j=cs;
  while(j<n && str[j]!==']' && str[j]!=='"' && str[j]!=="'" && str[j]!==' ') j++;
  if(j===cs) return null;
  var r=ksReadAttrs(str,j,true), e=r.end;
  while(e<n&&str[e]===' ') e++;
  if(str[e]!==']') return null;
  return {index:i,length:e+1-i,command:str.slice(cs,j),cmdStart:cs,attrs:r.attrs};
}
function ksInlineCommands(str){
  var out=[], i=0;
  while((i=str.indexOf('[',i))>=0){ var c=ksParseInline(str,i); if(c){ out.push(c); i=c.index+c.length; } else i++; }
  return out;
}

function hasJapanese(s){ for(var i=0;i<s.length;i++) if(s.charCodeAt(i)>=0x3000) return true; return false; } // StringUtil.IsJapaneseCharacter

// Value ranges of a parsed command; only values containing Japanese are text (reference: GetAttributeValueRanges).
function ksAttrRanges(str,base,attrs,type,out){
  for(var i=0;i<attrs.length;i++){
    var a=attrs[i]; if(a.valStart<0) continue;
    if(!hasJapanese(str.slice(a.valStart,a.valEnd))) continue;
    if(a.valEnd-a.valStart<=0) continue;
    out.push({offset:base+a.valStart,length:a.valEnd-a.valStart,type:type});
  }
}

function ksHandleLineCommand(line,lineOffset,ranges){
  if(line==='@r'){ranges.push({offset:lineOffset,length:line.length,type:'message'});return}
  var m=/^\s*@([^ ]+)/.exec(line); if(!m) return;
  var cmdName=m[1], parsed=ksReadAttrs(line,m[0].length,false);
  if(KS_NAME_COMMANDS.indexOf(cmdName)!==-1) ksAttrRanges(line,lineOffset,parsed.attrs,'name',ranges);
  else if(KS_MESSAGE_COMMANDS.indexOf(cmdName)!==-1) ksAttrRanges(line,lineOffset,parsed.attrs,'message',ranges);
}

function ksHandleLabel(line,lineOffset,ranges,isRewindBookmark){
  var pipeIdx=line.indexOf('|');
  if(pipeIdx<0 || pipeIdx===line.length-1) return;
  // DEVIATION (kept from KOPIPE, real-game finding): a label wrapped as @lr / *label|X / @mr is a rewind/backlog
  // bookmark repeating the same text hundreds of times – not content. The reference extracts every `*label|text`.
  if(isRewindBookmark) return;
  var nameIdx=pipeIdx+1;
  ranges.push({offset:lineOffset+nameIdx,length:line.length-nameIdx,type:'message'});
}

function ksHandleMessageLine(line,lineOffset,ranges,state){
  var commands=ksInlineCommands(line), segmentStart=0;
  for(var ci=0;ci<commands.length;ci++){
    var cmd=commands[ci], cmdName=cmd.command;
    if(KS_ALLOWED_INLINE.indexOf(cmdName)!==-1) continue;
    if(cmd.index>segmentStart) ranges.push({offset:lineOffset+segmentStart,length:cmd.index-segmentStart,type:state.type});
    var isBracketName=cmdName.charAt(0)==='【' && cmdName.charAt(cmdName.length-1)==='】';
    if(isBracketName && cmdName.length>2) ranges.push({offset:lineOffset+cmd.cmdStart+1,length:cmdName.length-2,type:'name'});
    var inl=line.slice(cmd.index,cmd.index+cmd.length);
    if(KS_NAME_COMMANDS.indexOf(cmdName)!==-1 || isBracketName){
      ksAttrRanges(inl,lineOffset+cmd.index,cmd.attrs.map(function(a){return shiftAttr(a,-cmd.index)}),'name',ranges);
    } else if(KS_ENTER_NAME_COMMANDS.indexOf(cmdName)!==-1) state.type='name';
    else if(KS_EXIT_NAME_COMMANDS.indexOf(cmdName)!==-1) state.type='message';
    else if(KS_MESSAGE_COMMANDS.indexOf(cmdName)!==-1){
      ksAttrRanges(inl,lineOffset+cmd.index,cmd.attrs.map(function(a){return shiftAttr(a,-cmd.index)}),'message',ranges);
    }
    segmentStart=cmd.index+cmd.length;
  }
  if(segmentStart<line.length) ranges.push({offset:lineOffset+segmentStart,length:line.length-segmentStart,type:state.type});
}
function shiftAttr(a,d){ return {name:a.name,valStart:a.valStart<0?-1:a.valStart+d,valEnd:a.valEnd<0?-1:a.valEnd+d,quoted:a.quoted}; }

// — Text as the translator sees it (GetTextForRead): hard line joins removed, @r/[r] -> <BR>, ruby -> base text.
var KS_BR='<BR>';
function ksRubyToBase(str){
  var cmds=ksInlineCommands(str);
  for(var i=cmds.length-1;i>=0;i--){
    var c=cmds[i]; if(c.command!=='ruby') continue;
    var ruby=null, chars=null;
    for(var k=0;k<c.attrs.length;k++){ var a=c.attrs[k], v=a.valStart<0?'':str.slice(c.index+a.valStart,c.index+a.valEnd);
      if(a.name==='text') ruby=v; else if(a.name==='char') chars=v; }
    if(ruby==null) continue;
    var len, base=null;
    if(chars==null) len=1; else if(/^[\+\-]?\d+$/.test(chars)) len=parseInt(chars,10); else { base=chars; len=0; }
    if(len>0){ if(c.index+c.length+len>str.length) continue; base=str.substr(c.index+c.length,len); }
    str=str.slice(0,c.index)+base+str.slice(c.index+c.length+len);
  }
  return str;
}
function ksReadText(script,r){
  var t=script.substr(r.offset,r.length);
  t=t.replace(/\r?\n/g,'');
  t=t.split('@r').join(KS_BR);
  t=ksRubyToBase(t);
  t=t.split('[r]').join(KS_BR);
  return t;
}

// Ordered array of {offset,length,type} over the FULL script. type: 'name' | 'message'.
// Consecutive ranges of the same type are merged when adjacent or when the next one starts at the beginning of the
// directly following line (AreRangesContiguous) – one multi-line paragraph = one entry, like VNTextPatch.
function getKsRanges(script){
  var lines=ksSplitLines(script), out=[], inScript=false, state={type:'message'}, cur=null;
  function nearbySignificant(fromIdx,dir){
    var i=fromIdx+dir;
    while(i>=0 && i<lines.length){
      var t=lines[i].text.replace(/\r$/,'').trim();
      if(t!=='' && t.indexOf(';')!==0) return t;
      i+=dir;
    }
    return null;
  }
  function contiguous(first,lineOffset,r){
    if(r.type!==first.type) return false;
    var end=first.offset+first.length;
    if(end===r.offset) return true;
    if(r.offset===lineOffset){ var gap=script.slice(end,r.offset); return gap==='\r\n'||gap==='\n'; }
    return false;
  }
  for(var li=0;li<lines.length;li++){
    var lineOffset=lines[li].offset, line=lines[li].text.replace(/\r$/,'');

    if(line==='[iscript]'||line==='@iscript'||line.indexOf('[macro')===0||line.indexOf('@macro')===0) inScript=true;
    else if(line==='[endscript]'||line==='@endscript'||line==='[endmacro]'||line==='@endmacro') inScript=false;
    if(inScript) continue;

    var trimmed=line.replace(/^\s+/,''), lr=[];
    if(trimmed.indexOf(';')===0){}
    else if(trimmed.indexOf('@')===0) ksHandleLineCommand(line,lineOffset,lr);
    else if(trimmed.indexOf('*')===0) ksHandleLabel(line,lineOffset,lr,nearbySignificant(li,-1)==='@lr' && nearbySignificant(li,1)==='@mr');
    else if(trimmed.indexOf('#')===0){
      var hashIdx=line.indexOf('#');
      if(line.length-hashIdx-1>0) lr.push({offset:lineOffset+hashIdx+1,length:line.length-hashIdx-1,type:'name'});
    }
    else if(line.trim()!=='') ksHandleMessageLine(line,lineOffset,lr,state);

    for(var ri=0;ri<lr.length;ri++){
      var r=lr[ri];
      if(ksReadText(script,r).split(KS_BR).join('').trim()==='') continue; // reference: whitespace-only (incl. a lone \r\n from [r]) is dropped
      if(cur && contiguous(cur,lineOffset,r)) cur.length=r.offset+r.length-cur.offset;
      else { if(cur) out.push(cur); cur={offset:r.offset,length:r.length,type:r.type}; }
    }
  }
  if(cur) out.push(cur);
  return out;
}

function extractFromKs(script,sg){
  var ranges=getKsRanges(script);
  var entries=[],pendingNames=[];
  for(var i=0;i<ranges.length;i++){
    var r=ranges[i],raw=ksReadText(script,r);
    if(r.type==='name'){pendingNames.push(raw);continue}
    entries.push({names:pendingNames,message:raw});
    pendingNames=[];
  }
  var lines=[],tagStore={};
  for(var idx=0;idx<entries.length;idx++){
    var e=entries[idx];
    var rawName=e.names.length?e.names.join(' / '):'Narasi';
    var name=sg.length?applyGls(rawName,sg):rawName;
    var dialog=sg.length?applyGls(e.message,sg):e.message;
    var mt=maskTxtTags(dialog);
    tagStore[idx]={tl:mt.tl,nameCount:e.names.length};
    lines.push('['+idx+'|'+name+'] '+mt.masked);
  }
  return{lines:lines,tagStore:tagStore,entryCount:entries.length};
}

// Write side (GetTextForWrite): <BR> and wrap breaks become `[r]` + real newline (script's own newline style).
// `nlSep` is ignored for .ks on purpose – paragraphs are merged, so [r]\n is the only correct break.
function repackKs(script,tagStore,translations,wrapWidth,nlSep){
  var ranges=getKsRanges(script), NL=script.indexOf('\r\n')>=0?'\r\n':'\n';
  var entries=[],pendingNameRanges=[];
  for(var i=0;i<ranges.length;i++){
    var r=ranges[i];
    if(r.type==='name'){pendingNameRanges.push(r);continue}
    entries.push({nameRanges:pendingNameRanges,messageRange:r});
    pendingNameRanges=[];
  }
  var repMap=new Map();
  var tKeys=Object.keys(translations);
  for(var ti=0;ti<tKeys.length;ti++){
    var idx=parseInt(tKeys[ti],10);
    var entry=entries[idx];
    if(!entry) continue;
    var store=tagStore[String(idx)];
    if(!store) continue;
    var val=translations[tKeys[ti]];
    var newName=val[0], translatedMasked=val[1];
    var wrapped=wrapText(translatedMasked.split(KS_BR).join('\n'),wrapWidth,'\n');
    var unmasked=unmaskTags(wrapped,store.tl||[]).replace(/\r?\n/g,'[r]'+NL);
    repMap.set(entry.messageRange.offset,unmasked);
    if(entry.nameRanges.length && newName && newName.trim() && newName.toLowerCase()!=='narasi'){
      for(var ni=0;ni<entry.nameRanges.length;ni++) repMap.set(entry.nameRanges[ni].offset,newName);
    }
  }
  var out='',copyStart=0;
  for(var ri=0;ri<ranges.length;ri++){
    var rr=ranges[ri];
    out+=script.slice(copyStart,rr.offset);
    out+=repMap.has(rr.offset)?repMap.get(rr.offset):script.slice(rr.offset,rr.offset+rr.length);
    copyStart=rr.offset+rr.length;
  }
  out+=script.slice(copyStart);
  return out;
}

export { decodeKs, encodeKs, scanAttrs, ksSplitLines, getKsRanges, extractFromKs, repackKs };
