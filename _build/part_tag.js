/* ============================================================================
 * part_tag —— Tag 页：标签管理（改名 / 合并 / 删除 / 备注 / 分组 / 颜色）
 * 自旧版 L4746–4905 移植；差异：
 *   · saveTagMeta → saveMeta()（服务端 meta.json + localStorage 双写，防抖）
 *   · renderCards() → refreshAll()；saveData() → commit() + saveData()
 *   · state.tagMeta 由 app 的 loadMeta() 装载（服务端优先，localStorage 兜底）
 * ======================================================================== */
function allTagNames(){
  var seen = {}, out = [];
  state.rows.forEach(function(r){ splitList(r.tags).forEach(function(t){ if(t && !seen[t]){ seen[t] = 1; out.push(t); } }); });
  return out.sort(naturalCmp);
}
function tagCount(t){
  return state.rows.filter(function(r){ return splitList(r.tags).indexOf(t) !== -1; }).length;
}
/* 颜色：meta.color 优先，否则按标签名哈希自动取色（同一标签永远同一颜色） */
var TAG_PALETTE = ['#60a5fa','#34d399','#f472b6','#fbbf24','#a78bfa','#22d3ee','#fb7185','#4ade80','#f97316','#94a3b8'];
function tagHash(s){
  var h = 0, str = String(s || '');
  for(var i = 0; i < str.length; i++){ h = (h * 31 + str.charCodeAt(i)) >>> 0; }
  return h;
}
function autoTagColor(t){ return TAG_PALETTE[tagHash(t) % TAG_PALETTE.length]; }
function tagMetaOf(t){ return (state.tagMeta && state.tagMeta[t]) || {}; }
function tagColorOf(t){ var m = tagMetaOf(t); return m.color ? m.color : autoTagColor(t); }
function tagGroupOf(t){ var m = tagMetaOf(t); return m.group ? String(m.group) : ''; }
function tagGroupNames(){
  var seen = {}, out = [];
  Object.keys(state.tagMeta || {}).forEach(function(t){
    var g = tagGroupOf(t);
    if(g && !seen[g]){ seen[g] = 1; out.push(g); }
  });
  return out.sort(naturalCmp);
}
/* #rrggbb → rgba(...) ，非法的回退成灰色 */
function hexA(hex, a){
  var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if(!m) return 'rgba(148,163,184,' + a + ')';
  var n = parseInt(m[1], 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}
function tagPills(tags){
  return splitList(tags).map(function(t){
    var c = tagColorOf(t);
    return '<span class="tag-pill" style="color:' + c + ';border-color:' + hexA(c, 0.45) + ';background:' + hexA(c, 0.12) + '">' + escapeHtml(t) + '</span>';
  }).join('');
}
function tagSetColor(t, c){
  state.tagMeta[t] = state.tagMeta[t] || {};
  if(c) state.tagMeta[t].color = c; else delete state.tagMeta[t].color;
  saveMeta(); renderTagPage(); refreshAll();
}
function tagSetGroup(t, g){
  g = String(g || '').trim();
  state.tagMeta[t] = state.tagMeta[t] || {};
  if(g) state.tagMeta[t].group = g; else delete state.tagMeta[t].group;
  saveMeta(); renderTagPage();
}
function renderTagPage(){ renderTagList(); }
function tagCardHtml(t){
  var meta = tagMetaOf(t), c = tagColorOf(t);
  var sws = TAG_PALETTE.map(function(p){
    return '<button type="button" class="tsw' + (meta.color === p ? ' on' : '') + '" data-tcolor="' + p + '" style="background:' + p + '" title="' + p + '"></button>';
  }).join('') + '<button type="button" class="tsw auto' + (!meta.color ? ' on' : '') + '" data-tcolor="" title="按标签名自动配色">自动</button>';
  return '<div class="tag-card" data-tag="' + escapeHtml(t) + '">' +
    '<div class="th"><span class="tname" style="color:' + c + '">' + escapeHtml(t) + '</span><span class="tcnt">' + tagCount(t) + ' 部</span></div>' +
    '<div class="tsws">' + sws + '</div>' +
    '<input class="tgin" data-tgroup="1" list="tagGroupList" value="' + escapeHtml(tagGroupOf(t)) + '" placeholder="分组（留空＝未分组）">' +
    (meta.note ? '<div class="tmeta" style="font-size:11.5px;color:var(--muted);margin:4px 0">' + escapeHtml(meta.note) + '</div>' : '') +
    '<div class="tact">' +
      '<button class="btn sm" data-act="rename">改名</button>' +
      '<button class="btn sm" data-act="merge">合并</button>' +
      '<button class="btn sm" data-act="note">备注</button>' +
      '<button class="btn sm danger" data-act="del">删除</button>' +
    '</div></div>';
}
function renderTagList(){
  var box = $('#tagList'); if(!box) return;
  var q = ($('#tagSearch').value || '').trim().toLowerCase();
  var names = allTagNames();
  var list = names.concat(Object.keys(state.tagMeta).filter(function(t){ return names.indexOf(t) === -1; }));
  if(q) list = list.filter(function(t){ return t.toLowerCase().indexOf(q) !== -1; });
  list.sort(naturalCmp);
  $('#tagCount').textContent = list.length;
  var dl = $('#tagGroupList');
  if(dl) dl.innerHTML = tagGroupNames().map(function(g){ return '<option value="' + escapeHtml(g) + '"></option>'; }).join('');
  if(!list.length){ box.innerHTML = '<div class="p-empty">还没有标签</div>'; return; }
  /* 按分组聚合：未分组排最后 */
  var map = {}, order = [];
  list.forEach(function(t){
    var g = tagGroupOf(t);
    if(!map[g]){ map[g] = []; order.push(g); }
    map[g].push(t);
  });
  order.sort(function(a, b){ if(a === '') return 1; if(b === '') return -1; return naturalCmp(a, b); });
  box.innerHTML = order.map(function(g){
    return '<div class="tg-sec">' +
      '<div class="tg-head"><span class="tg-bar"></span><b>' + (g ? escapeHtml(g) : '未分组') + '</b><span>' + map[g].length + ' 个</span></div>' +
      '<div class="tg-body">' + map[g].map(tagCardHtml).join('') + '</div>' +
    '</div>';
  }).join('');
}
/* 把所有影片里的标签 oldName 换成 newName（newName 为空 = 删除该标签） */
function replaceTagEverywhere(oldName, newName){
  var n = 0;
  state.rows.forEach(function(r){
    var list = splitList(r.tags);
    if(list.indexOf(oldName) === -1) return;
    var out = list.filter(function(t){ return t !== oldName; });
    if(newName && out.indexOf(newName) === -1) out.push(newName);
    /* v2.1.19：必须保持数组不变量。此前 r.tags = out.join(', ') 写成字符串，
       会连环引爆 6 处数组用法：tableRowHtml/openForm/CSV 的 .join、openDetail 的
       r.tags.join、收件箱合并的 row.tags.forEach/.push、selTag 的 r.tags.push
       （indexOf 在字符串上是子串匹配不报错，push 直接 TypeError）。
       normalizeRow 下次加载才会 healing，崩溃全发生在当前会话内。 */
    r.tags = out;
    n++;
  });
  return n;
}
function tagAction(t, act){
  if(act === 'rename'){
    var v = prompt('把标签「' + t + '」改名为：', t);
    if(v == null) return;
    v = String(v).trim();
    if(!v || v === t) return;
    var n = replaceTagEverywhere(t, v);
    if(state.tagMeta[t]){ state.tagMeta[v] = state.tagMeta[t]; delete state.tagMeta[t]; }
    commit(); saveData(); saveMeta(); refreshAll(); renderTagPage();
    toast('已改名并更新 ' + n + ' 部影片', 'ok');
    return;
  }
  if(act === 'merge'){
    var to = prompt('把标签「' + t + '」合并到哪个标签？（该标签会被删除）', '');
    if(to == null) return;
    to = String(to).trim();
    if(!to || to === t) return;
    var m = replaceTagEverywhere(t, to);
    delete state.tagMeta[t];
    commit(); saveData(); saveMeta(); refreshAll(); renderTagPage();
    toast('已把 ' + m + ' 部影片的「' + t + '」并入「' + to + '」', 'ok');
    return;
  }
  if(act === 'note'){
    var cur = (state.tagMeta[t] || {}).note || '';
    var nt = prompt('标签「' + t + '」的备注：', cur);
    if(nt == null) return;
    state.tagMeta[t] = state.tagMeta[t] || {};
    state.tagMeta[t].note = String(nt).trim();
    saveMeta(); renderTagPage();
    toast('备注已保存', 'ok');
    return;
  }
  if(act === 'del'){
    var c = tagCount(t);
    if(!confirm('删除标签「' + t + '」？将从 ' + c + ' 部影片里移除')) return;
    replaceTagEverywhere(t, '');
    delete state.tagMeta[t];
    commit(); saveData(); saveMeta(); refreshAll(); renderTagPage();
    toast('已删除标签', 'ok');
    return;
  }
}
function addTag(){
  var v = ($('#tagNewName').value || '').trim();
  if(!v){ toast('请输入标签名', 'err'); return; }
  var names = allTagNames();
  if(names.indexOf(v) !== -1){ toast('标签已存在', 'err'); return; }
  state.tagMeta[v] = state.tagMeta[v] || {};
  $('#tagNewName').value = '';
  saveMeta(); renderTagPage(); renderTagFilter(); renderTabCounts();
  toast('已新增标签（还没有影片用它，去主页给影片加上即可）', 'ok');
}
function bindTag(){
  $('#tagAddBtn').addEventListener('click', addTag);
  $('#tagSearch').addEventListener('input', renderTagList);
  $('#tagNewName').addEventListener('keydown', function(ev){ if(ev.key === 'Enter'){ ev.preventDefault(); addTag(); } });
  $('#tagList').addEventListener('click', function(ev){
    var sw = ev.target.closest('[data-tcolor]');
    var host = ev.target.closest('[data-tag]');
    if(!host) return;
    var t = host.getAttribute('data-tag');
    if(sw){ tagSetColor(t, sw.getAttribute('data-tcolor')); return; }
    var act = ev.target.closest('[data-act]');
    if(act){ tagAction(t, act.getAttribute('data-act')); return; }
  });
  $('#tagList').addEventListener('change', function(ev){
    var gin = ev.target.closest('[data-tgroup]');
    if(!gin) return;
    var host = gin.closest('[data-tag]');
    if(host) tagSetGroup(host.getAttribute('data-tag'), gin.value);
  });
}
