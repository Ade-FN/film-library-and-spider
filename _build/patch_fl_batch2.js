'use strict';
/* patch_fl_batch2.js — Film Library 第二批修复（v2.1.27）
 *   15 详情删除同步清 state.sel（死 id → 批量条虚报 / 所选操作静默落空）
 *   16 搜索范围「演员」与默认范围纳入 actorF/actorM（卡片显示着却搜不到）
 *   17 CSV 导出公式注入防护（= + - @ 开头前置单引号）
 *   18 导出图片包改为限并发分批（旧版全量并发 + 全量驻留内存 → 大图库 OOM）
 *   24 搜索防抖定时器提为模块级，应用预设时撤销（旧输入延迟回调覆盖预设）
 *   25 CSV：换行符统一（裸 \r 修复）+ 旧表头别名空值不占位（第二列不再被丢）
 * 纪律：唯一锚点替换（计数==1）→ 语法校验 → 行尾守恒
 */
const fs = require('fs');
const vm = require('vm');
const APP = 'C:/Users/Li-ieng-ou/WorkBuddy/BT/_build/v2_app.js';
const ZIP = 'C:/Users/Li-ieng-ou/WorkBuddy/BT/_build/part_zip.js';
const BUILD = 'C:/Users/Li-ieng-ou/WorkBuddy/BT/_build/build_v2.js';

function load(p) { const s = fs.readFileSync(p, 'utf8'); return { s, crlf: /\r\n/.test(s), raw: s }; }
function save(p, st) {
  let out = st.s;
  if (st.crlf) out = out.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  fs.writeFileSync(p, out);
}
function apply(st, jobs, fileLabel) {
  for (const p of jobs) {
    const c = st.s.split(p.f).length - 1;
    if (c !== 1) { console.log('FAIL ' + fileLabel + ' ' + p.n + ' 计数=' + c); process.exit(1); }
    st.s = st.s.replace(p.f, () => p.t);
    console.log('OK   ' + fileLabel + ' ' + p.n);
  }
}

/* ============ v2_app.js ============ */
let app = load(APP);
app.s = app.s.replace(/\r\n/g, '\n');
apply(app, [
  { n: 'BUG-15 删除清 state.sel',
    f: "        state.rows = state.rows.filter(function (x) { return x.id !== r.id; });\n        closeModal('detailMask'); commit(); saveData();\n        toast('已删除 ' + r.code, 'ok');",
    t: "        state.rows = state.rows.filter(function (x) { return x.id !== r.id; });\n        /* v2.1.27 BUG-15：同步清掉勾选态。旧版留下死 id → 批量条虚报条数，\n           「导出所选 / 删除所选」按 selIds 过滤时匹配不到任何行，静默落空。 */\n        delete state.sel[r.id];\n        closeModal('detailMask'); commit(); saveData();\n        toast('已删除 ' + r.code, 'ok');" },
  { n: 'BUG-24 防抖定时器提为模块级',
    f: "  function bindSearch() {\n    var t = null;\n    $('#searchInput').addEventListener('input', function () {\n      var v = this.value;\n      clearTimeout(t);\n      t = setTimeout(function () {",
    t: "  /* v2.1.27 BUG-24：防抖定时器必须是模块级的——应用预设时要能从外部撤销。\n     旧版是 bindSearch 闭包内的局部变量：输入后 180ms 内点预设，定时器随后触发\n     会把 state.filter.text 改回旧输入，预设被无声覆盖。 */\n  var _searchDebounce = null;\n  function bindSearch() {\n    $('#searchInput').addEventListener('input', function () {\n      var v = this.value;\n      clearTimeout(_searchDebounce);\n      _searchDebounce = setTimeout(function () {" },
  { n: 'BUG-24 searchClear 改用模块级定时器',
    f: "      clearTimeout(t);                 /* 撤销挂起的防抖，否则旧搜索词会被重新应用（v2.1.2 修） */",
    t: "      clearTimeout(_searchDebounce);    /* 撤销挂起的防抖，否则旧搜索词会被重新应用（v2.1.2 修） */" },
  { n: 'BUG-24 应用预设时撤销防抖',
    f: "  function applyFilterSnapshot(s) {\n    var f = state.filter;",
    t: "  function applyFilterSnapshot(s) {\n    /* BUG-24：撤销挂起的搜索防抖，否则预设会被上一次输入的延迟回调覆盖 */\n    if (_searchDebounce) { clearTimeout(_searchDebounce); _searchDebounce = null; }\n    var f = state.filter;" },
  { n: 'BUG-25 CSV 换行符统一（裸 \\r）',
    f: "  function parseCsv(text) {\n    var rows = [], row = [], cell = '', q = false, i = 0;\n    text = String(text || '').replace(/^\\uFEFF/, '');",
    t: "  function parseCsv(text) {\n    var rows = [], row = [], cell = '', q = false, i = 0;\n    /* v2.1.27 BUG-25：先把 \\r\\n 与裸 \\r（老 Mac 换行）统一成 \\n。\n       旧版在循环里直接丢掉 \\r —— 裸 \\r 分行的 CSV 会被读成一整行，\n       且单元格里的 \\r 在 round-trip 中丢失。 */\n    text = String(text || '').replace(/^\\uFEFF/, '').replace(/\\r\\n?/g, '\\n');" },
  { n: 'BUG-25 旧表头别名空值不占位',
    f: "              CSV_COLS.forEach(function (c) { if (c[1] === hn && o[c[0]] == null) o[c[0]] = line[i]; });",
    t: "              /* BUG-25：空值不占位——旧版用 o[c[0]] == null 判空，第一列值为空串时\n                 也会占位，导致第二列（如配信日）的真实值被丢弃。 */\n              CSV_COLS.forEach(function (c) {\n                if (c[1] !== hn) return;\n                var v = line[i];\n                if (v == null || String(v).trim() === '') return;\n                if (o[c[0]] == null || String(o[c[0]]).trim() === '') o[c[0]] = v;\n              });" },
  { n: 'BUG-17 CSV 导出公式注入防护',
    f: "        v = v == null ? '' : String(v);\n        return /[\",\\n]/.test(v) ? ('\"' + v.replace(/\"/g, '\"\"') + '\"') : v;",
    t: "        v = v == null ? '' : String(v);\n        /* v2.1.27 BUG-17：CSV 公式注入防护——以 = + - @ 开头的单元格会被\n           Excel / WPS 当公式执行。导出时前置单引号（打开后按文本显示）。\n           导入端保持原值不动（避免污染库内数据），真正的执行点在导出。 */\n        if (/^[=+\\-@\\t\\r]/.test(v)) v = \"'\" + v;\n        return /[\",\\n]/.test(v) ? ('\"' + v.replace(/\"/g, '\"\"') + '\"') : v;" },
  { n: 'bump APP_VERSION', f: "  var APP_VERSION = '2.1.26';", t: "  var APP_VERSION = '2.1.27';" }
], 'v2_app.js');
try { new vm.Script(app.s); } catch (e) { console.log('FAIL v2_app.js 语法: ' + e.message); process.exit(1); }
if (app.s.indexOf('\uFFFD') >= 0) { console.log('FAIL U+FFFD'); process.exit(1); }
save(APP, app);

/* ============ part_zip.js ============ */
let zip = load(ZIP);
zip.s = zip.s.replace(/\r\n/g, '\n');
apply(zip, [
  { n: 'BUG-18 图片包导出限并发分批',
    f: "function exportZip(){\n  if(!state.rows.length){ toast('当前没有数据可导出'); return; }\n  var files = [], jobs = [];\n  var payload = { app: 'Film Library', version: 3, exportedAt: new Date().toISOString(), rows: [] };\n  state.rows.forEach(function(r){\n    var o = stripRow(r);\n    payload.rows.push(o);\n    if(r.cover){\n      var p1 = r.cover.path || ('covers/' + r.cover.name);\n      jobs.push(imgBytesFromServer(r.cover).then(function(b){ if(b) files.push({ name: p1, data: b }); }));\n    }\n    r.shots.forEach(function(s){\n      var p2 = s.path || ('shots/' + s.name);\n      jobs.push(imgBytesFromServer(s).then(function(b){ if(b) files.push({ name: p2, data: b }); }));\n    });\n  });\n  Promise.all(jobs).then(function(){",
    t: "/* v2.1.27 BUG-18：旧版一次性 Promise.all 全部图片——262 行 × 数十张图会同时\n   打出几百个请求，且全部字节驻留内存直到打包，大图库直接 OOM / 卡死。\n   改为「任务队列 + 限并发 6」逐批推进。 */\nfunction exportZip(){\n  if(!state.rows.length){ toast('当前没有数据可导出'); return; }\n  var files = [], jobs = [];\n  var payload = { app: 'Film Library', version: 3, exportedAt: new Date().toISOString(), rows: [] };\n  state.rows.forEach(function(r){\n    var o = stripRow(r);\n    payload.rows.push(o);\n    if(r.cover){\n      var p1 = r.cover.path || ('covers/' + r.cover.name);\n      jobs.push(function(){ return imgBytesFromServer(r.cover).then(function(b){ if(b) files.push({ name: p1, data: b }); }); });\n    }\n    r.shots.forEach(function(s){\n      var p2 = s.path || ('shots/' + s.name);\n      jobs.push(function(){ return imgBytesFromServer(s).then(function(b){ if(b) files.push({ name: p2, data: b }); }); });\n    });\n  });\n  var CONC = 6, at = 0, total = jobs.length;\n  if(total) toast('正在打包 ' + total + ' 个图片文件…', 'ok');\n  function runBatch(){\n    var batch = jobs.slice(at, at + CONC);\n    if(!batch.length) return Promise.resolve();\n    at += CONC;\n    return Promise.all(batch.map(function(fn){ return fn(); })).then(runBatch);\n  }\n  runBatch().then(function(){" }
], 'part_zip.js');
try { new vm.Script(zip.s); } catch (e) { console.log('FAIL part_zip.js 语法: ' + e.message); process.exit(1); }
save(ZIP, zip);

/* ============ build_v2.js（搜索引擎补丁：scopeText） ============ */
let bd = load(BUILD);
bd.s = bd.s.replace(/\r\n/g, '\n');
apply(bd, [
  { n: 'BUG-16 scopeText 演员范围含 actorF/actorM',
    f: "deps = rep(deps,\n  \"  if(s === 'note') return r.note;\\n\",",
    t: "/* v2.1.27 BUG-16：搜索范围「演员」与默认范围都要含 actorF/actorM ——\n   卡片与详情展示的是合并后的演员，旧版只查 r.actor，拆分录入的行搜不到。 */\ndeps = rep(deps,\n  \"  if(s === 'actor') return r.actor;\\n\",\n  \"  if(s === 'actor') return [r.actor, r.actorF, r.actorM].filter(Boolean).join(', ');\\n\", 'scopeText actor 含 actorF/actorM');\ndeps = rep(deps,\n  \"  if(s === 'note') return r.note;\\n\"," },
  { n: 'BUG-16 默认范围纳入 actorF/actorM',
    f: "\"  return [r.code, r.title, r.titleCn, r.release, r.maker, r.series, r.director, r.platform, r.actor, r.tags, r.note].join(' ');\\n\", 'scopeText 默认范围纳入新字段');",
    t: "\"  return [r.code, r.title, r.titleCn, r.release, r.maker, r.series, r.director, r.platform, r.actor, r.actorF, r.actorM, r.tags, r.note].join(' ');\\n\", 'scopeText 默认范围纳入新字段（v2.1.27 补 actorF/actorM）');" }
], 'build_v2.js');
try { new vm.Script(bd.s); } catch (e) { console.log('FAIL build_v2.js 语法: ' + e.message); process.exit(1); }
save(BUILD, bd);

console.log('DONE v2_app.js / part_zip.js / build_v2.js 已写入（v2.1.27，需重建产物）');
