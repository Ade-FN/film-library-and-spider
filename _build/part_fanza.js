/* ============================================================================
 * part_fanza —— 待抓清单（v2.1.24 起多站点版）
 * 自旧版 L3431–3513 移植；差异：
 *   · v2.1.24：「FANZA 清单」更名「待抓清单」，来源站由用户勾选：
 *     FANZA / MGS / FC2 按番号规则精确匹配；JAVDB / MISSAV 是聚合站
 *     （收录各类番号）→ 通配。勾选状态存 localStorage（默认仅 FANZA，
 *     与旧行为一致）；点番号打开该行命中的第一个勾选站搜索页。
 *   · 导出番号清单同时 POST /api/pending（FL Spider 批量队列的 HTTP 来源，
 *     载荷加 sources 数组；爬虫只读 codes，兼容旧版），
 *     下载 json 保留（兼容旧爬虫的文件读取模式）
 *   · copyText / download / stamp 用 app 内的实现
 * ======================================================================== */
/* 番号规则（三站各自精确；聚合站通配）：
   · FANZA：字母头（ABP-123 / dsod00009 形态），排除 FC2
   · MGS  ：数字前缀字母段（300MIUM-451 / 426SDDL-012）
   · FC2  ：FC2[- ]?(PPV)?[- ]?数字（大小写不敏感） */
var RE_CODE_FANZA_ONLY = /^[A-Za-z]{3,6}(?:-|00)\d{3,6}(?:-U)?(?:-C)?(?:-E)?(?:-\d)?$/;
var RE_CODE_MGS = /^\d{2,4}[A-Za-z]{3,6}-?\d{2,5}$/;
var RE_FC2_ANY = /FC2[- ]?(PPV)?[- ]?\d{3,10}/i;
function isFc2Code(code){ return RE_FC2_ANY.test(String(code || '')); }
/* 待补全判定：原名 / 中文名 / 演员 / 封面 缺一即算（part_fill 的收件箱状态也用）
   v2.1.29 A-09：演员口径对齐 getFiltered 的 miss:pending（认 actorF/actorM）——
   拆分录入（只有女演员/男演员）的行旧版在这里被误判「缺演员」，待抓清单和
   补全面板反复挂着明明有演员的行。 */
function pendingRow(r){
  return !r.title || !r.titleCn || !(r.actor || r.actorF || r.actorM) || !(r.cover && (r.cover.src || r.cover.path));
}
/* 缺哪些字段（用于清单里标注） */
function missingFields(r){
  var miss = [];
  if(!r.title) miss.push('原名');
  if(!r.titleCn) miss.push('中文名');
  if(!(r.actor || r.actorF || r.actorM)) miss.push('演员');
  if(!(r.cover && (r.cover.src || r.cover.path))) miss.push('封面');
  return miss.length ? ('缺 ' + miss.join(' / ')) : '资料完整';
}
/* ---------- 来源站定义（顺序即「点番号打开哪个站」的优先级） ---------- */
var PENDING_SITES = [
  { key: 'fanza', name: 'FANZA', agg: false,
    match: function (c) { return !isFc2Code(c) && RE_CODE_FANZA_ONLY.test(c); },
    site: function (s) { return !!s && (s.xf === 'fanza' || /dmm\.co\.jp/.test(String(s.url || ''))); },
    fallback: { key: 'fanza', name: 'FANZA', url: 'https://video.dmm.co.jp/av/list/?key={code}', xf: 'fanza' } },
  { key: 'mgs', name: 'MGS', agg: false,
    match: function (c) { return RE_CODE_MGS.test(c); },
    site: function (s) { return !!s && String(s.key || '').toLowerCase() === 'mgs'; },
    fallback: { key: 'mgs', name: 'MGS', url: 'https://www.mgstage.com/search/cSearch.php?search_word={code}' } },
  { key: 'fc2', name: 'FC2', agg: false,
    match: function (c) { return RE_FC2_ANY.test(c); },
    site: function () { return null; },
    fallback: { key: 'fc2', name: 'FC2', url: 'fc2-article' } },
  { key: 'javdb', name: 'JAVDB', agg: true,
    match: function () { return true; },
    site: function (s) { return !!s && String(s.key || '').toLowerCase() === 'javdb'; },
    fallback: { key: 'javdb', name: 'JAVDB', url: 'https://javdb.com/search?q={code}&f=all' } },
  { key: 'missav', name: 'MISSAV', agg: true,
    match: function () { return true; },
    site: function (s) { return !!s && String(s.key || '').toLowerCase() === 'missav'; },
    fallback: { key: 'missav', name: 'MISSAV', url: 'https://missav.ws/cn/search/{code}' } }
];
var LS_PENDING_SITES = 'wb_film_v2_pending_sites';
/* 勾选的来源站键（localStorage；默认仅 FANZA 保持旧行为） */
function getPendingSites(){
  var keys = null;
  try { keys = JSON.parse(lsGet(LS_PENDING_SITES, 'null')); } catch (e) { keys = null; }
  if (!Array.isArray(keys)) keys = ['fanza'];
  var known = PENDING_SITES.map(function (s) { return s.key; });
  keys = keys.filter(function (k) { return known.indexOf(k) >= 0; });
  if (!keys.length) keys = ['fanza'];
  return keys;
}
function setPendingSites(keys){ lsSet(LS_PENDING_SITES, JSON.stringify(keys)); }
/* 该番号命中勾选站中的哪些（按 PENDING_SITES 顺序） */
function matchedSites(code, keys){
  var c = String(code || '');
  return PENDING_SITES.filter(function (s) {
    return keys.indexOf(s.key) >= 0 && s.match(c);
  }).map(function (s) { return s.key; });
}
/* 待抓行 = 资料不完整 且 番号命中任一勾选站 */
function pendingRowsFor(keys){
  return state.rows.filter(function (r) {
    return pendingRow(r) && matchedSites(r.code, keys).length > 0;
  });
}
/* 兼容名：FANZA 单选时的待抓行（build 存在性校验与旧调用点用） */
function fanzaPendingRows(){ return pendingRowsFor(['fanza']); }
/* 取某站的搜索配置：优先用户设置里的资料来源，取不到用内置默认 */
function pendingSiteCfg(key){
  var def = PENDING_SITES.filter(function (s) { return s.key === key; })[0];
  if (!def) return null;
  var hit = null;
  getSites().forEach(function (s) { if (!hit && def.site(s)) hit = s; });
  return hit || def.fallback;
}
/* 打开该行命中的第一个勾选站的搜索页（FC2 走文章页，按番号取数字 id） */
function openPendingSearch(code, keys){
  var m = matchedSites(code, keys);
  if (!m.length) { toast('该番号不在勾选的来源站规则内', 'err'); return; }
  var key = m[0], s = pendingSiteCfg(key);
  if (!s) return;
  if (key === 'fc2') {
    var id = String(code).replace(/^FC2[- ]?(PPV)?[- ]?/i, '');
    window.open('https://adult.contents.fc2.com/article/' + encodeURIComponent(id) + '/', '_blank');
    return;
  }
  window.open(siteUrlOf(s, code), '_blank');
}
function renderPendingSiteBox(keys){
  var box = $('#pendingSites');
  if (!box) return;
  box.innerHTML = PENDING_SITES.map(function (s) {
    var on = keys.indexOf(s.key) >= 0;
    return '<label style="display:flex;align-items:center;gap:5px;font-size:13px;cursor:pointer;user-select:none;"' +
      ' title="' + (s.agg ? '聚合站：收录各类番号' : '按番号规则匹配') + '">' +
      '<input type="checkbox" data-pending-site="' + s.key + '"' + (on ? ' checked' : '') + ' style="width:auto;margin:0;">' +
      escapeHtml(s.name) + '</label>';
  }).join('');
  $all('input[data-pending-site]', box).forEach(function (inp) {
    inp.addEventListener('change', function () {
      var k = inp.getAttribute('data-pending-site');
      var cur = getPendingSites();
      var i = cur.indexOf(k);
      if (inp.checked) { if (i < 0) cur.push(k); }
      else if (i >= 0) cur.splice(i, 1);
      if (!cur.length) { toast('至少勾选一个来源站', 'err'); inp.checked = true; return; }
      setPendingSites(cur);
      renderPendingList();
    });
  });
}
function renderPendingList(){
  var keys = getPendingSites();
  renderPendingSiteBox(keys);
  var list = pendingRowsFor(keys);
  var box = $('#fanzaList');
  if (!box) return;
  if (!list.length) {
    box.innerHTML = '<div class="mg-empty">勾选的来源站下没有待抓影片（没有资料不完整且番号符合所选站点规则的影片）。</div>';
    return;
  }
  box.innerHTML =
    '<div class="mg-group" style="justify-content:space-between;">' +
      '<span class="mg-name">共 <b>' + list.length + '</b> 部待抓</span>' +
      '<span class="mg-meta">点番号打开命中站点的搜索页</span>' +
    '</div>' +
    '<div class="fanza-grid">' +
    list.map(function (r) {
      var tags = matchedSites(r.code, keys).map(function (k) {
        var def = PENDING_SITES.filter(function (s) { return s.key === k; })[0];
        return def ? def.name : k;
      }).join(' · ');
      return '<div><button type="button" class="btn sm" data-pending-code="' + escapeHtml(r.code) + '" style="width:100%;">' +
        escapeHtml(r.code) + '</button>' +
        '<div class="shot-name">' + escapeHtml(missingFields(r)) + '</div>' +
        '<div class="shot-name" style="color:var(--blue)">' + escapeHtml(tags) + '</div></div>';
    }).join('') + '</div>';
}
function openPendingPanel(){ renderPendingList(); openModal('fanzaMask'); }
function closePendingPanel(){ closeModal('fanzaMask'); }
function pendingCodes(){ return pendingRowsFor(getPendingSites()).map(function (r) { return r.code; }); }
function copyPendingCodes(){
  var codes = pendingCodes();
  if (!codes.length) { toast('没有待抓影片', 'err'); return; }
  copyText(codes.join('\n'), '已复制 ' + codes.length + ' 个番号');
}
/* 导出为「Film Library 待补全番号_*.json」——FL Spider「批量」认这个文件；
   同时 POST /api/pending，新版爬虫可直接从服务端读队列（只读 codes，兼容）。
   本函数名 exportPendingCodes 是待抓清单专属，part_fill 的补全面板导出
   必须用 exportFillPendingCodes——本部件拼接在前，同名会被后者覆盖（v2.1.25 修） */
function exportPendingCodes(){
  var codes = pendingCodes();
  if (!codes.length) { toast('没有待抓影片', 'err'); return; }
  var keys = getPendingSites();
  var payload = { app: 'Film Library', type: 'pending-codes', source: keys[0], sources: keys,
    exportedAt: new Date().toISOString(), codes: codes };
  download('Film Library 待补全番号_' + stamp() + '.json',
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  API.pendingPost(codes).catch(function () {});
  toast('已导出 ' + codes.length + ' 个番号（并已写入服务端队列，爬虫「批量」可直接读取）', 'ok');
}
function openPendingBatch(){
  var keys = getPendingSites();
  var codes = pendingCodes();
  if (!codes.length) { toast('没有待抓影片', 'err'); return; }
  codes.slice(0, 5).forEach(function (c) { openPendingSearch(c, keys); });
  toast('已打开 ' + Math.min(5, codes.length) + ' 个搜索页（按各自命中的站点），抓完点「读取收件箱」', 'ok');
}
function bindFanza(){
  $('#fanzaBtn').addEventListener('click', openPendingPanel);
  $('#fanzaClose').addEventListener('click', closePendingPanel);
  $('#fanzaCloseBtn').addEventListener('click', closePendingPanel);
  $('#fanzaCopyBtn').addEventListener('click', copyPendingCodes);
  $('#fanzaExportBtn').addEventListener('click', exportPendingCodes);
  $('#fanzaBatchBtn').addEventListener('click', openPendingBatch);
  $('#fanzaList').addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-pending-code]');
    if (b) openPendingSearch(b.getAttribute('data-pending-code'), getPendingSites());
  });
}
