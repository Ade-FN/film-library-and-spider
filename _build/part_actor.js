/* ============================================================================
 * part_actor —— Actor 页：演员资料（日文/中文/英文名 / 头像 / 合并去重）
 * 自旧版 L4395–4741 移植；差异：
 *   · 头像落盘改走 API.upload('avatars', <id>.<ext>) → actors/ 目录（服务端唯一写方）
 *   · saveActors → saveMeta()（meta.json + localStorage 双写）
 *   · stripActorImg 形态与旧版一致（avatar 只留 name+path），src 由 imgSrc 现算
 * ======================================================================== */
function normalizeActor(x){
  x = x || {};
  return {
    id: x.id || uid(),
    nameJa: String(x.nameJa || ''),
    nameZh: String(x.nameZh || ''),
    nameEn: String(x.nameEn || ''),
    alias: splitList(Array.isArray(x.alias) ? x.alias.join(',') : (x.alias || '')).join(', '),
    gender: (x.gender === 'm' || x.gender === 'u') ? x.gender : 'f',
    note: String(x.note || ''),
    avatar: normImg(x.avatar),
    ts: x.ts || Date.now()
  };
}
function actorDisplayName(a){ return a.nameZh || a.nameJa || a.nameEn || '(未命名)'; }
function actorNamesOf(a){
  return [a.nameJa, a.nameZh, a.nameEn].concat(splitList(a.alias)).map(function(s){ return String(s || '').trim(); }).filter(Boolean);
}
/* 影片里出现过的演员名（含性别线索：f=女 m=男 u=未知） */
function actorNamesInFilms(){
  var map = {};
  state.rows.forEach(function(r){
    splitList(r.actorF).forEach(function(n){ if(n && !map[n]) map[n] = 'f'; });
    splitList(r.actorM).forEach(function(n){ if(n && !map[n]) map[n] = 'm'; });
    splitList(r.actor).forEach(function(n){ if(n && !map[n]) map[n] = 'u'; });
  });
  return Object.keys(map).map(function(n){ return { name: n, gender: map[n] }; });
}
function findActorByName(n){
  var k = String(n || '').trim().toLowerCase();
  if(!k) return null;
  for(var i = 0; i < state.actors.length; i++){
    var hit = actorNamesOf(state.actors[i]).some(function(x){ return x.toLowerCase() === k; });
    if(hit) return state.actors[i];
  }
  return null;
}
function actorWorks(a){
  var names = actorNamesOf(a).map(function(s){ return s.toLowerCase(); });
  if(!names.length) return [];
  return state.rows.filter(function(r){
    var list = splitList([r.actorF, r.actorM, r.actor].join(',')).map(function(s){ return s.toLowerCase(); });
    return names.some(function(n){ return list.indexOf(n) !== -1; });
  });
}
function actorById(id){
  if(!id) return null;
  for(var i = 0; i < state.actors.length; i++){ if(state.actors[i].id === id) return state.actors[i]; }
  return null;
}
function setV(sel, v){ var el = $(sel); if(el) el.value = (v == null ? '' : v); }
function val(sel){ var el = $(sel); return el ? String(el.value || '') : ''; }

function renderActorPage(){ renderActorList(); renderActorMain(); }
function renderActorMain(){
  var ov = $('#actorOverview'), pf = $('#actorProfile');
  var profile = (state.actorMode === 'profile');
  if(ov) ov.hidden = profile;
  if(pf) pf.hidden = !profile;
  if(profile) renderActorForm(); else renderActorOverview();
}
function openActor(id){ state.actorId = id || null; state.actorMode = 'profile'; state.pendingAvatar = null; renderActorPage(); }
function backToActorOverview(){ state.actorMode = 'overview'; state.actorId = null; state.pendingAvatar = null; renderActorPage(); }
function renderActorList(){
  var box = $('#actorList'); if(!box) return;
  var q = val('#actorSearch').trim().toLowerCase();
  var list = state.actors.slice().sort(function(x, y){ return naturalCmp(actorDisplayName(x), actorDisplayName(y)); });
  if(q) list = list.filter(function(a){ return actorNamesOf(a).join(' ').toLowerCase().indexOf(q) !== -1; });
  $('#actorCount').textContent = state.actors.length;
  if(!list.length){
    box.innerHTML = '<div class="p-empty">' +
      (state.actors.length ? '没有匹配的演员' : '还没有演员资料，点「从影片导入」或「新增演员」') + '</div>';
    return;
  }
  box.innerHTML = list.map(function(a){
    var src = a.avatar ? imgSrc(a.avatar) : '';
    var av = src ? '<img src="' + escapeHtml(src) + '" alt="">' : escapeHtml(actorDisplayName(a).slice(0, 1));
    var sub = [a.nameJa, a.nameEn].filter(Boolean).join(' / ');
    var al = splitList(a.alias);
    if(al.length) sub = (sub ? sub + ' / ' : '') + '曾用：' + al.join('、');
    return '<div class="p-item' + (a.id === state.actorId ? ' on' : '') + '" data-id="' + a.id + '">' +
      '<div class="act-av">' + av + '</div>' +
      '<div style="min-width:0;flex:1;">' +
        '<div class="nm"><span class="gdot ' + a.gender + '"></span> ' + escapeHtml(actorDisplayName(a)) + '</div>' +
        (sub ? '<div class="sub" style="font-size:11.5px;color:var(--muted)">' + escapeHtml(sub) + '</div>' : '') +
      '</div>' +
      '<span class="cnt">' + actorWorks(a).length + ' 部</span>' +
    '</div>';
  }).join('');
}
function actorOvCard(a){
  var src = a.avatar ? imgSrc(a.avatar) : '';
  var av = src ? '<img src="' + escapeHtml(src) + '" alt="">' : '<span>' + escapeHtml(actorDisplayName(a).slice(0, 1)) + '</span>';
  var sub = [a.nameZh, a.nameEn].filter(Boolean).join(' / ');
  if(!sub && a.alias) sub = '曾用：' + a.alias;
  var works = actorWorks(a).length;
  return '<div class="ov-card" data-id="' + a.id + '">' +
    '<div class="ov-cover">' + av + '</div>' +
    '<div style="min-width:0">' +
      '<div class="ov-name"><span class="gdot ' + a.gender + '"></span> ' + escapeHtml(actorDisplayName(a)) + '</div>' +
      (sub ? '<div class="ov-sub">' + escapeHtml(sub) + '</div>' : '') +
      '<div class="ov-meta"><span>' + works + ' 部</span>' + (a.alias ? '<span>有曾用名</span>' : '') + '</div>' +
    '</div>' +
  '</div>';
}
function renderActorOverview(){
  var box = $('#actorOvBody'); if(!box) return;
  var acts = state.actors;
  $('#actorOvCount').textContent = acts.length;
  if(!acts.length){
    box.innerHTML = '<div class="p-empty">还没有演员资料。<br>点左侧「从影片导入」把影片里出现过的演员批量建档，或点「新增演员」手动添加。</div>';
    return;
  }
  var g = { f: 0, m: 0, u: 0 }, withAv = 0;
  acts.forEach(function(a){
    if(g[a.gender] == null) g[a.gender] = 0;
    g[a.gender]++;
    if(a.avatar && (a.avatar.src || a.avatar.path)) withAv++;
  });
  var unbuilt = actorNamesInFilms().filter(function(n){ return !findActorByName(n.name); }).length;
  var stats = [['演员总数', acts.length], ['女演员', g.f], ['男演员', g.m], ['性别未知', g.u], ['有头像', withAv], ['影片中未建档', unbuilt]];
  var html = '<div class="ov-stats">' + stats.map(function(s){
    return '<div class="ov-stat"><span class="v">' + s[1] + '</span><span class="l">' + s[0] + '</span></div>';
  }).join('') + '</div>';
  var sorted = acts.slice().sort(function(a, b){ return naturalCmp(actorDisplayName(a), actorDisplayName(b)); });
  html += '<div class="side-label" style="margin-top:14px">全部演员（' + acts.length + '）</div><div class="ov-grid">' +
    sorted.map(actorOvCard).join('') + '</div>';
  box.innerHTML = html;
}
function renderActorForm(){
  var a = actorById(state.actorId);
  $('#actorFormTitle').textContent = a ? ('演员资料 · ' + actorDisplayName(a)) : '新增演员';
  setV('#actorJa', a ? a.nameJa : '');
  setV('#actorZh', a ? a.nameZh : '');
  setV('#actorEn', a ? a.nameEn : '');
  setV('#actorAlias', a ? a.alias : '');
  $('#actorGender').value = a ? a.gender : 'f';
  setV('#actorNote', a ? a.note : '');
  var pend = state.pendingAvatar;
  var avSrc = (pend && pend.src) || (a && a.avatar ? imgSrc(a.avatar) : '') || '';
  $('#actorAvatar').innerHTML = avSrc ? '<img src="' + escapeHtml(avSrc) + '" alt="">' : '<span>无头像</span>';
  var w = $('#actorWorks');
  if(w){
    if(!a){ w.innerHTML = ''; }
    else{
      var ws = actorWorks(a);
      w.innerHTML = '<div class="side-label">参演影片（' + ws.length + '）· 点番号看影片详情</div>' +
        '<div class="wk-list">' +
        (ws.length ? ws.map(function(r){
            var ttl = r.title || r.titleCn || '';
            var short = ttl.length > 16 ? ttl.slice(0, 16) + '…' : ttl;
            return '<span class="wk" data-fid="' + r.id + '" title="' + escapeHtml(ttl) + '">' + escapeHtml(r.code) +
                   (short ? '<span class="wt">' + escapeHtml(short) + '</span>' : '') + '</span>';
          }).join('')
                   : '<span class="p-empty" style="padding:4px 0">库里还没有匹配的影片</span>') +
        '</div>';
    }
  }
}
/* ============ 合并去重 ============
   检测：两位演员的任意名字（含曾用名）归一化后相同 → 疑似同一人。
   合并：被合并方的名字并入保留方的「曾用名」——actorWorks() 按「所有名字+曾用名」
   匹配影片，所以影片数据一行都不用改，参演影片会自动归入保留方。 */
function normNameKey(s){
  return String(s || '').toLowerCase()
    .replace(/[\u3000\s]/g, '')
    .replace(/[\u00b7\u30fb.,_\-\u2013\u2014]/g, '')
    .replace(/[\uFF01-\uFF5E]/g, function(c){ return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); });
}
function findActorDupGroups(){
  var out = [];
  for(var i = 0; i < state.actors.length; i++){
    for(var j = i + 1; j < state.actors.length; j++){
      var A = state.actors[i], B = state.actors[j];
      var pa = actorNamesOf(A).map(function(x){ return { raw: x, key: normNameKey(x) }; }).filter(function(p){ return !!p.key; });
      var pb = actorNamesOf(B).map(function(x){ return { raw: x, key: normNameKey(x) }; }).filter(function(p){ return !!p.key; });
      var why = '';
      for(var x = 0; x < pa.length && !why; x++){
        for(var y = 0; y < pb.length; y++){ if(pa[x].key === pb[y].key){ why = pa[x].raw; break; } }
      }
      if(why) out.push({ a: A.id, b: B.id, why: why });
    }
  }
  return out;
}
function mergeActors(keepId, dropId){
  var keep = actorById(keepId), drop = actorById(dropId);
  if(!keep || !drop || keep.id === drop.id) return false;
  if(!keep.nameJa && drop.nameJa) keep.nameJa = drop.nameJa;
  if(!keep.nameZh && drop.nameZh) keep.nameZh = drop.nameZh;
  if(!keep.nameEn && drop.nameEn) keep.nameEn = drop.nameEn;
  var add = [];
  [drop.nameJa, drop.nameZh, drop.nameEn].concat(splitList(drop.alias)).forEach(function(nm){
    nm = String(nm || '').trim();
    if(!nm) return;
    var k = normNameKey(nm);
    if(!k) return;
    if(actorNamesOf(keep).map(normNameKey).indexOf(k) !== -1) return;
    if(add.map(normNameKey).indexOf(k) !== -1) return;
    add.push(nm);
  });
  if(add.length) keep.alias = splitList([keep.alias].concat(add).join(',')).join(', ');
  if((!keep.avatar || !(keep.avatar.src || keep.avatar.path)) && drop.avatar && (drop.avatar.src || drop.avatar.path)) keep.avatar = drop.avatar;
  var dn = String(drop.note || '').trim();
  if(dn){
    var kn = String(keep.note || '').trim();
    keep.note = kn ? (kn.indexOf(dn) !== -1 ? kn : kn + '\n' + dn) : dn;
  }
  keep.ts = Date.now();
  var dropName = actorDisplayName(drop);
  state.actors = state.actors.filter(function(x){ return x.id !== drop.id; });
  if(state.actorId === drop.id) state.actorId = keep.id;
  saveMeta();
  toast('已把「' + dropName + '」合并到「' + actorDisplayName(keep) + '」', 'ok');
  return true;
}
function openActorMerge(){ renderActorMerge(); openModal('actorMergeMask'); }
function closeActorMerge(){ closeModal('actorMergeMask'); }
function renderActorMerge(){
  var box = $('#actorMergeList'); if(!box) return;
  var groups = findActorDupGroups();
  if(!groups.length){
    box.innerHTML = '<div class="mg-empty">没有检测到疑似重复的演员。也可以用下方「手动合并」。</div>';
  } else {
    box.innerHTML = groups.map(function(g){
      var A = actorById(g.a), B = actorById(g.b);
      if(!A || !B) return '';
      return '<div class="mg-group">' +
        '<span class="mg-name">' + escapeHtml(actorDisplayName(A)) + '</span><span class="mg-meta">' + actorWorks(A).length + ' 部</span>' +
        '<span class="mg-meta">⟷</span>' +
        '<span class="mg-name">' + escapeHtml(actorDisplayName(B)) + '</span><span class="mg-meta">' + actorWorks(B).length + ' 部</span>' +
        '<span class="mg-why">同名：' + escapeHtml(g.why) + '</span>' +
        '<span style="flex:1"></span>' +
        '<span>' +
          '<button type="button" class="btn sm" data-mgkeep="' + escapeHtml(A.id) + '" data-mgdrop="' + escapeHtml(B.id) + '">保留左</button>' +
          '<button type="button" class="btn sm" data-mgkeep="' + escapeHtml(B.id) + '" data-mgdrop="' + escapeHtml(A.id) + '">保留右</button>' +
        '</span></div>';
    }).join('');
  }
  var sorted = state.actors.slice().sort(function(x, y){ return naturalCmp(actorDisplayName(x), actorDisplayName(y)); });
  var opts = sorted.map(function(a){ return '<option value="' + escapeHtml(a.id) + '">' + escapeHtml(actorDisplayName(a)) + '</option>'; }).join('');
  $('#mgKeepSel').innerHTML = opts;
  $('#mgDropSel').innerHTML = opts;
}
/* 保存表单：头像若是新选的（dataUrl）→ 上传服务端 actors/ 再落 path */
function saveActorFromForm(){
  var ja = val('#actorJa').trim(), zh = val('#actorZh').trim(), en = val('#actorEn').trim();
  if(!ja && !zh && !en){ toast('至少填一个名字（日文 / 中文 / 英文）', 'err'); return; }
  var a = null;
  if(state.actorId) for(var i = 0; i < state.actors.length; i++){ if(state.actors[i].id === state.actorId){ a = state.actors[i]; break; } }
  var _isNewActor = false;
  if(!a){ a = normalizeActor({}); state.actors.push(a); _isNewActor = true; }
  /* v2.1.37 #20：上传前先快照。旧版把字段先写进内存对象，头像上传失败时
     after()（含 saveMeta + renderActorPage）没执行——UI 显示旧值、内存已是新值，
     用户点「取消」也回不去，下一次任意 saveMeta 会把这次「已取消」的修改悄悄落盘。 */
  var _snapA = { nameJa: a.nameJa, nameZh: a.nameZh, nameEn: a.nameEn, alias: a.alias, gender: a.gender, note: a.note, ts: a.ts, avatar: a.avatar };
  a.nameJa = ja; a.nameZh = zh; a.nameEn = en;
  a.alias = splitList(val('#actorAlias')).join(', ');
  a.gender = val('#actorGender') || 'f';
  a.note = val('#actorNote').trim();
  a.ts = Date.now();
  var pend = state.pendingAvatar;
  state.actorId = a.id;
  var btn = $('#actorSaveBtn');
  btn.disabled = true; btn.textContent = '保存中…';
  var after = function(){
    state.pendingAvatar = null;
    saveMeta();
    renderActorPage(); renderTabCounts();
    btn.disabled = false; btn.textContent = '保存';
    toast('演员资料已保存', 'ok');
  };
  if(pend && pend.src && /^data:/.test(pend.src)){
    var blob = dataUrlToBlob(pend.src);
    var ext = /^data:image\/png/.test(pend.src) ? '.png' : '.jpg';
    API.upload('avatars', a.id + ext, blob).then(function(r){
      a.avatar = { name: a.id + ext, path: r.path };
      after();
    }).catch(function(e){
      /* v2.1.37 #20：回滚字段（新建的还要撤出列表），保证「取消/失败」后一致 */
      Object.keys(_snapA).forEach(function(k){ a[k] = _snapA[k]; });
      if(_isNewActor){ var _ai = state.actors.indexOf(a); if(_ai >= 0) state.actors.splice(_ai, 1); }
      btn.disabled = false; btn.textContent = '保存';
      toast('头像上传失败：' + ((e && e.message) || e), 'err');
    });
  } else {
    after();
  }
}
function deleteActor(){
  if(!state.actorId){ toast('请先选择一位演员', 'err'); return; }
  var a = actorById(state.actorId);
  if(!a) return;
  if(!confirm('删除演员「' + actorDisplayName(a) + '」的资料？（影片里的演员名不受影响）')) return;
  state.actors = state.actors.filter(function(x){ return x.id !== a.id; });
  state.actorMode = 'overview'; state.actorId = null; state.pendingAvatar = null;
  saveMeta(); renderActorPage(); renderTabCounts();
  toast('已删除演员资料', 'ok');
}
/* 把影片里出现过、还没建档的演员批量建成资料卡 */
function importActorsFromFilms(){
  var names = actorNamesInFilms();
  var added = 0;
  names.forEach(function(n){
    if(findActorByName(n.name)) return;
    var o = { gender: (n.gender === 'u' ? 'f' : n.gender) };
    if(/[\u3040-\u30ff]/.test(n.name)) o.nameJa = n.name;
    else if(/^[A-Za-z0-9 ._\-]+$/.test(n.name)) o.nameEn = n.name;
    else o.nameZh = n.name;
    state.actors.push(normalizeActor(o));
    added++;
  });
  if(!added){ toast('影片里的演员都已建档', 'ok'); return; }
  saveMeta(); renderActorPage(); renderTabCounts();
  toast('已从影片导入 ' + added + ' 位演员', 'ok');
}
function bindActor(){
  $('#actorAddBtn').addEventListener('click', function(){ openActor(null); });
  $('#actorBackBtn').addEventListener('click', backToActorOverview);
  $('#actorImportBtn').addEventListener('click', importActorsFromFilms);
  $('#actorMergeBtn').addEventListener('click', openActorMerge);
  $('#actorSaveBtn').addEventListener('click', saveActorFromForm);
  $('#actorCancelBtn').addEventListener('click', backToActorOverview);
  $('#actorDelBtn').addEventListener('click', deleteActor);
  $('#actorSearch').addEventListener('input', renderActorList);
  $('#actorAvatarBtn').addEventListener('click', function(){ $('#actorAvatarInput').click(); });
  $('#actorAvatarInput').addEventListener('change', function(){
    var f = this.files && this.files[0];
    if(!f) return;
    var rd = new FileReader();
    rd.onload = function(){ state.pendingAvatar = { src: String(rd.result) }; renderActorForm(); };
    rd.readAsDataURL(f);
    this.value = '';
  });
  $('#actorAvatarClear').addEventListener('click', function(){
    state.pendingAvatar = { src: '' };
    var a = actorById(state.actorId);
    if(a) a.avatar = null;
    renderActorForm();
  });
  $('#actorMergeClose').addEventListener('click', closeActorMerge);
  $('#actorMergeCloseBtn').addEventListener('click', closeActorMerge);
  $('#mgDoBtn').addEventListener('click', function(){
    var k = $('#mgKeepSel').value, d = $('#mgDropSel').value;
    if(!k || !d || k === d){ toast('请选两位不同的演员', 'err'); return; }
    if(mergeActors(k, d)){ renderActorMerge(); renderActorPage(); renderTabCounts(); }
  });
  /* 列表 / 总览卡片 → 打开资料 */
  $('#actorList').addEventListener('click', function(ev){
    var it = ev.target.closest('[data-id]');
    if(it) openActor(it.getAttribute('data-id'));
  });
  $('#actorOvBody').addEventListener('click', function(ev){
    var it = ev.target.closest('[data-id]');
    if(it) openActor(it.getAttribute('data-id'));
  });
  /* 合并弹窗里的「保留左/右」 */
  $('#actorMergeList').addEventListener('click', function(ev){
    var b = ev.target.closest('[data-mgkeep]');
    if(!b) return;
    if(mergeActors(b.getAttribute('data-mgkeep'), b.getAttribute('data-mgdrop'))){
      renderActorMerge(); renderActorPage(); renderTabCounts();
    }
  });
  /* 参演影片 → 影片详情 */
  $('#actorWorks').addEventListener('click', function(ev){
    var wk = ev.target.closest('[data-fid]');
    if(wk) openDetail(wk.getAttribute('data-fid'));
  });
}
