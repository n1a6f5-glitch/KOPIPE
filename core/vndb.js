// core/vndb.js – VNDB character fetch + glossary draft building. Ported from KOPIPE.
import { parseBatchUnified, isNarrationSpeaker } from './batch.js';
import { setLogger } from './util.js';
let _log = () => {};
export function setVndbLogger(fn){ _log = fn || (() => {}); }
function log(m, c){ _log(m, c); }
// ── VNDB ──────────────────────────────────────────────────
async function vndbPost(ep,payload,retries){
  retries=retries||3;
  for(var a=1;a<=retries;a++){
    var r=await fetch('https://api.vndb.org/kana/'+ep,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(r.status==429&&a<retries){log('  [VNDB] Rate-limited – tunggu '+2*a+'s...','w');await new Promise(function(x){setTimeout(x,2000*a)});continue;}
    if(!r.ok)throw new Error('VNDB HTTP '+r.status);
    return r.json();
  }
  throw new Error('VNDB: max retries exceeded.');
}
async function fetchVndb(raw){
  var id='v'+parseInt(raw.replace(/[^0-9]/g,''),10);
  log('  [VNDB] Fetching characters for '+id+'...','i');
  var all=[],page=1;
  while(true){
    var r=await vndbPost('character',{filters:['vn','=',['id','=',id]],fields:'name,original,aliases',results:25,page:page});
    all=all.concat(r.results||[]);if(!r.more)break;page++;await new Promise(function(x){setTimeout(x,300)});
  }
  log('  [VNDB] '+all.length+' characters retrieved.','i');return all;
}
function normStr(s){return s.trim().normalize('NFKC').toLowerCase()}
function jpOrder(r){var p=r.trim().split(' ');return p.length==2?p[1]+' '+p[0]:r}

// FIXED VNDB Name Matching: Latin name in VNDB is [Given] [Family], Japanese is [Family] [Given]
function splitVndbName(kf, rf){
  kf=(kf||'').trim(); rf=(rf||'').trim();
  var res={kanji_full:kf,romaji_full:rf,kanji_family:'',kanji_given:'',romaji_family:'',romaji_given:'',order:'normal'};
  var rp=rf?rf.split(/\s+/):[];
  var hasDot=/[・]/.test(kf), hasSp=/[\s\u3000]/.test(kf);
  var kp=kf?kf.split(/[\s\u3000・]+/).filter(Boolean):[];
  if(kp.length==1&&rp.length<=1){ res.kanji_given=kf; res.romaji_given=rf; return res; }
  if(kp.length==2&&rp.length==2){
    res.romaji_given=rp[0]; res.romaji_family=rp[1];
    if(hasDot&&!hasSp){ res.kanji_given=kp[0]; res.kanji_family=kp[1]; res.order='western'; }
    else { res.kanji_family=kp[0]; res.kanji_given=kp[1]; res.order='japanese'; }
    return res;
  }
  if(rp.length==2 && /[\u3040-\u30ff\u4e00-\u9fff]/.test(kf) && !hasDot) res.order='japanese'; else res.order='western';
  return res;
}
function fullRomaji(p){
  if(p.romaji_given&&p.romaji_family)
    return p.order==='japanese'? p.romaji_family+' '+p.romaji_given : p.romaji_given+' '+p.romaji_family;
  if(p.order==='japanese'){var t=p.romaji_full.split(/\s+/);return t.length==2?t[1]+' '+t[0]:p.romaji_full}
  return p.romaji_full;
}
function matchVndb(names,chars){
  var strip=function(x){return x.replace(/[\s\u3000・]+/g,'');};
  var idx=new Map();
  chars.forEach(function(c){
    var o=(c.original||'').trim(); if(!o) return;
    var n=normStr(o); if(!idx.has(n)) idx.set(n,c);
    var ns=strip(n); if(ns&&!idx.has(ns)) idx.set(ns,c);
  });
  var out={};
  names.forEach(function(sn){
    var sN=normStr(sn), sS=strip(sN), found=null, conf='', famOnly=false;
    if(idx.has(sN)){found=idx.get(sN);conf='exact'} else if(idx.has(sS)){found=idx.get(sS);conf='exact'}
    if(!found && sS.length>=2){
      var hits=[]; idx.forEach(function(ch,k){ if(k.includes(sS)&&hits.indexOf(ch)<0) hits.push(ch) });
      if(hits.length==1){found=hits[0];conf='partial'}
      else if(hits.length>1){
        var ps=hits.map(function(h){return splitVndbName(h.original,h.name)});
        var sameFam=ps.every(function(p){return (p.kanji_family?strip(normStr(p.kanji_family))===sS:(p.order==='japanese'?strip(normStr(splitVndbName(p.kanji_full,p.romaji_full).kanji_family))===sS:false))});
        if(sameFam){found=hits[0];conf='family-shared';famOnly=true} else conf='ambiguous';
      }
    }
    if(!found&&conf!=='ambiguous'){
      for(var i=0;i<chars.length&&!found;i++)
        (chars[i].aliases||[]).forEach(function(a){ if(!found&&normStr(a)===sN){found=chars[i];conf='alias'} });
    }
    if(found){
      var p=splitVndbName(found.original,found.name);
      if(famOnly){
        out[sn]={kanji_full:sn,romaji_fullOut:p.romaji_family||p.romaji_full.split(/\s+/).pop(),kanji_family:'',kanji_given:sn,romaji_family:p.romaji_family||'',romaji_given:'',order:'western',confidence:'family-only',vndb_id:found.id||''};
      } else {
        out[sn]={kanji_full:found.original||sn,romaji_fullOut:fullRomaji(p),kanji_family:p.kanji_family,kanji_given:p.kanji_given,romaji_family:p.romaji_family,romaji_given:p.romaji_given,order:p.order,confidence:conf,vndb_id:found.id||''};
      }
    } else if(conf==='ambiguous'){
      out[sn]={skip:true,reason:'Nama ambigu – cocok dengan beberapa karakter VNDB'};
    }
  });
  return out;
}
function buildGls(names,matches,existingGls){
  var out=Object.assign({},existingGls||{});
  (names||[]).forEach(function(n){
    var m=matches[n]; if(!m||m.skip) return;
    var full=m.romaji_fullOut||'';
    if(full&&!out[n]) out[n]=full;
    if(m.kanji_given&&m.romaji_given&&!out[m.kanji_given]) out[m.kanji_given]=m.romaji_given;
    if(m.kanji_family&&m.romaji_family&&!out[m.kanji_family]) out[m.kanji_family]=m.romaji_family;
  });
  return out;
}
async function fetchVndbByUrl(url){
  var m=url.match(/v(\d+)/i); if(!m) throw new Error('URL / ID VNDB tidak valid');
  return fetchVndb('v'+m[1]);
}
export { fetchVndb, fetchVndbByUrl, matchVndb, buildGls, splitVndbName, fullRomaji };
