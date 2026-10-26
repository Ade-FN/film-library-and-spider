/* ============================================================================
 * build_v2.js — 装配 Film Library.html（v2 正式版）
 *   1. 读 _build/part_search.js（「高级搜索语法」搜索引擎：自 v1 旧版备份固化
 *      而来的独立部件，v2 适配史与复验入口见该文件头注释）
 *   2. 注入 _build/v2_app.js 的 CARRY:search-engine 锚点
 *   3. 注入 _build/part_*.js 部件（tag/actor/video/fanza/fill/xlsx/zip）
 *   4. 把 JS 注入 _build/v2_core.html 的 APP 占位，产出 Film Library.html
 *   5. 校验：语法（vm）/ U+FFFD / rating 与死代码零残留 / </script> 防线 /
 *      script 标签计数 / 占位符零残留 / 关键存在性
 *   6. 原子写产物（tmp → fsync → rename），写盘中途被打断不留半截 HTML
 *
 * 历史：v2.1.x 之前搜索引擎由本脚本从冻结旧备份抽取 + 10 余个链式精确补丁适配，
 *   顺序耦合一碰就断（审计 A-21）；现已整体固化为 part_search.js，本脚本只读部件。
 *   改搜索语义 → 改 _build/part_search.js → 跑本脚本重建；改产物无效（会被覆盖）。
 * ==========================================================================*/
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = 'C:/Users/Li-ieng-ou/WorkBuddy/BT';
const CORE = path.join(ROOT, '_build/v2_core.html');
const APP = path.join(ROOT, '_build/v2_app.js');
const SEARCH = path.join(ROOT, '_build/part_search.js');
const OUT = path.join(ROOT, 'Film Library.html');

function die(msg) { console.error('❌ ' + msg); process.exit(1); }
function rep(s, anchor, repl, label) {
  const c = s.split(anchor).length - 1;
  if (c !== 1) die('锚点命中 ' + c + ' 次（要求 1）：' + label);
  console.log('✅ ' + label);
  return s.replace(anchor, typeof repl === 'function' ? repl : () => repl);
}
/* A-25：原子写——先写 tmp、fsync、再 rename。写盘中途被打断（断电/杀进程/
   磁盘满）时，要么留下完整 tmp（下次构建覆盖），要么原成品完好，
   绝不会出现半截 HTML 被浏览器加载（那会表现为页面半瘫且难以回头查）。 */
function writeFileAtomic(dest, content) {
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, content);
  let fd;
  try {
    fd = fs.openSync(tmp, 'r+');
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fs.renameSync(tmp, dest);
}

/* ---------- 1. 搜索引擎部件（A-21：固化，不再抽取不再打补丁） ---------- */
const searchCode = fs.readFileSync(SEARCH, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
if (searchCode.indexOf('@@') !== -1) die('part_search.js 里有 @@ 占位符残留');
if (/rating|评分/.test(searchCode.replace(/\/\*[\s\S]*?\*\//g, ''))) die('part_search.js 仍有 rating/评分 残留');
console.log('📦 搜索引擎：part_search.js（' + searchCode.split('\n').length + ' 行，A-21 固化部件）');

/* ---------- 2. 注入 app.js ---------- */
let app = fs.readFileSync(APP, 'utf8').replace(/\r\n/g, '\n');
app = rep(app, '  /* @@CARRY:search-engine@@ */', () => searchCode, '注入搜索引擎（part_search.js）');

/* ---------- 2b. 注入 Phase 1b 部件（tag/actor/video/fanza/fill/xlsx/zip） ---------- */
const PARTS = [
  ['@@PART:tag@@', 'part_tag.js'],
  ['@@PART:actor@@', 'part_actor.js'],
  ['@@PART:video@@', 'part_video.js'],
  ['@@PART:fanza@@', 'part_fanza.js'],
  ['@@PART:fill@@', 'part_fill.js'],
  ['@@PART:xlsx@@', 'part_xlsx.js'],
  ['@@PART:zip@@', 'part_zip.js']
];
PARTS.forEach(function (p) {
  const anchor = '/* ' + p[0] + ' */';
  const code = fs.readFileSync(path.join(__dirname, p[1]), 'utf8').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  app = rep(app, anchor, () => '\n' + code + '\n', '注入 ' + p[1]);
});

/* ---------- 3. 装配 html ---------- */
let core = fs.readFileSync(CORE, 'utf8').replace(/\r\n/g, '\n');
core = rep(core, '/* @@APP@@ */', () => '\n' + app + '\n', '注入 JS 到 html');

/* A-26：appVer 静态回退值 = 当前 APP_VERSION，构建期注入、永不脱节。
   整段 script 语法崩/被浏览器挡下时（APP_VERSION 根本没机会跑），
   顶栏不再显示陈旧的 v2.0.0——用户/支持者能按真实版本定位问题。 */
const APP_VER = (app.match(/APP_VERSION = '([^']+)'/) || [])[1];
if (!APP_VER) die('v2_app.js 找不到 APP_VERSION');
core = rep(core, 'id="appVer">v@@APP_VER@@ · 本地服务版',
  'id="appVer">v' + APP_VER + ' · 本地服务版', 'appVer 回退值注入 v' + APP_VER);

/* ---------- 4. 校验 ---------- */
function validateProduct(core) {
  const errs = [];
  if (core.split('\uFFFD').length - 1 !== 0) errs.push('出现 U+FFFD');
  if (core.indexOf('@@') !== -1) errs.push('成品里残留 @@ 占位符');
  /* A-22：HTML 解析器遇到 JS 里的 </script 字面量会提前掐断整个脚本——
     构建照常通过、页面半瘫，且极难回头查。标签计数 + 切片双保险挡住。 */
  const nOpen = core.split('<script>').length - 1;
  const nClose = core.split('</' + 'script>').length - 1;
  if (nOpen !== 1) errs.push('<script> 开标签数量 ' + nOpen + '（要求 1）');
  if (nClose !== 1) errs.push('</script> 闭标签数量 ' + nClose + '（要求 1）：JS 内疑似含 </script 字面量，字符串里须写成 <\\/script');
  /* 用最后一个 <script>（注释里可能出现 script 字样，不能用第一个匹配）；
     闭标签同理取最后一个——注入的 JS 在前，真正的闭标签在最后 */
  const jsStart = core.lastIndexOf('<script>') + '<script>'.length;
  const jsEnd = core.lastIndexOf('</' + 'script>');
  const js = core.slice(jsStart, jsEnd);
  if (/<\/script/i.test(js)) errs.push('JS 内含 </script 字面量（字符串里须写成 <\\/script）');
  try { new vm.Script(js); }
  catch (e) { errs.push('JS 语法错误：' + e.message); }
  /* rating/死代码判定只扫 JS 代码，且用字符串/注释感知的剥离器：
     ① 朴素的块注释正则会命中 HTML 属性里的 MIME 通配符（accept="image/*"），
        把一大片真代码当注释吞掉（迁移前实测吞 10.8KB，rating 检查半聋）；
     ② HTML 文本/属性/CSS 本来就不是"成品代码"，不该参与判定；
     ③ 注释里允许出现"评分已删"之类的说明文字（部件头注释就在讲历史）。 */
  function stripJsComments(src) {
    const KW = /^(?:return|typeof|case|in|of|new|delete|void|do|else|instanceof)$/;
    let out = '', i = 0; const n = src.length;
    let prevCh = '', prevWord = '';
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') {           /* 行注释：跳到行尾 */
        while (i < n && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {           /* 块注释：跳到配对星斜杠 */
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {       /* 字符串：整体拷贝到配对引号 */
        const q = c; out += c; i++;
        while (i < n) {
          if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
          if (src[i] === q) { out += src[i]; i++; break; }
          out += src[i]; i++;
        }
        prevCh = q; prevWord = '';
        continue;
      }
      if (c === '/' && (KW.test(prevWord) || !prevCh || '(,=:[!&|?{;+-*%<>~^'.indexOf(prevCh) >= 0)) {
        /* 正则字面量：整体拷贝到斜杠（字符类里的斜杠不算结束） */
        out += c; i++;
        let inClass = false;
        while (i < n) {
          const d = src[i];
          if (d === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
          if (d === '\n') break;                       /* 正则不跨行：异常时按普通字符继续 */
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { out += d; i++; break; }
          out += d; i++;
        }
        prevCh = '/'; prevWord = '';
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        let w = '';
        while (i < n && /[A-Za-z0-9_$]/.test(src[i])) { w += src[i]; i++; }
        out += w; prevCh = w[w.length - 1]; prevWord = w;
        continue;
      }
      if (!/\s/.test(c)) { prevCh = c; prevWord = ''; }
      out += c; i++;
    }
    return out;
  }
  const jsCode = stripJsComments(js);
  if (/\brating\b/.test(jsCode)) errs.push('成品 JS 代码里仍有 rating');
  /* A-24：v2 已删功能一旦复活（改部件时手滑粘回）必须炸，不能只打日志——
     旧版 getWatchRows 死代码移除是全文唯一无计数断言的替换，失配只 console.log */
  ['function getWatchRows', 'function cmpRating'].forEach(k => {
    if (jsCode.indexOf(k) !== -1) errs.push('死代码复活：' + k);
  });
  /* 关键存在性 */
  ['function buildRowMatcher', 'function buildPlainMatcher', 'function getFiltered', 'function naturalCmp', 'function scopeText',
    'var VS = {', 'var API', 'function normalizeRow', 'id="vsViewport"', 'id="setupMask"',
    'function renderVideoPage', 'function renderActorPage', 'function renderTagPage',
    'function exportZip', 'function importTabular', 'function pendingRowsFor',
    'id="fanzaMask"', 'id="fillMask"', 'id="actorMergeMask"', 'id="videoEl"', 'id="tagList"', 'id="actorList"'
  ].forEach(k => { if (core.indexOf(k) === -1) errs.push('缺少：' + k); });
  return errs;
}
const errs = validateProduct(core);
if (errs.length) { errs.forEach(e => console.error('❌ ' + e)); process.exit(1); }

writeFileAtomic(OUT, core.replace(/\n/g, '\r\n'));
console.log('\n🎉 已生成 ' + OUT);
console.log('   大小 ' + (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB · 行数 ' + core.split('\n').length);
