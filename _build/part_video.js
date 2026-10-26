/* ============================================================================
 * part_video —— Video 页：按维度分组的播放列表 + 服务端视频播放
 * 与旧版差异（架构变更）：
 *   · 视频文件来自「视频目录」（服务端 /api/videos 列举 + /video/<name> Range 播放），
 *     不再用浏览器文件选择器；番号与文件按文件名自动关联（codeFromFilename）
 *   · 分组维度去掉「评分」（v2.0.0 已删评分）：状态 / 标签 / 演员 / 发售年
 *   · videoMap（code→文件名记忆）不再需要：关联每次从目录实时推导
 * ======================================================================== */
var VIDEO_DIMS = [['status', '状态'], ['tag', '标签'], ['actor', '演员'], ['year', '发售年']];
var videoObjUrl = '';
/* 番号 → 视频文件（按文件名提取番号归一化匹配；MGS 形态互换） */
function videoFileMap(){
  var map = {};
  state.videoFiles.forEach(function(f){
    var c = codeFromFilename(f.name);
    if(!c) return;
    var nc = normCode(c);
    if(!map[nc]) map[nc] = f;
    var alt = normCode(mgsCodeConvert(nc));
    if(alt && !map[alt]) map[alt] = f;
  });
  return map;
}
function videoFileOf(r){ return videoFileMap()[normCode(r.code)] || null; }
function videoGroups(){
  var dim = state.videoDim, map = {}, order = [];
  state.rows.forEach(function(r){
    var keys = [];
    if(dim === 'status') keys = [r.status || '未看'];
    else if(dim === 'tag'){ keys = splitList(r.tags); if(!keys.length) keys = ['（无标签）']; }
    else if(dim === 'actor'){ keys = statsActorNames(r); if(!keys.length) keys = ['（无演员）']; }
    else {
      /* v2.1.28 BUG-29（P3）：旧版 slice(0, 4) 对非 ISO 日期（如 5/6/2024）
         会切出「5/6/」这类乱码分组；改为按 4 位年份提取。 */
      var ym = /(?:19|20)\d{2}/.exec(String(r.release || ''));
      keys = [ym ? ym[0] : '（无日期）'];
    }
    keys.forEach(function(k){
      if(!map[k]){ map[k] = []; order.push(k); }
      map[k].push(r);
    });
  });
  return order.map(function(k){
    var rows = map[k].slice().sort(function(a, b){ return naturalCmp(a.code, b.code); });
    return { name: k, count: rows.length, rows: rows };
  }).sort(function(a, b){ return (b.count - a.count) || String(a.name).localeCompare(String(b.name)); });
}
function videoCurGroup(){
  var gs = videoGroups();
  if(!gs.length) return null;
  for(var i = 0; i < gs.length; i++){ if(gs[i].name === state.videoGroup) return gs[i]; }
  return gs[0];
}
function videoCurRow(g){
  if(!g || !g.rows.length) return null;
  for(var i = 0; i < g.rows.length; i++){ if(g.rows[i].code === state.videoCode) return g.rows[i]; }
  return g.rows[0];
}
function loadVideoFiles(){
  if(!state.configured) return Promise.resolve();
  return API.videos().then(function(d){
    state.videoFiles = d.files || [];
  }).catch(function(){ state.videoFiles = []; });
}
function renderVideoPage(){
  if(!state.videoFiles.length && state.configured){
    loadVideoFiles().then(function(){ renderVideoSide(); renderVideoMain(); });
    return;
  }
  renderVideoSide(); renderVideoMain();
}
function renderVideoSide(){
  $all('#videoDims .chip').forEach(function(b){
    b.classList.toggle('on', b.getAttribute('data-dim') === state.videoDim);
  });
  var box = $('#videoGroupList'); if(!box) return;
  var gs = videoGroups();
  $('#videoGroupCount').textContent = gs.length;
  if(!gs.length){ box.innerHTML = '<div class="p-empty">还没有影片，无法生成播放列表</div>'; return; }
  var cur = videoCurGroup();
  box.innerHTML = gs.map(function(g){
    var on = (cur && g.name === cur.name) ? ' on' : '';
    return '<div class="p-item' + on + '" data-vg="' + escapeHtml(g.name) + '">' +
      '<div class="nm">' + escapeHtml(g.name) + '</div><span class="cnt">' + g.count + ' 部</span></div>';
  }).join('');
}
function renderVideoMain(){
  var list = $('#videoItemList'), now = $('#videoNow');
  var nameEl = $('#videoGroupName'), cntEl = $('#videoItemCount');
  if(!list) return;
  var g = videoCurGroup();
  if(!g){
    if(nameEl) nameEl.textContent = '播放列表';
    if(cntEl) cntEl.textContent = '0';
    list.innerHTML = '<div class="p-empty">暂无影片</div>';
    if(now) now.innerHTML = '';
    return;
  }
  state.videoGroup = g.name;
  if(nameEl) nameEl.textContent = g.name;
  if(cntEl) cntEl.textContent = g.count;
  var cur = videoCurRow(g);
  if(cur) state.videoCode = cur.code;
  var fmap = videoFileMap();
  list.innerHTML = g.rows.map(function(r){
    var f = fmap[normCode(r.code)];
    var th = imgSrc(r.cover) ? '<img src="' + escapeHtml(imgSrc(r.cover)) + '" alt="">' : '';
    var on = (cur && r.code === cur.code) ? ' on' : '';
    var ttl = r.title ? ('　' + escapeHtml(r.title)) : '';
    return '<div class="v-item' + on + '" data-vc="' + escapeHtml(r.code) + '">' +
      '<div class="v-thumb">' + th + '</div>' +
      '<div class="nm">' + escapeHtml(r.code) + ttl + '</div>' +
      (f ? '<span class="has">▶ 有视频</span>' : '') +
      '<span class="sub">' + escapeHtml(r.status || '未看') + '</span></div>';
  }).join('');
  if(!now) return;
  if(!cur){ now.innerHTML = ''; return; }
  var f = fmap[normCode(cur.code)];
  var watched = (cur.status === '已看');
  now.innerHTML =
    '<span class="code">' + escapeHtml(cur.code) + '</span>' +
    '<span class="t">' + escapeHtml(cur.titleCn || cur.title || '') + '</span>' +
    (f ? '<span class="fn">' + escapeHtml(f.name) + '</span>' : '<span class="fn" style="color:var(--amber)">视频目录里没有对应文件</span>') +
    '<span class="sp"></span>' +
    (f ? '<button type="button" class="btn sm primary" id="videoPlayBtn">播放</button>' : '') +
    '<button type="button" class="btn sm" id="videoWatchedBtn">' + (watched ? '标为未看' : '标为已看') + '</button>' +
    '<button type="button" class="btn sm" id="videoDetailBtn">详情</button>';
  var pb = $('#videoPlayBtn');
  if(pb) pb.addEventListener('click', function(){ videoPlayUrl(f.url, f.name); });
  var w = $('#videoWatchedBtn');
  if(w) w.addEventListener('click', function(){
    var r = findRow(cur.id); if(!r) return;
    r.status = (r.status === '已看') ? '未看' : '已看';
    commit(); saveData(); renderVideoMain();
    toast(cur.code + ' → ' + r.status, 'ok');
  });
  var d = $('#videoDetailBtn');
  if(d) d.addEventListener('click', function(){ openDetail(cur.id); });
}
function videoStop(){
  var v = $('#videoEl'), box = $('#videoPlayerBox');
  if(v){ try{ v.pause(); }catch(_){ } v.removeAttribute('src'); try{ v.load(); }catch(_){ } }
  if(box) box.classList.remove('on');
  if(videoObjUrl){ try{ URL.revokeObjectURL(videoObjUrl); }catch(_){ } videoObjUrl = ''; }
}
function videoPlayUrl(url, name){
  var v = $('#videoEl'), box = $('#videoPlayerBox');
  if(!v || !url) return;
  v.src = apiUrl(url);
  if(box) box.classList.add('on');
  try{ var p = v.play(); if(p && p.catch) p.catch(function(){ }); }catch(_){ }
  toast('正在播放 ' + name + '（服务端 Range 流式传输）', 'ok');
}
function bindVideo(){
  var dims = $('#videoDims');
  if(dims) dims.addEventListener('click', function(e){
    var b = e.target.closest ? e.target.closest('[data-dim]') : null;
    if(!b) return;
    state.videoDim = b.getAttribute('data-dim');
    state.videoGroup = ''; state.videoCode = '';
    videoStop(); renderVideoPage();
  });
  var gl = $('#videoGroupList');
  if(gl) gl.addEventListener('click', function(e){
    var it = e.target.closest ? e.target.closest('[data-vg]') : null;
    if(!it) return;
    state.videoGroup = it.getAttribute('data-vg');
    state.videoCode = '';
    videoStop(); renderVideoPage();
  });
  var il = $('#videoItemList');
  if(il) il.addEventListener('click', function(e){
    var it = e.target.closest ? e.target.closest('[data-vc]') : null;
    if(!it) return;
    state.videoCode = it.getAttribute('data-vc');
    videoStop(); renderVideoMain();
    /* 有对应视频文件时直接播放 */
    var f = videoFileMap()[normCode(state.videoCode)];
    if(f) videoPlayUrl(f.url, f.name);
  });
}
