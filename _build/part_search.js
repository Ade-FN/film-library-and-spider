/* ============================================================================
 * part_search.js — 「高级搜索语法」搜索引擎（A-21：自冻结旧备份固化为独立部件）
 *
 * 来历：迁移前由 build_v2.js 从冻结旧备份 _backup/2026-10-14_重写前/
 *   Film Library.html 抽取「#14 高级搜索语法」整节 + 4 个节外依赖函数
 *   （splitList / naturalCmp / scopeText / buildMatcher），再打 10 余个链式精确
 *   补丁适配 v2。链式替换顺序耦合、一碰就断，故整体固化为本部件：
 *   ★ 以后改搜索语义直接改本文件，然后 node _build/build_v2.js 重建即可；
 *   ★ 改产物 Film Library.html 无效（下次构建即被覆盖）。
 *
 * 复验：node _test/freeze_search_engine.js --diff 可对照旧备份重放整条补丁链，
 *   列出与本文件的差异（有意手改属预期；仅用于确认"没被无意改坏"）。
 *
 * 烘焙进本文件的 v2 适配（动手前知道自己在改什么）：
 *   · rating/评分 全链移除（v2.0.0 决策），getWatchRows/cmpRating 死代码剔除
 *   · releaseSale/releaseStream 二合一 → release；新增 maker；director 进搜索
 *   · 来源站扩展 javdb/missav/motv；platformOf 按番号推断存量来源
 *   · 影片日期年月日语义（releaseDatePairs / releaseDateMatch）
 *   · regexHint 改 class 驱动；普通模式走 buildPlainMatcher（字面匹配，无 ReDoS）
 *   · filterSig 补 f.scope；scopeText 默认范围纳入全部新字段
 * ==========================================================================*/
  /* ---- 以下自 v1 原样搬运（rating 分支按 v2.0.0 决策移除） ---- */
function splitList(s){
  return String(s || '').split(/[,，、;；]+/).map(function(t){ return t.trim(); }).filter(Boolean);
}

function naturalCmp(a, b){
  return String(a || '').localeCompare(String(b || ''), 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function scopeText(r){
  var s = state.filter.scope || 'all';
  if(s === 'code') return r.code;
  if(s === 'title') return r.title;
  if(s === 'titleCn') return r.titleCn || '';
  if(s === 'actor') return [r.actor, r.actorF, r.actorM].filter(Boolean).join(', ');
  if(s === 'tags') return r.tags;
  if(s === 'note') return r.note;
  if(s === 'series') return r.series || '';
  if(s === 'director') return r.director || '';
  if(s === 'maker') return r.maker || '';
  if(s === 'platform') return r.platform || platformOf(r.code) || '';
  if(s === 'release') return String(r.release || '');
  return [r.code, r.title, r.titleCn, r.release, r.maker, r.series, r.director, r.platform, r.actor, r.actorF, r.actorM, r.tags, r.note].join(' ');
}

function buildMatcher(text, force){
  var h = $('#regexHint');
  h.classList.remove('err');
  h.textContent = '正则模式：整个输入作为正则匹配（非法正则视为无结果）';
  if(!$('#regexToggle').classList.contains('on')) h.classList.remove('show');
  if(!text) return null;
  try{
    var re = new RegExp(text, 'i');
    return function(s){ return re.test(s); };
  }catch(e){
    h.classList.add('show', 'err');
    if(force){
      h.textContent = '正则表达式格式有误，请检查';
      return function(){ return false; };
    }
    h.textContent = '正则表达式格式有误，已按普通文本搜索';
    var low = text.toLowerCase();
    return function(s){ return String(s).toLowerCase().indexOf(low) !== -1; };
  }
}

/* ============ #14 高级搜索语法 ============
   字段定向 code:ABP-123 / 演员:花子；排除 -词 或 -字段:值；
   引号短语 "完全匹配"；竖线或 标签:巨乳|美乳；空格＝与。
   不含上述语法时 buildRowMatcher 返回 null，交给原有「范围 + 正则/子串」逻辑，保证向后兼容。 */
var Q_FIELDS = {
  code:'code', 番号:'code',
  title:'title', 原名:'title',
  cn:'titleCn', 中文名:'titleCn',
  actor:'actor', 演员:'actor',
  tag:'tags', 标签:'tags', tags:'tags',
  note:'note', 备注:'note',
  status:'status', 状态:'status',
  magnet:'magnet', 磁力:'magnet',
  release:'release', 发售:'release', 発売:'release', 上市:'release', 日期:'release', 影片日期:'release', 配信:'release', 发行日:'release',
  maker:'maker', 发行商:'maker', 制造商:'maker', 片商:'maker',
  series:'series', 系列:'series',
  director:'director', 导演:'director',
  platform:'platform', 平台:'platform', 来源:'platform'
};
var Q_FIELD_RE = /^([A-Za-z\u4e00-\u9fa5]+)\s*[:：][\s\S]*$/;

function fieldTextOf(r, key){
  if(key === 'code') return r.code || '';
  if(key === 'title') return r.title || '';
  if(key === 'titleCn') return r.titleCn || '';
  if(key === 'actor') return [r.actor, r.actorF, r.actorM].join(',');
  if(key === 'tags') return r.tags || '';
  if(key === 'note') return r.note || '';
  if(key === 'status') return r.status || '';
  if(key === 'magnet') return r.magnet || '';
  if(key === 'release') return String(r.release || '');
  if(key === 'maker') return r.maker || '';
  if(key === 'series') return r.series || '';
  if(key === 'director') return r.director || '';
  if(key === 'platform') return r.platform || platformOf(r.code) || '';
  return '';
}
/* 平台：按番号正则区分 FANZA / MGS / FC2（FC2 优先，避免被 FANZA 正则误收） */
function platformOf(code){
  var c = String(code || '').trim().toUpperCase();
  if(/FC2[- ]?(PPV)?[- ]?\d{3,10}/i.test(c)) return 'FC2';
  if(/^\d{2,4}[A-Za-z]{3,6}-\d{2,4}$/.test(c)) return 'MGS';
  if(/^[A-Za-z]{3,6}-\d{2,4}$/.test(c)) return 'FANZA';
  return '';
}
/* 导入时按来源站直接给平台（比番号正则更准：爬虫会把 300MIUM-451 转成 MIUM-451，正则会误判成 FANZA） */
function srcPlatform(source){
  if(!source) return '';
  var s = String(source).toLowerCase();
  if(s === 'mgs') return 'MGS';
  if(s === 'fc2') return 'FC2';
  if(s === 'fanza' || s === 'dmm' || s === 'dmmvideo') return 'FANZA';
  if(s === 'javdb') return 'JAVDB';
  if(s === 'missav') return 'MISSAV';
  if(s === 'motv') return 'MOTV';
  return '';
}
/* 按 | 切「或」，引号内的 | 不当分隔符 */
function splitOr(v){
  var out = [], buf = '', q = false;
  for(var i = 0; i < v.length; i++){
    var ch = v.charAt(i);
    if(ch === '"' || ch === '\u201c' || ch === '\u201d'){ q = !q; continue; }
    if(ch === '|' && !q){ out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  out.push(buf);
  return out.filter(function(x){ return x !== ''; });
}
/* 按空格切词，引号内空格保留，支持 \\ 转义 */
function tokenizeQuery(text){
  var out = [], i = 0, n = text.length;
  while(i < n){
    while(i < n && /\s/.test(text.charAt(i))) i++;
    if(i >= n) break;
    var neg = false;
    if(text.charAt(i) === '-' && i + 1 < n && !/\s/.test(text.charAt(i + 1))){ neg = true; i++; }
    var buf = '';
    while(i < n && !/\s/.test(text.charAt(i))){
      var ch = text.charAt(i);
      if(ch === '"' || ch === '\u201c' || ch === '\u201d'){
        var q = ch; i++;
        while(i < n && text.charAt(i) !== q){ buf += text.charAt(i); i++; }
        i++; continue;
      }
      if(ch === '\\' && i + 1 < n){ buf += text.charAt(i + 1); i += 2; continue; }
      buf += ch; i++;
    }
    if(buf) out.push({ neg: neg, raw: buf });
  }
  return out;
}
function parseClause(raw){
  var m = Q_FIELD_RE.exec(raw);
  if(m){
    var key = Q_FIELDS[m[1].toLowerCase()];
    if(key) return { field: key, value: raw.slice(m[1].length).replace(/^\s*[:：]\s*/, '') };
  }
  return { field: '', value: raw };
}
/* 从影片日期原文抽取全部 (年,月[,日]) 组合（v2.1.22）。
   兼容 2017/03/17、2017-03-17、2017年3月17日、2017.03、区间串（首段即起始日）。
   抽不到年月对时退化为纯年份（"2017" → [2017,0,0]）。 */
function releaseDatePairs(raw){
  var s = String(raw == null ? '' : raw), out = [], m;
  var re = /(\d{4})\s*[-/.年]\s*(\d{1,2})(?:\s*[-/.日月]\s*(\d{1,2}))?/g;
  while((m = re.exec(s))) out.push([+m[1], +m[2], m[3] ? +m[3] : 0]);
  if(!out.length){
    var re2 = /(\d{4})/g;
    while((m = re2.exec(s))) out.push([+m[1], 0, 0]);
  }
  return out;
}
/* release 查询值匹配：年 / 月 / 年月 / 年月日；1-2 位纯数字只按月份语义
   （防止 "17" 误中 2017 年份子串），其余值按子串退化匹配。 */
function releaseDateMatch(raw, q){
  var v = String(q == null ? '' : q).trim();
  if(!v) return false;
  var m = /^(\d{4})(?:[-/.年]\s*(\d{1,2})(?:[-/.日月]\s*(\d{1,2}))?)?$/.exec(v);
  if(m){
    var y = +m[1], mo = m[2] ? +m[2] : 0, d = m[3] ? +m[3] : 0;
    return releaseDatePairs(raw).some(function(p){
      if(p[0] !== y) return false;
      if(mo && p[1] !== mo) return false;
      if(d && p[2] !== d) return false;
      return true;
    });
  }
  if(/^\d{1,2}$/.test(v)){
    var mm = +v;
    return mm >= 1 && mm <= 12 && releaseDatePairs(raw).some(function(p){ return p[1] === mm; });
  }
  return String(raw == null ? '' : raw).toLowerCase().indexOf(v.toLowerCase()) !== -1;
}
/* 返回 null＝无高级语法（走旧逻辑）；否则 function(row)->bool */
/* 普通模式匹配器（v2.1.26 BUG-10）：字面子串匹配，竖线保留「或」语义，
   绝不 new RegExp —— 元字符不再漂移，也没有灾难性回溯。 */
function buildPlainMatcher(text){
  if(!text) return null;
  var parts = String(text).split('|').map(function(s){ return s.trim().toLowerCase(); }).filter(Boolean);
  if(!parts.length) return null;
  return function(s){
    var low = String(s).toLowerCase();
    return parts.some(function(p){ return low.indexOf(p) !== -1; });
  };
}
function buildRowMatcher(text){
  if(!text) return null;
  var toks = tokenizeQuery(text);
  if(!toks.length) return null;
  var clauses = toks.map(function(t){ var c = parseClause(t.raw); c.neg = t.neg; return c; });
  var advanced = clauses.some(function(c){ return !!c.field || c.neg; });
  if(!advanced) return null;
  var tests = clauses.map(function(c){
    var parts = splitOr(c.value), key = c.field, sub;
    if(key === 'status'){
      sub = function(r){ var st = String(r.status || ''); return parts.some(function(p){ return st.indexOf(p) !== -1; }); };
    } else if(key === 'release'){
      sub = function(r){ return parts.some(function(p){ return releaseDateMatch(fieldTextOf(r, 'release'), p); }); };
    } else {
      var ms = parts.map(function(p){ return buildMatcher(p) || function(){ return false; }; });
      sub = function(r){
        var s = key ? fieldTextOf(r, key) : scopeText(r);
        return ms.some(function(m){ return m(s); });
      };
    }
    return c.neg ? function(r){ return !sub(r); } : sub;
  });
  return function(r){ return tests.every(function(t){ return t(r); }); };
}

  var _fltCache = { sig: '', rows: null };
  function filterSig(){
    var f = state.filter;
    return [f.text||'', f.scope||'', f.status||'', f.tag||'', f.actor||'', (f.miss||[]).join(','), f.regex||'', f.sort||'', state.rowsVersion||0, state.rows.length].join('\u0001');
  }
  function getFiltered(){
    var sig = filterSig();
    if(sig === _fltCache.sig && _fltCache.rows) return _fltCache.rows;
    var f = state.filter;
    var qm = f.regex ? null : buildRowMatcher(f.text);
    var match = f.regex ? buildMatcher(f.text, true) : (qm ? null : buildPlainMatcher(f.text));
    var rows = state.rows.filter(function(r){
      if(f.status && r.status !== f.status) return false;
      if(f.tag && splitList(r.tags).indexOf(f.tag) === -1) return false;
      if(f.actor && splitList([r.actor, r.actorF, r.actorM].join(',')).indexOf(f.actor) === -1) return false;
      if(f.miss && f.miss.length){
        for(var mi = 0; mi < f.miss.length; mi++){
          var mk = f.miss[mi];
          if(mk === 'cover' && r.cover && (r.cover.src || r.cover.path)) return false;
          if(mk === 'magnet' && String(r.magnet || '').trim()) return false;
          if(mk === 'pending' && !(!r.title || !r.titleCn || !(r.actor || r.actorF || r.actorM) || !(r.cover && (r.cover.src || r.cover.path)))) return false;
        }
      }
      if(qm){ if(!qm(r)) return false; }
      else if(match && !match(scopeText(r))) return false;
      return true;
    });
    rows.sort(function(a, b){
      if(f.sort === 'code_desc') return naturalCmp(b.code, a.code);
      if(f.sort === 'recent') return (b.ts || 0) - (a.ts || 0);
      if(f.sort === 'recent_asc') return (a.ts || 0) - (b.ts || 0);
      if(f.sort === 'updated') return (b.updated || 0) - (a.updated || 0);
      if(f.sort === 'updated_asc') return (a.updated || 0) - (b.updated || 0);
      return naturalCmp(a.code, b.code);
    });
    _fltCache.rows = rows; _fltCache.sig = sig;
    return rows;
  }
function getAllTags(){
  var seen = {}, out = [];
  state.rows.forEach(function(r){
    splitList(r.tags).forEach(function(t){ if(!seen[t]){ seen[t] = 1; out.push(t); } });
  });
  return out.sort();
}

