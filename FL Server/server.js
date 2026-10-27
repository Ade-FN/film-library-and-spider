#!/usr/bin/env node
/* ============================================================================
 * FL Server · Film Library 本地服务（Node 主服务，零第三方依赖）
 * ----------------------------------------------------------------------------
 * 为什么需要它（2026-10-14 架构定稿）：
 *   旧方案 = 浏览器 File System Access 读写数据文件夹 + 爬虫写「收件箱.json」。
 *   问题：两个进程（页面/爬虫）抢同一个文件夹，要靠 localStorage 锁 + 去重 +
 *         归档兜底，链路长、易丢数据；且 File System Access 只有 Chromium 有。
 *   新方案 = 本服务是唯一有权写数据目录的进程：
 *     · 页面（Film Library.html）所有读写走 HTTP（同源）
 *     · 爬虫（FL Spider）抓完 POST /api/inbox，即时知道成功/失败
 *     · 写文件一律「临时文件 + 原子替换」，绝不写半截
 *     · 只绑 127.0.0.1，只允许访问数据目录内的文件（防路径穿越）
 *
 * 数据目录：由 data-dir.txt 指定（首次运行在页面里填，也可记事本改）。
 *   目录结构（与旧版完全一致，旧数据零转换直接读）：
 *     Film Library.json            主数据
 *     covers/  shots/  covers/thumb/  actors/   图片
 *     backups/                     自动备份
 *     Film Library 收件箱.json      爬虫来料
 *     Film Library 收件箱_已导入.json  归档
 *     Film Library 待补全番号.json   爬虫批量队列来源
 *
 * 端口：默认 8787，被占则顺延 8788…8796（启动日志会显示实际端口）。
 * 兼容：Python 备服务 server.py 功能等价；启动 Film Library.cmd 自动二选一。
 * ==========================================================================*/
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

/* ---------- 常量（真实值，不占位） ---------- */
/* v1.1.8（附录批次 6）：A-15 对拍 Py 流式（见下 pipeFile）/ A-16 createReadStream
   error 监听 / A-17 配置文件 GBK 回退解码 / A-18 错误码与排序双端对齐 + 损坏
   收件箱拒绝导入 / A-19 原子写 fsync / A-20 闲置连接超时。 */
const VERSION = '1.1.12';
const PORT_FIRST = 8787;
const PORT_LAST = 8796;
const HERE = __dirname;

const APP_DEFAULT = path.join(HERE, '..', 'Film Library.html');
const APP_OVERRIDE_FILE = path.join(HERE, 'app-file.txt');
const DATA_DIR_FILE = path.join(HERE, 'data-dir.txt');
const VIDEO_DIR_FILE = path.join(HERE, 'video-dir.txt');

const MAIN_FILE = 'Film Library.json';
const MAIN_FILE_OLD = '影片档案馆.json';        // 旧命名，读到即提示迁移
const INBOX_FILE = 'Film Library 收件箱.json';
const INBOX_DONE = 'Film Library 收件箱_已导入.json';
const PENDING_FILE = 'Film Library 待补全番号.json';
const META_FILE = 'meta.json';                  // 演员资料 + 标签元数据（v2.1 起服务端持久化）

const MAX_JSON_BODY = 128 * 1024 * 1024;        // 收件箱带 base64 图，放大限额
const MAX_UPLOAD_BODY = 128 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'video/ogg',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
};
const VIDEO_EXT = ['.mp4', '.webm', '.ogg', '.mov', '.mkv', '.avi', '.flv', '.ts', '.wmv'];

/* ============================================================================
 * 文件工具：原子写 + 读
 * ==========================================================================*/
/* v1.1.8 A-17：配置文件可能被记事本另存为 GBK/ANSI（用户手改 data-dir.txt 的
   常见形态）。旧版两种坏面貌：Python 严格 utf8 失败 → 全端 409；Node 按 utf8
   静默替换字符 → 中文路径变乱码还照样报 configured。现在：utf8 严格校验
   （TextDecoder fatal）失败即回退 GBK 解码；GBK 也不可用时退回原行为。 */
/* v1.1.10 #2：单文件读入上限（64MB）。V8 单字符串上限约 512MB（实测
   MAX_STRING_LENGTH = 536870888）；收件箱归档长期累积可达数百 MB（实测 866MB），
   readFileSync + toString 直接抛 RangeError → /api/status 与收件箱接口全线 500。
   超过门限按「读不到」返回 null，由调用方降级（见 /api/status 的 oversize 标记），
   绝不因为一个归档文件拖垮整个服务。 */
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
function fileTooLarge(p) {
  try { const st = fs.statSync(p); return !!st && st.isFile() && st.size > MAX_TEXT_BYTES; }
  catch (e) { return false; }
}
function readText(p) {
  let buf;
  try {
    if (fileTooLarge(p)) return null;
    buf = fs.readFileSync(p);
  } catch (e) { return null; }
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return buf.toString('utf8'); }
  catch (e) { /* 非 utf8 字节，走 GBK 回退；也可能是超上限，下面逐级兜底 */ }
  try { return new TextDecoder('gbk').decode(buf); }
  catch (e2) { try { return buf.toString('utf8'); } catch (e3) { return null; } }
}
/* 去掉 Notepad 可能存进的 BOM / 首尾空白 / 包裹的引号 */
function cleanPathText(s) {
  if (s == null) return '';
  return String(s).replace(/^\uFEFF/, '').trim().replace(/^"(.*)"$/, '$1').trim();
}
/* v1.1.8 A-19：先 fsync 再 rename。旧版 rename 生效但文件内容还在 OS 缓存里，
   掉电窗口内 JSON 看似写成功、重启后是空/半截文件（概率低后果重）。 */
function writeTextAtomic(p, text) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = p + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');        // 无 BOM，UTF-8
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, p);                        // 同卷 rename ≈ 原子替换
}
function writeBufAtomic(p, buf) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = p + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, buf);
    fs.fsyncSync(fd);                           // v1.1.8 A-19：同上
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, p);
}
/* 串行化所有写操作：避免两个请求交叉写同一文件 */
let writeChain = Promise.resolve();
function withWriteLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(() => {}, () => {});
  return run;
}
/* 防路径穿越：只允许 base 目录内的相对路径 */
function safeJoin(base, rel) {
  if (!base) return null;
  const r = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!r || r.split('/').some(seg => seg === '..')) return null;
  /* v1.1.10 #3：必须解析符号链接 / junction 之后再判越界。旧版只用 path.resolve
     做「字符串前缀」比较：数据目录里若有指向外部的 junction（为省空间把 covers
     链接到别的盘是很常见的做法），就能读到目录外的文件；而 Python 备端用的是
     realpath，同一个请求两端给出不同结果（Node 200 / Python 403）。
     现在两端统一：realpath 后判前缀；realpath 失败（不存在/无权限）退回字符串
     比较，让上层按 404 处理，不把「读不到」误判成「禁止访问」。 */
  let abs, b;
  try {
    abs = fs.realpathSync(path.resolve(base, r));
    b = fs.realpathSync(path.resolve(base));
  } catch (e) {
    abs = path.resolve(base, r);
    b = path.resolve(base);
  }
  if (abs !== b && !abs.startsWith(b + path.sep)) return null;
  return abs;
}
/* Windows 保留设备名：写入会被重定向到设备句柄，文件"上传成功"却不存在（BUG-13） */
const WIN_RESERVED_NAMES = new Set(['CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => 'COM' + (i + 1)),
  ...Array.from({ length: 9 }, (_, i) => 'LPT' + (i + 1))]);
/* 文件名净化：只要 basename，拒绝对目录逃逸 */
function safeName(name) {
  let n = path.basename(String(name || '').replace(/\\/g, '/')).trim();
  n = n.replace(/^\.+/, '').replace(/[\x00-\x1f]/g, '');
  n = n.replace(/[ .]+$/, '');          // Windows 文件名不能以空格或点结尾
  if (!n || n.length > 200) return null;
  if (WIN_RESERVED_NAMES.has(n.split('.')[0].toUpperCase())) return null;
  return n;
}
/* CORS 白名单（BUG-22）：无 Origin（同域/非浏览器）、127.0.0.1、localhost、
   file:// 页面（Origin: null）放行；其余来源不回 ACAO → 浏览器预检失败，
   跨域网页读不到数据也发不出写请求。油猴 GM_xmlhttpRequest 不走 CORS 检查。 */
function originAllowed(origin) {
  if (!origin) return true;
  const o = String(origin).trim();
  if (o === 'null') return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(o);
}
function getDataDir() { return cleanPathText(readText(DATA_DIR_FILE)); }
function getVideoDir() {
  const v = cleanPathText(readText(VIDEO_DIR_FILE));
  return v || getDataDir();
}
function getAppFile() {
  const o = cleanPathText(readText(APP_OVERRIDE_FILE));
  if (o) return path.isAbsolute(o) ? o : path.join(HERE, o);
  return APP_DEFAULT;
}

/* ============================================================================
 * 番号归一化（与 FL Spider 的 padKey 一致：DSOD-9 ↔ DSOD-009 视为同一部）
 * ==========================================================================*/
function padKey(code) {
  const str = String(code == null ? '' : code).trim().toUpperCase();
  const m = /^([A-Z]+)-?0*(\d+)$/.exec(str);
  if (m) return m[1] + '-' + String(parseInt(m[2], 10));
  return str;
}
function digitLen(code) {
  /* v1.1.11 #24：先 trim 再匹配。Python 端加了 re.ASCII 使 \s 只认 ASCII 空白，
     而 JS 的 \s 是 Unicode 语义（含 \u00A0、\uFEFF）——番号尾部带全角/不换行空格时
     两端 digitLen 不同 → dedupe 归并保留的条目不同 → 收件箱随主备端切换漂移。 */
  const m = /(\d+)\s*$/.exec(String(code == null ? '' : code).trim());
  return m ? m[1].length : 0;
}
/* ============================================================================
 * 来源分级（v1.1.3，与 FL Spider v1.3.45 一致；用户拍板：FC2 计一级）
 *   一级 = FANZA / MGS / FC2（官方卖家）；二级 = JAVDB / MISSAV / MOTV 等聚合站
 *   用于收件箱归并（scoreItem 第一排序键）与 POST /api/inbox 同番号写入比对
 * ==========================================================================*/
const TIER1_PLATFORMS = ['FANZA', 'MGS', 'FC2'];
function isFc2Code(v) { return /FC2[- ]PPV[- ]\d{3,10}/i.test(String(v == null ? '' : v)); }
function tierOfItem(it) {
  if (!it) return 0;
  if (it.srcTier === 1 || it.srcTier === 2) return it.srcTier;
  if (isFc2Code(it.code)) return 1;                 // FC2 番号一律一级（官方卖家本人）
  const p = String(it.platform || '').toUpperCase();
  if (TIER1_PLATFORMS.indexOf(p) >= 0) return 1;
  return p ? 2 : 0;                                  // 无层级信息的旧来料不占档
}
/* 图片有效性判定（v1.1.7 BUG-30）：字符串非空 / 对象至少有一个非空值。
   旧版 js 用 `if (it.cover)` —— {} 空对象也算有图（+2），Python 端 `if it.get('cover')`
   判为无图 → 两端打分不同 → dedupe 保留的那条不同，收件箱内容随主备端切换而变。 */
function hasImg(v) {
  if (typeof v === 'string') return !!v.trim();
  if (v && typeof v === 'object') return Object.keys(v).some(k => String(v[k] == null ? '' : v[k]).trim());
  return !!v;
}
function scoreItem(it) {
  if (!it) return -1;
  let n = 0;
  /* v1.1.3：对齐 FL Spider v1.3.40 十字段字段体系——旧表里的 tags/releaseSale/
     releaseStream 已废，换成 maker/release/platform 口径 */
  ['title', 'titleCn', 'actorF', 'actorM', 'actor', 'maker', 'release', 'magnet']
    /* v1.1.11 #25：与 Python 端一致——只看「非 null 且去空白非空」。
       Python 的 or '' 会把 0 / false 当空，Node 的 ==null 不会 → 打分差 1
       → dedupe 保留的那条不同，双端收件箱内容不一致。 */
    .forEach(k => { const v = it[k]; if (v != null && String(v).trim()) n++; });
  if (hasImg(it.cover)) n += 2;
  if (Array.isArray(it.shots) && it.shots.length) n += 2;
  /* 来源层级作第一排序键：一级加大档（2000）、二级加小档（1000），
     档位差远大于字段分上限（~12）——一级穷条目赢二级富条目 */
  const t = tierOfItem(it);
  if (t === 1) n += 2000;
  else if (t === 2) n += 1000;
  return n;
}
/* 收件箱内按归一化键归并：保留信息更全、番号位数更完整的那条 */
function dedupeInbox(items) {
  const buckets = [], at = {};
  (items || []).forEach(it => {
    const k = (it && it.code) ? padKey(it.code) : ('#' + buckets.length);
    if (at[k] === undefined) { at[k] = buckets.length; buckets.push(it); return; }
    const cur = buckets[at[k]];
    const a = scoreItem(it), b = scoreItem(cur);
    if (a > b || (a === b && digitLen(it.code) > digitLen(cur.code))) buckets[at[k]] = it;
  });
  return buckets;
}
/* 收件箱文件兼容两种历史形态：{items:[...]} 或裸数组 */
function parseInbox(txt) {
  if (!txt) return [];
  try {
    const p = JSON.parse(txt.replace(/^\uFEFF/, ''));
    return Array.isArray(p) ? p : (Array.isArray(p.items) ? p.items : []);
  } catch (e) { return null; }               // null = 文件损坏（与「空」区分）
}
function inboxPayload(items) {
  return JSON.stringify({
    app: 'Film Library', type: 'inbox', source: 'fl-spider',
    updatedAt: new Date().toISOString(), items
  }, null, 2);
}

/* ============================================================================
 * HTTP 基础
 * ==========================================================================*/
function cors(res, req) {
  const origin = req && req.headers && req.headers.origin;
  if (originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
}
function sendJson(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': b.length,
    'Cache-Control': 'no-store',
  });
  res.end(b);
}
function sendErr(res, code, msg) { sendJson(res, code, { ok: false, error: msg }); }
function sendHtml(res, code, html) {
  const b = Buffer.from(html, 'utf8');
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(b);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      /* v1.1.11 #26：不能先 destroy——销毁请求流会连带关掉 socket，413 根本发不到
         客户端（实测收到 ECONNRESET，浏览器表现为 Failed to fetch）。
         与 Python 端一致：先排空剩余 body，再由路由回 413。 */
      if (size > limit) { req.resume(); reject(new Error('body too large')); return; }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseJsonBuf(buf) {
  const t = buf.toString('utf8').replace(/^\uFEFF/, '');
  return JSON.parse(t);
}
/* Range 支持：Video 页拖动进度条必须（206 Partial Content） */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || ''));
  if (!m) return null;
  let start, end;
  if (m[1] === '') {
    if (m[2] === '') return null;
    const n = parseInt(m[2], 10);
    if (!n) return null;
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : parseInt(m[2], 10);
  }
  if (!isFinite(start) || !isFinite(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/* v1.1.8 A-16：stat 与 open 之间文件可能被删/移动。ReadStream 的 'error' 事件
   若无监听器，Node 按未捕获异常处理直接终结进程——一个坏请求 = 全站停摆。
   已发响应头就只能断流，未发头则回 500（与 Python 端的优雅降级对齐）。 */
function pipeFile(res, abs, opts) {
  const st = fs.createReadStream(abs, opts);
  st.on('error', () => {
    if (res.headersSent) { try { res.destroy(); } catch (e) {} }
    else { try { sendErr(res, 500, 'read failed'); } catch (e) {} }
  });
  st.pipe(res);
  return st;
}

/* 发送数据目录/视频目录里的文件（支持 Range / HEAD；/data/ 与 /video/ 共用） */
function serveFile(req, res, abs) {
  let st;
  try { st = fs.statSync(abs); } catch (e) { sendErr(res, 404, 'not found'); return; }
  if (!st.isFile()) { sendErr(res, 404, 'not found'); return; }
  const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const range = parseRange(req.headers.range, st.size);
  if (range) {
    res.writeHead(206, {
      'Content-Type': mime,
      'Content-Length': range.end - range.start + 1,
      'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + st.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    pipeFile(res, abs, { start: range.start, end: range.end });
  } else {
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': st.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    pipeFile(res, abs);
  }
}

/* ============================================================================
 * 路由
 * ==========================================================================*/
const server = http.createServer(async (req, res) => {
  cors(res, req);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  let url, pathname;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch (e) { sendErr(res, 400, 'bad url'); return; }
  /* v1.1.4 BUG-09（P1）：decodeURIComponent 原先在 try 之外——畸形百分号编码
     （如 /data/%E4% 、/%zz）会抛 URIError，async handler 的 rejection 无人接管 →
     unhandled rejection 直接终止 Node 进程，整个服务被打崩（一个坏请求 = 全站停摆）。 */
  try { pathname = decodeURIComponent(url.pathname); }
  catch (e) { sendErr(res, 400, 'bad url encoding'); return; }
  /* v1.1.11 #28：百分号编码的点段（%2e%2e）在 WHATWG URL 解析阶段就被归一化，
     导致 Node 落到 404 而 Python 回 403——同一请求两端结果不同。
     解码后显式拒绝任何 .. 段，与 Python 端对齐。 */
  if (pathname.split('/').indexOf('..') >= 0) { sendErr(res, 403, 'path denied'); return; }

  try {
    /* ---- 静态：应用本体 ---- */
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const app = getAppFile();
      const html = readText(app);
      if (html == null) {
        sendHtml(res, 500, '<!DOCTYPE html><meta charset="utf-8"><title>FL Server</title>' +
          '<body style="font-family:sans-serif;padding:40px;line-height:1.8">' +
          '<h2>找不到 Film Library.html</h2>' +
          '<p>期望位置：<code>' + APP_DEFAULT + '</code></p>' +
          '<p>如果把 html 放在了别处，在 <code>' + APP_OVERRIDE_FILE + '</code> 里写它的完整路径。</p></body>');
        return;
      }
      sendHtml(res, 200, html);
      return;
    }
    if (req.method === 'GET' && pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }

    /* ---- 数据目录内文件（图片 / json / 视频，支持 Range） ---- */
    if (req.method === 'GET' && pathname.startsWith('/data/')) {
      const dataDir = getDataDir();
      if (!dataDir) { sendErr(res, 409, 'data dir not configured'); return; }
      const abs = safeJoin(dataDir, pathname.slice('/data/'.length));
      if (!abs) { sendErr(res, 403, 'path denied'); return; }
      serveFile(req, res, abs);
      return;
    }

    /* ---- 视频目录内文件（Video 页播放，支持 Range） ---- */
    if (req.method === 'GET' && pathname.startsWith('/video/')) {
      const vd = getVideoDir();
      if (!vd) { sendErr(res, 409, 'video dir not configured'); return; }
      const name = safeName(pathname.slice('/video/'.length));
      if (!name) { sendErr(res, 400, 'bad name'); return; }
      serveFile(req, res, path.join(vd, name));
      return;
    }

    /* ---- 状态 ---- */
    if (req.method === 'GET' && pathname === '/api/status') {
      const dataDir = getDataDir();
      const st = { ok: true, server: 'node', version: VERSION, configured: !!dataDir, dataDir: dataDir || '' };
      if (dataDir) {
        const main = path.join(dataDir, MAIN_FILE);
        const inboxP = path.join(dataDir, INBOX_FILE);
        const doneP = path.join(dataDir, INBOX_DONE);
        const inboxTxt = readText(inboxP);
        const doneTxt = readText(doneP);
        /* v1.1.10 #2：超大文件读不动，计数只能是 0——但不标记原因的话，前端只看到
           「收件箱 0 条」，用户无从判断是真空还是读不动（曾导致误以为数据丢了）。 */
        const inboxBig = fileTooLarge(inboxP), doneBig = fileTooLarge(doneP);
        st.exists = { main: fs.existsSync(main), mainOld: fs.existsSync(path.join(dataDir, MAIN_FILE_OLD)), inbox: inboxTxt != null || inboxBig };
        st.counts = {
          films: countFilms(dataDir),
          inbox: (parseInbox(inboxTxt) || []).length,
          archive: (parseInbox(doneTxt) || []).length,
        };
        if (inboxBig || doneBig) st.oversize = { inbox: inboxBig, archive: doneBig };
        /* v1.1.12 #31：原子写是「写 tmp → fsync → rename」。进程被强杀/崩溃时 rename
           没执行，tmp 就永久留在数据目录里（实测一个进程留下 5 个、共 823MB）。
           这里只报告不清理——删文件必须由用户确认。 */
        try {
          let tmpN = 0, tmpB = 0;
          fs.readdirSync(dataDir).forEach(function (n) {
            if (!/\.tmp-\d+-[0-9a-z]+$/.test(n)) return;
            try { const s = fs.statSync(path.join(dataDir, n)); if (s.isFile()) { tmpN++; tmpB += s.size; } } catch (e) {}
          });
          if (tmpN) st.staleTmp = { count: tmpN, bytes: tmpB };
        } catch (e) {}
      }
      sendJson(res, 200, st);
      return;
    }

    /* ---- 配置数据目录 ---- */
    if (req.method === 'POST' && pathname === '/api/config') {
      const body = parseJsonBuf(await readBody(req, 1024 * 1024));
      const dir = cleanPathText(body && body.dataDir);
      if (!dir) { sendErr(res, 400, 'dataDir required'); return; }
      let stt;
      try { stt = fs.statSync(dir); } catch (e) { sendErr(res, 400, 'directory does not exist: ' + dir); return; }
      if (!stt.isDirectory()) { sendErr(res, 400, 'not a directory: ' + dir); return; }
      writeTextAtomic(DATA_DIR_FILE, dir);
      if (body.videoDir !== undefined) {
        const v = cleanPathText(body.videoDir);
        if (v) writeTextAtomic(VIDEO_DIR_FILE, v);
      }
      sendJson(res, 200, { ok: true, dataDir: dir });
      return;
    }

    /* ---- 主数据 ---- */
    if (req.method === 'GET' && pathname === '/api/data') {
      const dataDir = getDataDir();
      if (!dataDir) { sendErr(res, 409, 'data dir not configured'); return; }
      let file = MAIN_FILE, txt = readText(path.join(dataDir, MAIN_FILE));
      if (txt == null) { file = MAIN_FILE_OLD; txt = readText(path.join(dataDir, MAIN_FILE_OLD)); }
      if (txt == null) { sendJson(res, 200, { ok: true, exists: false, file: null, payload: { app: 'Film Library', version: 3, rows: [] } }); return; }
      let payload;
      try { payload = JSON.parse(txt.replace(/^\uFEFF/, '')); } catch (e) { sendErr(res, 500, 'main data is not valid JSON'); return; }
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.rows)) { sendErr(res, 500, 'main data shape unexpected'); return; }
      sendJson(res, 200, { ok: true, exists: true, file, payload });
      return;
    }
    /* ---- 番号查库（v1.1.9：FL Spider「一/二/无」查询）----
       FL Spider 把识别到的番号发来这里，由 Server 直读主数据文件判定：
       padKey 归一匹配（DSOD-9 ↔ DSOD-009 同一部），多行同番号取最高 tier
       （与收件箱归并「一级覆盖二级」同哲学）。tierOfItem 行级判定：
       srcTier 章 → FC2 番号 → platform ∈ TIER1 → 2 → 0。
       不整库回传（/api/data 太重），只回判定结果。 */
    if (req.method === 'GET' && pathname === '/api/exists') {
      const dataDir = getDataDir();
      if (!dataDir) { sendErr(res, 409, 'data dir not configured'); return; }
      const code = padKey(url.searchParams.get('code') || '');
      if (!code) { sendErr(res, 400, 'code required'); return; }
      let txt = readText(path.join(dataDir, MAIN_FILE));
      if (txt == null) txt = readText(path.join(dataDir, MAIN_FILE_OLD));
      if (txt == null) { sendJson(res, 200, { ok: true, found: false, tier: 0, code: code }); return; }
      let payload;
      try { payload = JSON.parse(txt.replace(/^\uFEFF/, '')); } catch (e) { sendErr(res, 500, 'main data is not valid JSON'); return; }
      /* v1.1.11 #23：与 Python 端一致——结构异常要 500，不能静默降级成 []。
         旧版 Node 返回 200 {found:false}，Python 返回 500，同一份坏数据两端表现不同。 */
      const rows = (payload && Array.isArray(payload.rows)) ? payload.rows : null;
      if (!rows) { sendErr(res, 500, 'main data shape unexpected'); return; }
      let best = 0, hit = null;
      /* 同番号多行取「最优」来源层级：一级(1) > 二级(2) > 无来源(0)——
         tier 数字越小来源越硬；0 只在不输给任何有来源行时才胜出。 */
      for (const r of rows) {
        if (!r || padKey(r.code) !== code) continue;
        const t = tierOfItem(r);
        if (!hit || (t !== 0 && (best === 0 || t < best))) { best = t; hit = r; }
      }
      if (!hit) { sendJson(res, 200, { ok: true, found: false, tier: 0, code: code }); return; }
      sendJson(res, 200, {
        ok: true, found: true, tier: best, code: code, libCode: String(hit.code || ''),
        platform: String(hit.platform || ''),
        title: String(hit.title || hit.titleCn || '').slice(0, 80)
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/data') {
      const dataDir = getDataDir();
      if (!dataDir) { sendErr(res, 409, 'data dir not configured'); return; }
      const body = parseJsonBuf(await readBody(req, MAX_JSON_BODY));
      const payload = body && body.payload;
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.rows)) { sendErr(res, 400, 'payload.rows must be an array'); return; }
      const out = { app: 'Film Library', version: 3, updatedAt: new Date().toISOString(), rows: payload.rows };
      await withWriteLock(() => { writeTextAtomic(path.join(dataDir, MAIN_FILE), JSON.stringify(out, null, 2)); });
      sendJson(res, 200, { ok: true, rows: out.rows.length });
      return;
    }

    /* ---- 图片上传（raw body，查询串带 kind 与 name） ---- */
    if (req.method === 'POST' && pathname === '/api/upload') {
      const dataDir = getDataDir();
      if (!dataDir) { sendErr(res, 409, 'data dir not configured'); return; }
      const kind = url.searchParams.get('kind') || '';
      const sub = { covers: 'covers', shots: 'shots', thumb: 'covers/thumb', avatars: 'actors' }[kind];
      if (!sub) { sendErr(res, 400, 'kind must be covers/shots/thumb/avatars'); return; }
      const name = safeName(url.searchParams.get('name') || '');
      if (!name) { sendErr(res, 400, 'bad name'); return; }
      const buf = await readBody(req, MAX_UPLOAD_BODY);
      if (!buf.length) { sendErr(res, 400, 'empty body'); return; }
      const rel = sub + '/' + name;
      await withWriteLock(() => { writeBufAtomic(path.join(dataDir, rel), buf); });
      sendJson(res, 200, { ok: true, path: rel });
      return;
    }

    /* ---- 备份 ---- */
    if (req.method === 'POST' && pathname === '/api/backup') {
      const dataDir = getDataDir();
      if (!dataDir) { sendErr(res, 409, 'data dir not configured'); return; }
      const body = parseJsonBuf(await readBody(req, MAX_JSON_BODY));
      const name = safeName(body && body.name);
      if (!name || !/\.json$/i.test(name)) { sendErr(res, 400, 'bad backup name'); return; }
      const payload = body && body.payload;
      if (!payload || !Array.isArray(payload.rows)) { sendErr(res, 400, 'payload.rows must be an array'); return; }
      const out = { app: 'Film Library', version: 3, updatedAt: new Date().toISOString(), rows: payload.rows };
      await withWriteLock(() => { writeTextAtomic(path.join(dataDir, 'backups', name), JSON.stringify(out, null, 2)); });
      sendJson(res, 200, { ok: true, name });
      return;
    }

    /* ---- 抓取报告（FL Spider 批量汇总；v1.1.6 BUG-14） ----
       通用 JSON 落盘：内容原样保存（/api/backup 会重写成 rows 结构，不能用）。 */
    if (req.method === 'POST' && pathname === '/api/report') {
      const dataDir = getDataDir();
      if (!dataDir) { sendErr(res, 409, 'data dir not configured'); return; }
      const body = parseJsonBuf(await readBody(req, MAX_JSON_BODY));
      const name = safeName(body && body.name);
      if (!name || !/\.json$/i.test(name)) { sendErr(res, 400, 'bad report name'); return; }
      const payload = (body && body.payload !== undefined) ? body.payload : null;
      if (payload === null) { sendErr(res, 400, 'payload required'); return; }
      const rel = 'reports/' + name;
      await withWriteLock(() => {
        fs.mkdirSync(path.join(dataDir, 'reports'), { recursive: true });
        writeTextAtomic(path.join(dataDir, rel), JSON.stringify(payload, null, 2));
      });
      sendJson(res, 200, { ok: true, path: rel });
      return;
    }

    /* ---- 收件箱 ---- */
    if (req.method === 'POST' && pathname === '/api/inbox/import') {
      /* v1.1.2：读掉请求体再处理。此前不消费 body，Node 请求流暂停，
         同一 keep-alive 连接上的后续请求全部挂起（Python 端同因是 501）。
         页面现在也不发 body 了，这里是双保险。 */
      await readBody(req, MAX_JSON_BODY);
      const dataDir = getDataDir();
      if (!dataDir) { sendErr(res, 409, 'data dir not configured'); return; }
      const inboxPath = path.join(dataDir, INBOX_FILE);
      const r = await withWriteLock(() => {
        /* v1.1.8 A-18：收件箱/归档文件损坏时拒绝导入并保留原文件。旧版 `|| []`
           把损坏当空——归档后顺手清空收件箱 = 无声数据丢失（GET /api/inbox
           早就对损坏回 500，唯独 import 这条最危险的路径静默成功）。 */
        /* v1.1.12 #31：readText 超过 64MB 门限返回 null，而 parseInbox(null) 是 []——
           「读不动」与「空」在调用方眼里完全一样。归档 866MB 时这里的 old 就成了 []，
           merged 只剩本次新来料，一次导入把数百 MB 历史归档整文件覆盖掉（回 200 ok）。
           与 #1 同款的静默丢失，只是发生在归档文件上。现在：存在但读不动 → 拒绝导入。 */
        if (fs.existsSync(inboxPath) && fileTooLarge(inboxPath)) throw new Error('inbox file is too large');
        const cur = parseInbox(readText(inboxPath));
        if (cur === null) throw new Error('inbox file is corrupted');
        if (!cur.length) return { archived: 0 };
        const donePath = path.join(dataDir, INBOX_DONE);
        if (fs.existsSync(donePath) && fileTooLarge(donePath)) throw new Error('archive file is too large');
        const old = parseInbox(readText(donePath));
        if (old === null) throw new Error('archive file is corrupted');
        const merged = dedupeInbox(old.concat(cur));
        writeTextAtomic(donePath, JSON.stringify({ app: 'Film Library', type: 'inbox-archive', updatedAt: new Date().toISOString(), items: merged }, null, 2));
        writeTextAtomic(inboxPath, inboxPayload([]));
        return { archived: cur.length };
      });
      sendJson(res, 200, { ok: true, archived: r.archived });
      return;
    }
    if (pathname === '/api/inbox') {
      const dataDir = getDataDir();
      if (!dataDir) { sendErr(res, 409, 'data dir not configured'); return; }
      const inboxPath = path.join(dataDir, INBOX_FILE);
      if (req.method === 'GET') {
        if (fileTooLarge(inboxPath)) { sendErr(res, 500, 'inbox file is too large'); return; }
        const cur = parseInbox(readText(inboxPath));
        if (cur === null) { sendErr(res, 500, 'inbox file is corrupted'); return; }
        sendJson(res, 200, { ok: true, exists: fs.existsSync(inboxPath), items: cur });
        return;
      }
      if (req.method === 'POST') {
        const body = parseJsonBuf(await readBody(req, MAX_JSON_BODY));
        const incoming = Array.isArray(body) ? body : [body];
        const valid = incoming.filter(it => it && String(it.code || '').trim());
        if (!valid.length) { sendErr(res, 400, 'no item with code'); return; }
        const r = await withWriteLock(() => {
          /* v1.1.10 #1：损坏/超大的收件箱绝不能被「空数组」兜底。旧版
             `parseInbox(...) || []` 把「解析失败(null)」当「空」，于是 Spider
             POST 一条新来料就把整箱旧数据覆盖成 [新条目]——整箱丢失且回 200，
             与同文件 /api/inbox/import 的既有修复自相矛盾。
             现在：文件存在但读不动/解析不了 → 抛错回 500，一个字节都不写。 */
          let cur;
          if (fs.existsSync(inboxPath)) {
            if (fileTooLarge(inboxPath)) throw new Error('inbox file is too large');
            const t = readText(inboxPath);
            cur = parseInbox(t);
            if (cur === null) throw new Error('inbox file is corrupted');
          } else { cur = []; }
          const added = [], updated = [], skipped = [];
          valid.forEach(it => {
            const idx = cur.findIndex(x => x && x.code && padKey(x.code) === padKey(it.code));
            if (idx >= 0) {
              if (digitLen(cur[idx].code) > digitLen(it.code)) it.code = cur[idx].code;
              /* v1.1.3 分级覆盖：新来料层级低于存量（tier 数值更大）→ 保留存量（回执 skipped）；
                 同级或更高 → 替换（与旧行为一致） */
              if (tierOfItem(it) > tierOfItem(cur[idx])) { skipped.push(it.code); return; }
              cur[idx] = it; updated.push(it.code);
            } else { cur.push(it); added.push(it.code); }
          });
          writeTextAtomic(inboxPath, inboxPayload(dedupeInbox(cur)));
          return { added, updated, skipped };
        });
        sendJson(res, 200, { ok: true, added: r.added, updated: r.updated, skipped: r.skipped, total: (parseInbox(readText(inboxPath)) || []).length });
        return;
      }
    }

    /* ---- 待补全番号（爬虫批量队列来源） ---- */
    if (pathname === '/api/pending') {
      const dataDir = getDataDir();
      if (!dataDir) { sendErr(res, 409, 'data dir not configured'); return; }
      const p = path.join(dataDir, PENDING_FILE);
      if (req.method === 'GET') {
        const txt = readText(p);
        let codes = [];
        if (txt) { try { const j = JSON.parse(txt.replace(/^\uFEFF/, '')); codes = Array.isArray(j) ? j : (j.codes || []); } catch (e) {} }
        sendJson(res, 200, { ok: true, exists: txt != null, codes });
        return;
      }
      if (req.method === 'POST') {
        const body = parseJsonBuf(await readBody(req, 1024 * 1024));
        /* v1.1.5 BUG-21：畸形 body（非对象 / codes 非数组）旧版静默写成空队列并
           返回 200 —— 用户的待抓清单被无声清空。与 Python 端校验对齐。 */
        if (!body || typeof body !== 'object' || !Array.isArray(body.codes)) { sendErr(res, 400, 'codes must be an array'); return; }
        const codes = body.codes.map(String);
        await withWriteLock(() => {
          writeTextAtomic(p, JSON.stringify({ app: 'Film Library', type: 'pending', updatedAt: new Date().toISOString(), codes }, null, 2));
        });
        sendJson(res, 200, { ok: true, count: codes.length });
        return;
      }
    }

    /* ---- 视频目录列表（Video 页分组用；播放走 /video/ 的 Range） ---- */
    if (req.method === 'GET' && pathname === '/api/videos') {
      const vd = getVideoDir();
      if (!vd) { sendJson(res, 200, { ok: true, configured: false, files: [] }); return; }
      let names = [];
      try { names = fs.readdirSync(vd); } catch (e) { sendJson(res, 200, { ok: true, configured: true, error: String(e.message || e), files: [] }); return; }
      const files = names
        .filter(n => VIDEO_EXT.includes(path.extname(n).toLowerCase()))
        .map(n => { const st = fs.statSync(path.join(vd, n)); return { name: n, size: st.size, mtime: st.mtimeMs, url: '/video/' + encodeURIComponent(n) }; })
        /* v1.1.8 A-18：双端统一码点序。旧版 localeCompare（ICU 默认 locale）与
         Python 的 sorted 码点序不一致——'a.mp4' vs 'B.mp4'、'2.mp4' vs '10.mp4'
         两端顺序相反 → Video 页分组随主备端切换而变。 */
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      sendJson(res, 200, { ok: true, configured: true, dir: vd, files });
      return;
    }

    /* ---- 数据目录根级 json 文件名列表（补全资料：找爬虫失败清单） ---- */
    if (req.method === 'GET' && pathname === '/api/files') {
      const dataDir = getDataDir();
      if (!dataDir) { sendErr(res, 409, 'data dir not configured'); return; }
      const prefix = String(url.searchParams.get('prefix') || '');
      let names = [];
      try { names = fs.readdirSync(dataDir); } catch (e) { names = []; }
      const files = names
        .filter(n => /\.json$/i.test(n) && (!prefix || n.indexOf(prefix) === 0))
        .slice(0, 50);
      sendJson(res, 200, { ok: true, files });
      return;
    }

    /* ---- 元数据（演员资料 + 标签分组颜色；v2.1 服务端持久化） ---- */
    if (pathname === '/api/meta') {
      const dataDir = getDataDir();
      if (!dataDir) { sendErr(res, 409, 'data dir not configured'); return; }
      const p = path.join(dataDir, META_FILE);
      if (req.method === 'GET') {
        const txt = readText(p);
        let meta = null;
        if (txt != null) { try { meta = JSON.parse(txt.replace(/^\uFEFF/, '')); } catch (e) { sendErr(res, 500, 'meta.json is not valid JSON'); return; } }
        sendJson(res, 200, { ok: true, exists: txt != null, meta: meta || { actors: [], tagMeta: {} } });
        return;
      }
      if (req.method === 'POST') {
        const body = parseJsonBuf(await readBody(req, MAX_JSON_BODY));
        /* v1.1.4 BUG-03（P1）：与 Python 端校验对齐。旧逻辑静默降级——
           actors 非数组 → []、tagMeta 非对象 → {}，照写落盘，等于把 meta.json
           里的演员资料/标签配色整批清空（Python 端同期是 400 拒绝）。
           数据丢失必须报错，不能静默接受。 */
        const actors = (body && body.actors != null) ? body.actors : null;
        const tagMeta = (body && body.tagMeta != null) ? body.tagMeta : null;
        if (!Array.isArray(actors)) { sendErr(res, 400, 'actors must be an array'); return; }
        if (!tagMeta || typeof tagMeta !== 'object' || Array.isArray(tagMeta)) { sendErr(res, 400, 'tagMeta must be an object'); return; }
        if (actors.length > 5000 || Object.keys(tagMeta).length > 5000) { sendErr(res, 400, 'too many meta entries'); return; }
        const out = { app: 'Film Library', type: 'meta', updatedAt: new Date().toISOString(), actors: actors, tagMeta: tagMeta };
        await withWriteLock(() => { writeTextAtomic(p, JSON.stringify(out, null, 2)); });
        sendJson(res, 200, { ok: true, actors: actors.length });
        return;
      }
    }

    sendErr(res, 404, 'not found: ' + pathname);
  } catch (e) {
    const msg = String((e && e.message) || e);
    sendErr(res, msg === 'body too large' ? 413 : 500, msg);
  }
});

function countFilms(dataDir) {
  const txt = readText(path.join(dataDir, MAIN_FILE)) || readText(path.join(dataDir, MAIN_FILE_OLD));
  if (!txt) return 0;
  try { const p = JSON.parse(txt.replace(/^\uFEFF/, '')); return Array.isArray(p.rows) ? p.rows.length : 0; }
  catch (e) { return -1; }
}

/* ============================================================================
 * 启动：端口顺延 + 自动开浏览器（FL_NO_OPEN=1 可关）
 * ==========================================================================*/
function openBrowser(u) {
  if (process.env.FL_NO_OPEN) return;
  const cmd = process.platform === 'win32' ? 'start "" "' + u + '"'
    : process.platform === 'darwin' ? 'open "' + u + '"'
    : 'xdg-open "' + u + '"';
  exec(cmd, () => {});
}
function listen() {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      const s = server.listen(port, '127.0.0.1', () => resolve({ server: s, port }));
      /* v1.1.8 A-20：与 Python 备端对齐的闲置连接超时（120s）。默认 0 = 永不
         到期——被挂住的连接会把句柄/线程囤积；到期无默认监听时 Node 行为不定，
         显式销毁。 */
      s.timeout = 120000;
      s.on('timeout', sock => { try { sock.destroy(); } catch (e) {} });
      s.on('error', e => {
        if (e && e.code === 'EADDRINUSE' && port < PORT_LAST) tryPort(port + 1);
        else reject(e);
      });
    };
    tryPort(PORT_FIRST);
  });
}
listen().then(({ port }) => {
  const u = 'http://127.0.0.1:' + port + '/';
  console.log('[FL Server] v' + VERSION + ' (node) listening on ' + u);
  console.log('[FL Server] data dir: ' + (getDataDir() || '(not configured - set it in the page)'));
  openBrowser(u);
}).catch(e => {
  console.error('[FL Server] failed to start: ' + String((e && e.message) || e));
  process.exit(1);
});
