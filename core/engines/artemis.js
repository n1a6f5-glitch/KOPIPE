// core/engines/artemis.js – Artemis .txt/.art/.ast (structural + generic fallback). Ported from KOPIPE.
import { applyGls, maskTxtTags, wrapText, unmaskTags } from '../util.js';
import { ksSplitLines } from './kirikiri.js';
// ============================================================================
// ARTEMIS .txt – GENERAL parser (note: '.art' is NOT a real Artemis extension; real ones are .asb/.ast/.txt) (ported from VNTextPatch ArtemisTxtScript.cs)
// Sequential range-based, same principle as the KS module above.
// ============================================================================
function artRemoveComment(line){
  var s1=line.indexOf('//'), s2=line.indexOf(';'), idx=-1;
  if(s1>=0 && (s2<0 || s1<s2)) idx=s1; else if(s2>=0) idx=s2;
  return idx>=0 ? line.slice(0,idx) : line;
}

// Mirrors ArtemisTxtScript.CommandRegex:
//  ^\s*\[(?<command>[^\s' ]+)(?: +(?<attrname>[^= ]+)(?: *= *(?<attrvalue>(?:"[^"]*"|'[^']*'|(?:\\'|[^'])*|[^' ]+)*))?)*\]\s*$
// Note: attr names may themselves contain quotes – `[name "Taro"]` yields attrname `"Taro"` (quotes included),
// exactly like the C# reference, so the `name` range covers them.
function artReadQuoted(line,i,q){
  var j=i+1, n=line.length;
  while(j<n){ if(line[j]==='\\'&&line[j+1]===q){ j+=2; continue; } if(line[j]===q) return j+1; j++; }
  // unterminated with escapes -> regex would backtrack and treat `\` as a plain char
  j=i+1; while(j<n&&line[j]!==q) j++;
  return j<n ? j+1 : -1;
}
function artParseFullLineCommand(line){
  var n=line.length, i=0;
  while(i<n && /\s/.test(line[i])) i++;
  if(line[i]!=='[') return null;
  i++;
  var cs=i; while(i<n && line[i]!==']' && line[i]!=="'" && line[i]!==' ') i++;
  if(i===cs) return null;
  var cmd=line.slice(cs,i), attrs=[];
  while(true){
    var save=i; while(i<n && line[i]===' ') i++;
    if(i===save) break;
    var ns=i; while(i<n && line[i]!==']' && line[i]!=='=' && line[i]!==' ') i++;
    if(i===ns){ i=save; break; }
    var at={name:line.slice(ns,i), nameStart:ns, nameEnd:i, valStart:-1, valEnd:-1, quoted:false};
    var j=i; while(j<n && line[j]===' ') j++;
    if(line[j]==='='){
      j++; while(j<n && line[j]===' ') j++;
      var ve=-1;
      if(line[j]==="'"||line[j]==='"'){
        ve=artReadQuoted(line,j,line[j]);
        if(ve>=0){ at.valStart=j+1; at.valEnd=ve-1; at.quoted=true; }
      }
      if(ve<0){ ve=j; while(ve<n && line[ve]!==']' && line[ve]!=="'" && line[ve]!=='"' && line[ve]!==' ') ve++; at.valStart=j; at.valEnd=ve; }
      i=ve;
    }
    attrs.push(at);
  }
  while(i<n && line[i]===' ') i++; // tolerance (reference regex rejects `[cmd a="b" ]`, which would turn the command into message text)
  if(line[i]!==']') return null;
  if(line.slice(i+1).trim()!=='') return null;
  return {cmd:cmd,attrs:attrs};
}

// Range order/semantics follow ArtemisTxtScript.GetRanges:
// - '*label' lines (NO leading-whitespace tolerance) are skipped without ending a message block
// - a message block = consecutive non-blank, non-command lines; blank lines end it, other command lines
//   (e.g. [wait]) do NOT end it (they stay inside the range and get masked as tags)
// - deviations (all safe): a `name`/`sel_text` command inside an open block ends the block first so ranges stay
//   in ascending file order; the last block is flushed at EOF even without a trailing blank line.
function looksLikeArtemisTxt(text){
  var lines=text.split(/\r?\n/), cmd=0, label=0;
  for(var i=0;i<lines.length;i++){ var l=lines[i];
    if(/^\*\S/.test(l)) label++;
    var f=artParseFullLineCommand(artRemoveComment(l)); if(f && /^(name|sel_text|text|ex|bg|fg|vo|bgm|se|trans|wait|ret|rt|eval|lyc|lyprop)$/i.test(f.cmd)) cmd++;
  }
  return label>0 && cmd>=2;
}
function getArtRanges(script){
  var lines=ksSplitLines(script), ranges=[], messageStart=-1, messageEnd=-1;
  function flushMessage(){
    if(messageStart>=0){ ranges.push({offset:messageStart,length:messageEnd-messageStart,type:'message'}); messageStart=-1; messageEnd=-1; }
  }
  function unq(off){ var c=script[off-1]; return c!=='"' && c!=="'"; }
  for(var li=0;li<lines.length;li++){
    var lineOffset=lines[li].offset;
    var line=artRemoveComment(lines[li].text.replace(/\r$/,''));

    if(line.indexOf('*')===0) continue;

    var full=artParseFullLineCommand(line);
    if(full){
      if(full.cmd==='name'){
        flushMessage();
        var nameAttr=full.attrs[0];
        if(nameAttr) ranges.push({offset:lineOffset+nameAttr.nameStart,length:nameAttr.nameEnd-nameAttr.nameStart,type:'name',unquoted:unq(lineOffset+nameAttr.nameStart)});
      } else if(full.cmd==='sel_text'){
        flushMessage();
        for(var ai=0;ai<full.attrs.length;ai++){
          var a=full.attrs[ai];
          if(a.name==='text' && a.valEnd>=a.valStart){ ranges.push({offset:lineOffset+a.valStart,length:a.valEnd-a.valStart,type:'message',unquoted:!a.quoted}); }
        }
      }
      continue;
    }

    if(line.trim()!==''){
      if(messageStart<0) messageStart=lineOffset;
      messageEnd=lineOffset+line.length;
    } else flushMessage();
  }
  flushMessage();
  return ranges.filter(function(r){return script.slice(r.offset,r.offset+r.length).trim()!=='';});
}

function extractFromArt(script,sg){
  var ranges=getArtRanges(script);
  var entries=[],pendingNames=[];
  for(var i=0;i<ranges.length;i++){
    var r=ranges[i],raw=script.slice(r.offset,r.offset+r.length);
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

// ArtemisTxtScript.GetTextForWrite: an unquoted attribute value that gains a space must be quoted.
function artQuoteIfNeeded(range,text){ return range.unquoted && text.indexOf(' ')>=0 ? '"'+text+'"' : text; }

function repackArt(script,tagStore,translations,wrapWidth,mlSep){
  var ranges=getArtRanges(script);
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
    var newName=val[0],translatedMasked=val[1];
    var wrapped=wrapText(translatedMasked,wrapWidth,mlSep);
    var unmasked=unmaskTags(wrapped,store.tl||[]);
    repMap.set(entry.messageRange.offset,artQuoteIfNeeded(entry.messageRange,unmasked));
    if(entry.nameRanges.length && newName && newName.trim() && newName.toLowerCase()!=='narasi'){
      for(var ni=0;ni<entry.nameRanges.length;ni++) repMap.set(entry.nameRanges[ni].offset,artQuoteIfNeeded(entry.nameRanges[ni],newName));
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

// ============================================================================
// ARTEMIS .ast – mini Lua-literal parser (ported from LuaParser.cs / LuaTable.cs /
// LuaString.cs / LuaNumber.cs / LuaAttribute.cs) + ArtemisAstScript.cs logic.
// NOTE: unlike KS/txt (byte-exact patch of only translated spans), .ast repack
// REBUILDS the whole file from the parsed tree – structurally identical to the
// source but whitespace/indentation will differ (same as how VNTextPatch itself
// serializes Lua tables back out).
// ============================================================================
var AST_ESC_MAP={n:'\n',r:'\r',t:'\t',0:'\0',a:'\x07',b:'\b',f:'\f',v:'\v','\\':'\\',"'":"'",'"':'"'};
var AST_UNESC_MAP={'\n':'n','\r':'r','\t':'t','\0':'0','\x07':'a','\b':'b','\f':'f','\v':'v','\\':'\\'}; // '\'' is escaped by luaQuoteC (v2.5 escaped it twice by bug; standard Lua needs just \")
function luaUnescapeC(str){
  var out='',i=0;
  while(i<str.length){
    if(str[i]==='\\' && i+1<str.length){ var c=str[i+1]; out+=(c in AST_ESC_MAP)?AST_ESC_MAP[c]:c; i+=2; }
    else { out+=str[i]; i++; }
  }
  return out;
}
function luaEscapeC(str){
  var out='';
  for(var i=0;i<str.length;i++){ var c=str[i]; out+=(c in AST_UNESC_MAP)?('\\'+AST_UNESC_MAP[c]):c; }
  return out;
}
function luaQuoteC(str){ return '"'+luaEscapeC(str).replace(/"/g,'\\"')+'"'; }

function LStr(v){return{k:'str',v:v}}
function LNum(v){return{k:'num',v:v}}
function LAttr(name,v){return{k:'attr',name:name,v:v}}
function LTable(items){return{k:'table',items:items||[]}}
function tableGet(table,key){
  if(!table||table.k!=='table') return undefined;
  for(var i=0;i<table.items.length;i++){ var it=table.items[i]; if(it.k==='attr'&&it.name===key) return it.v; }
  return undefined;
}

function luaRead(text,state){
  luaSkipWs(text,state);
  if(state.pos>=text.length) return null;
  var c=text[state.pos];
  if((c>='0'&&c<='9')||c==='+'||c==='-'||c==='.') return luaReadNumber(text,state);
  if(c==="'"||c==='"') return luaReadQuotedString(text,state);
  if(c==='['&&state.pos+1<text.length&&(text[state.pos+1]==='['||text[state.pos+1]==='=')) return luaReadBracketedString(text,state);
  if((c>='a'&&c<='z')||(c>='A'&&c<='Z')||c==='_'||c==='[') return luaReadAttribute(text,state);
  if(c==='{') return luaReadTable(text,state);
  throw new Error('Invalid Lua token at pos '+state.pos);
}
function luaSkipWs(text,state){ while(state.pos<text.length && /\s/.test(text[state.pos])) state.pos++; }
function luaReadNumber(text,state){
  var start=state.pos;
  while(state.pos<text.length){ var c=text[state.pos]; if((c>='0'&&c<='9')||c==='+'||c==='-'||c==='.') state.pos++; else break; }
  return LNum(text.slice(start,state.pos));
}
function luaReadQuotedString(text,state){
  var start=state.pos, quote=text[state.pos]; state.pos++;
  while(state.pos<text.length){ var c=text[state.pos]; state.pos++; if(c==='\\') state.pos++; else if(c===quote) break; }
  return LStr(luaUnescapeC(text.slice(start+1,state.pos-1)));
}
function luaReadBracketedString(text,state){
  state.pos++;
  var openLevel=0;
  while(state.pos<text.length && text[state.pos]==='='){ openLevel++; state.pos++; }
  if(state.pos===text.length || text[state.pos]!=='[') throw new Error('No second [ found in literal string');
  state.pos++;
  var start=state.pos, end=0, inClose=false, closeLevel=0;
  while(true){
    if(state.pos===text.length) throw new Error('Unclosed literal string');
    var c=text[state.pos]; state.pos++;
    if(c===']'){ if(!inClose||closeLevel!==openLevel){ end=state.pos-1; inClose=true; closeLevel=0; } else break; }
    else if(c==='='){ if(inClose) closeLevel++; }
    else inClose=false;
  }
  return LStr(text.slice(start,end));
}
function luaReadAttribute(text,state){
  var name;
  if(text[state.pos]==='['){
    state.pos++;
    var nameNode=luaRead(text,state);
    if(nameNode.k==='num'||nameNode.k==='str') name=nameNode.v;
    else throw new Error('Invalid data type in attribute name');
    luaSkipWs(text,state);
    if(state.pos===text.length||text[state.pos]!==']') throw new Error('No "]" found after attribute name');
    state.pos++;
  } else {
    var nameStart=state.pos;
    while(state.pos<text.length && /[\p{L}\p{Nd}_]/u.test(text[state.pos])) state.pos++; // char.IsLetterOrDigit || '_'
    name=text.slice(nameStart,state.pos);
  }
  luaSkipWs(text,state);
  if(state.pos===text.length||text[state.pos]!=='=') throw new Error('No "=" found after attribute name');
  state.pos++;
  var value=luaRead(text,state);
  if(value===null) throw new Error('Attribute without value encountered');
  return LAttr(name,value);
}
function luaReadTable(text,state){
  var items=[]; state.pos++;
  while(state.pos<text.length){
    luaSkipWs(text,state);
    if(state.pos===text.length) throw new Error('Incomplete table encountered');
    if(text[state.pos]==='}'){ state.pos++; break; }
    var item=luaRead(text,state);
    if(item===null) throw new Error('Incomplete table encountered');
    items.push(item);
    luaSkipWs(text,state);
    if(state.pos===text.length) throw new Error('Incomplete table encountered');
    if(text[state.pos]===',') state.pos++;
  }
  return LTable(items);
}
function luaWriteNode(node,out,indentLevel){
  if(node.k==='str'){ out.push(luaQuoteC(node.v)); return; }
  if(node.k==='num'){ out.push(node.v); return; }
  if(node.k==='attr'){
    // reference: digit-leading names -> [N]; we additionally quote names that aren't valid identifiers (["a b"]) so output stays parseable
    out.push(/^[0-9]/.test(node.name) ? ('['+node.name+']') : /^[\p{L}_][\p{L}\p{Nd}_]*$/u.test(node.name) ? node.name : '['+luaQuoteC(node.name)+']');
    out.push('=');
    luaWriteNode(node.v,out,indentLevel);
    return;
  }
  if(node.k==='table'){
    // forceExplode: set by deserializeAstMessage on the specific message-container
    // table it just rewrote. The original .ast dumps always explode a dialogue's
    // message table (one segment per line + trailing comma) even when it holds
    // just a single string – e.g. {"a single line"} still prints as
    // { "a single line", } – whereas a small leaf command tuple like {"rt2"} or
    // {"vo",file="..."} stays compact. Both shapes are "a table with only
    // string/attr children", so there's no way to tell them apart from local
    // structure alone; forceExplode is the tag that says "this one is a message".
    var hasChildTables=node.forceExplode||node.items.some(function(i){return i.k==='table'||(i.k==='attr'&&i.v.k==='table')});
    out.push('{'); if(hasChildTables) out.push('\n');
    // No leading-space indentation on purpose: the original .ast dumps use newlines
    // between entries but no per-level padding. For files with thousands of numbered
    // dialogue entries, 4-space-per-nesting-level indentation balloons the rebuilt
    // file size drastically compared to the source (which can matter if this script
    // is packed inside an archive/index that's sensitive to file size). Keep the
    // newlines for structure/diffability, drop the padding.
    var lvl=indentLevel+1;
    for(var i=0;i<node.items.length;i++){
      luaWriteNode(node.items[i],out,lvl);
      var isLast=i===node.items.length-1;
      if(hasChildTables){ out.push(','); out.push('\n'); }
      else if(!isLast){ out.push(','); }
    }
    out.push('}');
    return;
  }
  throw new Error('Unknown Lua node kind: '+node.k);
}
function luaToString(node){ var out=[]; luaWriteNode(node,out,0); return out.join(''); }

function luaParseDocument(text){
  var state={pos:0}, roots=[];
  while(true){ var node=luaRead(text,state); if(node===null) break; roots.push(node); }
  return roots;
}
function findRootAttr(roots,name){
  for(var i=0;i<roots.length;i++) if(roots[i].k==='attr'&&roots[i].name===name) return roots[i].v;
  return undefined;
}
function getAstStringNodes(roots){
  var ast=findRootAttr(roots,'ast');
  if(!ast||ast.k!=='table') throw new Error('No "ast" attribute found in file');
  // Dialogue can live in genuinely different places within the same file –
  // ast.text[N] (flat list) and/or ast[N] directly (numbered blocks alongside
  // unrelated anonymous command-list tables) – so both are always scanned and
  // combined rather than picking whichever one happens to find entries first
  // and returning early. They read disjoint parts of the tree (ast.text vs.
  // ast's own numbered attrs), so there's no risk of double-counting.
  var v1=getAstStringNodesV1(ast);
  var blocks=getAstStringNodesBlocks(ast);
  return v1.concat(blocks);
}
// Shared by both getAstStringNodesV1 (block lives at ast.text[N]) and
// getAstStringNodesBlocks (block lives at ast[N] directly): a block using the
// "ja" shape holds its speaker name as a command-shaped table under the "name"
// key – {"name", name="Atsushi"}, where the ACTUAL display name is the inner
// "name" attr, not the outer key – plus one or more bare (non attr-keyed)
// positional table entries holding the message segments themselves. Returns
// true iff this block actually had a "ja" field, so callers can tell whether
// to try a different shape instead.
function extractJaBlockEntries(block,out){
  var jaT=tableGet(block,'ja');
  if(!jaT||jaT.k!=='table') return false;
  var nameCmd=tableGet(jaT,'name');
  if(nameCmd){
    if(nameCmd.k==='table'){
      var nameVal=tableGet(nameCmd,'name');
      if(nameVal&&nameVal.k==='str') out.push({node:nameVal,type:'name'});
    } else if(nameCmd.k==='str'){
      out.push({node:nameCmd,type:'name'});
    }
  }
  for(var j=0;j<jaT.items.length;j++){
    var jItem=jaT.items[j];
    if(jItem.k==='table') out.push({node:jItem,type:'message'});
  }
  return true;
}
function getAstStringNodesV1(ast){
  var out=[]; var texts=tableGet(ast,'text');
  if(!texts||texts.k!=='table') return out;
  for(var i=0;i<texts.items.length;i++){
    var item=texts.items[i];
    if(item.k!=='attr'||item.v.k!=='table') continue;
    var text=item.v;
    var nameTable=tableGet(text,'name');
    // Confirmed against an existing published patch of this same game: when a
    // character has BOTH sub-fields, "name" stays untouched in Japanese (internal
    // reference key) and "ja" is the on-screen text that gets translated, e.g.
    // name={name="スヴェトラーナ", ja="Sve"}. But some characters only ever have the
    // "name" sub-field (no "ja" at all, e.g. name={name="香子"}) – for those, "name"
    // IS the display text, so fall back to it when "ja" isn't present.
    var nameJa=tableGet(nameTable,'ja');
    var name=nameTable&&nameTable.k==='table'?(nameJa&&nameJa.k==='str'?nameJa:tableGet(nameTable,'name')):undefined;
    if(name&&name.k==='str') out.push({node:name,type:'name'});
    var select=tableGet(text,'select');
    if(select&&select.k==='table') for(var si=0;si<select.items.length;si++) if(select.items[si].k==='str') out.push({node:select.items[si],type:'message'});
    // The message itself can be nested under a "ja" field (see extractJaBlockEntries
    // above – this is the same shape as ast[N].ja seen elsewhere, just one level
    // deeper at ast.text[N].ja; a naive "jaT.items.length===1" check used to miss
    // every block that ALSO carried a speaker name here, since that adds a second
    // item to ja.items and silently dropped the whole line, not just the name), or
    // as a bare positional table entry sitting directly among text[i]'s own items.
    if(!extractJaBlockEntries(text,out)){
      var message=text.items.find(function(n){return n.k==='table'});
      if(message) out.push({node:message,type:'message'});
    }
  }
  return out;
}
// Numbered blocks under "ast" ([1]={...}, [2]={...}, ...) come in (at least) two
// known shapes, and – critically – a single file can mix BOTH across different
// blocks, so every block is checked independently rather than picking one shape
// for the whole file:
// - "wrapped": block.text.ja = { { name={...}, message... } } (one-item table
//   holding the whole line, name nested inside it)
// - "direct": block.ja = { name={"name",name="X"}, {message segments} } (name
//   stored as its own attr-keyed command-table, message as a bare sibling item)
// "select" (choice-menu options) is unrelated to either shape and can appear on
// any block regardless, so it's always checked on its own.
function getAstStringNodesBlocks(ast){
  var out=[];
  for(var i=0;i<ast.items.length;i++){
    var item=ast.items[i];
    if(item.k!=='attr'||item.v.k!=='table') continue;
    var block=item.v;

    var selectT=tableGet(block,'select');
    var select=selectT&&selectT.k==='table'?tableGet(selectT,'ja'):undefined;
    if(select&&select.k==='table') for(var si=0;si<select.items.length;si++) if(select.items[si].k==='str') out.push({node:select.items[si],type:'message'});

    var matchedWrapped=false;
    var textT=tableGet(block,'text');
    var text=textT&&textT.k==='table'?tableGet(textT,'ja'):undefined;
    if(text&&text.k==='table'&&text.items.length===1){
      var message=text.items[0];
      if(message&&message.k==='table'){
        var names=tableGet(message,'name');
        // Only take the first item as the display name. Multi-lang .ast dumps store
        // this as an unnamed [fullName, shortNickname] pair (mirroring the attr-keyed
        // {name=..., ja=...} pair seen in single-lang files), not multiple simultaneous
        // speakers – pushing every item here would show a "Full / Nickname" mashup
        // (sometimes mixed-script) as the speaker instead of a single clean name.
        if(names&&names.k==='table'&&names.items.length&&names.items[0].k==='str') out.push({node:names.items[0],type:'name'});
        out.push({node:message,type:'message'});
        matchedWrapped=true;
      }
    }
    if(matchedWrapped) continue;

    // "direct" shape: block.ja = { name={"name",name="X"}, {message segments} }.
    // Same shape extractJaBlockEntries already knows how to read (shared with
    // getAstStringNodesV1, where it appears one level deeper at ast.text[N].ja).
    extractJaBlockEntries(block,out);
  }
  return out;
}
function isRt2(it){ return it&&it.k==='table'&&it.items.length===1&&it.items[0].k==='str'&&it.items[0].v==='rt2'; }
function serializeAstMessage(table){
  var out='';
  for(var i=0;i<table.items.length;i++){
    var item=table.items[i];
    if(item.k==='str'){ out+=item.v; continue; }
    if(item.k==='table'){
      if(item.items.length===1&&item.items[0].k==='str'&&item.items[0].v==='rt2') out+='\r\n';
      else out+=serializeAstCommand(item);
    }
  }
  return out.trim();
}
function serializeAstCommand(table){
  var out='[', first=table.items[0];
  if(!first||first.k!=='str') throw new Error('Command table must start with a string');
  out+=first.v;
  for(var i=1;i<table.items.length;i++){
    var attr=table.items[i];
    if(attr.k!=='attr') throw new Error('Command table must only contain a name and attributes');
    out+=' '+attr.name+'='+luaToString(attr.v);
  }
  return out+']';
}
var AST_CMD_REGEX=/^\[(\/?\w+)((?:\s+\w+\s*=\s*(?:"(?:\\.|[^"])*"|[-+.\d]+))*)\]/;
var AST_CMD_ATTR_REGEX=/(\w+)\s*=\s*("(?:\\.|[^"])*"|[-+.\d]+)/g;
function deserializeAstCommand(cmdText){
  var m=AST_CMD_REGEX.exec(cmdText);
  if(!m) throw new Error('Failed to parse command '+cmdText);
  var items=[LStr(m[1])], attrsStr=m[2], am;
  AST_CMD_ATTR_REGEX.lastIndex=0;
  while((am=AST_CMD_ATTR_REGEX.exec(attrsStr))!==null){
    var aname=am[1], avalRaw=am[2];
    var valNode=avalRaw[0]==='"'?LStr(luaUnescapeC(avalRaw.slice(1,-1))):LNum(avalRaw);
    items.push(LAttr(aname,valNode));
  }
  return LTable(items);
}
function astSplitKeepDelims(text){
  var re=/\r\n|\[.+?\]/g, out=[], last=0, m;
  while((m=re.exec(text))!==null){
    if(m.index>last) out.push({seg:text.slice(last,m.index),match:null});
    out.push({seg:null,match:m[0]});
    last=m.index+m[0].length;
  }
  if(last<text.length) out.push({seg:text.slice(last),match:null});
  return out;
}
function deserializeAstMessage(text,table,rt2AsSpace){
  table.items=table.items.filter(function(n){return n.k==='attr'});
  var parts=astSplitKeepDelims(text);
  var prependSpace=false;
  for(var i=0;i<parts.length;i++){
    var p=parts[i];
    if(p.seg!==null){
      table.items.push(LStr(prependSpace?' '+p.seg:p.seg));
      prependSpace=false;
    } else if(p.match==='\r\n'){
      // rt2AsSpace: drop the {"rt2"} line-break tag entirely and just fold the
      // two sides together with a plain space – two adjacent string segments
      // instead of string / {"rt2"} / string. Requested to make the Indonesian
      // text read as one continuous line instead of a forced mid-sentence break.
      if(rt2AsSpace) prependSpace=true;
      else table.items.push(LTable([LStr('rt2')]));
    }
    else {
      // reference throws on a bracket group that isn't a valid command (e.g. "[Mr. X]"); keep it as literal text instead
      var cmdNode; try{ cmdNode=deserializeAstCommand(p.match); }catch(err){ cmdNode=null; }
      if(cmdNode) table.items.push(cmdNode); else { table.items.push(LStr(prependSpace?' '+p.match:p.match)); prependSpace=false; }
    }
  }
  // Mark this specific table so luaWriteNode always explodes it (one item per
  // line, trailing comma) – matches the original dump's convention for message
  // containers even when there's only a single string segment, unlike small leaf
  // tags like {"rt2"} which stay compact.
  table.forceExplode=true;
}

function extractFromAst(scriptText,sg){
  var roots=luaParseDocument(scriptText);
  var nodes=getAstStringNodes(roots);
  var entries=[],pendingNames=[];
  for(var i=0;i<nodes.length;i++){
    var n=nodes[i];
    var raw=n.node.k==='str'?n.node.v:serializeAstMessage(n.node);
    if(n.type==='name'){pendingNames.push(raw);continue}
    entries.push({names:pendingNames,message:raw});
    pendingNames=[];
  }
  var lines=[],tagStore={};
  for(var idx=0;idx<entries.length;idx++){
    var e=entries[idx];
    var rawName=e.names.length?e.names.join(' / '):'Narasi';
    var name=sg.length?applyGls(rawName,sg):rawName;
    var dialog=sg.length?applyGls(e.message,sg):e.message;
    // serializeAstMessage decodes {rt2} into a literal \r\n – if left as-is, a single
    // dialogue entry with a mid-line break turns into TWO physical lines in the
    // exported MT_Batch .txt, breaking the "1 entry = 1 line" contract the batch
    // count (and any 1:1-per-line AI prompt) depends on. Fold it into a one-line
    // placeholder here; repackAst restores it to \r\n right before rebuilding.
    dialog=dialog.split('\r\n').join('<BR>');
    var mt=maskTxtTags(dialog);
    tagStore[idx]={tl:mt.tl,nameCount:e.names.length};
    lines.push('['+idx+'|'+name+'] '+mt.masked);
  }
  var av=findRootAttr(roots,'astver');
  return{lines:lines,tagStore:tagStore,entryCount:entries.length,astver:av&&av.k==='num'?av.v:null};
}

function repackAst(scriptText,tagStore,translations,wrapWidth,mlSep,rt2AsSpace){
  var roots=luaParseDocument(scriptText);
  var nodes=getAstStringNodes(roots);
  var entries=[],pendingNameNodes=[];
  for(var i=0;i<nodes.length;i++){
    var n=nodes[i];
    if(n.type==='name'){pendingNameNodes.push(n.node);continue}
    // Standardize every message container's formatting on rebuild, not just the
    // ones translated this pass – otherwise translated lines explode (one segment
    // per line) while untouched lines keep whatever compactness they happened to
    // parse with, producing an inconsistent-looking file across a partial batch.
    if(n.node.k==='table') n.node.forceExplode=true;
    entries.push({nameNodes:pendingNameNodes,messageNode:n.node});
    pendingNameNodes=[];
  }
  var tKeys=Object.keys(translations);
  for(var ti=0;ti<tKeys.length;ti++){
    var idx=parseInt(tKeys[ti],10);
    var entry=entries[idx];
    if(!entry) continue;
    var store=tagStore[String(idx)];
    if(!store) continue;
    var val=translations[tKeys[ti]];
    var newName=val[0],translatedMasked=val[1];
    var wrapped=wrapText(translatedMasked,wrapWidth,mlSep);
    var unmasked=unmaskTags(wrapped,store.tl||[]);
    unmasked=unmasked.split('<BR>').join('\r\n');
    if(entry.messageNode.k==='str') entry.messageNode.v=unmasked;
    else {
      // serializeAstMessage trims, so a trailing {"rt2"} (end-of-message break) never reaches the batch; reference
      // DeserializeMessage then drops it for every translated line. Re-attach it so line-ending behaviour is kept.
      var its=entry.messageNode.items, trail=0;
      while(trail<its.length && isRt2(its[its.length-1-trail])) trail++;
      deserializeAstMessage(unmasked,entry.messageNode,rt2AsSpace);
      for(var tr=0;tr<trail;tr++) entry.messageNode.items.push(LTable([LStr('rt2')]));
    }
    if(entry.nameNodes.length && newName && newName.trim() && newName.toLowerCase()!=='narasi'){
      for(var ni=0;ni<entry.nameNodes.length;ni++) entry.nameNodes[ni].v=newName;
    }
  }
  return roots.map(function(r){return luaToString(r)}).join('\n')+'\n';
}

// ============================================================================
// ARTEMIS .ast – GENERIC REGEX fallback (ported from Gardroid's AstParser.cpp /
// AstPacker.cpp – same author as VNTextPatch, but a dumb-but-robust regex scrape
// instead of structural tree walking). Use this when the structural (VNTextPatch)
// parser above finds 0 entries, since real .ast files vary in field naming
// across games and the structural walker only covers ONE specific schema.
// No character-name extraction – matches Gardroid exactly (message text only).
// ============================================================================
var AST_LANG_IGNORED_KEYS = new Set([
  'ast','text','vo','label','select','name','msg','bg','fg','se','ex','cgdel','msgoff',
  'user','quake','extrans','bgm','video','linknext','linkback','line','pagebreak',
  'hide','clickpass','savetitle','eval','sys','astname','astver','mode','next','scene',
  'rt','log','param','include','var','top','bottom','left','right','center',
  'width','height','x','y','z','zoom','alpha','time','ease','accel','file','path','rule',
  'ch','index','set','buf','storage','visible','layer','pos','size','anchor','pivot',
  'r','g','b','a','m','w','k','p','s'
]);

function detectAstLanguages(scriptText){
  var re=/(\w+)\s*=\s*\{/g, m, found=new Set();
  while((m=re.exec(scriptText))!==null){
    var key=m[1];
    if(/^[0-9]/.test(key)) continue;
    if(AST_LANG_IGNORED_KEYS.has(key)) continue;
    found.add(key);
  }
  return Array.from(found);
}

function astGenericRegex(langKey){
  return new RegExp(langKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')+'\\s*=\\s*\\{\\s*\\{\\s*(?:"([^"]*)"|\\[\\[([\\s\\S]*?)\\]\\])', 'g');
}

function extractFromAstGeneric(scriptText,langKey,sg){
  var re=astGenericRegex(langKey), m, lines=[], tagStore={}, idx=0;
  while((m=re.exec(scriptText))!==null){
    var raw = m[1]!==undefined ? m[1] : m[2];
    var dialog = sg.length?applyGls(raw,sg):raw;
    var mt=maskTxtTags(dialog);
    tagStore[idx]={tl:mt.tl,nameCount:0};
    lines.push('['+idx+'|Narasi] '+mt.masked);
    idx++;
  }
  return{lines:lines,tagStore:tagStore,entryCount:lines.length};
}

function repackAstGeneric(scriptText,tagStore,translations,wrapWidth,mlSep,langKey){
  var re=astGenericRegex(langKey);
  var matches=[],m;
  while((m=re.exec(scriptText))!==null) matches.push(m);

  var out='',lastPos=0;
  for(var i=0;i<matches.length;i++){
    var mm=matches[i];
    var store=tagStore[String(i)];
    var val=translations[String(i)];
    out+=scriptText.slice(lastPos,mm.index);
    var openQuote = mm[1]!==undefined;
    var quoteStart = openQuote ? mm[0].indexOf('"') : mm[0].indexOf('[[');
    var prefix = mm[0].slice(0, quoteStart);

    if(val && store){
      var wrapped=wrapText(val[1],wrapWidth,mlSep);
      var unmasked=unmaskTags(wrapped,store.tl||[]);
      var useBracket = unmasked.indexOf('"')!==-1;
      out += prefix + (useBracket ? ('[['+unmasked+']]') : ('"'+unmasked+'"'));
    } else {
      out += mm[0];
    }
    lastPos = mm.index + mm[0].length;
  }
  out += scriptText.slice(lastPos);
  return out;
}


export { getArtRanges as getArtemisTxtRanges, extractFromArt as extractFromArtemisTxt, repackArt as repackArtemisTxt, looksLikeArtemisTxt,
  getArtRanges, extractFromArt, repackArt, extractFromAst, repackAst, detectAstLanguages, extractFromAstGeneric, repackAstGeneric };
