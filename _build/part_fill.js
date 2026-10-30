/* ============================================================================
 * part_fill —— 补全资料面板（与 FL 爬虫对接）
 * 自旧版 L2839–3173 移植；差异：
 *   · 文件夹连接 / fsRead / listDirNames / countInbox / archiveInbox 全部走服务端 API：
 *     收件箱状态 = API.inbox()；失败清单 = API.files(prefix) + /data/<name> 读取；
 *     导入归档 = importInbox()（app §9，服务端 dedupeInbox + 归档）
 *   · getSites 保留旧 localStorage 键（wb_film_v2_sites），老用户配置不丢；
 *     一次性迁移：缺 FANZA 补首位 + javbd 误写改回 javdb（v2.1.4 补回 #45）
 * ======================================================================== */
var DEFAULT_SITES = [
  { key: 'fan',    name: 'FANZA',  url: 'https://video.dmm.co.jp/av/list/?key={code}', xf: 'fanza' },
  { key: 'javdb',  name: 'JavDB',  url: 'https://javdb.com/search?q={code}&f=all' },
  { key: 'missav', name: 'MissAV', url: 'https://missav.ws/cn/search/{code}' },
  { key: 'mgs',    name: 'MGS',    url: 'https://www.mgstage.com/?search_word={code}', xf: '' }
];
var FAILED_PREFIX = 'Film Library 抓取失败番号_';
var LS_SITES_JD = 'wb_film_v2_sites_javdbfix';   // 一次性迁移标记：把误写成的 javbd 改回 javdb（v1.0.9 同款键）
function getSites(){
  /* v2.1.4 修：lsSet 不做 JSON 序列化，数组直接 setItem 会被 coercion 成
     "[object Object],…" 字符串，下次读回来不是数组 → 用户改的资料来源从来不落盘。
     这里显式 JSON.parse/lsSet 显式 JSON.stringify，与 actors/tagMeta 的读写方式一致
     （v2.1.40：筛选预设功能已移除，原注释所指的那份存储不再存在）。 */
  var s = null;
  try { s = JSON.parse(lsGet(LS.sites, 'null')) || null; } catch (e) { s = null; }
  if(!Array.isArray(s) || !s.length) s = DEFAULT_SITES.slice();
  /* 缺 FANZA 就补到首位（老用户迁移） */
  if(!s.some(function(x){ return x && (x.xf === 'fanza' || /dmm\.co\.jp/.test(String(x.url || ''))); })){
    s = DEFAULT_SITES.slice(0, 1).concat(s);
    setSites(s);
  }
  /* 一次性迁移：资料来源里误写成的 javbd（字母顺序写反）改回 javdb（#45，v1.0.9 同款逻辑） */
  if(!lsGet(LS_SITES_JD, 0)){
    var _jd = 0;
    s.forEach(function(x){
      if(!x) return;
      if(String(x.key || '').toLowerCase() === 'javbd'){ x.key = 'javdb'; _jd++; }
      if(/javbd/i.test(String(x.name || ''))){ x.name = String(x.name).replace(/javbd/ig, 'JavDB'); _jd++; }
      if(/javbd/i.test(String(x.url || ''))){ x.url = String(x.url).replace(/javbd/ig, 'javdb'); _jd++; }
    });
    if(_jd) setSites(s);
    lsSet(LS_SITES_JD, 1);
  }
  return s.map(function(x){
    var u = String(x.url || '');
    if(u === 'https://www.dmm.co.jp/digital/videoa/-/search/=/searchstr={code}') u = 'https://video.dmm.co.jp/av/list/?key={code}';
    if(u === 'https://missav.com/search?q={code}' || u === 'https://missav.com/search?q={code}&') u = 'https://missav.ws/cn/search/{code}';
    return { key: x.key || '', name: x.name || '', url: u, xf: x.xf || '' };
  });
}
function setSites(list){ lsSet(LS.sites, JSON.stringify(list)); }
function fillCodes(){
  return splitList(String($('#fillCode').value || '').replace(/，/g, ','));
}
function openFill(code){
  $('#fillCode').value = code || '';
  renderSiteList();
  renderInboxStatus();
  openModal('fillMask');
}
function closeFill(){ closeModal('fillMask'); }
function renderSiteList(){
  var box = $('#siteList');
  var sites = getSites();
  box.innerHTML = sites.map(function(s, i){
    return '<div class="site-item">' +
      '<input type="text" class="nm" value="' + escapeHtml(s.name) + '" data-i="' + i + '" data-k="name">' +
      '<input type="text" value="' + escapeHtml(s.url) + '" data-i="' + i + '" data-k="url" placeholder="https://…{code}…">' +
      '<button type="button" class="btn sm" data-open="' + i + '">打开</button>' +
      '<label style="font-size:11.5px;color:var(--muted);display:flex;align-items:center;gap:4px;white-space:nowrap;" title="勾选后，打开搜索页时把 ABP-123 转成 FANZA 写法 ABP00123">' +
        '<input type="checkbox" data-i="' + i + '" data-k="xf" style="width:auto"' + (s.xf === 'fanza' ? ' checked' : '') + '>FANZA 写法</label>' +
    '</div>';
  }).join('');
  $all('input[data-k]', box).forEach(function(inp){
    inp.addEventListener('change', function(){
      var i = parseInt(inp.getAttribute('data-i'), 10), k = inp.getAttribute('data-k');
      var list = getSites();
      if(!list[i]) return;
      if(k === 'xf') list[i].xf = inp.checked ? 'fanza' : '';
      else list[i][k] = inp.value.trim();
      setSites(list);
      if(k === 'xf') renderSiteList();
    });
  });
  $all('button[data-open]', box).forEach(function(btn){
    btn.addEventListener('click', function(){ openSite(parseInt(btn.getAttribute('data-open'), 10)); });
  });
}
function openSite(i){
  var s = getSites()[i];
  var codes = fillCodes();
  if(!s || !s.url){ toast('请先填写该网站的地址模板', 'err'); return; }
  if(!codes.length){ toast('请先填写番号', 'err'); return; }
  codes.slice(0, 5).forEach(function(code){
    window.open(siteUrlOf(s, code), '_blank');
  });
  toast('已打开 ' + Math.min(5, codes.length) + ' 个搜索页' +
    (s.xf === 'fanza' ? '（番号已按 FANZA 规则转换，如 ABP-123 → ABP00123）' : '') + '，等 FL 爬虫抓完后点「读取收件箱」', 'ok');
}
/* 收件箱状态 + 失败清单（服务端） */
function renderInboxStatus(){
  var el = $('#inboxStatus');
  if(!el) return;
  var pending = state.rows.filter(pendingRow).length;
  el.textContent = '正在检查收件箱…';
  API.inbox().then(function(d){
    var n = (d.items || []).length;
    var txt = '数据目录：' + baseName(state.dataDir) + ' ｜ 待补全影片 ' + pending + ' 部';
    txt += n > 0 ? (' ｜ 收件箱有 ' + n + ' 条待导入') : ' ｜ 收件箱暂无来料';
    el.textContent = txt;
  }).catch(function(e){
    el.textContent = '读取收件箱失败：' + ((e && e.message) || e);
  });
  API.files(FAILED_PREFIX).then(function(d){
    var names = d.files || [];
    if(!names.length) return;
    var name = names[names.length - 1];
    var wrap = document.createElement('div');
    wrap.style.marginTop = '6px';
    wrap.innerHTML = '发现抓取失败清单 <code>' + escapeHtml(name) + '</code> ' +
      '<button type="button" class="btn sm" id="fillFailedBtn" style="margin-left:4px;">回填番号重抓</button>';
    el.appendChild(wrap);
    $('#fillFailedBtn').addEventListener('click', function(){ readFailedCodes(name); });
  }).catch(function(){});
}
/* 读取爬虫写的失败清单 → 回填到番号输入框 */
function readFailedCodes(name){
  fetch(apiUrl('/data/' + encodeURIComponent(name))).then(function(r){
    if(!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }).then(function(txt){
    var p = JSON.parse(txt.replace(/^\uFEFF/, ''));
    var codes = (p && (p.codes || p.items)) || [];
    codes = codes.map(function(c){ return typeof c === 'string' ? c : (c && c.code); }).filter(function(c){ return !!c; });
    if(!codes.length){ toast('失败清单是空的', 'err'); return; }
    $('#fillCode').value = codes.join(', ');
    renderInboxStatus();
    toast('已回填 ' + codes.length + ' 个失败番号（来自 ' + name + '），可直接点「打开搜索页」重抓', 'ok');
  }).catch(function(e){ toast('读取失败清单出错：' + ((e && e.message) || e), 'err'); });
}
/* 导出待补全番号（全部 pending，不限 FANZA 规则）。
   注意与待抓清单的 exportPendingCodes（part_fanza）严格区分名：
   part_fanza 拼接在前，同名函数声明会被本函数覆盖（v2.1.25 修） */
function exportFillPendingCodes(){
  var pending = state.rows.filter(pendingRow).map(function(r){ return r.code; });
  if(!pending.length){ toast('没有待补全的影片', 'err'); return; }
  var payload = { app: 'Film Library', type: 'pending-codes', exportedAt: new Date().toISOString(), codes: pending };
  download('Film Library 待补全番号_' + stamp() + '.json',
    new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  API.pendingPost(pending).catch(function(){});
  toast('已导出 ' + pending.length + ' 个待补全番号（并已写入服务端队列）', 'ok');
}
function bindFill(){
  $('#fillBtn').addEventListener('click', function(){ openFill(''); });
  $('#fillClose').addEventListener('click', closeFill);
  $('#fillCloseBtn').addEventListener('click', closeFill);
  $('#fillOpenBtn').addEventListener('click', function(){
    var codes = fillCodes();
    if(!codes.length){ toast('请先填写番号', 'err'); return; }
    var sites = getSites();
    var s = sites[0];
    if(!s || !s.url){ toast('请先填写第一个网站的地址模板', 'err'); return; }
    codes.slice(0, 5).forEach(function(code){ window.open(siteUrlOf(s, code), '_blank'); });
    toast('已打开 ' + Math.min(5, codes.length) + ' 个搜索页，等 FL 爬虫抓完后点「读取收件箱并导入」', 'ok');
  });
  $('#fillExportPendingBtn').addEventListener('click', exportFillPendingCodes);
  $('#fillReadFailedBtn').addEventListener('click', function(){
    API.files(FAILED_PREFIX).then(function(d){
      var names = d.files || [];
      if(!names.length){ toast('数据目录里没有 ' + FAILED_PREFIX + '*.json', 'err'); return; }
      readFailedCodes(names[names.length - 1]);
    }).catch(function(e){ toast('查找失败清单出错：' + ((e && e.message) || e), 'err'); });
  });
  $('#fillReadInboxBtn').addEventListener('click', function(){
    closeFill();
    /* 必须重新拉取收件箱：state.inboxItems 可能是上次 openInbox 的旧缓存，
       直接用会把新来料漏掉、甚至把没导入过的来料归档掉（v2.1.1 修） */
    toast('正在读取收件箱…', 'ok');
    API.inbox().then(function(d){
      state.inboxItems = d.items || [];
      if(!state.inboxItems.length){ toast('收件箱是空的，没有可导入的来料', 'err'); return; }
      importInbox();
    }).catch(function(e){ toast('读取收件箱失败：' + ((e && e.message) || e), 'err'); });
  });
}
