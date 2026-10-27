/* ============================================================================
 * part_xlsx —— XLSX 导入导出（SheetJS CDN；离线回退 CSV）
 * 自旧版 L3840–3943 移植；差异：
 *   · 表头去掉「评分」列（v2.0.0 已删评分）
 *   · importTabular 改用 v2 语义：按 codeDedupeKey 去重，存在则补空字段，
 *     不存在则新建（与 importFiles 一致），不再「跳过重复」
 * ======================================================================== */
var _xlsxPromise = null;
function loadXlsx(){
  if(window.XLSX) return Promise.resolve(window.XLSX);
  if(_xlsxPromise) return _xlsxPromise;
  _xlsxPromise = new Promise(function(resolve, reject){
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = function(){
      if (window.XLSX) { resolve(window.XLSX); return; }
      _xlsxPromise = null;   /* BUG-28：加载了却没就绪同样算失败，允许重试 */
      reject(new Error('XLSX 未就绪'));
    };
    s.onerror = function(){
      /* v2.1.28 BUG-28（P3）：旧版把失败的 Promise 永久缓存进 _xlsxPromise，
         离线失败一次后本会话内再也加载不了（恢复网络也没用）。清掉拒绝态可重试。 */
      _xlsxPromise = null;
      reject(new Error('无法加载 xlsx 库（可能离线）'));
    };
    document.head.appendChild(s);
  });
  return _xlsxPromise;
}
function exportXlsx(){
  if(!state.rows.length){ toast('当前没有数据可导出'); return; }
  loadXlsx().then(function(XLSX){
    /* v2.1.20：补「已收藏」（saved）列——此前只有「已下载」，而 saved 是独立字段，
       导出丢列 = round-trip 丢数据。 */
    /* v2.1.35 #6：补「磁力链接 / 系列 / 来源层级」三列。旧版表头缺这三列，
       而 importTabular 是能读它们的（iMagnet / iSrcTier 都在）——把 XLSX
       当备份用「导出 → 再导入」一轮，这三个字段就被静默清空，且无任何提示。 */
    var head = ['编号', 'FANZA番号', '原名', '中文名', '影片日期', '发行商', '演员名称', '女演员', '男演员', '导演', '观看状态', '标签', '备注', '磁力链接', '系列', '已下载', '已收藏', '封面文件名', '截图文件名', '来源', '来源层级'];
    var aoa = [head];
    state.rows.forEach(function(r){
      aoa.push([
        r.code, fanzaCodeOf(r.code), r.title, r.titleCn || '', r.release || '', r.maker || '',
        r.actor, (r.actorF || ''), (r.actorM || ''), (r.director || ''), r.status, (r.tags || []).join('、'), r.note,
        (r.magnet || []).filter(Boolean).join(' / '), (r.series || ''),
        r.downloaded ? '是' : '否', r.saved ? '是' : '否',
        (r.cover && r.cover.name) || '',
        r.shots.map(function(s){ return s.name; }).join(' / '),
        (r.platform || ''), (r.srcTier || 0)
      ]);
    });
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Film Library');
    XLSX.writeFile(wb, 'Film Library_' + stamp() + '.xlsx');
    toast('已导出 XLSX', 'ok');
  }).catch(function(e){
    toast('导出 XLSX 失败：' + ((e && e.message) || e) + '（可改用 CSV）', 'err');
  });
}
function importXlsxFile(f){
  var rd = new FileReader();
  rd.onload = function(){
    loadXlsx().then(function(XLSX){
      var wb = XLSX.read(rd.result, { type: 'array' });
      var ws = wb.Sheets[wb.SheetNames[0]];
      var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false });
      importTabular(aoa);
    }).catch(function(e){
      toast('导入 XLSX 失败：' + ((e && e.message) || e) + '（可改用 CSV）', 'err');
    });
  };
  rd.readAsArrayBuffer(f);
}
/* 通用表格导入：aoa[0] 为表头，aoa[1..] 为数据行；CSV 与 XLSX 共用同一套列映射 */
function importTabular(aoa){
  if(!aoa || aoa.length < 2){ toast('内容为空或无数据行', 'err'); return; }
  var head = aoa[0].map(function(s){ return String(s == null ? '' : s).trim(); });
  function col(names){
    for(var i = 0; i < head.length; i++){ if(names.indexOf(head[i]) !== -1) return i; }
    return -1;
  }
  var iCode   = col(['编号', 'code']);
  var iTitle  = col(['原名', '标题', '片名', 'title']);
  var iTitleCn = col(['中文名', '影片中文名', 'titleCn']);
  var iRelease = col(['影片日期', '发售日', '商品発売日', '商品発売', '発売日', '配信開始日', '配信開始', '配信开始日', 'release']);
  var iMaker = col(['发行商', '制造商', 'メーカー', '片商', 'maker']);
  var iActor  = col(['演员名称', '演员', 'actor']);
  var iActorF = col(['女演员', 'actorF']);
  var iActorM = col(['男演员', 'actorM']);
  var iStatus = col(['观看状态', '状态', 'status']);
  var iTags   = col(['标签', 'tags']);
  var iNote   = col(['备注', 'note']);
  var iMagnet = col(['磁力链接', 'magnet', 'magnetLink']);
  /* v2.1.20：已下载/已收藏分成两列。旧版合成一个 iSaved（'已下载' 命中后
     downloaded 和 saved 被设成同一个值）——两个语义完全不同的字段互相污染。 */
  var iDownloaded = col(['已下载', 'downloaded']);
  var iSaved  = col(['已收藏', '已保存', '是否有保存', 'saved']);
  var iDirector = col(['导演', 'director']);
  var iPlatform = col(['来源', '平台', 'platform']);
  var iSrcTier = col(['来源层级', 'srcTier']);
  var iSeries  = col(['系列', 'series']);
  if(iCode === -1){ toast('缺少「编号」列，无法导入', 'err'); return; }
  var added = 0, updated = 0;
  for(var n = 1; n < aoa.length; n++){
    var cells = aoa[n];
    var code = fromJavdbCode(normCode(cells[iCode] || ''));
    if(!code) continue;
    var row = rowByCode(code);
    if(!row){ row = normalizeRow({ id: uid(), code: code }); state.rows.push(row); added++; }
    else updated++;
    function setIf(k, v){ if(v != null && String(v).trim() && !row[k]) row[k] = String(v).trim(); }
    setIf('title', iTitle === -1 ? '' : cells[iTitle]);
    setIf('titleCn', iTitleCn === -1 ? '' : cells[iTitleCn]);
    setIf('release', iRelease === -1 ? '' : cells[iRelease]);
    setIf('maker', iMaker === -1 ? '' : cells[iMaker]);
    setIf('actor', iActor === -1 ? '' : cells[iActor]);
    setIf('actorF', iActorF === -1 ? '' : cells[iActorF]);
    setIf('actorM', iActorM === -1 ? '' : cells[iActorM]);
    setIf('director', iDirector === -1 ? '' : cells[iDirector]);
    setIf('platform', iPlatform === -1 ? '' : cells[iPlatform]);
    setIf('series', iSeries === -1 ? '' : cells[iSeries]);
    restampSrcTier(row);
    /* v2.1.21：来源层级列（一级/二级/1/2 都认；无此列的旧表不受影响） */
    if(iSrcTier !== -1 && cells[iSrcTier] != null && String(cells[iSrcTier]).trim()){
      var _st = String(cells[iSrcTier]).trim();
      row.srcTier = (_st === '一级' || _st === '1') ? 1 : (_st === '二级' || _st === '2') ? 2 : 0;
    }
    if(iStatus !== -1 && cells[iStatus] && STATUS.indexOf(String(cells[iStatus]).trim()) >= 0 && row.status === '未看'){
      row.status = String(cells[iStatus]).trim();
    }
    if(iTags !== -1 && cells[iTags] && !row.tags.length) row.tags = splitList(cells[iTags]);
    if(iNote !== -1 && cells[iNote] && !row.note) row.note = String(cells[iNote]);
    if(iMagnet !== -1 && cells[iMagnet] && !row.magnet.length) row.magnet = normMagnets(cells[iMagnet]);
    if(iDownloaded !== -1 && cells[iDownloaded] != null && String(cells[iDownloaded]).trim() && !row.downloaded){
      row.downloaded = /^(是|true|1|yes|y)$/i.test(String(cells[iDownloaded]).trim());
    }
    if(iSaved !== -1 && cells[iSaved] != null && String(cells[iSaved]).trim() && !row.saved){
      row.saved = /^(是|true|1|yes|y)$/i.test(String(cells[iSaved]).trim());
    }
    row.updated = Date.now();
  }
  commit(); saveData();
  toast('导入完成：新增 ' + added + ' 条，更新 ' + updated + ' 条', 'ok');
}
