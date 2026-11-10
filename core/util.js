// core/util.js – glossary helpers, tag masking, wrapping. Ported from KOPIPE.
let _log = () => {};
export function setLogger(fn){ _log = fn || (() => {}); }
function log(msg, c){ _log(msg, c); }
export const cfg = { maskJpQuotes: false };

function loadGls(data){
  if(typeof data!='object'||Array.isArray(data)){log('  [WARN] Glossary bukan object.','w');return{}}
  var c={};
  var keys=Object.keys(data);
  for(var i=0;i<keys.length;i++){
    var k=keys[i],v=data[k];
    if(typeof k==='string'&&typeof v==='string')c[k]=v;
  }
  log('  [Glossary] '+Object.keys(c).length+' entries loaded.');
  return c;
}
function sortGls(g){
  return Object.entries(g).filter(function(x){return x[1].trim()}).sort(function(a,b){return b[0].length-a[0].length||a[0].localeCompare(b[0])});
}
function applyGls(text,sg){
  for(var i=0;i<sg.length;i++){var s=sg[i][0],t=sg[i][1];if(text.includes(s))text=text.split(s).join(t)}
  return text;
}

function maskTags(msg){
  var tl=[],n=0;
  var masked=msg.replace(/%[^;]+;/g,function(x){tl.push(x);return'<T'+(++n)+'>'});
  return{masked:masked,tl:tl};
}
function unmaskTags(text,tl){
  return text.replace(/<T(\d+)>/g,function(m,n){
    var i=parseInt(n,10)-1;
    if(i>=0&&i<tl.length)return tl[i];
    log('  [WARN] Unresolvable <T'+(i+1)+'>','w');return m;
  });
}

function resEsc(s){return s.replace(/\\n/g,'\n').replace(/\\r/g,'\r').replace(/\\t/g,'\t')}
function wrapText(text,width,nl){
  if(width<=0)return text;
  var words=text.split(' '),lines=[],cur='';
  for(var i=0;i<words.length;i++){
    var w=words[i];
    if(!cur){cur=w;continue}
    if((cur+' '+w).length<=width)cur+=' '+w;
    else{lines.push(cur);cur=w}
  }
  if(cur)lines.push(cur);
  return lines.join('\n').replace(/\n/g,nl);
}

function applyGlsSafe(text,sg){
  return text.split(/(<T\d+>)/).map(function(p,i){return i%2?p:applyGls(p,sg)}).join('');
}
function maskTxtTags(msg){
  var tl=[],n=0;
  var re = cfg.maskJpQuotes ? /%[^;]+;|\[.*?\]|[「」『』]/g : /%[^;]+;|\[.*?\]/g;
  var masked=msg.replace(re,function(x){tl.push(x);return'<T'+(++n)+'>'});
  return{masked:masked,tl:tl};
}

export { loadGls, sortGls, applyGls, applyGlsSafe, maskTags, unmaskTags, resEsc, wrapText, maskTxtTags };
