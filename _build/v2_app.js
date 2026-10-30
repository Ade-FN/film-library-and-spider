/* ============================================================================
 * Film Library 应用主体（IIFE，零依赖）
 * 架构说明见文件头注释。本节只列关键决策：
 *   · 所有 IO 走 API（FL Server）；本文件不碰 File System Access
 *   · 虚拟滚动：卡片/表格共用一套 viewport 计算，卡片尺寸在 CSS 里取整固定
 *   · 搜索语法引擎 / 番号归一化自 v1 原样搬运（17/17 回归的行为基线），
 *     仅按 v2.0.0 决策移除 rating（评分）相关分支
 * ==========================================================================*/
(function () {
  'use strict';

  /* ==========================================================================
   * §0 常量与状态
   * ======================================================================== */
  var APP_VERSION = '2.1.40';
  var STATUS = ['未看', '想看', '已看'];
  var LS = {
    tab: 'wb_film_v2_tab', view: 'wb_film_v2_view', compact: 'wb_film_v2_compact',
    lastBackup: 'wb_film_v2_lastbackup',
    actors: 'wb_film_v2_actors', tagMeta: 'wb_film_v2_tagmeta', sites: 'wb_film_v2_sites',
    autoInbox: 'wb_film_v2_autoinbox'      // v2.1.30：收件箱自动导入开关（'0'=关，缺省开）
  };
  /* 卡片尺寸（两栏版 v2.1.6；v2.1.8 起卡宽动态铺满；v2.1.9 起封面随卡宽等比缩放）
     · k      ：封面宽 / 卡宽 的比例（取自标准设计 100/340、紧凑 72/272）
     · cvMax  ：封面宽上限，防止超宽屏把卡片撑得过高
     · h      ：仅作初始值与兜底，实际高度由 geom() 按封面高度 (cvW×1.5) 现算，
                行高 rowH 同步走动态值——虚拟滚动靠它算，写死就会错位。 */
  /* v2.1.38：封面 30%(100/340) -> 40%，卡片随之变高（h = cvW * 1.5，封面恒定 2:3）。
     h 必须与 k 对齐：340*0.4=136 -> 136*1.5=204；紧凑 272*0.32=87 -> 87*1.5=131。
     改 k 不改 h 会让 VS.rowH 初值与实测值不符（首屏错位一行的高度）。 */
  var CARD = { w: 290, h: 152, gap: 12, pad: 12, minW: 240, k: 0.5, cvMax: 240 };
  var CARD_C = { w: 240, h: 116, gap: 8, pad: 8, minW: 190, k: 0.5, cvMax: 160 };
  var ROW_H = 34;
  /* v2.1.29 A-11：表格 sticky 表头高度。滚动总量必须算上它——旧版 spacer 只按
     行数×ROW_H 估，末行永远差一截滚不到（实测 thead≈37px）。render 先用此默认值，
     paint 里用 offsetHeight 实测值校正。 */
  var THEAD_H = 35;                       // 表格行高（与 CSS .vs-table td 对齐）

  var state = {
    configured: false, dataDir: '', videoDir: '',
    rows: [], rowsVersion: 0,
    filter: { text: '', scope: 'all', status: '', tag: '', actor: '', miss: [], regex: false, sort: 'recent' },
    sel: {},                            // id -> true
    view: 'card', compact: false,
    editing: null,                      // 正在编辑的行 id（null = 新增）
    pendingImages: { cover: null, shots: [] },
    inboxItems: [],
    viewer: { list: [], at: 0 },
    noteFor: null,
    dirty: false, saveTimer: 0,
    /* ---- Phase 1b：Actor / Tag / Video / FANZA / 补全资料 ---- */
    actors: [], tagMeta: {},            // 服务端 meta.json + localStorage 双写
    actorMode: 'overview', actorId: null, pendingAvatar: null,
    videoFiles: [], videoDim: 'status', videoGroup: '', videoCode: ''
  };

  function $(s, el) { return (el || document).querySelector(s); }
  function $all(s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function uid() { return 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  /* v2.1.29 A-13：localStorage 写入失败（配额超限/隐私模式）不再静默——
     演员/标签/偏好全走这里，本地兜底丢了用户可能完全不知情。节流 10s 一次；
     toast 自身依赖 #toast 元素，异常时不能再往上抛（lsSet 的调用方无处接）。 */
  var _lsWarnAt = 0;
  function lsSet(k, v) {
    try { localStorage.setItem(k, v); }
    catch (e) {
      if (Date.now() - _lsWarnAt > 10000) {
        _lsWarnAt = Date.now();
        try { toast('本地暂存写入失败（浏览器存储空间已满或处于隐私模式），资料仅保存在服务端', 'err'); } catch (e2) {}
      }
    }
  }
  function toast(msg, type) {
    var box = $('#toast');
    var d = document.createElement('div');
    d.className = 'toast-item' + (type ? ' ' + type : '');
    d.textContent = msg;
    box.appendChild(d);
    setTimeout(function () { d.style.opacity = '0'; d.style.transition = '.3s'; }, 2400);
    setTimeout(function () { d.remove(); }, 2800);
  }

  /* ==========================================================================
   * §1 api 层（FL Server）
   * --------------------------------------------------------------------------
   * file:// 直开模式（用户双击 html）下页面没有 HTTP 源，fetch('/api/...') 会
   * 解析成 file:///api/... 直接 TypeError "Failed to fetch"——apiUrl() 统一
   * 补全为服务端源（CORS 已全开，null 源可过）。http:// 模式（服务端托管页面，
   * 含测试）保持相对 URL：同源即可，且服务端端口遇 EADDRINUSE 会自动顺延，
   * 在 http 模式写死端口反而连错实例。
   * ======================================================================== */
  var SERVER_ORIGIN = 'http://127.0.0.1:8787';
  function apiUrl(p) {
    p = String(p == null ? '' : p);
    if (!p) return p;
    if (/^(https?:|data:|blob:|about:)/i.test(p)) return p;
    if (location.protocol !== 'file:') return p;
    return SERVER_ORIGIN + (p.charAt(0) === '/' ? p : '/' + p);
  }
  /* 响应体不是 JSON 时的自诊断：打到静态服务（如聊天窗口里的网页预览）或
     错误页时会拿到 HTML，裸 r.json() 只会抛 "Unexpected token '<'"，用户
     看不懂——换成带页面源、HTTP 状态和处置指引的明确提示 */
  function rj(r, url) {
    var ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct.indexOf('json') < 0) {
      return r.text().then(function (t) {
        var head = String(t == null ? '' : t).slice(0, 24).replace(/\s+/g, ' ').trim();
        throw new Error('FL Server 返回了网页而不是数据（页面源 ' + (location.host || '本地文件') +
          '，HTTP ' + r.status + (head ? ('，开头「' + head + '」') : '') +
          '）——请先刷新页面；若仍失败，请确认由「启动 Film Library.cmd」打开，且地址栏端口与黑窗口 listening on 行的端口一致（勿用聊天窗口内的网页预览）');
      });
    }
    return r.json().then(function (x) {
      if (!r.ok) throw new Error(x && x.error ? x.error : ('HTTP ' + r.status));
      return x;
    });
  }
  function j(url, opts, keepalive) {
    /* v2.1.29 A-13：keepalive 供 pagehide 卸载期请求用（普通 fetch 会被取消） */
    var o = opts || {};
    if (keepalive) o.keepalive = true;
    return fetch(apiUrl(url), o).then(function (r) {
      return rj(r, url);
    }).catch(function (e) {
      /* fetch 网络层失败恒为 TypeError("Failed to fetch")——裸消息用户看不懂，
         换成带处置指引的话（HTTP 业务错误是 Error，原样透传） */
      if (e && e.name === 'TypeError' && /fetch|network|load failed/i.test(String(e.message || ''))) {
        throw new Error('无法连接 FL Server（' + SERVER_ORIGIN + '）——请确认「启动 Film Library.cmd」正在运行，然后刷新本页');
      }
      throw e;
    });
  }
  var API = {
    status: function () { return j('/api/status'); },
    data: function () { return j('/api/data'); },
    save: function (payload, keepalive) { return j('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload: payload }) }, keepalive); },
    config: function (dataDir, videoDir) { return j('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataDir: dataDir, videoDir: videoDir || '' }) }); },
    upload: function (kind, name, buf) {
      /* v2.1.29 A-14：改走 j()——旧版裸 fetch 绕过了友好错误映射，服务端没起时
         用户看到裸英文 "Failed to fetch"，看不懂也无从下手。 */
      return j('/api/upload?kind=' + encodeURIComponent(kind) + '&name=' + encodeURIComponent(name), { method: 'POST', body: buf });
    },
    backup: function (name, payload) { return j('/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, payload: payload }) }); },
    inbox: function () { return j('/api/inbox'); },
    inboxPost: function (items) { return j('/api/inbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(items) }); },
    inboxImport: function () { return j('/api/inbox/import', { method: 'POST' }); },
    pendingPost: function (codes) { return j('/api/pending', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codes: codes }) }); },
    videos: function () { return j('/api/videos'); },
    files: function (prefix) { return j('/api/files' + (prefix ? ('?prefix=' + encodeURIComponent(prefix)) : '')); },
    metaGet: function () { return j('/api/meta'); },
    metaPost: function (actors, tagMeta, keepalive) { return j('/api/meta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actors: actors, tagMeta: tagMeta }) }, keepalive); }
  };

  /* ==========================================================================
   * §2 数据层（归一化 / 存取 / 备份）
   * ======================================================================== */
  function normCode(v) {
    var s = String(v == null ? '' : v).trim().toUpperCase().replace(/[^A-Z0-9\-]/g, '');
    s = s.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
    var m = /^([A-Z]+)-?(\d+)$/.exec(s);
    if (m) s = m[1] + '-' + m[2];
    return s;
  }
  function fromFanzaCode(v) {
    var s = String(v == null ? '' : v).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    var m = /^([A-Z]+?)(\d{1,6})$/.exec(s);
    if (m && m[2] !== '0') {
      var digits = m[2];
      var num = (digits.length >= 4 && digits.charAt(0) === '0') ? String(parseInt(digits, 10)) : digits;
      return m[1] + '-' + num;
    }
    return normCode(v);
  }
  var fromJavdbCode = fromFanzaCode;   // 旧名兼容（收件箱来料可能是 javdb 形态）
  /* 番号「00 → -」自动纠正：DSOD00009 → DSOD-009（厂商真实三位编号，不是 DSOD-9）。
     幂等：已带横线的不再处理。与旧版 normalizeRow 行为一致。 */
  function fixCode00(v) {
    var raw = String(v == null ? '' : v).trim();
    var s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    var m = /^([A-Z]{3,6})00(\d{3,6})$/.exec(s);
    if (!m) return raw;
    return m[1] + '-' + m[2];
  }
  /* 库内 ABP-123 → FANZA 写法 ABP00123（去短横线，数字左补 0 到 5 位） */
  function fanzaCodeOf(code) {
    var s = normCode(code);
    var m = /^([A-Z]+)-(\d+)$/.exec(s);
    if (!m) return s.replace(/-/g, '');
    return m[1] + (m[2].length >= 5 ? m[2] : ('00000' + m[2]).slice(-5));
  }
  /* MGS 形态互转：300MIUM-451 ↔ MIUM-451 */
  function mgsCodeConvert(code) {
    var s = String(code || '').trim().toUpperCase();
    var m = /^(\d{2,4})([A-Za-z]{3,6})(-)(\d{2,4})$/.exec(s);
    if (m) return m[2] + '-' + m[4];
    return s;
  }
  /* 从视频文件名提取番号：FC2 → MGS → 常规(RegExp-FANZA)，匹配不到返回空串 */
  function codeFromFilename(name) {
    var t = String(name || ''), m;
    if ((m = /FC2[- ]PPV[- ]\d{3,10}/i.exec(t))) return m[0].toUpperCase().replace(/ /g, '-');
    if ((m = /\d{2,4}[A-Za-z]{3,6}[- ]\d{2,4}/.exec(t))) return m[0].replace(/ /g, '-');
    if ((m = /[A-Za-z]{3,6}(?:-|00)\d{3,6}(?:-U)?(?:-C)?(?:-E)?(?:-\d)?|\d{2,4}[A-Za-z]{3,6}-?\d{2,5}/.exec(t))) return m[0];
    return '';
  }
  /* 影片里出现过的演员名列表（actorF/actorM/actor 拆分） */
  function statsActorNames(r) {
    var out = [], seen = {};
    [r.actorF, r.actorM, r.actor].forEach(function (s) {
      String(s || '').split(/[,，、\/|]/).forEach(function (n) {
        n = String(n || '').trim();
        /* 按行去重：actor 与 actorF/actorM 同值时只计一次（r3 回归发现，v2.1.3 修） */
        if (n && !seen[n]) { seen[n] = 1; out.push(n); }
      });
    });
    return out;
  }
  /* 零填充归一化键：DSOD-009 与 DSOD-9 视为同一部 */
  function codeDedupeKey(c) {
    var s = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    var m = /^([A-Z]+)(\d+)$/.exec(s);
    if (!m) return s;
    return m[1] + parseInt(m[2], 10);
  }
  /* 磁力统一为字符串数组（≤3）；兼容旧的字符串 / 换行分隔形态 */
  function normMagnets(v) {
    var arr = Array.isArray(v) ? v : String(v == null ? '' : v)
      /* v2.1.20：磁力链内部可能含逗号（dn 显示名未百分号编码），旧版
         "见逗号就切" 会把一条链拦腰截成两条残链。新分隔规则：
         ① 换行 / 分号一律是分隔符；
         ② 逗号仅当"后面紧接 magnet:"时才算分隔（手写 "链1,链2" 旧形态）；
         ③ 段内不含 magnet: 前缀时仍按逗号细分（非链接文本的兼容）。 */
      .split(/[\n;；]+|[,，](?=\s*magnet:)/i)
      .reduce(function (acc, seg) {
        if (seg.indexOf('magnet:') >= 0 || seg.indexOf(',') < 0) acc.push(seg);
        else acc.push.apply(acc, seg.split(/[,，]+/));
        return acc;
      }, []);
    return arr.map(function (s) { return String(s == null ? '' : s).trim(); })
      .filter(Boolean).slice(0, 3);
  }
  /* 图片对象白名单：{name, path}；src 由服务端 URL 现算，不落盘 */
  function normImg(x) {
    if (!x) return null;
    var p = String(x.path || '');
    return { name: String(x.name || ''), path: p };
  }
  function imgSrc(img) {
    if (!img) return '';
    if (img.src && /^(https?:|data:)/.test(img.src)) return img.src;
    return img.path ? apiUrl('/data/' + img.path.split('/').map(encodeURIComponent).join('/')) : '';
  }
  /* ==========================================================================
   * 来源分级（v2.1.21，用户三项决策：① 一级覆盖二级 ② 字段级非空覆盖 ③ srcTier 溯源）
   *   一级 = FANZA/MGS/FC2（官方卖家，字段权威）；二级 = JAVDB/MISSAV/MOTV（聚合站）；
   *   0 = 未知/用户自建（无 platform 且无 srcTier）——只填空，永不覆盖。
   *   与 Spider tierOfItem / server.js+server.py tierOfItem 同口径（1=一级 2=二级）。
   *   FC2 番号的一级认定由 Spider 侧 srcTier 章负责（无论从哪个站抓到都盖 1）。
   * ======================================================================== */
  var TIER1_PLATFORMS = ['FANZA', 'MGS', 'FC2'];
  function tierOfPlatform(p) {
    if (!p) return 0;
    return TIER1_PLATFORMS.indexOf(String(p).toUpperCase()) >= 0 ? 1 : 2;
  }
  /* 来料层级：Spider 盖的 srcTier 章优先；旧来料（无章）按 platform 推断 */
  function tierOfItem(it) {
    if (it && it.srcTier) return +it.srcTier || 0;
    return tierOfPlatform(it && it.platform);
  }
  /* 行层级：srcTier 优先；老行（v2.1.21 前落盘，无此字段）按 platform 推断 */
  function tierOfRow(r) {
    if (r.srcTier) return +r.srcTier || 0;
    return tierOfPlatform(r.platform);
  }
  /* 字段补齐后重算印章：无章且有 platform 时补推断值，保持落盘值与 tierOfRow
     的运行时口径一致（否则 CSV/XLSX 导出会把 JAVDB 行导出成「未知」） */
  function restampSrcTier(row) {
    if (!row.srcTier && row.platform) row.srcTier = tierOfPlatform(row.platform);
  }
  function normalizeRow(r) {
    r = r || {};
    var magnets = normMagnets(r.magnet);
    return {
      id: r.id || uid(),
      code: normCode(fixCode00(r.code)),
      title: String(r.title || ''),
      titleCn: String(r.titleCn || ''),
      actor: String(r.actor || ''),
      actorF: String(r.actorF || ''), actorM: String(r.actorM || ''),
      status: STATUS.indexOf(r.status) >= 0 ? r.status : '未看',
      tags: splitList(r.tags),
      note: String(r.note || ''),
      magnet: magnets,
      downloaded: !!r.downloaded, saved: !!r.saved,
      series: String(r.series || ''), director: String(r.director || ''),
      platform: String(r.platform || ''),
      /* v2.1.21：来源层级溯源。缺省按 platform 推断（tierOfPlatform）——
         老行无 srcTier 也能参与分级覆盖判定；显式 srcTier（数字或字符串）优先 */
      srcTier: r.srcTier > 0 ? (+r.srcTier || 0) : tierOfPlatform(r.platform),
      /* v2.1.16：日期单字段化（Spider v1.3.40 十字段体系），原样保留页面文本；
         旧库迁移：releaseSale/releaseStream 二合一（发售优先），只认一次 */
      release: String(r.release || r.releaseSale || r.releaseStream || ''),
      maker: String(r.maker || ''),
      cover: normImg(r.cover),
      shots: (Array.isArray(r.shots) ? r.shots : []).map(normImg).filter(Boolean),
      ts: r.ts || Date.now(), updated: r.updated || 0
    };
  }
  /* 落盘形态：与旧版 stripImgSrc 一致（cover/shots 只留 name+path），rating 不再写 */
  function stripRow(r) {
    return {
      id: r.id, code: r.code, title: r.title, titleCn: r.titleCn,
      release: r.release, maker: r.maker,
      actor: r.actor, status: r.status,
      tags: r.tags, note: r.note, magnet: r.magnet, saved: r.saved,
      downloaded: !!r.downloaded, ts: r.ts, updated: r.updated || 0,
      series: r.series, director: r.director, platform: r.platform,
      srcTier: r.srcTier || 0,
      actorF: r.actorF, actorM: r.actorM,
      cover: r.cover ? { name: r.cover.name, path: r.cover.path } : null,
      shots: r.shots.map(function (s) { return { name: s.name, path: s.path }; })
    };
  }
  function payloadOf() {
    return { app: 'Film Library', version: 3, updatedAt: new Date().toISOString(), rows: state.rows.map(stripRow) };
  }
  function rowByCode(code) {
    var k = codeDedupeKey(code), hit = null;
    state.rows.forEach(function (r) { if (!hit && codeDedupeKey(r.code) === k) hit = r; });
    return hit;
  }
  function findRow(id) {
    for (var i = 0; i < state.rows.length; i++) if (state.rows[i].id === id) return state.rows[i];
    return null;
  }
  function commit() {           // 改数据后：标记脏 → 防抖保存 → 全量刷新
    state.dirty = true;
    state.rowsVersion++;
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveData, 600);
    refreshAll();
  }
  function saveData(silent, keepalive) {
    clearTimeout(state.saveTimer);
    if (!state.configured) return Promise.resolve(false);
    var p = payloadOf();
    return API.save(p, keepalive).then(function () {
      state.dirty = false;
      if (!silent) toast('已保存 ' + p.rows.length + ' 条到 ' + baseName(state.dataDir), 'ok');
      return true;
    }).catch(function (e) {
      toast('保存失败：' + ((e && e.message) || e), 'err');
      return false;
    });
  }
  function baseName(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p; }

  /* ---- 加载 ---- */
  function loadData() {
    return API.status().then(function (st) {
      state.configured = !!st.configured;
      state.dataDir = st.dataDir || '';
      renderDirBar(st);
      if (!st.configured) { openSetup(); return null; }
      return API.data().then(function (d) {
        state.rows = (d.payload.rows || []).map(normalizeRow);
        state.rowsVersion++;
        if (d.file === '影片档案馆.json') toast('读到旧命名文件，保存后将改用 Film Library.json', 'warn');
        dailyAutoBackup();
        return d;
      });
    });
  }
  function renderDirBar(st) {
    var bar = $('#dirBar');
    if (state.configured) {
      bar.classList.add('on');
      $('#dirPath').innerHTML = '数据目录：<b>' + escapeHtml(baseName(state.dataDir)) + '</b>';
      var c = st.counts || {};
      $('#dirCounts').textContent = c.films >= 0 ? (c.films + ' 条' + (c.inbox ? ' · 收件箱 ' + c.inbox : '')) : '';
    } else {
      bar.classList.remove('on');
      $('#dirPath').textContent = '未连接数据目录';
      $('#dirCounts').textContent = '';
    }
  }
  /* ---- 自动备份：每天一次（幂等） ---- */
  /* v2.1.30：stamp() 精确到秒。旧版只到天——pre-import / pre-zipimport / 手动
     备份与各种导出文件名在一天内第二次就互相覆盖（A-04 同款问题：Spider 侧
     已修，FL 侧漏了）。表现：一天内导入两次，「导入前自动备份」只剩当天最后
     一份，回滚保护名存实亡；导出同日重名也只能靠浏览器加 (1) 后缀区分。
     每日自动备份的幂等键改用 dateOnly()——只比日期，不因加了时刻就每天
     备份多次（localStorage lastBackup 语义不变）。 */
  function stamp() {
    var d = new Date(), p = function (n) { return ('0' + n).slice(-2); };
    return dateOnly(d) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function dateOnly(d) {
    d = d || new Date();
    var p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }
  function dailyAutoBackup() {
    var today = dateOnly();   /* v2.1.30：幂等键只比日期（stamp 已精确到秒） */
    if (lsGet(LS.lastBackup) === today) return;
    API.backup('Film Library ' + today + '.json', payloadOf()).then(function () {
      lsSet(LS.lastBackup, today);
    }).catch(function () {});
  }

  /* ---- 元数据（演员资料 + 标签分组颜色）：服务端 meta.json 为主，localStorage 兜底 ---- */
  var metaTimer = 0;
  var _metaWarnAt = 0;
  function loadMeta() {
    if (!state.configured) return Promise.resolve();
    return API.metaGet().then(function (d) {
      var m = d.meta || {};
      if (d.exists && (Array.isArray(m.actors) && m.actors.length || m.tagMeta && Object.keys(m.tagMeta).length)) {
        state.actors = m.actors || [];
        state.tagMeta = m.tagMeta || {};
      } else {
        /* 服务端没有 → 用浏览器里可能存在的旧数据（老用户迁移），下次保存自动上服 */
        try { state.actors = JSON.parse(lsGet(LS.actors, '[]')) || []; } catch (e) { state.actors = []; }
        try { state.tagMeta = JSON.parse(lsGet(LS.tagMeta, '{}')) || {}; } catch (e) { state.tagMeta = {}; }
      }
      renderTabCounts();
    }).catch(function () {});
  }
  function saveMeta(immediate) {
    lsSet(LS.actors, JSON.stringify(state.actors));
    lsSet(LS.tagMeta, JSON.stringify(state.tagMeta));
    if (!state.configured) return;
    clearTimeout(metaTimer);
    var push = function () {
      API.metaPost(state.actors, state.tagMeta).catch(function () {
        /* v2.1.29 A-13：上服失败不再完全静默——localStorage 已有兜底，但服务端
           同步失败（如重启中）用户应知道。节流 10s 一次，不刷屏。 */
        if (Date.now() - _metaWarnAt > 10000) {
          _metaWarnAt = Date.now();
          try { toast('演员/标签资料同步到服务端失败，已暂存本地（下次保存会自动重试）', 'err'); } catch (e) {}
        }
      });
    };
    if (immediate) push(); else metaTimer = setTimeout(push, 800);
  }
  /* v2.1.29 A-13：pagehide 时把防抖窗内待发的 meta 立刻推服——tagSetColor/
     演员编辑都走 800ms 防抖路径，窗口内关页面会整段丢失。keepalive 让请求
     活过页面卸载（Chrome/Edge/Firefox 均支持）。 */
  function flushMeta() {
    if (!metaTimer) return;
    clearTimeout(metaTimer);
    metaTimer = 0;
    if (!state.configured) return;
    API.metaPost(state.actors, state.tagMeta, true).catch(function () {});
  }
  /* 资料来源 URL 模板：{code} 替换；xf=fanza 时转 FANZA 五位写法 */
  function siteUrlOf(s, code) {
    var c = normCode(code);
    if (s && s.xf === 'fanza') c = fanzaCodeOf(c);
    return String(s.url || '').replace('{code}', encodeURIComponent(c));
  }

  /* ---- 图片上传 ---- */
  function dataUrlToBlob(url) {
    var m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(String(url || ''));
    if (!m) return null;
    /* v2.1.36 #9：atob 对非法 base64（含换行/空白、URL 编码残留、以及旧形态
       来料把 http URL 当成裸 base64 送来）会抛 InvalidCharacterError，异常穿
       forEach 冒泡到 Promise.all → 一条脏来料就中断整批（几十条）导入。
       单条坏数据应该被跳过并计数，而不是拖垮整批。 */
    var bin;
    try { bin = atob(m[3]); } catch (e) { return null; }
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: m[1] || 'image/jpeg' });
  }
  function coverNameOf(code) { return code + '.jpg'; }
  function shotNameOf(code, i) { return code + '_' + String(i + 1).padStart(2, '0') + '.jpg'; }
  function thumbNameOf(code) { return code + '@360.jpg'; }
  /* canvas 缩放到 ≤360 宽，返回 Blob */
  function makeThumb(blob) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        var w = Math.min(360, img.naturalWidth || 360);
        var h = Math.round(img.naturalHeight * (w / (img.naturalWidth || w)));
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { resolve(b || blob); }, 'image/jpeg', 0.82);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(blob); };
      img.src = url;
    });
  }
  /* 把 pendingImages 里「本次新选」的图（blob 非空）上传到服务端，返回 {cover, shots}
     v2.1.17 修（用户实测「图片上传失败：empty body」）：编辑已有影片时 openForm 会把
     现有封面/截图填进 pendingImages 做回显，blob=null。旧代码无条件对这些旧图也发
     API.upload(..., null) → fetch 空体 POST → 服务端 400 empty body → 整个保存链断，
     连文本字段都存不进。现在只传新选的图；out.shots 按下标回填（跳过项留空洞），
     供 submitForm 与预览列表逐位对齐。 */
  function uploadPendingImages(code) {
    var pi = state.pendingImages, jobs = [];
    var out = { cover: null, shots: [] };
    if (pi.cover && pi.cover.blob) {
      jobs.push(API.upload('covers', coverNameOf(code), pi.cover.blob).then(function (r) {
        out.cover = { name: coverNameOf(code), path: r.path };
        return makeThumb(pi.cover.blob).then(function (tb) {
          return API.upload('thumb', thumbNameOf(code), tb);
        });
      }));
    }
    pi.shots.forEach(function (s, i) {
      if (!s.blob) return;                     /* 旧图回显（blob=null）：不重传 */
      /* 防重名：删掉中间某张再添新图时，按序号命名会撞上「保留旧图」的文件名
         （旧图 path 没变，新图会把它的文件覆盖掉）→ 顺延到第一个没用过的名字 */
      var used = {};
      pi.shots.forEach(function (x, j) {
        if (j !== i && x.path) used[baseOf(x.path)] = 1;
      });
      var k = i, nm = shotNameOf(code, k);
      while (used[nm]) { k++; nm = shotNameOf(code, k); }
      jobs.push(API.upload('shots', nm, s.blob).then(function (r) {
        out.shots[i] = { name: nm, path: r.path };
      }));
    });
    return Promise.all(jobs).then(function () { return out; });
  }

  /* ==========================================================================
   * §3 搜索语法引擎 + 过滤排序（自 v1 搬运，rating 分支已按 v2.0.0 决策移除）
   * ======================================================================== */
  /* @@CARRY:search-engine@@ */

  /* ==========================================================================
   * §4 筛选控件 / 预设
   * ======================================================================== */
  function renderStatusChips() {
    $all('#statusChips .chip').forEach(function (b) {
      b.classList.toggle('on', (b.getAttribute('data-status') || '') === (state.filter.status || ''));
    });
  }
  function renderActorFilter() {
    var names = {}, out = [];
    state.rows.forEach(function (r) {
      splitList([r.actor, r.actorF, r.actorM].join(',')).forEach(function (a) {
        if (!names[a]) { names[a] = 1; out.push(a); }
      });
    });
    out.sort();
    var sel = $('#actorFilter'), cur = state.filter.actor;
    sel.innerHTML = '<option value="">全部演员</option>' + out.map(function (a) {
      return '<option value="' + escapeHtml(a) + '"' + (a === cur ? ' selected' : '') + '>' + escapeHtml(a) + '</option>';
    }).join('');
  }
  function renderTagFilter() {
    var sel = $('#tagFilter'), cur = state.filter.tag;
    var tags = getAllTags();
    /* v2.1.28 BUG-27（P3）：当前过滤的标签若已不在库里（条目删了/改了标签），
       旧版下拉里根本没有它 → 显示回落到「全部标签」，但 state.filter.tag 仍生效，
       用户看到「全部」却只有部分数据，过滤来源完全不可见。补一个可见的幽灵项。 */
    var ghost = '';
    if (cur && tags.indexOf(cur) < 0) {
      ghost = '<option value="' + escapeHtml(cur) + '" selected>' + escapeHtml(cur) + '（无匹配）</option>';
    }
    sel.innerHTML = '<option value="">全部标签</option>' + ghost + tags.map(function (t) {
      return '<option value="' + escapeHtml(t) + '"' + (!ghost && t === cur ? ' selected' : '') + '>' + escapeHtml(t) + '</option>';
    }).join('');
  }
  /* @@PART:tag@@ */
  /* ==========================================================================
   * §5 虚拟滚动渲染（卡片 / 表格共用）
   * ======================================================================== */
  var VS = {
    start: -1, end: -1, cols: 1, rowH: CARD.h + CARD.gap, pad: CARD.pad, theadH: 0,
    geom: function () {
      var g = state.compact ? CARD_C : CARD;
      /* v2.1.19：停在其他 tab 时 #pageHome 隐藏 → #vsViewport.clientWidth=0。
         此时 avail 为负 → 卡宽/封面宽/行高全算成负数 → render 把负值写进
         --card-w/--cv-w/spacer 高，paint 再 translateY(负值) 把卡片拽出视口，
         切回主页一片错乱（且不触发任何报错，极难定位）。隐藏即返回 null。 */
      var vpEl = $('#vsViewport');
      if (vpEl.clientWidth === 0 || vpEl.clientHeight === 0) return null;
      var vw = vpEl.clientWidth - 2;             // 去掉边框
      var avail = vw - g.pad * 2;                     // 内容区实际可用宽
      /* v2.1.37 #27：avail 可能 <= 0（视口被拖到极窄 / 分屏 / 系统缩放，
         clientWidth > 0 却容不下左右 padding）。旧版只守了 clientWidth===0，
         此时 cols 被兜成 1 而 w 仍为负 → --card-w/--card-h 负值、rowH<=0，
         paint 的守卫直接 return，卡片区彻底画不出来。几何不可用即返回 null。 */
      if (!(avail > 0)) return null;
      /* v2.1.38：目标列数 3 -> 4（对齐设计稿的「4 列卡片网格」）。
         为什么必须同时改列数：封面提到 40% 后卡高 = 卡宽 × 0.4 × 1.5，
         卡宽越大卡片越高——3 列时卡宽 390 → 卡高 234px，一屏只剩约 6 张。
         改 4 列后卡宽 286 → 卡高 171px（≈ 设计稿的 176px），一屏约 10 张。
         卡宽一律由「可用宽 - 列间距」均分得到，不封顶 → 任何宽度下都填满、左右不留白。
         封面 2:3 恒定（宽 = 卡宽 × k，上限 cvMax；高 = 宽 × 1.5）。 */
      var cols = 4;
      if (Math.floor((avail - 3 * g.gap) / 4) < g.minW) {
        /* 兜底必须按 minW 反推列数：旧版按 g.w(340) 反推，窄屏时会从 4 列
           直接跳到 2 列（中间空一档），按 minW 才是逐档递减。 */
        cols = Math.max(1, Math.min(4, Math.floor((avail + g.gap) / (g.minW + g.gap))));
      }
      var w = Math.max(g.minW, Math.floor((avail - (cols - 1) * g.gap) / cols));
      /* 封面随卡宽等比缩放（2:3 恒定）：宽 = 卡宽 × k（上限 cvMax），高 = 宽 × 1.5 */
      var cvW = Math.min(Math.round(w * g.k), g.cvMax);
      /* v2.1.39：卡片内部改 5:5 分栏后，卡高不再由封面的 2:3 反推——
         那样卡宽一大卡片就失控变高（390 宽 → 234 高）。高度改由 CARD.h 直接下发，
         封面区 = 卡宽×k 宽 × 卡高 满高，图片 object-fit:cover 自适应。 */
      var h = g.h;
      return { cols: cols, w: w, cvW: cvW, h: h, rowH: h + g.gap, pad: g.pad };
    },
    render: function () {
      var rows = getFiltered();
      var vp = $('#vsViewport'), sp = $('#vsSpacer'), ct = $('#vsContent');
      $('#emptyTip').hidden = rows.length > 0;
      $('#tabCountHome').textContent = String(state.rows.length);
      /* v2.1.38：大标题下的等宽统计行。放在 geom() 守卫之前——视口隐藏时
         也要更新，否则切回主页会看到上一页的旧数字。 */
      var sShown = $('#statShown'), sAll = $('#statAll'), sShots = $('#statShots');
      if (sShown) sShown.textContent = String(rows.length);
      if (sAll) sAll.textContent = String(state.rows.length);
      if (sShots) {
        var shotsN = 0;
        for (var si = 0; si < rows.length; si++) shotsN += (rows[si].shots || []).length;
        sShots.textContent = String(shotsN);
      }
      if (state.view === 'table') {
        var g2 = { cols: 1, rowH: ROW_H, pad: 0 };
        VS.cols = 1; VS.rowH = ROW_H; VS.pad = 0;
        sp.style.height = (rows.length * ROW_H + (VS.theadH || THEAD_H) + 2) + 'px';
        ct.className = 'vs-content';
        ct.style.gridTemplateColumns = '';
        ct.style.justifyContent = '';
      } else {
        var g = VS.geom();
        /* v2.1.19：geom 返回 null = 视口隐藏中。直接 return 不动任何布局属性
           （表格视图不依赖几何，无需守卫）；切回主页由 bindTabs 补 VS.render()。 */
        if (!g) return;
        VS.cols = g.cols; VS.rowH = g.rowH; VS.pad = g.pad;
        var rowCount = Math.ceil(rows.length / g.cols);
        sp.style.height = (rowCount * g.rowH + g.pad * 2) + 'px';
        ct.style.setProperty('--card-w', g.w + 'px');   /* 卡宽动态：一行 3 张铺满 */
        ct.style.setProperty('--card-h', g.h + 'px');   /* 卡高 = 封面高（2:3 等比） */
        ct.style.setProperty('--cv-w', g.cvW + 'px');   /* 封面宽随卡宽等比缩放 */
        ct.className = 'vs-content vs-cards' + (state.compact ? ' compact' : '');
        ct.style.gridTemplateColumns = 'repeat(' + g.cols + ', ' + g.w + 'px)';
        ct.style.justifyContent = 'center';
      }
      VS.paint(rows, true);
    },
    paint: function (rows, force) {
      var vp = $('#vsViewport'), ct = $('#vsContent');
      /* v2.1.19：行高未就绪（从未成功渲染 / 刚过隐藏期）时不画。
         rowH<=0 时 first/visibleRows 全是垃圾值，translateY 负值把卡片拽出视口。 */
      if (!VS.rowH || VS.rowH <= 0) return;
      var scrollTop = vp.scrollTop;
      var viewH = vp.clientHeight;
      var first = Math.floor((scrollTop - VS.pad) / VS.rowH);
      var firstIdx = Math.max(0, first * VS.cols);
      var visibleRows = Math.ceil((viewH + VS.rowH * 2) / VS.rowH) + 1;
      var start = Math.max(0, (first - 1) * VS.cols);
      var end = Math.min(rows.length, start + visibleRows * VS.cols + VS.cols);
      if (!force && start === VS.start && end === VS.end) return;
      VS.start = start; VS.end = end;
      var html = '';
      if (state.view === 'table') {
        html = '<table class="vs-table"><thead><tr>' +
          '<th style="width:30px"></th><th>番号</th><th>原名</th><th>中文名</th><th>演员</th><th>标签</th>' +
          '<th>状态</th><th class="num">截图</th><th>影片日期</th><th>来源</th></tr></thead><tbody>';
        for (var i = start; i < end; i++) html += tableRowHtml(rows[i]);
        html += '</tbody></table>';
      } else {
        for (var j = start; j < end; j++) html += cardHtml(rows[j]);
      }
      ct.innerHTML = html;
      if (state.view === 'table') {
        /* v2.1.29 A-11：实测 sticky 表头高度并补正滚动总量。offsetHeight 与
           ROW_H 同为整数像素，漂移 ≤1px；只在变化时写 spacer，滚动零开销。 */
        var thEl = ct.querySelector('thead');
        var thH = thEl ? (thEl.offsetHeight || 0) : 0;
        if (thH > 0 && thH !== VS.theadH) {
          VS.theadH = thH;
          var sp2 = $('#vsSpacer');
          if (sp2) sp2.style.height = (rows.length * VS.rowH + thH + 2) + 'px';
        }
      }
      if (state.view === 'card') {
        ct.style.transform = 'translateY(' + (Math.floor(start / VS.cols) * VS.rowH) + 'px)';
      } else {
        ct.style.transform = 'translateY(' + (start * VS.rowH) + 'px)';
      }
    },
    onScroll: function () {
      if (VS._raf) return;
      VS._raf = requestAnimationFrame(function () {
        VS._raf = 0;
        VS.paint(getFiltered(), false);
      });
    }
  };
  /* 卡片：两栏（左封面 / 右文本信息，v2.1.6）
     左栏 .cv 带 data-cv → bindCards 里点它进灯箱，列表 = [封面, ...截图] 可连续翻页 */
  function cardHtml(r) {
    var img = imgSrc(r.cover);
    var sel = state.sel[r.id] ? ' sel' : '';
    var badges = '<span class="badge st-' + escapeHtml(r.status) + '">' + escapeHtml(r.status) + '</span>' +
      (r.downloaded ? '<span class="badge dl">已下载</span>' : '');
    var actor = statsActorNames(r).join(' / ');
    /* v2.1.39：内部左右 5:5 分栏。左半 = 封面区（无封面时占位：深绿灰渐变 +
       线性封面图标 +「封面」二字，右缘一条分隔竖线）；右半自上而下 番号 / 标题
       （单行省略）/ 演员，行内只用留白分隔、不画分割线，番号走等宽字体。 */
    return '<div class="vs-card card' + sel + '" data-id="' + r.id + '">' +
      '<div class="cv" data-cv="1">' +
        (img
          ? '<img loading="lazy" src="' + escapeHtml(img) + '" alt="">'
          : '<div class="ph">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">' +
            '<rect x="3" y="4" width="18" height="16" rx="2"/>' +
            '<circle cx="8.6" cy="9" r="1.5"/>' +
            '<path d="M3 17l5.2-5.2 3.4 3.4 3-3L21 17"/></svg>' +
            '<span>封面</span></div>') +
      '</div>' +
      '<div class="meta">' +
        '<div class="r1"><span class="code">' + escapeHtml(r.code) + '</span><span class="badges">' + badges + '</span></div>' +
        '<div class="ttl">' + escapeHtml(r.titleCn || r.title || '（无标题）') + '</div>' +
        '<div class="r3">' + escapeHtml(actor || '—') + '</div>' +
      '</div>' +
      '<div class="ck" data-ck="1">' + (state.sel[r.id] ? '✓' : '') + '</div>' +
    '</div>';
  }
  function tableRowHtml(r) {
    var sel = state.sel[r.id] ? ' sel' : '';
    return '<tr class="' + sel.trim() + '" data-id="' + r.id + '">' +
      '<td data-ck="1" style="text-align:center;cursor:pointer">' + (state.sel[r.id] ? '☑' : '☐') + '</td>' +
      '<td class="c-code">' + escapeHtml(r.code) + '</td>' +
      '<td>' + escapeHtml(r.title) + '</td>' +
      '<td>' + escapeHtml(r.titleCn) + '</td>' +
      '<td>' + escapeHtml(r.actor) + '</td>' +
      '<td class="c-tags">' + escapeHtml((r.tags || []).join(', ')) + '</td>' +
      '<td>' + escapeHtml(r.status) + '</td>' +
      '<td class="num">' + (r.shots || []).length + '</td>' +
      '<td>' + escapeHtml(r.release) + '</td>' +
      '<td>' + escapeHtml(r.platform) + '</td></tr>';
  }

  /* @@PART:actor@@ */

  /* ---- 想看清单 / 统计 ---- */
  function renderTabCounts() {
    $('#tabCountHome').textContent = String(state.rows.length);
    $('#tabCountActor').textContent = String(state.actors.length);
    $('#tabCountTag').textContent = String(allTagNames ? allTagNames().length : 0);
  }
  /* ---- 状态统计（未看片单 section#watchSection 已于 v2.1.6 整体删除） ---- */
  function renderStats() {
    var c = { 未看: 0, 想看: 0, 已看: 0 };
    state.rows.forEach(function (r) { c[r.status] = (c[r.status] || 0) + 1; });
    $('#statFilms').textContent = String(state.rows.length);
    $('#statStatus').innerHTML = STATUS.map(function (s) {
      var n = c[s] || 0, pct = state.rows.length ? Math.round(n / state.rows.length * 100) : 0;
      return '<div class="stat-bar"><span class="t">' + s + '</span>' +
        '<span class="b"><i style="width:' + pct + '%"></i></span><span class="n">' + n + '</span></div>';
    }).join('');
  }
  function renderStatsModal() {
    var tagC = {}, actorC = {}, platC = {}, monthC = {};
    state.rows.forEach(function (r) {
      splitList(r.tags).forEach(function (t) { tagC[t] = (tagC[t] || 0) + 1; });
      /* 演员计数走 statsActorNames（按行去重，v2.1.3 统一） */
      statsActorNames(r).forEach(function (a) { actorC[a] = (actorC[a] || 0) + 1; });
      var p = r.platform || platformOf(r.code) || '未标记';
      platC[p] = (platC[p] || 0) + 1;
      if (r.ts) { var d = new Date(r.ts); var k = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2); monthC[k] = (monthC[k] || 0) + 1; }
    });
    function bars(obj, unit) {
      var keys = Object.keys(obj).sort(function (a, b) { return obj[b] - obj[a]; }).slice(0, 12);
      if (!keys.length) return '<div style="color:var(--muted);font-size:12.5px">暂无数据</div>';
      var max = obj[keys[0]];
      return keys.map(function (k) {
        return '<div class="stat-bar"><span class="t" title="' + escapeHtml(k) + '">' + escapeHtml(k) + '</span>' +
          '<span class="b"><i style="width:' + Math.round(obj[k] / max * 100) + '%"></i></span>' +
          '<span class="n">' + obj[k] + (unit || '') + '</span></div>';
      }).join('');
    }
    $('#statsBody').innerHTML =
      '<div class="side-block" style="margin-bottom:12px"><div class="side-label">标签 Top</div><div class="stat-bars">' + bars(tagC) + '</div></div>' +
      '<div class="side-block" style="margin-bottom:12px"><div class="side-label">演员 Top</div><div class="stat-bars">' + bars(actorC) + '</div></div>' +
      '<div class="side-block" style="margin-bottom:12px"><div class="side-label">来源</div><div class="stat-bars">' + bars(platC) + '</div></div>' +
      '<div class="side-block"><div class="side-label">按月录入</div><div class="stat-bars">' + bars(monthC) + '</div></div>';
  }
  function refreshAll() {
    renderStatusChips();
    renderActorFilter();
    renderTagFilter();
    renderStats();
    renderTabCounts();
    VS.render();
    renderBulk();
  }

  /* ==========================================================================
   * §6 批量
   * ======================================================================== */
  function selIds() { return Object.keys(state.sel).filter(function (k) { return state.sel[k]; }); }
  function renderBulk() {
    var ids = selIds();
    $('#bulkBar').classList.toggle('show', ids.length > 0);
    $('#selCount').textContent = String(ids.length);
  }
  function bulkSetStatus(s) {
    selIds().forEach(function (id) { var r = findRow(id); if (r) r.status = s; });
    toast('已将 ' + selIds().length + ' 部标为「' + s + '」', 'ok');
    commit();
  }
  function bulkDelete() {
    var ids = selIds();
    if (!ids.length) return;
    if (!confirm('确定删除选中的 ' + ids.length + ' 部？（可用「备份」先行保存）')) return;
    state.rows = state.rows.filter(function (r) { return !state.sel[r.id]; });
    state.sel = {};
    commit();
    toast('已删除 ' + ids.length + ' 部', 'ok');
  }

  /* ==========================================================================
   * §7 详情 / 表单 / 备注
   * ======================================================================== */
  function openModal(id) { $('#' + id).classList.add('show'); }
  function closeModal(id) { $('#' + id).classList.remove('show'); }

  function openDetail(id) {
    var r = findRow(id);
    if (!r) return;
    var img = imgSrc(r.cover);
    /* 演员：女 + 男合并为一行（两者都空才回退 actor 主字段） */
    var actorLine = [r.actorF, r.actorM].filter(function (x) { return x; }).join('、') || r.actor || '';
    /* v2.1.16：日期单字段化（Spider v1.3.40），原样保留页面文本（斜杠/ISO/区间串） */
    var releaseLine = r.release || '';
    /* 番号固定为 KV 区首行（不随空值过滤上浮），原名紧随其后 */
    /* v2.1.23：每个字段值后带复制按钮（封面/截图除外）——复制文本经
       data-copykv 属性传递（escapeHtml 已转义双引号），点击委托在 bindDetail。
       值包 <span class="kv-val">：与按钮文本分离，读值/选中复制不混入「复制」二字 */
    var kv = ['<div class="k">番号</div><div class="v"><span class="kv-val">' + escapeHtml(r.code) + '</span>' + kvCopyBtn(r.code) + '</div>'].concat([
      ['原名', r.title], ['中文名', r.titleCn], ['演员', actorLine],
      ['系列', r.series], ['导演', r.director],
      ['影片日期', releaseLine], ['发行商', r.maker],
      ['来源', r.platform || platformOf(r.code)],
      ['标签', splitList(r.tags).join('、')],
      ['备注', r.note]
    ].map(function (p) {
      if (!p[1]) return '';
      /* v2.1.29 A-12：标签行直接渲染彩色 pill（tagColorOf 由 Tag 部件提供）。
         旧版先用通用模板拼出「、」连接行、再整串 kv.replace 换成 pill——替换串里
         含 $& / $' 等模式时 String.replace 会按「匹配子串」展开（标签名 "$&"
         实测把整行又插一遍），且标签含特殊字符时搜索串失配还会静默不换。
         现在零 replace；复制按钮保留（值为「、」连接串）。 */
      if (p[0] === '标签') {
        return '<div class="k">标签</div><div class="v"><span class="kv-val">' + tagPills(r.tags) + '</span>' + kvCopyBtn(p[1]) + '</div>';
      }
      return '<div class="k">' + p[0] + '</div><div class="v"><span class="kv-val">' + escapeHtml(p[1]) + '</span>' + kvCopyBtn(p[1]) + '</div>';
    })).join('');
    /* v2.1.29 A-12：标签 pill 已改为上面 map 内直接渲染（零 replace，防 $& 展开） */
    var magnets = (r.magnet || []).map(function (m, i) {
      return '<div class="magnet-item"><span class="lk" title="' + escapeHtml(m) + '">' + escapeHtml(m) + '</span>' +
        '<button class="btn sm" data-copy="' + i + '">复制</button></div>';
    }).join('');
    var shots = (r.shots || []).map(function (s, i) {
      return '<img src="' + escapeHtml(imgSrc(s)) + '" data-shot="' + i + '" alt="">';
    }).join('');
    $('#detailBody').innerHTML =
      '<div class="detail-grid">' +
      '<div class="detail-cover">' + (img ? '<img src="' + escapeHtml(img) + '" data-cover="1" title="点击预览大图" alt="">' : '<div class="nocover" style="padding:60px 0;text-align:center;color:var(--muted)">无封面</div>') + '</div>' +
      '<div class="detail-side"><div class="detail-kv">' + kv + '</div>' +
      (magnets ? ('<div style="margin-top:12px"><div class="side-label">磁力链接（' + r.magnet.length + '）</div>' +
        '<div class="magnet-list">' + magnets + '</div>' +
        '<button class="btn sm" id="copyAllMag" style="margin-top:7px">复制全部磁力</button></div>') : '') +
      (shots ? ('<div style="margin-top:12px"><div class="side-label">截图（' + r.shots.length + '）</div><div class="detail-shots">' + shots + '</div></div>') : '') +
      '</div></div>' +
      /* v2.1.15：站外搜索跳转（MGS 用原名，与 FL Spider 互跳按钮同一套 URL） */
      '<div class="detail-actions">' +
      '<button class="btn sm" data-act="jump-fanza">FANZA 搜索</button>' +
      '<button class="btn sm" data-act="jump-mgs">MGS 搜索</button>' +
      '<button class="btn sm" data-act="jump-javdb">JAVDB 搜索</button>' +
      '<button class="btn sm" data-act="wish">想看</button>' +
      '<button class="btn sm" data-act="unwatch">未看</button>' +
      '<button class="btn sm" data-act="watched">已看</button>' +
      '<button class="btn sm" data-act="dl">' + (r.downloaded ? '取消已下载' : '标为已下载') + '</button>' +
      '<button class="btn sm" data-act="note">备注</button>' +
      '<button class="btn sm" data-act="edit">编辑</button>' +
      '<button class="btn sm danger" data-act="del">删除</button>' +
      '</div>';
    $('#detailBody').setAttribute('data-id', r.id);
    openModal('detailMask');
  }
  /* v2.1.15：详情页站外搜索跳转 URL（与 FL Spider 互跳按钮保持同一套地址）：
   * fanza  key= 要 FANZA 写法（EBWH-346 → EBWH00346，复用 fanzaCodeOf）；
   * mgs    search_word= 用原名（日文），取不到依次退回中文名、番号（MGS 也认番号）；
   * javdb  直接用库内标准番号。 */
  function jumpUrlOf(kind, r) {
    if (!r) return '';
    if (kind === 'fanza') return 'https://video.dmm.co.jp/list/?key=' + fanzaCodeOf(r.code);
    if (kind === 'mgs') {
      var kw = r.title || r.titleCn || r.code || '';
      return 'https://www.mgstage.com/search/cSearch.php?search_word=' + encodeURIComponent(kw) + '&x=56&y=17&search_shop_id=&type=top';
    }
    if (kind === 'javdb') return 'https://javdb.com/search?q=' + encodeURIComponent(r.code) + '&f=all';
    return '';
  }
  function copyText(text, okMsg) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast(okMsg || '已复制', 'ok'); }
      catch (e) { toast('复制失败，请手动复制', 'err'); }
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(okMsg || '已复制', 'ok'); }, fallback);
    } else fallback();
  }
  /* v2.1.23：详情 KV 行值尾部的复制按钮（封面/截图不加）。
     文本走 data-copykv 属性——escapeHtml 已转 & < > "，双引号属性安全。 */
  function kvCopyBtn(text) {
    return '<button class="kv-copy" data-copykv="' + escapeHtml(String(text == null ? '' : text)) + '" title="复制此值">复制</button>';
  }

  /* ---- 表单 ---- */
  /* v2.1.36 #14：blob URL 必须显式释放。旧版只 createObjectURL 从不 revoke——
     反复「编辑 → 选图 → 换一部再选图」，或一次拖入几十张截图，被丢弃的 blob URL
     会一直持有底层 Blob（每张几 MB）直到页面关闭。只释放 blob: 开头的，
     已有图片的 http URL 不能碰（那是服务端资源）。 */
  function releasePendingUrls() {
    var pi = state.pendingImages;
    if (!pi) return;
    function rel(u) { if (u && /^blob:/.test(u)) { try { URL.revokeObjectURL(u); } catch (e) {} } }
    if (pi.cover) rel(pi.cover.url);
    (pi.shots || []).forEach(function (s) { if (s) rel(s.url); });
  }
  function openForm(row) {
    state.editing = row ? row.id : null;
    releasePendingUrls();   /* v2.1.36 #14：换一部片子编辑前先释放上一部的预览 URL */
    state.pendingImages = { cover: row && row.cover ? { blob: null, url: imgSrc(row.cover), path: row.cover.path, name: row.cover.name } : null, shots: row ? row.shots.map(function (s) { return { blob: null, url: imgSrc(s), path: s.path, name: s.name }; }) : [] };
    $('#formTitle').textContent = row ? ('编辑 · ' + row.code) : '新增影片';
    var f = $('#filmForm');
    f.f_code.value = row ? row.code : '';
    f.f_status.value = row ? row.status : '未看';
    f.f_title.value = row ? row.title : '';
    f.f_titleCn.value = row ? row.titleCn : '';
    f.f_actor.value = row ? row.actor : '';
    f.f_actorF.value = row ? row.actorF : '';
    f.f_actorM.value = row ? row.actorM : '';
    f.f_series.value = row ? row.series : '';
    f.f_director.value = row ? row.director : '';
    f.f_platform.value = row ? row.platform : '';
    f.f_release.value = row ? (row.release || '') : '';
    f.f_maker.value = row ? (row.maker || '') : '';
    f.f_tags.value = row ? (row.tags || []).join(', ') : '';
    var mg = row ? (row.magnet || []) : [];
    f.f_magnet0.value = mg[0] || ''; f.f_magnet1.value = mg[1] || ''; f.f_magnet2.value = mg[2] || '';
    f.f_note.value = row ? row.note : '';
    f.f_downloaded.checked = row ? !!row.downloaded : false;
    f.f_saved.checked = row ? !!row.saved : false;
    $('#formErr').textContent = '';
    renderImagePreviews();
    openModal('formMask');
  }
  function renderImagePreviews() {
    var pi = state.pendingImages;
    var cp = $('#coverPreview');
    cp.innerHTML = pi.cover ? '<div class="pv"><img src="' + escapeHtml(pi.cover.url) + '"><button class="rm" data-rm="cover">✕</button></div>' : '';
    var sp = $('#shotsPreview');
    sp.innerHTML = pi.shots.map(function (s, i) {
      return '<div class="pv"><img src="' + escapeHtml(s.url) + '"><button class="rm" data-rm="shot" data-i="' + i + '">✕</button></div>';
    }).join('');
  }
  function pickImages(files, which) {
    Array.prototype.slice.call(files).forEach(function (f) {
      if (!/^image\//.test(f.type)) return;
      var url = URL.createObjectURL(f);
      if (which === 'cover') {
        var _oc = state.pendingImages.cover;
        if (_oc && _oc.url && /^blob:/.test(_oc.url)) { try { URL.revokeObjectURL(_oc.url); } catch (e) {} }
        state.pendingImages.cover = { blob: f, url: url, path: '', name: f.name };
      } else {
        state.pendingImages.shots.push({ blob: f, url: url, path: '', name: f.name });
      }
    });
    renderImagePreviews();
  }
  function submitForm(ev) {
    ev.preventDefault();
    var f = ev.target;
    var code = normCode(f.f_code.value);
    if (!code) { $('#formErr').textContent = '番号不能为空'; return; }
    var row = state.editing ? findRow(state.editing) : null;
    var isNew = !row;
    if (isNew) {
      var dup = rowByCode(code);
      if (dup) { $('#formErr').textContent = '番号 ' + dup.code + ' 已存在，请直接编辑它'; return; }
      /* v2.1.26 BUG-02（P0）：不在图片上传前 push。旧版这一步就把幽灵行塞进
         state.rows，上传失败时不回滚：内存有这条、磁盘上没有；再保存同番号会被
         rowByCode 判「已存在」挡住，刷新后条目又消失 → 保存死锁。
         现在只创建行对象，等上传成功、即将落盘前才 push（失败时状态干净可重试）。 */
      row = normalizeRow({ id: uid(), code: code });
    } else if (row.code !== code && rowByCode(code)) {
      $('#formErr').textContent = '番号 ' + code + ' 已被其它影片使用'; return;
    }
    row.code = code;
    row.status = f.f_status.value;
    row.title = f.f_title.value.trim();
    row.titleCn = f.f_titleCn.value.trim();
    row.actor = f.f_actor.value.trim();
    row.actorF = f.f_actorF.value.trim();
    row.actorM = f.f_actorM.value.trim();
    row.series = f.f_series.value.trim();
    row.director = f.f_director.value.trim();
    row.platform = f.f_platform.value.trim();
    row.release = f.f_release.value.trim();
    row.maker = f.f_maker.value.trim();
    row.tags = splitList(f.f_tags.value);
    row.magnet = [f.f_magnet0.value, f.f_magnet1.value, f.f_magnet2.value].map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 3);
    row.note = f.f_note.value;
    row.downloaded = f.f_downloaded.checked;
    row.saved = f.f_saved.checked;
    restampSrcTier(row);          /* v2.1.21：无章行补填 platform 后补层级章，保持落盘一致 */
    row.updated = Date.now();
    var btn = $('#formSubmit');
    /* v2.1.36 #8：上传前先快照字段。旧版把字段直接写进 state.rows 里的活对象，
       上传失败只恢复按钮文本、不回滚字段——界面显示旧值、内存已是新值，之后
       任何一次别的保存（批量加标签 / 导入 / 10s 自动导入）都会把用户从未确认
       成功的编辑静默落盘。新建路径 v2.1.26 已修（isNew 才 push），编辑路径漏了。 */
    var _snap = null;
    if (!isNew) { _snap = {}; Object.keys(row).forEach(function (k) { _snap[k] = row[k]; }); }
    btn.disabled = true; btn.textContent = '保存中…';
    uploadPendingImages(code).then(function (up) {
      /* v2.1.17：图片以表单预览列表为最终态——删了=移除，没换图=保留原 path，
         换图/添图=新上传 path（up.shots 与 pendingImages.shots 逐位对齐）。
         旧代码只「追加」不「移除」，且换封面时旧 path 残留。 */
      var pi = state.pendingImages;
      row.cover = up.cover || (pi.cover && pi.cover.path ? { name: pi.cover.name || '', path: pi.cover.path } : null);
      row.shots = pi.shots.map(function (s, i) {
        return up.shots[i] || { name: s.name || '', path: s.path || '' };
      }).filter(function (s) { return !!s.path; });
      /* v2.1.26 BUG-02：新建行在此处才入列（紧跟落盘前）。上传失败走 catch 时
         row 从未进 state.rows，状态干净——用户改好图片可直接重试，不会撞上
         「番号已存在」的幽灵行。 */
      if (isNew) state.rows.push(row);
      btn.disabled = false; btn.textContent = '保存';
      closeModal('formMask');
      commit();
      saveData();
      releasePendingUrls();   /* v2.1.36 #14：保存成功后本次预览 URL 已完成使命 */
      toast(isNew ? ('已新增 ' + code) : ('已保存 ' + code), 'ok');
    }).catch(function (e) {
      /* v2.1.36 #8：回滚到快照，保证「取消/失败」后内存与界面一致 */
      if (_snap) { Object.keys(_snap).forEach(function (k) { row[k] = _snap[k]; }); refreshAll(); }
      btn.disabled = false; btn.textContent = '保存';
      $('#formErr').textContent = '图片上传失败：' + ((e && e.message) || e);
    });
  }

  /* ==========================================================================
   * §8 灯箱
   * ======================================================================== */
  /* v2.1.32 BUG-1：灯箱列表统一构造。
     旧代码三个入口各造各的 list——卡片入口过滤空 src、详情入口不过滤。imgSrc() 在
     path 为空时返回 ''（ZIP 导入失败 / 旧数据 / shots 里混了占位项），空字符串赋给
     img.src 会被浏览器解析成「当前文档 URL」并发一次必然失败的请求，灯箱永远停在
     「加载中 / 加载失败」，用户以为图丢了。
     过滤必须与 labels 同步进行，否则点第 N 张截图时 at 与标签整体错位；shotAt[i]
     记录第 i 张截图在过滤后 list 里的下标（-1 = 该张没有可用源文件）。 */
  function viewerListOf(row) {
    var list = [], labels = [], shotAt = [];
    var cov = row && row.cover ? imgSrc(row.cover) : '';
    if (cov) { list.push(cov); labels.push('封面'); }
    ((row && row.shots) || []).forEach(function (s, i) {
      var u = imgSrc(s);
      if (!u) { shotAt[i] = -1; return; }
      shotAt[i] = list.length;
      list.push(u);
      labels.push('截图 ' + (i + 1));
    });
    return { list: list, labels: labels, shotAt: shotAt };
  }
  /* v2.1.15：labels 为可选参数，与 list 等长；不传时标签行为空（卡片网格入口不区分封面/截图） */
  function openViewer(list, at, labels) {
    state.viewer = { list: list, at: at, labels: labels || [], scale: 0 };
    paintViewer();
    $('#imgViewer').classList.add('show');
  }
  function paintViewer() {
    var v = state.viewer;
    if (!v.list.length) return;
    v.at = (v.at + v.list.length) % v.list.length;
    v.scale = 0;   /* 翻页/重开一律回到适应窗口，避免上一张的放大系数带到下一张 */
    $('#imgViewerImg').src = v.list[v.at];
    $('#ivCount').textContent = (v.at + 1) + ' / ' + v.list.length;
    $('#ivLabel').textContent = (v.labels && v.labels.length === v.list.length) ? v.labels[v.at] : '';
    /* 翻页/重开都要把上一张的残留态清干净：尺寸信息、失败按钮 */
    $('#ivInfo').textContent = '';
    $('#ivRetry').hidden = true;
    $('#ivSkip').hidden = true;
    /* 单张时禁用翻页；加载态在 load/error 里收（见 bindViewer） */
    $('#ivPrev').disabled = v.list.length < 2;
    $('#ivNext').disabled = v.list.length < 2;
    $('#ivLoading').style.display = '';
    $('#ivLoading').textContent = '加载中…';
    viewerPreload();
    viewerApplyScale();
    renderViewerStrip();
  }
  /* v2.1.32：相邻图预取——即使是本地服务也要走磁盘 IO，翻页时才发请求会肉眼可见卡顿 */
  function viewerPreload() {
    var v = state.viewer;
    if (!v || !v.list || v.list.length < 2) return;
    [1, -1].forEach(function (d) {
      var i = (v.at + d + v.list.length) % v.list.length;
      if (i === v.at) return;
      var im = new Image();
      im.src = v.list[i];
    });
  }
  /* v2.1.32 BUG-3：失败重试。加时间戳破缓存，否则浏览器直接复用上一次的失败结果 */
  function reloadViewer() {
    var v = state.viewer;
    if (!v || !v.list.length) return;
    var u = v.list[v.at];
    $('#ivRetry').hidden = true;
    $('#ivSkip').hidden = true;
    $('#ivInfo').textContent = '';
    $('#ivLoading').style.display = '';
    $('#ivLoading').textContent = '加载中…';
    $('#imgViewerImg').src = u + (u.indexOf('?') >= 0 ? '&' : '?') + '_r=' + Date.now();
  }
  /* ---------- v2.1.33：缩放（D2=A） + 缩略图条（D3=A） ---------- */
  var _suppressViewerClick = false;   /* 拖动过就抑制紧随的 click——松手落在遮罩上会误关灯箱 */
  var _viewerDrag = null;             /* 放大态拖动平移的状态 */
  var _stripIO = null;                /* 缩略图懒加载观察器（root = #ivStrip） */

  /* 适应态的等效倍率：图片实际渲染宽度 / 原始宽度。滚轮从当前视觉大小接着调，
     否则从「适应」一滚就跳到 120%（视觉断层）。 */
  function viewerFitScale() {
    var im = $('#imgViewerImg');
    var nw = im.naturalWidth || 0;
    if (!nw) return 1;
    var w = im.getBoundingClientRect().width || nw;
    return Math.max(0.2, Math.min(4, w / nw));
  }
  /* scale：0 = 适应窗口；>0 = 按倍率以原始像素渲染（1 = 1:1，看清水印/小字） */
  function viewerApplyScale() {
    var v = state.viewer, box = $('#imgViewer'), im = $('#imgViewerImg');
    var s = v.scale || 0;
    if (!s || !im.naturalWidth) {
      v.scale = 0;
      box.classList.remove('zoomed');
      im.style.width = '';
    } else {
      box.classList.add('zoomed');
      im.style.width = Math.round(im.naturalWidth * s) + 'px';
    }
    setViewerInfo();
  }
  function setViewerInfo() {
    var im = $('#imgViewerImg'), v = state.viewer;
    var dim = (im.naturalWidth && im.naturalHeight) ? (im.naturalWidth + '×' + im.naturalHeight) : '';
    var z = (v && v.scale) ? (' · ' + Math.round(v.scale * 100) + '%') : (dim ? ' · 适应' : '');
    $('#ivInfo').textContent = dim + z;
  }
  function viewerToggleZoom() {
    var v = state.viewer, im = $('#imgViewerImg');
    if (!im.naturalWidth) return;      /* 没加载成功时不给缩放（否则按 0 宽渲染成一条线） */
    v.scale = v.scale ? 0 : 1;
    viewerApplyScale();
  }
  function viewerWheelZoom(dir) {
    var v = state.viewer, im = $('#imgViewerImg');
    if (!im.naturalWidth) return;
    var cur = v.scale || viewerFitScale();
    var next = Math.round((cur + dir) * 10) / 10;
    v.scale = Math.max(0.2, Math.min(4, next));
    viewerApplyScale();
  }
  /* 缩略图条：D3=A——截图没有 thumb（只有封面有 code@360.jpg），直接用原图 + 懒加载。
     列表不变时只切高亮，不重建 DOM（否则每次翻页都把 IntersectionObserver 推倒重来）。 */
  function renderViewerStrip() {
    var v = state.viewer, box = $('#imgViewer'), strip = $('#ivStrip');
    var show = v.list.length > 1;
    box.classList.toggle('has-strip', show);
    strip.classList.toggle('on', show);
    if (!show) { strip.innerHTML = ''; strip.removeAttribute('data-n'); return; }
    if (strip.getAttribute('data-n') !== String(v.list.length) || strip.getAttribute('data-for') !== v.list[0]) {
      strip.innerHTML = v.list.map(function (u, i) {
        var t = (v.labels && v.labels[i]) ? v.labels[i] : ('第 ' + (i + 1) + ' 张');
        return '<div class="iv-thumb" data-i="' + i + '" title="' + escapeHtml(t) + '"><img data-src="' + escapeHtml(u) + '" alt=""></div>';
      }).join('');
      strip.setAttribute('data-n', String(v.list.length));
      strip.setAttribute('data-for', v.list[0]);
      stripLazyLoad();
    }
    $all('#ivStrip .iv-thumb').forEach(function (el) {
      el.classList.toggle('on', +el.getAttribute('data-i') === v.at);
    });
    var cur = strip.querySelector('.iv-thumb.on');
    if (cur) strip.scrollLeft = Math.max(0, cur.offsetLeft - strip.clientWidth / 2 + cur.offsetWidth / 2);
  }
  function stripLazyLoad() {
    var strip = $('#ivStrip');
    if (!window.IntersectionObserver) {   /* 退化：直接全量加载 */
      $all('#ivStrip img[data-src]').forEach(function (im) {
        im.src = im.getAttribute('data-src');
        im.removeAttribute('data-src');
      });
      return;
    }
    if (!_stripIO) {
      _stripIO = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          var im = e.target, s = im.getAttribute('data-src');
          if (s) { im.src = s; im.removeAttribute('data-src'); }
          _stripIO.unobserve(im);
        });
      }, { root: strip, rootMargin: '140px' });
    }
    $all('#ivStrip img[data-src]').forEach(function (im) { _stripIO.observe(im); });
  }
  function closeViewer() {
    $('#imgViewer').classList.remove('show');
    /* v2.1.32 BUG-2：旧代码用 src = '' 清图——空串会被浏览器解析成当前文档 URL 并重新
       发一次必然失败的请求；且 error 回调在 display:none 之后又把 #ivLoading 显示回来，
       留下脏状态。正确做法是摘掉属性（removeAttribute 不会触发新的加载）。 */
    $('#imgViewerImg').removeAttribute('src');
    $('#imgViewer').classList.remove('zoomed');
    $('#imgViewer').classList.remove('dragging');
    $('#imgViewerImg').style.width = '';
    $('#ivStrip').classList.remove('on');
    $('#ivLoading').style.display = 'none';
    $('#ivInfo').textContent = '';
    $('#ivRetry').hidden = true;
    $('#ivSkip').hidden = true;
  }

  /* ==========================================================================
   * §9 收件箱（FL Spider 来料 → 合并入库 → 归档）
   * ======================================================================== */
  function openInbox() {
    API.inbox().then(function (d) {
      state.inboxItems = d.items || [];
      renderInbox();
      openModal('inboxMask');
    }).catch(function (e) { toast('读取收件箱失败：' + ((e && e.message) || e), 'err'); });
  }
  function renderInbox() {
    var items = state.inboxItems;
    $('#inboxImportBtn').disabled = !items.length;
    if (!items.length) { $('#inboxList').innerHTML = '<div style="color:var(--muted);padding:20px 0">收件箱是空的。用 FL Spider 在影片页点「保存」后，这里会出现来料。</div>'; return; }
    $('#inboxList').innerHTML = '<div style="color:var(--muted);margin-bottom:10px">共 ' + items.length + ' 条待导入（按番号合并，已入库的只补空缺字段）</div>' +
      items.map(function (it) {
        var cov = it.cover && (it.cover.dataUrl || it.cover.src) ? '<img src="' + escapeHtml(it.cover.dataUrl || it.cover.src) + '" style="width:52px;height:69px;object-fit:cover;border-radius:5px">' : '';
        return '<div class="inb-item" style="align-items:flex-start">' + cov +
          '<div style="flex:1;min-width:0"><div class="inb-code">' + escapeHtml(it.code) + '</div>' +
          '<div class="inb-title" style="white-space:normal">' + escapeHtml(it.titleCn || it.title || '') + '</div>' +
          '<div style="font-size:11.5px;color:var(--muted)">' + escapeHtml(it.actor || '') +
          (Array.isArray(it.shots) && it.shots.length ? (' · 截图 ' + it.shots.length) : '') + '</div></div></div>';
      }).join('');
  }
  /* 合并语义与旧版 readInbox 一致：新番号建行（未看），旧行只补空缺 */
  /* 合并一批收件箱来料。counts = {added, filled} 累加器（多轮合并汇总）。
     返回 Promise：图片上传完成 + 落盘。 */
  function mergeInboxItems(items, counts) {
    /* v2.1.35 #4：clearedShots 登记「本次被清空的截图」——一级来料覆盖时
       row.shots.length = 0 是破坏性前置操作，若后续异步上传失败而不回滚，
       外层 catch（手动导入 / 10s 自动轮询）仍会 commit() 落盘，该片截图
       记录就永久消失且没有任何提示。 */
    var byCode = {}, byKey = {}, imgJobs = [], clearedShots = [], touchedRows = [];
    state.rows.forEach(function (r) { byCode[r.code.toLowerCase()] = r; byKey[codeDedupeKey(r.code)] = r; });
    items.forEach(function (it) {
      if (!it) return;
      var code = fromJavdbCode(normCode(it.code || it['番号'] || ''));
      if (!code) return;
      var itTier = tierOfItem(it);
      var row = byCode[code.toLowerCase()] || byKey[codeDedupeKey(code)];
      var isNew = false;
      if (!row) {
        row = normalizeRow({ code: code, status: '未看' });
        state.rows.push(row);
        byCode[code.toLowerCase()] = row; byKey[codeDedupeKey(code)] = row;
        isNew = true;
        counts.added++;
      } else counts.filled++;
      /* v2.1.21 分级覆盖（用户三项决策）：
         ① 一级覆盖二级——来料层级 < 行层级（来料更权威）时覆盖爬取属有字段；
         ② 字段级非空覆盖——只用来料的非空值覆盖，来料缺位的字段保留原值；
         ③ srcTier 溯源——行层级取 srcTier，老行按 platform 推断（TIER1=FANZA/MGS/FC2
            → 1，其他聚合站 → 2，无 platform → 0）。
         行层级 0（未知/用户自建）时任何来料都只填空，永不覆盖。
         用户属有字段（status/tags/note/magnet/downloaded/saved）任何路径都不被覆盖，
         只走原有的「只填空」逻辑。 */
      var over = !isNew && itTier > 0 && itTier < tierOfRow(row);
      if (itTier > 0 && (isNew || over)) row.srcTier = itTier;
      ['title', 'titleCn', 'actor', 'actorF', 'actorM', 'series', 'director', 'maker', 'platform', 'release'].forEach(function (k) {
        if (it[k] && (over || !row[k])) row[k] = String(it[k]);
      });
      restampSrcTier(row);
      /* 兼容旧版 Spider 来料（v1.3.40 前）：releaseSale/releaseStream 二合一 + 中文日期键 */
      if (!row.release) {
        var _rel = it.releaseSale || it.releaseStream || it['商品発売日'] || it['发售日'] || it['配信開始日'] || it['配信开始日'];
        if (_rel) row.release = String(_rel);
      }
      /* 兼容旧版 Spider 来料：发行商的各站叫法 */
      if (!row.maker) {
        var _mk = it['发行商'] || it['制造商'] || it['メーカー'] || it['片商'];
        if (_mk) row.maker = String(_mk);
      }
      /* 平台/来源兜底：一级站 Spider 直接给 platform；老来料可能只有 source 字段。
         over 时即使行已有 platform 也以来料来源为准（爬取属有字段） */
      if (it.source && (over || !row.platform)) row.platform = srcPlatform(it.source) || String(it.source);
      if (it.tags && it.tags.length) {
        var have = {};
        row.tags.forEach(function (t) { have[t] = 1; });
        splitList(it.tags).forEach(function (t) { if (!have[t]) { have[t] = 1; row.tags.push(t); } });
      }
      if ((it.magnet || it['磁力链接']) && !row.magnet.length) row.magnet = normMagnets(it.magnet || it['磁力链接']);
      /* 封面：来料有三种历史形态——dataUrl 字符串（Spider 现行）/ {dataUrl|src|base64} 对象（旧版）/
         裸 base64（无 data: 前缀）。v2 重写时丢了字符串兼容，Spider 来料封面全部断链成 null
         （旧版 applyInboxImage 三态全认），此处恢复全兼容 */
      var cov = it.cover && (typeof it.cover === 'string' ? it.cover : (it.cover.dataUrl || it.cover.src || it.cover.base64 || ''));
      if (cov && cov.indexOf('data:') !== 0) cov = 'data:image/jpeg;base64,' + cov;
      if (cov && (over || !row.cover)) {
        var blob = /^data:/.test(cov) ? dataUrlToBlob(cov) : null;
        if (blob) imgJobs.push(API.upload('covers', coverNameOf(row.code), blob).then(function (r) {
          row.cover = { name: coverNameOf(row.code), path: r.path };
        }));
      }
      if (Array.isArray(it.shots) && it.shots.length && (over || !row.shots.length)) {
        /* v2.1.21：一级来料覆盖时先清掉二级截图，再传一级的（否则变成混合两张站点） */
        if (touchedRows.indexOf(row) === -1) touchedRows.push(row);
        if (over && row.shots.length) { clearedShots.push({ row: row, old: row.shots.slice() }); row.shots.length = 0; }
        /* #67：截图不限量。Spider 一级站（FANZA/MGS）按 999 上限全抓，
           旧代码在这里 slice(0,9) 又截回 9 张，两边口径不一致；命名序号已 padStart 到 2 位，≥100 张不撞名。 */
        it.shots.forEach(function (s, i) {
          var du = s && (typeof s === 'string' ? s : (s.dataUrl || s.src || s.base64 || ''));
          if (!du) return;
          if (du.indexOf('data:') !== 0) du = 'data:image/jpeg;base64,' + du;
          if (!/^data:/.test(du)) return;
          var b = dataUrlToBlob(du);
          if (b) {
            if (touchedRows.indexOf(row) === -1) touchedRows.push(row);
            imgJobs.push(API.upload('shots', shotNameOf(row.code, i), b).then(function (r) {
              /* v2.1.36 #10：按下标回填而不是 push。并发上传的完成顺序不确定，
                 push 会让截图落库顺序随机错乱，与 shotAt[i] 及详情页「截图 N」
                 的编号不再对应（uploadPendingImages 早就用 out.shots[i] 的写法，
                 收件箱这条路径一直没跟上）。 */
              row.shots[i] = { name: shotNameOf(row.code, i), path: r.path };
            }));
          }
        });
      }
    });
    API.backup('Film Library pre-import ' + stamp() + '.json', payloadOf()).catch(function () {});
    return Promise.all(imgJobs).then(function () {
      /* v2.1.36 #10：按下标回填会在「跳过空项」处留下 undefined 洞，落盘前压掉 */
      touchedRows.forEach(function (r) { r.shots = (r.shots || []).filter(Boolean); });
      state.rowsVersion++;
      return saveData(true);
    }, function (e) {
      /* v2.1.35 #4：任一图片上传失败 → 回滚本次被清空的截图。
         旧版此时 row.shots 已是空数组，而调用方（手动导入 / 10s 自动轮询）
         的 catch 仍会 commit() 落盘 → 截图记录永久丢失且无任何提示。
         回滚后调用方 commit() 出来的是与磁盘一致的完整状态。 */
      clearedShots.forEach(function (c) { c.row.shots = c.old; });
      throw e;
    });
  }
  /* 来料里不在已导入集合中的新条目（按归一番号判定） */
  function inboxDelta(doneItems, freshItems) {
    var done = {};
    doneItems.forEach(function (it) {
      var c = fromJavdbCode(normCode(it.code || it['番号'] || ''));
      if (c) done[c.toLowerCase()] = 1;
    });
    return (freshItems || []).filter(function (it) {
      var c = fromJavdbCode(normCode(it.code || it['番号'] || ''));
      return c && !done[c.toLowerCase()];
    });
  }
  /* v2.1.30 自动导入：抽出的共用内核——手动「全部导入并归档」与自动轮询共用同一条
     合并/归档链路（BUG8 竞态防护只维护一份）。opts.auto 的区别仅两处：
     ① Spider 持续写入时手动路径 throw 提示用户；自动路径静默 resolve（kept），
        留给下一轮轮询——抓取狂奔时每秒都在写，弹错误 toast 是纯噪声；
     ② 收尾提示由各自调用方做（手动路径要关弹窗，自动路径要刷状态行）。 */
  function importInboxCore(items, opts) {
    var counts = { added: 0, filled: 0 };
    return mergeInboxItems(items, counts).then(function () {
      /* BUG8 修复（v2.1.20）：归档前重拉快照。合并 + 图片上传是异步窗口，
         期间 FL Spider 可能又写了新来料；服务端 /api/inbox/import 是「整箱归档」
         （inbox.json 全量搬进 inbox_done.json 后清空）——直接调用会把没导入过
         的新来料悄悄吞进 archive，主库永远看不到，且无任何提示。
         对策：归档前重拉；有增量就再并一轮；连续两轮都有增量（抓取正在狂奔）
         则保留不归档并提示用户，绝不吞数据。 */
      return API.inbox().then(function (d) {
        var delta = inboxDelta(items, d.items || []);
        if (!delta.length) return API.inboxImport();
        return mergeInboxItems(delta, counts).then(function () {
          return API.inbox().then(function (d2) {
            var delta2 = inboxDelta(items.concat(delta), d2.items || []);
            if (!delta2.length) return API.inboxImport();
            if (opts && opts.auto) return { kept: delta2.length };
            throw new Error('收件箱仍在持续写入，已保留 ' + delta2.length + ' 条未归档，请稍后再次导入');
          });
        });
      });
    }).then(function (r) {
      return { counts: counts, kept: (r && r.kept) || 0 };
    });
  }
  function importInbox() {
    var items = state.inboxItems;
    if (!items.length) return;
    /* v2.1.30：与自动轮询共用互斥锁。两条路径同时跑会互相穿过对方
       importInboxCore 里的「归档前重拉」检查，把没合并过的新来料吞进
       archive（BUG8 的数据丢失场景换一条路复发）——用户点「全部导入」
       正好撞上 10s 自动 tick 是最常见的触发窗口。 */
    if (_importBusy) { toast('正在导入收件箱，请稍候…', 'warn'); return; }
    _importBusy = true;
    importInboxCore(items, null).then(function (r) {
      _importBusy = false;
      closeModal('inboxMask');
      commit();
      toast('已导入 ' + r.counts.added + ' 条新影片' + (r.counts.filled ? ('，' + r.counts.filled + ' 条已有记录补齐字段') : '') + '，收件箱已归档', 'ok');
    }).catch(function (e) {
      _importBusy = false;
      commit();
      toast('导入完成但有问题：' + ((e && e.message) || e), 'warn');
    });
  }

  /* v2.1.30：收件箱自动导入——FL Spider 抓完写收件箱后无需人点「全部导入」。
     触发：页面加载后一次 + 每 10s 轮询（页面隐藏时跳过；切回可见时补检一次，
     后台标签不空转）。防护：
     ① _importBusy 互斥锁（手动导入进行中/上一轮未完成 → 跳过本轮）；
     ② 仅在 loadData 完成后由 boot 启动（state.rows 就绪，否则合并会写空库）；
     ③ 持续写入走 importInboxCore 的 kept 分支静默保留，下一轮重试；
     ④ 失败静默（补全面板状态行可见原因），不每 10s 弹错误 toast 刷屏。 */
  var _importBusy = false;      // v2.1.30：收件箱导入互斥锁（手动/自动两条路径共用）
  var _autoInboxTimer = 0;
  var AUTO_INBOX_MS = 10000;
  function autoInboxOn() { return lsGet(LS.autoInbox, '1') !== '0'; }
  function autoInboxTick() {
    if (_importBusy) return;
    if (!autoInboxOn()) return;
    if (document.visibilityState === 'hidden') return;
    _importBusy = true;
    API.inbox().then(function (d) {
      var items = d.items || [];
      if (!items.length) return null;
      state.inboxItems = items;
      return importInboxCore(items, { auto: true }).then(function (r) {
        commit();
        renderInboxStatus();
        toast('已自动导入 ' + r.counts.added + ' 条新影片' +
          (r.counts.filled ? ('，' + r.counts.filled + ' 条已有记录补齐字段') : '') +
          (r.kept ? ('（' + r.kept + ' 条来料仍在写入，稍后自动重试）') : ''), 'ok');
      });
    }).catch(function (e) {
      /* 合并可能已改内存：commit() 保证内存/磁盘一致；失败原因进状态行，静默重试 */
      try { commit(); } catch (e2) {}
      try { renderInboxStatus(); } catch (e2) {}
    }).then(function () { _importBusy = false; });
  }
  function startAutoInbox() {
    if (_autoInboxTimer) return;
    autoInboxTick();
    _autoInboxTimer = setInterval(autoInboxTick, AUTO_INBOX_MS);
  }
  /* ==========================================================================
   * §11 导入导出（JSON / CSV / XLSX / ZIP）
   * ======================================================================== */
  /* @@PART:video@@ */
  /* @@PART:fanza@@ */
  /* @@PART:fill@@ */
  function download(name, blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function exportJson(rows) {
    rows = rows || state.rows;
    download('Film Library ' + stamp() + '.json', new Blob([JSON.stringify({ app: 'Film Library', version: 3, exportedAt: new Date().toISOString(), rows: rows.map(stripRow) }, null, 2)], { type: 'application/json' }));
    toast('已导出 ' + rows.length + ' 条', 'ok');
  }
  /* v2.1.21：补 来源层级（srcTier 的人类可读形态：一级/二级/空=未知）。
     与 normalizeRow 的推断口径一致；导入侧一级/二级/1/2 都认。 */
  var CSV_COLS = [['code', '番号'], ['title', '原名'], ['titleCn', '中文名'], ['actor', '演员'], ['actorF', '女演员'], ['actorM', '男演员'], ['status', '状态'], ['tags', '标签'], ['series', '系列'], ['director', '导演'], ['platform', '来源'], ['srcTier', '来源层级'], ['release', '影片日期'], ['maker', '发行商'], ['magnet', '磁力链接'], ['note', '备注'], ['downloaded', '已下载'], ['saved', '已收藏']];
  function exportCsv(rows) {
    rows = rows || state.rows;
    var lines = [CSV_COLS.map(function (c) { return c[1]; }).join(',')];
    rows.forEach(function (r) {
      lines.push(CSV_COLS.map(function (c) {
        var v = r[c[0]];
        if (c[0] === 'tags') v = (r.tags || []).join('、');
        if (c[0] === 'srcTier') v = r.srcTier === 1 ? '一级' : r.srcTier === 2 ? '二级' : '';
        /* v2.1.20：导出用分号连接。旧版用空格——而 normMagnets 按逗号/分号/换行
           切分，空格连接的多条链导入时会并成一条残链（round-trip 断裂）。
           磁力 URI 本身不含分号，分号是安全分隔符。 */
        if (c[0] === 'magnet') v = (r.magnet || []).join(';');
        if (typeof v === 'boolean') v = v ? '是' : '';
        v = v == null ? '' : String(v);
        /* v2.1.27 BUG-17：CSV 公式注入防护——以 = + - @ 开头的单元格会被
           Excel / WPS 当公式执行。导出时前置单引号（打开后按文本显示）。
           导入端保持原值不动（避免污染库内数据），真正的执行点在导出。 */
        if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
        return /[",\n]/.test(v) ? ('"' + v.replace(/"/g, '""') + '"') : v;
      }).join(','));
    });
    download('Film Library ' + stamp() + '.csv', new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv' }));
    toast('已导出 ' + rows.length + ' 条', 'ok');
  }
  function parseCsv(text) {
    var rows = [], row = [], cell = '', q = false, i = 0;
    /* v2.1.27 BUG-25：先把 \r\n 与裸 \r（老 Mac 换行）统一成 \n。
       旧版在循环里直接丢掉 \r —— 裸 \r 分行的 CSV 会被读成一整行，
       且单元格里的 \r 在 round-trip 中丢失。 */
    text = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    while (i < text.length) {
      var ch = text.charAt(i);
      if (q) {
        if (ch === '"') { if (text.charAt(i + 1) === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); cell = ''; rows.push(row); row = []; }
      else if (ch !== '\r') cell += ch;
      i++;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  function importFiles(files) {
    /* v2.1.29 A-10：input[type=file] 是 multiple，旧版只取 files[0]——多选时
       其余文件被静默丢弃（用户以为全导入了）。改为顺序处理全部文件：
       FileReader 是异步的，用索引递归链顺序读（每个文件一个 reader）；
       zip/xlsx 由各自导入器自行提示，csv/json 累计计数后一次性 toast。 */
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    var added = 0, updated = 0, failed = 0, tabular = 0;
    var next = function (i) {
      if (i >= list.length) {
        if (!tabular) return;                 /* 全是 zip/xlsx：它们自己会提示 */
        if (failed) { toast('导入完成：新增 ' + added + '，更新 ' + updated + '，' + failed + ' 个文件失败', 'err'); return; }
        toast('导入完成：新增 ' + added + '，更新 ' + updated, 'ok');
        return;
      }
      var f = list[i];
      if (/\.zip$/i.test(f.name)) { importZipFile(f); next(i + 1); return; }
      if (/\.xlsx$/i.test(f.name) || /\.xls$/i.test(f.name)) { importXlsxFile(f); next(i + 1); return; }
      tabular++;
      var rd = new FileReader();
      rd.onload = function () {
        var rows = [];
        try {
          if (/\.json$/i.test(f.name)) {
            var p = JSON.parse(String(rd.result).replace(/^\uFEFF/, ''));
            rows = Array.isArray(p) ? p : (p.rows || []);
          } else {
            var tbl = parseCsv(rd.result);
            var head = tbl.shift() || [];
            /* 旧表头别名（v2.1.16 前的 CSV：发售日/配信日 → 影片日期；平台 → 来源）；
               两个旧日期列都别名到「影片日期」时首列获胜（发售日在前，与 Spider 优先级一致） */
            var HEAD_ALIAS = { '发售日': '影片日期', '商品発売日': '影片日期', '配信日': '影片日期', '配信開始日': '影片日期', '配信开始日': '影片日期', '平台': '来源' };
            tbl.forEach(function (line) {
              var o = {};
              head.forEach(function (h, i) {
                var hn = HEAD_ALIAS[h.trim()] || h.trim();
                /* BUG-25：空值不占位——旧版用 o[c[0]] == null 判空，第一列值为空串时
                   也会占位，导致第二列（如配信日）的真实值被丢弃。 */
                CSV_COLS.forEach(function (c) {
                  if (c[1] !== hn) return;
                  var v = line[i];
                  if (v == null || String(v).trim() === '') return;
                  if (o[c[0]] == null || String(o[c[0]]).trim() === '') o[c[0]] = v;
                });
              });
              rows.push(o);
            });
          }
        } catch (e) { failed++; toast('解析失败：' + f.name + '：' + ((e && e.message) || e), 'err'); next(i + 1); return; }
        var a = 0, u = 0;
        rows.forEach(function (raw) {
          var code = normCode(raw.code || raw['番号'] || '');
          if (!code) return;
          var row = rowByCode(code);
          if (row) { u++; } else { row = normalizeRow({ id: uid(), code: code }); state.rows.push(row); a++; }
          ['title', 'titleCn', 'actor', 'actorF', 'actorM', 'status', 'series', 'director', 'platform', 'release', 'maker', 'note'].forEach(function (k) {
            if (raw[k] != null && String(raw[k]).trim()) row[k] = String(raw[k]).trim();
          });
          /* v2.1.21：来源层级列（一级/二级标签或 1/2 数字都认；缺失列的老 CSV 不受影响） */
          restampSrcTier(row);
          if (raw.srcTier != null && String(raw.srcTier).trim()) {
            var _st = String(raw.srcTier).trim();
            row.srcTier = (_st === '一级' || _st === '1') ? 1 : (_st === '二级' || _st === '2') ? 2 : 0;
          }
          if (raw.tags) row.tags = splitList(raw.tags);
          if (raw.magnet) row.magnet = normMagnets(raw.magnet);
          if (raw.downloaded != null) row.downloaded = /是|true|1/i.test(String(raw.downloaded));
          if (raw.saved != null) row.saved = /是|true|1/i.test(String(raw.saved));
          if (STATUS.indexOf(row.status) < 0) row.status = '未看';
          row.updated = Date.now();
        });
        added += a; updated += u;
        commit(); saveData();
        next(i + 1);
      };
      rd.onerror = function () { failed++; toast('读取失败：' + f.name, 'err'); next(i + 1); };
      rd.readAsText(f, 'utf-8');
    };
    next(0);
  }
  /* @@PART:xlsx@@ */
  /* @@PART:zip@@ */

  /* ==========================================================================
   * §12 事件绑定
   * ======================================================================== */
  /* 正则提示默认文案（与 v2_core.html 里 #regexHint 的初始文本保持一致） */
  var REGEX_HINT_DEFAULT = '正则模式：整个输入作为正则匹配（非法正则视为无结果）';
  /* v2.1.26 BUG-10 次生：普通模式改字面匹配后不再解析正则，从正则模式切回时
     若不复位，残留的「正则表达式格式有误，请检查」会一直挂在那里误导用户
     （还没隐藏干净，切回普通后本就不该再谈正则）。 */
  function resetRegexHint(on) {
    var h = $('#regexHint');
    if (!h) return;
    h.classList.toggle('show', !!on);
    h.classList.remove('err');
    h.textContent = REGEX_HINT_DEFAULT;
  }
  /* v2.1.27 BUG-24：防抖定时器必须是模块级的——应用预设时要能从外部撤销。
     旧版是 bindSearch 闭包内的局部变量：输入后 180ms 内点预设，定时器随后触发
     会把 state.filter.text 改回旧输入，预设被无声覆盖。 */
  var _searchDebounce = null;
  function bindSearch() {
    $('#searchInput').addEventListener('input', function () {
      var v = this.value;
      clearTimeout(_searchDebounce);
      _searchDebounce = setTimeout(function () {
        state.filter.text = v;
        if (state.filter.regex) VS.render();
        refreshAll();
      }, 180);
    });
    $('#searchClear').addEventListener('click', function () {
      clearTimeout(_searchDebounce);    /* 撤销挂起的防抖，否则旧搜索词会被重新应用（v2.1.2 修） */
      $('#searchInput').value = '';
      state.filter.text = '';
      refreshAll();
    });
    $('#searchScope').addEventListener('change', function () { state.filter.scope = this.value; refreshAll(); });
    var sbBtn = $('#btnSearch');
    if (sbBtn) sbBtn.addEventListener('click', function () {
      clearTimeout(_searchDebounce);
      state.filter.text = $('#searchInput').value;
      if (state.filter.regex) VS.render();
      refreshAll();
    });
    $('#regexToggle').addEventListener('click', function () {
      state.filter.regex = !state.filter.regex;
      this.classList.toggle('on', state.filter.regex);
      resetRegexHint(state.filter.regex);
      refreshAll();
    });
    $('#qHelpBtn').addEventListener('click', function () { $('#qHelp').classList.toggle('show'); });
    $('#qHelp').innerHTML =
      '高级语法（空格＝「与」）：<br>' +
      '· <code>字段:值</code> 定向搜索：<code>番号:</code> <code>演员:</code> <code>标签:</code> <code>状态:</code> <code>磁力:</code> <code>影片日期:</code> <code>发行商:</code> <code>系列:</code> <code>导演:</code> <code>来源:</code> <code>备注:</code> <code>中文名:</code><br>' +
      '· <code>影片日期:</code> 可按时间粒度：<code>release:2017</code> 年份 / <code>release:11</code> 月份 / <code>release:2017-11</code> 年月 / <code>release:2017-11-05</code> 完整日期<br>' +
      '· <code>-词</code> 或 <code>-字段:值</code> 排除<br>' +
      '· <code>"短语"</code> 引号内不当分词<br>' +
      '· <code>a|b</code> 或（标签:巨乳|美乳）<br>' +
      '· <code>\\</code> 转义。不含以上语法时按「搜索范围 + 子串/正则」匹配。';
  }
  function bindFilters() {
    $all('#statusChips .chip').forEach(function (b) {
      b.addEventListener('click', function () {
        state.filter.status = b.getAttribute('data-status') || '';
        refreshAll();
      });
    });
    $('#actorFilter').addEventListener('change', function () { state.filter.actor = this.value; refreshAll(); });
    $('#tagFilter').addEventListener('change', function () { state.filter.tag = this.value; refreshAll(); });
    $('#missFilter').addEventListener('change', function () {
      var v = this.value;
      state.filter.miss = v ? [v] : [];
      refreshAll();
    });
    $('#sortSelect').addEventListener('change', function () { state.filter.sort = this.value; refreshAll(); });
  }
  function bindView() {
    $('#addBtn').addEventListener('click', function () { openForm(null); });
    /* v2.1.38：大标题区的「添加影片」与左栏工具区的「＋ 新增」同源，
       不复用 #addBtn 的 DOM（两个同 id 不合法），直接各自调 openForm。 */
    var addTop = $('#addBtnTop');
    if (addTop) addTop.addEventListener('click', function () { openForm(null); });
    $('#viewCardBtn').addEventListener('click', function () { setView('card'); });
    var swBtn = $('#viewSwitchBtn');
    if (swBtn) swBtn.addEventListener('click', function () { setView(state.view === 'card' ? 'table' : 'card'); });
    bindSplit();
    bindFold();
    $('#viewTableBtn').addEventListener('click', function () { setView('table'); });
    $('#compactToggle').addEventListener('change', function () {
      state.compact = this.checked;
      lsSet(LS.compact, this.checked ? '1' : '');
      VS.render();
    });
    /* v2.1.31：自动导入收件箱开关。打开时立即补检一次（不用等下一个 10s 轮询） */
    $('#autoInboxToggle').addEventListener('change', function () {
      lsSet(LS.autoInbox, this.checked ? '1' : '0');
      if (this.checked) autoInboxTick();
    });
    $('#vsViewport').addEventListener('scroll', VS.onScroll);
    var rz = null;
    window.addEventListener('resize', function () {
      clearTimeout(rz);
      rz = setTimeout(function () { VS.render(); syncNavH(); }, 150);
    });
  }
  /* v2.1.34：主导航改为浮动吸顶卡。  /* v2.1.39 Split View：分隔条拖拽改侧栏宽度，双击复位，宽度存 localStorage。
     宽度写 CSS 变量 --split-w（#topPanel 的 flex-basis/width 读它），避免与响应式规则打架。 */
  var SPLIT_KEY = 'wb_film_v2_splitw', SPLIT_DEF = 264;
  function bindSplit() {
    var h = document.getElementById('splitHandle'), panel = document.getElementById('topPanel');
    if (!h || !panel) return;
    function apply(w) { document.documentElement.style.setProperty('--split-w', w + 'px'); }
    var saved = 0;
    try { saved = parseInt(localStorage.getItem(SPLIT_KEY) || '', 10) || 0; } catch (e) { saved = 0; }
    if (saved >= 200 && saved <= 560) apply(saved);
    var dragging = false, startX = 0, startW = 0;
    h.addEventListener('mousedown', function (ev) {
      if (panel.classList.contains('fold')) return;
      dragging = true; startX = ev.clientX; startW = panel.getBoundingClientRect().width;
      h.classList.add('drag'); document.body.style.userSelect = 'none'; ev.preventDefault();
    });
    window.addEventListener('mousemove', function (ev) {
      if (!dragging) return;
      apply(Math.max(200, Math.min(560, Math.round(startW + (ev.clientX - startX)))));
      VS.render();
    });
    window.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false; h.classList.remove('drag'); document.body.style.userSelect = '';
      var w = Math.round(panel.getBoundingClientRect().width);
      try { localStorage.setItem(SPLIT_KEY, String(w)); } catch (e) {}
      VS.render();
    });
    h.addEventListener('dblclick', function () {
      apply(SPLIT_DEF);
      try { localStorage.removeItem(SPLIT_KEY); } catch (e) {}
      VS.render();
    });
  }
  /* v2.1.39：侧栏折叠。收起后分隔条仍在，可随时拖回来或点按钮展开。 */
  function bindFold() {
    var btn = document.getElementById('panelFoldBtn');
    var panel = document.getElementById('topPanel');
    var h = document.getElementById('splitHandle');
    if (!btn || !panel) return;
    btn.addEventListener('click', function () {
      var folded = panel.classList.toggle('fold');
      btn.textContent = folded ? '▶ 展开侧栏' : '◀ 收起侧栏';
      if (h) h.classList.toggle('folded', folded);
      VS.render();
    });
  }

  /* v2.1.34：主导航改为浮动吸顶卡。窄屏会换行变高，故实测其高度写入 --navH，
     供 #topPanel / .p-side 的 sticky 偏移避让（写死高度会在换行时错位）。 */
  function syncNavH() {
    var n = document.getElementById('mainTabs');
    if (!n) return;
    var h = Math.round(n.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty('--navH', h + 'px');
  }
  function setView(v) {
    state.view = v;
    lsSet(LS.view, v);
    $('#viewCardBtn').classList.toggle('on', v === 'card');
    $('#viewTableBtn').classList.toggle('on', v === 'table');
    var sw = $('#viewSwitchBtn');
    if (sw) sw.textContent = '切换视图：' + (v === 'card' ? '表格' : '卡片');
    VS.render();
  }
  function bindCards() {
    /* 事件委托：卡片/表格行点击 */
    $('#vsContent').addEventListener('click', function (ev) {
      var ck = ev.target.closest('[data-ck]');
      var host = ev.target.closest('[data-id]');
      if (!host) return;
      var id = host.getAttribute('data-id');
      if (ck) {
        if (state.sel[id]) delete state.sel[id]; else state.sel[id] = true;
        VS.paint(getFiltered(), true);
        renderBulk();
        return;
      }
      /* 左栏封面 → 灯箱大图预览：列表 = [封面, ...截图]，可连续翻页（封面/截图连着看） */
      if (ev.target.closest('[data-cv]')) {
        var vr = findRow(id);
        if (vr) {
          /* v2.1.32：与详情入口共用构造，卡片入口从此也显示「封面 / 截图 N」标签（BUG-1） */
          var vv = viewerListOf(vr);
          if (vv.list.length) { openViewer(vv.list, 0, vv.labels); return; }
          toast('这部影片还没有封面和截图', 'warn');
          return;
        }
      }
      openDetail(id);
    });
  }
  function bindBulk() {
    $('#selAll').addEventListener('click', function () {
      getFiltered().forEach(function (r) { state.sel[r.id] = true; });
      VS.paint(getFiltered(), true); renderBulk();
    });
    $('#selNone').addEventListener('click', function () {
      state.sel = {}; VS.paint(getFiltered(), true); renderBulk();
    });
    $('#selWish').addEventListener('click', function () { bulkSetStatus('想看'); });
    $('#selUnwatched').addEventListener('click', function () { bulkSetStatus('未看'); });
    $('#selWatched').addEventListener('click', function () { bulkSetStatus('已看'); });
    $('#selTag').addEventListener('click', function () {
      var t = prompt('给选中的 ' + selIds().length + ' 部加标签（多个用逗号分隔）：');
      if (!t) return;
      splitList(t).forEach(function (tag) {
        selIds().forEach(function (id) {
          var r = findRow(id);
          if (r && r.tags.indexOf(tag) === -1) r.tags.push(tag);
        });
      });
      commit(); saveData();
      toast('已加标签', 'ok');
    });
    $('#selExport').addEventListener('click', function () {
      var rows = state.rows.filter(function (r) { return state.sel[r.id]; });
      if (rows.length) exportJson(rows);
    });
    $('#selDelete').addEventListener('click', bulkDelete);
  }
  function bindDetail() {
    /* v2.1.14：详情弹窗标题栏（modal-head）已删除；v2.1.15：操作区「关闭」按钮也删除，
       关闭入口 = 点击弹窗外的遮罩区域（「影片详情」卡片以外的任何位置） */
    $('#detailMask').addEventListener('click', function (ev) {
      if (ev.target.id === 'detailMask') { closeModal('detailMask'); return; }   // 点遮罩关闭
      var act = ev.target.closest('[data-act]');
      var cp = ev.target.closest('[data-copy]');
      var kvcp = ev.target.closest('[data-copykv]');
      var shot = ev.target.closest('[data-shot]');
      var cov = ev.target.closest('[data-cover]');
      var id = $('#detailBody').getAttribute('data-id');
      var r = findRow(id);
      /* v2.1.23：字段值复制按钮（不依赖行存在，纯文本拷贝） */
      if (kvcp) {
        var kt = kvcp.getAttribute('data-copykv');
        copyText(kt, '已复制：' + (kt.length > 24 ? kt.slice(0, 24) + '…' : kt));
        return;
      }
      if (cp && r) {
        copyText(r.magnet[+cp.getAttribute('data-copy')] || '', '已复制该磁力链接');
        return;
      }
      if (ev.target.id === 'copyAllMag' && r) {
        copyText((r.magnet || []).join('\n'), '已复制全部 ' + r.magnet.length + ' 条磁力');
        return;
      }
      if (cov && r) {   /* 封面点击 → 灯箱（封面排首位） */
        var cv = viewerListOf(r);
        if (cv.list.length) openViewer(cv.list, 0, cv.labels);
        return;
      }
      if (shot && r) {
        var sv = viewerListOf(r);
        var si = +shot.getAttribute('data-shot');
        var sat = sv.shotAt[si];
        /* 该张没有可用源文件（path 为空）时不再把空 src 塞进灯箱（BUG-1） */
        if (!sv.list.length || sat == null || sat < 0) { toast('这张图片没有可用的源文件', 'warn'); return; }
        openViewer(sv.list, sat, sv.labels);
        return;
      }
      if (!act || !r) return;
      var a = act.getAttribute('data-act');
      if (a === 'jump-fanza' || a === 'jump-mgs' || a === 'jump-javdb') {
        var url = jumpUrlOf(a.slice(5), r);
        if (url) window.open(url, '_blank', 'noopener');
        return;
      }
      if (a === 'wish' || a === 'unwatch' || a === 'watched') {
        r.status = a === 'wish' ? '想看' : a === 'unwatch' ? '未看' : '已看';
        commit(); saveData(); openDetail(id);
      } else if (a === 'dl') {
        r.downloaded = !r.downloaded; commit(); saveData(); openDetail(id);
      } else if (a === 'note') {
        state.noteFor = r.id;
        $('#noteText').value = r.note || '';
        openModal('noteMask');
      } else if (a === 'edit') {
        closeModal('detailMask'); openForm(r);
      } else if (a === 'del') {
        if (!confirm('删除 ' + r.code + '？')) return;
        state.rows = state.rows.filter(function (x) { return x.id !== r.id; });
        /* v2.1.27 BUG-15：同步清掉勾选态。旧版留下死 id → 批量条虚报条数，
           「导出所选 / 删除所选」按 selIds 过滤时匹配不到任何行，静默落空。 */
        delete state.sel[r.id];
        closeModal('detailMask'); commit(); saveData();
        toast('已删除 ' + r.code, 'ok');
      }
    });
    $('#noteSave').addEventListener('click', function () {
      var r = findRow(state.noteFor);
      if (r) { r.note = $('#noteText').value; commit(); saveData(); }
      closeModal('noteMask');
    });
    $('#noteCancel').addEventListener('click', function () { closeModal('noteMask'); });
    /* v2.1.20：备注弹窗 ✕（noteClose）改遮罩关闭。原 ✕ 按钮是死控件（无监听），
       本次删 HTML 按钮 + 补遮罩监听，与详情弹窗/灯箱关闭方式统一。
       约束：target 必须精确等于 noteMask——点 textarea/按钮不关。 */
    $('#noteMask').addEventListener('click', function (ev) {
      if (ev.target.id === 'noteMask') closeModal('noteMask');
    });
  }
  function bindForm() {
    $('#filmForm').addEventListener('submit', submitForm);
    $('#formCancel').addEventListener('click', function () { closeModal('formMask'); });
    $('#formClose').addEventListener('click', function () { closeModal('formMask'); });
    $('#coverDrop').addEventListener('click', function () {
      var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
      inp.onchange = function () { pickImages(inp.files, 'cover'); };
      inp.click();
    });
    $('#shotsDrop').addEventListener('click', function () {
      var inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
      inp.onchange = function () { pickImages(inp.files, 'shots'); };
      inp.click();
    });
    [['#coverDrop', 'cover'], ['#shotsDrop', 'shots']].forEach(function (p) {
      $(p[0]).addEventListener('dragover', function (ev) { ev.preventDefault(); this.classList.add('over'); });
      $(p[0]).addEventListener('dragleave', function () { this.classList.remove('over'); });
      $(p[0]).addEventListener('drop', function (ev) {
        ev.preventDefault(); this.classList.remove('over');
        pickImages(ev.dataTransfer.files, p[1]);
      });
    });
    $('#coverPreview').addEventListener('click', function (ev) {
      var rm = ev.target.closest('[data-rm]');
      if (!rm) return;
      var _dc = state.pendingImages.cover;
      if (_dc && _dc.url && /^blob:/.test(_dc.url)) { try { URL.revokeObjectURL(_dc.url); } catch (e) {} }
      state.pendingImages.cover = null; renderImagePreviews();
    });
    $('#shotsPreview').addEventListener('click', function (ev) {
      var rm = ev.target.closest('[data-rm]');
      if (!rm) return;
      var _di = +rm.getAttribute('data-i');
      var _rm = state.pendingImages.shots[_di];
      if (_rm && _rm.url && /^blob:/.test(_rm.url)) { try { URL.revokeObjectURL(_rm.url); } catch (e) {} }
      state.pendingImages.shots.splice(_di, 1);
      renderImagePreviews();
    });
  }
  function bindTools() {
    $('#inboxBtn').addEventListener('click', openInbox);
    $('#inboxClose').addEventListener('click', function () { closeModal('inboxMask'); });
    $('#inboxCloseBtn').addEventListener('click', function () { closeModal('inboxMask'); });
    $('#inboxImportBtn').addEventListener('click', importInbox);
    $('#statsBtn').addEventListener('click', function () { renderStatsModal(); openModal('statsMask'); });
    $('#statsClose').addEventListener('click', function () { closeModal('statsMask'); });
    $('#statsCloseBtn').addEventListener('click', function () { closeModal('statsMask'); });
    $('#exportJsonBtn').addEventListener('click', function () { exportJson(); });
    $('#exportCsvBtn').addEventListener('click', function () { exportCsv(); });
    $('#exportXlsxBtn').addEventListener('click', function () { exportXlsx(); });
    $('#exportZipBtn').addEventListener('click', function () { exportZip(); });
    $('#importBtn').addEventListener('click', function () { $('#importFile').click(); });
    $('#importFile').addEventListener('change', function () { importFiles(this.files); this.value = ''; });
    $('#backupBtn').addEventListener('click', function () {
      API.backup('Film Library ' + stamp() + '_manual.json', payloadOf())
        .then(function () { toast('已备份到数据目录 backups/（服务端写入）', 'ok'); })
        .catch(function (e) { toast('备份失败：' + ((e && e.message) || e), 'err'); });
    });
  }
  /* v2.1.36 #12：boot 成功分支与「配置/更改数据目录」之后要跑的初始化是同一套。
     旧版 setup 路径只 loadData().then(refreshAll)：漏了 loadMeta（演员/标签
     元数据为空）和 startAutoInbox（自动导入整会话失效，必须刷新页面才恢复）。
     startAutoInbox 自带 _autoInboxTimer 幂等守卫，重复调用安全。 */
  function afterReady() {
    loadMeta().then(renderTabCounts).catch(function () {});
    refreshAll();
    startAutoInbox();
  }
  function bindSetup() {
    $('#btnChangeDir').addEventListener('click', openSetup);
    $('#setupClose').addEventListener('click', function () { closeModal('setupMask'); });
    $('#setupSaveBtn').addEventListener('click', function () {
      var dir = $('#setupPath').value.trim();
      if (!dir) { $('#setupMsg').textContent = '请填数据目录路径'; return; }
      $('#setupMsg').textContent = '正在连接…';
      API.config(dir, $('#setupVideoPath').value.trim()).then(function () {
        /* v2.1.36 #13：加载成功之后再关弹窗。旧版先 closeModal 再 loadData，
           失败时错误写进已经隐藏的 #setupMsg，用户只看到「已连接数据目录」的
           成功 toast，随后面对空/旧数据的界面却不知道原因。 */
        return loadData().then(function () {
          afterReady();   /* v2.1.36 #12：与 boot 共用初始化（loadMeta + 自动导入） */
          closeModal('setupMask');
          toast('已连接数据目录', 'ok');
        });
      }).catch(function (e) { $('#setupMsg').textContent = '连接失败：' + ((e && e.message) || e); });
    });
  }
  function openSetup() {
    $('#setupPath').value = state.dataDir || '';
    $('#setupVideoPath').value = state.videoDir || '';
    $('#setupMsg').textContent = '';
    openModal('setupMask');
  }
  function bindTabs() {
    $all('#mainTabs .tab').forEach(function (b) {
      b.addEventListener('click', function () {
        var t = b.getAttribute('data-tab');
        $all('#mainTabs .tab').forEach(function (x) { x.classList.toggle('on', x === b); });
        ['home', 'video', 'actor', 'tag'].forEach(function (k) {
          var el = $('#page' + k.charAt(0).toUpperCase() + k.slice(1));
          if (el) el.hidden = (k !== t);
        });
        lsSet(LS.tab, t);
        if (t === 'video') renderVideoPage();
        else videoStop();
        if (t === 'actor') renderActorPage();
        if (t === 'tag') renderTagPage();
        /* v2.1.19：回主页必须补 VS.render()。两个原因：① 停在其他 tab 期间
           render 被 geom 守卫跳过，几何是过期/初始值；② 窗口缩放只作用于
           当前可见页，隐藏中的 vsViewport 量不到新宽度。 */
        if (t === 'home') VS.render();
      });
    });
  }
  function bindViewer() {
    $('#ivPrev').addEventListener('click', function () { state.viewer.at--; paintViewer(); });
    $('#ivNext').addEventListener('click', function () { state.viewer.at++; paintViewer(); });
    /* v2.1.32 BUG-4：恢复可见的关闭按钮（用户决策 D1）。v2.1.18 为与详情弹窗统一而删，
       实测发现性太差——只能点遮罩或按 Esc。
       硬教训（r12 全程在守）：HTML 里加/删控件必须同步改这里的监听——$('#ivClose')
       为 null 时 addEventListener 直接抛异常，会把后面所有监听（含点遮罩关闭）
       全部拖垮，点遮罩当场失灵。 */
    $('#ivClose').addEventListener('click', function (ev) { ev.stopPropagation(); closeViewer(); });
    $('#ivRetry').addEventListener('click', function (ev) { ev.stopPropagation(); reloadViewer(); });
    $('#ivSkip').addEventListener('click', function (ev) { ev.stopPropagation(); state.viewer.at++; paintViewer(); });
    /* 点灯箱遮罩层（深色背景）即关，Esc 同样可关（见下方 keydown）。
       约束：target 必须精确等于 imgViewer——点图片/翻页按钮不关（保持 v2.1.15 语义）。 */
    $('#imgViewer').addEventListener('click', function (ev) {
      /* 放大态拖动结束后，松手那一帧的 click 会落在遮罩上——抑制掉，否则拖着看图 = 关灯箱 */
      if (_suppressViewerClick) return;
      if (ev.target.id === 'imgViewer') closeViewer();
    });
    /* D2=A：点图片在「适应 ↔ 1:1」间切换（不关闭——保持 v2.1.15 的遮罩语义） */
    $('#imgViewerImg').addEventListener('click', function (ev) { ev.stopPropagation(); viewerToggleZoom(); });
    /* 灯箱是不可滚动的 fixed 层，不拦的话滚轮会滚到背后的列表 */
    $('#imgViewer').addEventListener('wheel', function (ev) {
      /* 无论缩放与否都不让滚轮滚到底层列表；缩放态下滚轮 = ±20% 微调 */
      ev.preventDefault();
      viewerWheelZoom(ev.deltaY < 0 ? 0.2 : -0.2);
    }, { passive: false });
    $('#imgViewerImg').addEventListener('load', function () {
      if (!$('#imgViewer').classList.contains('show')) return;
      $('#ivLoading').style.display = 'none';
      setViewerInfo();
    });
    $('#imgViewerImg').addEventListener('error', function () {
      /* 关闭后的残留回调不再改 UI（旧代码会把已隐藏的 #ivLoading 又显示出来） */
      if (!$('#imgViewer').classList.contains('show')) return;
      $('#ivLoading').textContent = '图片加载失败';
      $('#ivLoading').style.display = '';
      $('#ivInfo').textContent = '';
      $('#ivRetry').hidden = false;
      /* 只有一张时「跳过」没意义（跳过去还是它自己） */
      $('#ivSkip').hidden = !(state.viewer && state.viewer.list.length > 1);
    });
    document.addEventListener('keydown', function (ev) {
      if (!$('#imgViewer').classList.contains('show')) return;
      if (ev.key === 'Escape') closeViewer();
      if (ev.key === 'ArrowLeft') { state.viewer.at--; paintViewer(); }
      if (ev.key === 'ArrowRight') { state.viewer.at++; paintViewer(); }
      /* v2.1.32：首/末张直达——几十张截图时不至于只能一路点下去 */
      if (ev.key === 'Home') { state.viewer.at = 0; paintViewer(); }
      if (ev.key === 'End') { state.viewer.at = state.viewer.list.length - 1; paintViewer(); }
    });
    /* 放大态拖动平移：图片大于视口时靠 scrollLeft/Top 移动（zoomed 态容器 overflow:auto） */
    $('#imgViewer').addEventListener('pointerdown', function (ev) {
      if (!$('#imgViewer').classList.contains('zoomed')) return;
      if (ev.target.closest('#ivStrip') || ev.target.closest('.iv-bar')) return;
      _viewerDrag = {
        x: ev.clientX, y: ev.clientY,
        sl: $('#imgViewer').scrollLeft, st: $('#imgViewer').scrollTop, moved: 0
      };
      $('#imgViewer').classList.add('dragging');
    });
    window.addEventListener('pointermove', function (ev) {
      if (!_viewerDrag) return;
      var dx = ev.clientX - _viewerDrag.x, dy = ev.clientY - _viewerDrag.y;
      _viewerDrag.moved = Math.max(_viewerDrag.moved, Math.abs(dx) + Math.abs(dy));
      $('#imgViewer').scrollLeft = _viewerDrag.sl - dx;
      $('#imgViewer').scrollTop = _viewerDrag.st - dy;
    });
    window.addEventListener('pointerup', function () {
      if (!_viewerDrag) return;
      var moved = _viewerDrag.moved;
      _viewerDrag = null;
      $('#imgViewer').classList.remove('dragging');
      _suppressViewerClick = moved > 5;
      setTimeout(function () { _suppressViewerClick = false; }, 0);
    });
    /* 缩略图条点击直达（绑定一次；renderViewerStrip 只换高亮不重建监听） */
    $('#ivStrip').addEventListener('click', function (ev) {
      var t = ev.target.closest('.iv-thumb');
      if (!t) return;
      ev.stopPropagation();
      state.viewer.at = +t.getAttribute('data-i');
      paintViewer();
    });
  }
  function bindLifecycle() {
    window.addEventListener('pagehide', function () {
      /* v2.1.36 #11：卸载阶段的普通 fetch 会被浏览器直接取消，必须带 keepalive
         才能真正发出去。metaPost 早就这样做了（v2.1.29 A-13），数据保存这条
         主路径一直漏着——改完数据立刻关页面/关浏览器就会丢掉 600ms 防抖窗内的改动。 */
      if (state.dirty) saveData(true, true);
      flushMeta();   /* v2.1.29 A-13：meta 防抖项随页面卸载立即推服 */
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && state.dirty) saveData(true);
      /* v2.1.30：切回可见时补检一次收件箱（隐藏期间暂停轮询，不空转也不漏导入） */
      else if (document.visibilityState === 'visible') autoInboxTick();
    });
  }

  /* ==========================================================================
   * §13 启动
   * ======================================================================== */
  function boot() {
    /* 恢复偏好 */
    state.view = lsGet(LS.view, 'card');
    state.compact = !!lsGet(LS.compact, '');
    $('#compactToggle').checked = state.compact;
    $('#autoInboxToggle').checked = autoInboxOn();   // v2.1.30：恢复自动导入开关
    $('#viewCardBtn').classList.toggle('on', state.view !== 'table');
    $('#viewTableBtn').classList.toggle('on', state.view === 'table');
    $('#appVer').textContent = 'v' + APP_VERSION + ' · 本地服务版';
    syncNavH();

    bindSearch(); bindFilters(); bindView(); bindCards(); bindBulk();
    bindDetail(); bindForm(); bindTools(); bindSetup(); bindTabs(); bindViewer(); bindLifecycle();
    /* v2.1.37 #30：五个 bind 串行且无故障隔离——任一个依赖的 DOM id 缺失/改名，
       第一个抛 null.addEventListener 之后，后面几个页面的事件全绑不上，页面整片
       失效而构建照样「✅ 通过」。逐个隔离并留下可查的报错。 */
    [['bindTag', bindTag], ['bindActor', bindActor], ['bindVideo', bindVideo], ['bindFanza', bindFanza], ['bindFill', bindFill]]
      .forEach(function (b) {
        try { b[1](); }
        catch (e) { try { console.error('[FL] ' + b[0] + ' 绑定失败：', e && e.message); } catch (e2) {} }
      });

    loadData().then(function () {
      afterReady();   /* v2.1.36 #12：与「配置数据目录」后共用同一套初始化 */
      var tab = lsGet(LS.tab, 'home');
      var btn = $all('#mainTabs .tab').filter(function (b) { return b.getAttribute('data-tab') === tab; })[0];
      if (btn && tab !== 'home') btn.click();
      toast('Film Library v' + APP_VERSION + ' 已就绪', 'ok');
    }).catch(function (e) {
      /* j() 已把网络失败换成带处置指引的消息；这里只做前缀与兜底 */
      toast('启动失败：' + ((e && e.message) || e), 'err');
      openSetup();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
