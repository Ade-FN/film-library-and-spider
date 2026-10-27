// ==UserScript==
// @name         FL Spider
// @namespace    https://github.com/your-name/fl-crawler
// @version      1.3.69
// @description  Film Library 爬虫 + 番号互跳（javdb / MissAV / FANZA / MOTV / MGS）。
//   ① 抓资料：番号/原名/中文名/上市时间/商品発売日/配信開始日/演员/标签/封面/截图 → 写入「Film Library 收件箱.json」
//   ② 番号识别 + 五站互跳按钮 + 一键复制番号（移植自「番号提取转换DSAI v2.0.0」）
//   ③ 自动清理 MissAV 右下角广告与遮挡按钮的全屏浮层（点击穿透保护）
// @match        https://javdb.com/*
// @match        https://*.javdb.com/*
// @match        https://*.missav.ws/*
// @match        https://missav.ws/*
// @match        https://*.missav.com/*
// @match        https://missav.com/*
// @match        https://*.missav.ai/*
// @match        https://missav.ai/*
// @match        https://*.motv.app/*
// @match        https://motv.app/*
// @match        https://*.dmm.co.jp/*
// @match        https://video.dmm.co.jp/*
// @match        https://www.dmm.co.jp/*
// @match        https://*.dmm.com/*
// @match        https://fanza.jp/*
// @match        https://*.fanza.jp/*
// @match        https://www.mgstage.com/*
// @match        https://*.mgstage.com/*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      127.0.0.1
// @connect      localhost
// @connect      translate.googleapis.com
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* ============================================================================
 * FL Spider v1.3.51 —— 架构总览
 * ----------------------------------------------------------------------------
 *  资料流：
 *    javdb / missav 影片页
 *      → parseDetail()  抽取 番号 / 原名 / 演员 / 标签 / 上市时间 / 封面URL / 截图URL
 *      → googleTranslate(原名) → 中文名        （可关，源语言可配）
 *      → 图片同站 fetch → base64 dataURL
 *      → 确认弹窗（每个字段都能改，中文名可就地重翻）
 *      → 写入「Film Library 收件箱.json」（File System Access API，首次选一次文件夹）
 *    Film Library 点「读取收件箱」→ 合并入库 → 收件箱自动归档
 *
 *  附带（移植自 番号提取转换DSAI v2.0.0）：页面番号识别、五站互跳按钮、一键复制番号、
 *  广告清理与「点击穿透」（站点全屏浮层盖住按钮时自动让它不拦截点击）。
 *  搜索页：列出结果，可点「打开」进详情页；也可「打开并自动抓取」进入批量队列。
 *  批量：从文件夹读取「Film Library 待补全番号_*.json」→ 依次自动抓取。
 *
 *  ⚠ 契约：图片必须 base64 入站，Film Library 的 syncOne() 不认远程 http URL。
 * ========================================================================== */

(function () {
  'use strict';

  /* ---------- 常量 ---------- */
  const VERSION = '1.3.69';;;;;;;;;;;;           // 与 @version 保持一致；设置面板顶部会显示，便于确认装的是哪一版
  const INBOX_FILE = 'Film Library 收件箱.json';
  const ARCHIVE_FILE = 'Film Library 收件箱_已导入.json';
  const PENDING_PREFIX = 'Film Library 待补全番号_';
  const STATUS = ['未看', '想看', '已看'];
  const Q_KEY = 'fl_queue';          // 批量队列（GM 值）
  const CUR_KEY = 'fl_current';      // 当前正在处理的队列项
  const FAIL_KEY = 'fl_failed';      // 重试后仍失败的番号
  const OK_KEY = 'fl_done';          // 已成功写入收件箱的番号
  const BATCH_BK_KEY = 'fl_inbox_batch_bk';   // 批量内存批的 GM 备份：beforeunload 时落盘，恢复后并入收件箱（v1.3.43）
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ---------- 番号识别（移植自「番号提取转换DSAI v2.0.0」）---------- */
  const RE_STRICT = /[A-Za-z]{2,5}-[0-9]{2,5}/;   // 内置兜底：必须带连字符
  const RE_LOOSE  = /[A-Za-z]{2,5}-?[0-9]{2,5}/;  // 内置兜底：可不带连字符（易误匹配，默认关）
  /* 番号正则共 7 条槽位：General / FANZA / MGS / FC2 预置，X / Y / Z 留给用户自定义（留空 = 跳过该条）。
   *   RegExp-General ：3~6 位字母 + 连字符或 00 + 3~6 位数字，可带后缀 -U/-C/-E/-数字；
   *                    尾部 (?=[ \W]|$) 是零宽边界——番号后必须是分隔符或结尾（不吃字符，
   *                    URL/meta 结尾没有尾随字符时也能命中）。
   *   RegExp-FANZA  ：General 形态，且支持「数字前缀 + 厂牌 + 尾缀」形式（尾缀 2-5 位字母数字，
 *                   如影院形 403pink005ag01；无尾缀的 300MIUM451 按用户规格不命中，避免与 MGS 槽抢码）
   *   RegExp-MGS    ：数字前缀 + 厂牌字母 + 连字符 + 数字（如 300MIUM-451）
   *   RegExp-FC2    ：FC2-PPV-1234567（分隔符允许「-」或空格）
   *   v1.3.51 A-08（P3）：四条预置槽统一带尾部零宽边界 (?=[ \\W]|$)。旧版 FANZA/MGS/FC2
   *   缺边界——超长数字串被静默截短成错码（SSIS-927001 → SSIS-92700、300MIUM-45101 →
   *   300MIUM-4510），错码入库后极难发现。宁可不命中（交由其他槽位/人工），不可错码。
   *   命名组：letter / digit / fzPrefix / fzLetter / fzDigit / prefix——同一正则内组名不能重名
   *   （JS 直接语法错误，整条槽位报废），所以 FANZA 第二分支的组加 fz 前缀；当前管线只读 m[0]，
   *   命名组供设置面板说明与后续扩展使用。
   *   每站启用哪些槽位由 sources[*].codeUse 指定（2026-10-16 用户规则）：
   *     FANZA（dmm / dmmvideo）= General + FANZA；MGS = MGS；MISSAV / JAVDB = General + FC2；
   *     motv 等未配置 codeUse 的站 = 全部 7 槽。
   *   匹配策略：按该站启用的槽位全部试一遍，取「最长的命中」（长度相同时取靠前的槽位）。
   *   FANZA / MGS 命中后统一「自动转换」为 General 形态（如 300MIUM-451 → MIUM-451）。 */
  const RE_NAMES = ['RegExp-General', 'RegExp-FANZA', 'RegExp-MGS', 'RegExp-FC2', 'RegExp-X', 'RegExp-Y', 'RegExp-Z'];
  const RE_GEN_DEF   = '(?<letter>[A-Za-z]{3,6})(-|00)(?<digit>\\d{3,6})(-U)?(-C)?(-E)?(-\\d)?(?=[ \\W]|$)';
  const RE_FANZA_DEF = '(?<letter>[A-Za-z]{3,6})(-|00)(?<digit>\\d{3,5})(?=[ \\W]|$)|(?<fzPrefix>\\d{2,4})(?<fzLetter>[A-Za-z]{3,6})(?<fzDigit>\\d{3,5})(?<fzTail>[A-Za-z\\d]{2,5})(?=[ \\W]|$)';
  const RE_MGS_DEF   = '(?<prefix>\\d{2,4})(?<letter>[A-Za-z]{3,6})(-)(?<digit>\\d{2,4})(?=[ \\W]|$)';
  const RE_FC2_DEF   = '(FC2)(-| )(PPV)(-| )(\\d{3,10})(?=[ \\W]|$)';   // RegExp-FC2：FC2-PPV-1234567 / FC2 PPV 1234567
  const RE_FC2 = /FC2[- ]PPV[- ]\d{3,10}/i;               // FC2 番号判定（忽略大小写，用于「抓全部字段」）
  const DEF_RE_LIST = [
    RE_GEN_DEF,
    RE_FANZA_DEF,
    RE_MGS_DEF,
    RE_FC2_DEF,
    '', '', ''
  ];
  const RE_SLOTS = 7;   // 当前 7 条槽位：General / FANZA / MGS / FC2 / X / Y / Z

  function normCode(v) {
    let s = String(v == null ? '' : v).trim();
    /* 数字前缀+厂牌字母+数字+字母数字尾（FANZA 影院/动画形如 403pink005ag01）：
       不是 General 形态，无从转换，保留页面原始大小写（v1.3.40） */
    if (/^\d{2,4}[A-Za-z]{3,6}\d{3,5}[A-Za-z\d]{2,5}$/.test(s)) return s;
    s = s.toUpperCase();
    s = s.replace(/[^A-Z0-9\-]/g, '');
    s = s.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
    /* v1.3.66 #29：单位数字前缀的 FANZA cid（1nhdtb00063 / 1pon00063）。前缀的「1」
       是系列标识的一部分（1pond / 1nhdtb / 1pon），不能像 MGS 的 300MIUM 那样剥掉；
       但也不能留成无连字符形态——库内约定「字母-数字」，且 fanzaCodeOf 的
       ^([A-Z]+)-(\d+)$ 对它失效后会走 replace(/-/g,'') 反而拼不回正确 cid。
       在「数字+字母」与后随数字之间补连字符：1NHDTB-00063（可无损拼回 1nhdtb00063）。 */
    const m1 = /^(\d{1,4}[A-Za-z]{3,6})-?(\d{2,5})$/.exec(s);
    if (m1) s = m1[1] + '-' + m1[2];
    const m = /^([A-Z]+)-?(\d+)$/.exec(s);
    if (m) s = m[1] + '-' + m[2];
    return s;
  }

  function convert00(s) {
    const raw = String(s == null ? '' : s).trim();
    const t = raw.toUpperCase();
    const f = /^(FC2)[-\s]*(PPV)[-\s]*(\d+)/i.exec(t);
    if (f) return 'FC2-PPV-' + f[3];
    /* 数字前缀+厂牌字母+数字+字母数字尾（FANZA 影院/动画形如 403pink005ag01）：
       无对应 General 形态，原样返回并保留原始大小写（v1.3.40） */
    if (/^\d{2,4}[A-Za-z]{3,6}\d{3,5}[A-Za-z\d]{2,5}$/i.test(raw)) return raw;
    // MGS / FANZA 前缀形式：数字前缀 + 厂牌字母 + 数字 → 厂牌-数字（如 300MIUM-451 → MIUM-451）
    // 锚定 $：只有整体是「前缀+字母+(-)数字」才剥，403pink005ag01 这类带尾串的不会被砍成 pink-005
    const m = /^(\d{2,4})([A-Za-z]{3,6})-?(\d{2,5})$/.exec(t);
    if (m) return m[2] + '-' + m[3];
    // 字母 + 00 + 数字 → 字母-数字（DSOD00009 → DSOD-009）
    const m2 = /^([A-Za-z]{2,})00(\d+)/.exec(t);
    if (m2) return m2[1] + '-' + m2[2] + t.slice(m2[0].length);
    return normCode(t);
  }

  /* MGS 番号剥离前导数字前缀：如 300MIUM-451 → MIUM-451（MGS 把厂商/类别前缀 300 拼在番号前） */
  /* 番号是否命中 RegExp-FC2（FC2-PPV-xxxxxxx）。命中 -> 所有站点都抓全部字段。 */
  function isFc2Code(v) { return RE_FC2.test(String(v == null ? '' : v)); }

  /* 用一条自定义正则去匹配，返回规范番号（或空串） */
  function matchByRe(text, pat) {
    if (!pat) return '';
    let re;
    try { re = new RegExp(pat); } catch (e) { return ''; }   // 用户填的正则不合法：跳过
    const t = String(text || '');
    let m = re.exec(t);
    if (!m) {
      /* 区分大小写没命中 -> 忽略大小写再试一次（页面上常是小写 fc2-ppv-1234567） */
      try { re = new RegExp(pat, 'i'); m = re.exec(t); } catch (e2) { return ''; }
    }
    if (!m) return '';
    return convert00(m[0]);
  }
  /* 每站启用的番号正则列表：按 sources[key].codeUse 里的槽位名取 pattern；
   * 未配置 codeUse 的站点（motv 等）= 全部 7 槽。FC2 保底规则不变。 */
  function codeReListFor(cfg, srcKey) {
    const all = Array.isArray(cfg.codeRes) ? cfg.codeRes.slice() : DEF_RE_LIST.slice();
    while (all.length < RE_SLOTS) all.push('');
    let list;
    const use = (srcKey && cfg.sources && cfg.sources[srcKey] && cfg.sources[srcKey].codeUse) || null;
    if (Array.isArray(use) && use.length) {
      list = [];
      use.forEach(function (name) {
        const i = RE_NAMES.indexOf(name);
        if (i >= 0 && all[i]) list.push(all[i]);
      });
      if (!list.length) list = all.slice();      // 槽位名全配错：退回全部槽位，不至于抓不到番号
    } else {
      list = all.slice();
    }
    /* RegExp-FC2 内置保底：即使设置里那条被清空，FC2 番号也不会退化成 PPV-12345 */
    if (list.indexOf(RE_FC2_DEF) === -1) list.push(RE_FC2_DEF);
    return list;
  }
  /* 从一段文本里取番号：按「该站启用的正则（srcKey）-> 内置兜底」的顺序 */
  function matchCodeIn(text, srcKey) {
    const cfg = getCfgSafe();
    const list = codeReListFor(cfg, srcKey);
    const t = String(text || '');
    /* 该站启用的槽位全部试一遍，取「最长的命中」；长度相同时取靠前的槽位。
       这样 A 排在 B 前面也不会把 SSNI-456-C 截成 SSNI-456。 */
    let best = '', bestLen = 0;
    for (let i = 0; i < list.length; i++) {
      const r = matchByRe(t, list[i]);
      if (r && r.length > bestLen) { best = r; bestLen = r.length; }
    }
    if (best) return best;
    const re = cfg.looseCode ? RE_LOOSE : RE_STRICT;
    const m = re.exec(t);
    return m ? normCode(m[0]) : '';
  }

  /* 从页面里识别番号：URL -> meta/title/h1 -> 所有 <strong>（正则按当前站的 codeUse 选） */
  function extractCodeFromPage() {
    const sk = currentSourceKey();
    let m = matchCodeIn(location.href, sk);
    if (m) return m;
    const sels = ['meta[property="og:title"]', 'meta[name="twitter:title"]', 'title', 'h1',
                  '.title', '.video-title', '[class*="title"]'];
    for (const s of sels) {
      try {
        const el = $(s);
        if (!el) continue;
        const t = (el.tagName === 'META') ? (el.getAttribute('content') || '') : (el.textContent || '');
        m = matchCodeIn(String(t || '').trim(), sk);
        if (m) return m;
      } catch (e) {}
    }
    const strongs = $$('strong');   /* 必须用全选助手：$ 返回单个元素，for...of 会抛 not iterable（v1.3.21 修） */
    for (const el of strongs) {
      m = matchCodeIn((el.textContent || '').trim(), sk);
      if (m) return m;
    }
    return '';
  }
  function mgsCodeConvert(code) {
    const m = /^(\d{2,4})([A-Za-z]{3,6})(-)(\d{2,4})$/.exec(String(code || '').trim());
    if (m) return m[2] + m[3] + m[4];
    return code;
  }
  /* 库内 ABP-123 → FANZA ABP00123 */
  function fanzaCodeOf(code) {
    const s = normCode(code);
    const m = /^([A-Z]+)-(\d+)$/.exec(s);
    if (!m) return s.replace(/-/g, '');
    return m[1] + (m[2].length >= 5 ? m[2] : ('00000' + m[2]).slice(-5));
  }
  /* 反解：FANZA 的 ABP00123 → 库内 ABP-123。
     统一走 convert00 约定（字母+"00"+数字 → 字母-数字）：dsod00009 → DSOD-009。
     旧实现用 0*+parseInt 把前导零吃光得 DSOD-9，与规范形不符——用户历年反馈的
     「DSOD-09 未补全为 DSOD-009」短码 Bug 根源（v1.3.43 修，与 fixCode00 对齐）。 */
  function fromFanzaCode(v) {
    return convert00(v);
  }
  /* 该站点要不要用 FANZA 写法 */
  function codeForSite(src, code) {
    const c = normCode(code);
    return (src && src.xf === 'fanza') ? fanzaCodeOf(c) : c;
  }
  /* 拼搜索 URL：{origin} → 当前站点域名（适配 missav 各镜像），{code} → 按站点换算后的番号 */
  function buildSearchUrl(src, code) {
    let u = String((src && src.searchUrl) || '');
    u = u.replace(/\{origin\}/g, location.origin);
    return u.replace(/\{code\}/g, encodeURIComponent(codeForSite(src, code)));
  }
  function stamp() {
    /* v1.3.51 A-04（P3）：旧版只到日精度——同一天第二批的抓取报告/失败清单会覆盖
       第一批（同名文件整文件覆写），回退文件名更是连日期都没有。加时补到秒，
       文件名按时间可排序且不再互相覆盖。 */
    const d = new Date(), p = n => ('0' + n).slice(-2);
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' +
           p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  /* v1.3.65 #12：脚本加载时捕获一次外部 toast（供测试桩/集成用），此后不再查 window。
     旧版每次调用都 `if (window.toast)`——站点自带的 toast 库（toastr / iview Toast 等）
     会定义同名全局，把本脚本全部提示（含「写入失败」「数据已暂存」这类关键告警）
     吞掉，用户看不到任何反馈。本脚本 @run-at 默认 document-start，早于站点脚本，
     捕获到的只可能是测试桩，站点后来定义的不会生效。 */
  var _extToast = null;
  try { if (typeof window.toast === 'function') _extToast = window.toast; } catch (e) {}
  function toast(msg, type) {
    if (_extToast) { try { _extToast(msg, type); return; } catch (e) {} }
    const d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText = 'position:fixed;left:50%;top:20px;transform:translateX(-50%);' +
      'background:#222;color:#fff;padding:8px 14px;border-radius:8px;z-index:' + Z + ';font-size:13px;max-width:80vw;';
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 2600);
  }

  /* ==========================================================================
   * 配置（源站点选择器 + 翻译开关），存 GM 值，可在「⚙ 设置」里改
   * ======================================================================== */
  const CFG_V = 12;                // 配置结构版本：升级时重置选择器（保留你的开关偏好）；v11 = sources 增 codeUse（每站番号正则启用清单）；v12 = 十字段体系（fields 去 tags、增 maker/platform，release 单字段）
  const DEFAULT_CFG = {
    v: CFG_V,
    translate: true,      // 用 Google 翻译原名得到中文名
    cnSourceUrl: '',       // 中文源 URL 模板（含 {code}）；留空则只用「本地映射 + 翻译」
    imgQuality: 'origin',  // 图片质量：origin=尽量取原图（去掉尺寸参数/缩略图标记）；thumb=直接用页面上的图
    imgRetry: 2,           // 取图失败重试次数（0 = 不重试）
    imgConc: 2,            // 取图并发数（调低可避免被站点风控）
    imgDelay: 250,         // 两次取图之间的最小间隔（毫秒）
    sl: 'auto',           // 源语言 auto / ja / en
    tl: 'zh-CN',
    maxShots: 99,         // 截图最多几张：0 = 不抓截图；1-99 = 最多几张（默认 99 = 上限，等于全抓）。
                          // 适配器 maxShots 仍只许往下压；返回 0 的站点（MissAV 无样图区）恒不抓。
    autoQueue: true,      // 队列中：进详情页自动抓取并跳下一个（3 秒缓冲可取消/停止）
    queueDelay: 3000,     // 队列两条之间的间隔（毫秒），半自动模式默认 3 秒防风控
    uiScale: 0.5,         // 按钮缩放比例（相对原始尺寸；字号有 9px 下限，防止小到看不清）
    jumpBtns: true,       // 显示「番号互跳 + 复制番号」按钮组
    looseCode: false,     // 内置兜底正则是否允许不带连字符（可能误匹配）
    codeRes: DEF_RE_LIST.slice(),  // 番号正则（至少 6 条，按顺序尝试）—— 用户可在设置里改
    adBlock: true,        // 自动清理 MissAV 右下角广告 / 全屏浮层
    killCover: true,      // 点击穿透：按钮被站点浮层盖住时，按下瞬间临时隐藏该浮层
    advMode: false,       // 高级/调试模式：开启后才弹「站点结构变更」告警、记录解析诊断
    sources: {
      javdb: {
        label: 'JAVDB',
        tier: 2,
        test: 'javdb',
        codeUse: ['RegExp-General', 'RegExp-FC2'],   // 每站启用哪些番号正则（2026-10-16 用户规则）
        // javdb 直接用库内写法 ABP-123（FANZA 才需要转成 ABP00123）
        searchUrl: 'https://javdb.com/search?q={code}&f=all',
        fields: { title:true, titleCn:true, actor:true, series:true, director:true, maker:true, cover:true, shots:true, release:true, platform:true },
        sel: {
          title: 'h2.title, .movie-title h2, h2 strong.current-title',
          cover: '.movie-info-cover img, .cover img, img.video-cover',
          actor: 'a[href*="/actor"]',
          tags:  'a[href*="/genre"]',
          shots: '.preview-images img, .tile-item img, .swiper-slide img',
          info:  '.movie-panel-info, .panel, .movie-info, div.column',
          series: 'div.panel-block',                    // 系列（按「系列:」标签定位，剥掉标签）
          result:'.movie-list .item, .video-list .item, .item-list .item'
        }
      },
      /* MISSAV —— 选择器按 2026-10-07 真实 DOM 样本固化（missav.ws/dm85/cn/jul-296）；
         2026-10-16 用户实测（missav.ws/dm13/mium-637，繁體界面）：日文原名在信息区
         「標題:」行的 span.font-medium 里，og:title 反而是中文名。titleInfo 必须简/繁
         两种标签都认（只配简体在繁体界面整站匹配失败）；title/titleCn 门控由此前
         false 改 true——false 时 gateFields 把标题清空，入库 25 条 title 全为空。 */
      missav: {
        label: 'MissAV',
        tier: 2,
        test: 'missav',
        codeUse: ['RegExp-General', 'RegExp-FC2'],
        searchUrl: '{origin}/search/{code}',
        fields: { title:true, titleCn:true, actor:true, series:true, director:true, maker:true, cover:false, shots:false, release:true, platform:true },
        sel: {
          titleInfo: '标题|標題',                 // 信息区「标题: / 標題:」= 日文原名（简/繁界面都要认）
          title: 'h1, .text-xl',
          titleCn: 'meta[property="og:title"]',   // og:title 本身就是中文名，无需再翻译
          cover: 'meta[property="og:image"]',
          actor: '.space-y-2 a[href*="/actresses/"]',
          tags:  '.space-y-2 a[href*="/genres/"]',
          shots: '',                               // MISSAV 详情页没有样图区，截图靠 javdb/FANZA 补
          info:  '.space-y-2',
          series: 'div.text-secondary',                  // 系列
          result:'.thumbnail.group'
        }
      },
      /* MOTV —— 选择器为常规猜测值（拿到真实 DOM 后用「导出 DOM 样本」校准） */
      motv: {
        label: 'MOTV',
        tier: 2,
        test: 'motv',
        searchUrl: 'https://motv.app/search?q={code}',
        fields: { title:false, titleCn:false, actor:true, series:false, director:false, maker:false, cover:false, shots:false, release:false, platform:true },
        sel: {
          title: 'h1, meta[property="og:title"]',
          cover: 'meta[property="og:image"]',
          actor: 'a[href*="/actress"], a[href*="/actor"]',
          tags:  'a[href*="/genre"], a[href*="/tag"]',
          shots: '',
          info:  'main, .info, .detail',
          result:'a[href*="/video/"], .video-item a, .card a'
        }
      },
      /* FANZA動画 video.dmm.co.jp —— 选择器按 2026-10-07 真实 DOM 样本固化；
         2026-10-16 复核（SUN-072A「只抓到 1 张截图」排查结论）：选择器无误，
         该片 CDN 仅有 pl.jpg 单张样图（jp-N / -N 系列全部 404），1 张即正确结果。
         FANZA 样图命名规律：pl.jpg=首图（海报大图）、jp-N.jpg=第 2 张起（N 从 2 计），
         样图缩略图外层常包指向原图的 <a>（shotSrcOf 已优先取 a[href]）。 */
      dmmvideo: {
        label: 'FANZA動画 (video.dmm.co.jp)',
        tier: 1,
        test: 'video.dmm.co.jp',
        xf: 'fanza',                  // 番号转换：库内 ABP-123 → FANZA ABP00123
        codeUse: ['RegExp-General', 'RegExp-FANZA'],
        searchUrl: 'https://video.dmm.co.jp/list/?key={code}',
        fields: { title:true, titleCn:true, actor:true, series:true, director:true, maker:true, cover:true, shots:true, release:true, platform:true },
        sel: {
          title: 'meta[property="og:title"], h1',
          cover: 'meta[property="og:image"]',
          actor: 'td a[href*="actress="], div.flex.flex-col.gap-4.grow.basis-44.min-w-\\[248px\\] a[href*="actress="]',   // 旧表格页 + 新规格容器（2026-10-17）双覆盖
          tags:  'td a[href*="?genre="]',
          shots: 'img[alt*="サンプル画像"]',
          series: 'a[href*="series="]',
          info:  'div.flex.flex-col.gap-4.grow.basis-44.min-w-\\[248px\\], table',   // 规格字段容器（用户 2026-10-17 指定）优先，table 兜底
          result:'a[href*="/av/content/?id="]'
        }
      },
      /* FANZA通販 www.dmm.co.jp（DVD/配信商店） */
      dmm: {
        label: 'FANZA (www.dmm.co.jp)',
        tier: 1,
        test: ['dmm.co.jp', 'fanza.jp'],
        xf: 'fanza',                  // 番号转换：库内 ABP-123 → FANZA ABP00123
        codeUse: ['RegExp-General', 'RegExp-FANZA'],
        searchUrl: 'https://www.dmm.co.jp/digital/videoa/-/search/=/searchstr={code}',
        fields: { title:true, titleCn:true, actor:true, series:true, director:true, maker:true, cover:true, shots:true, release:true, platform:true },
        sel: {
          title: '#title, .hreview h1, meta[property="og:title"]',
          cover: '.package img, meta[property="og:image"]',
          actor: 'a[href*="/actress/"], #performer a, td a[href*="actress"]',
          tags:  'a[href*="/genre/"], .genre a',
          shots: '#sample-image-block img, .mg-b20 img, .sample-image img',
          series: 'a[href*="article=series"], a[href*="series="]',
          info:  'div.flex.flex-col.gap-4.grow.basis-44.min-w-\\[248px\\], #detail-content, .mg-b20, table.mg-b20, .hreview',   // 规格字段容器（用户 2026-10-17 指定）优先
          result:'a[href*="/digital/videoa/-/detail/"]'
        }
      },
      /* MGS —— 选择器按 2026-10-11 mgstage.com 详情页样本固化；番号形如 300MIUM-451 */
      mgs: {
        label: 'MGS',
        test: 'mgstage.com',
        tier: 1,
        codeUse: ['RegExp-MGS'],
        searchUrl: 'https://www.mgstage.com/search/cSearch.php?search_word={code}&search_shop_id=&type=top',
        fields: { title:true, titleCn:true, actor:true, series:true, director:true, maker:true, cover:true, shots:true, release:true, platform:true },
        sel: {
          title: 'h1.tag',
          cover: 'img.enlarge_image',
          actor: 'a[href*="/cSearch.php?actor"]',
          tags:  'a[href*="/cSearch.php?genre"]',
          shots: 'a.sample_image',
          info:  '.detail_data, table',
          series: 'a[href*="/cSearch.php?series"]',
          director: 'td a[href*="director="]',
          result: 'a[href*="/product_detail/"]'
        }
      }
    }
  };

  /* v1.3.66 #25：读配置失败时的兜底。旧版只有 3 个字段——GM 存储损坏/JSON 解析抛错时
     sources/maxShots/imgConc/imgDelay/advMode 全 undefined：shotCandidateLimit 退化到
     99 张、imgGate 限速归 0（全速抓图，极易触发站点风控）、结构告警全静默——
     「读配置失败」不报错，而是变成一次高风险全速抓取。改为默认配置深拷贝 +
     节流提示（getCfgSafe 在启动路径被高频调用，10s 内只提示一次）。 */
  let _cfgSafeWarnAt = 0;
  function getCfgSafe() {
    try { return getCfg(); } catch (e) {
      try {
        const now = Date.now();
        if (now - _cfgSafeWarnAt > 10000) {
          _cfgSafeWarnAt = now;
          toast('配置读取失败，已临时使用默认值（' + ((e && e.message) || e) + '）', 'err');
        }
      } catch (e2) {}
      try { return JSON.parse(JSON.stringify(DEFAULT_CFG)); } catch (e3) { return { looseCode: false, uiScale: 0.5, codeRes: [] }; }
    }
  }
  function getCfg() {
    let c = null;
    try { c = JSON.parse(GM_getValue('fl_cfg', 'null')); } catch (e) { c = null; }
    if (!c || !c.sources) {
      /* 无存储配置（全新安装或配置损坏）：以默认重建，但同样过一次性迁移并落盘——
         早期直接 return 默认副本不写 _reV7 标记，用户首次保存后下次 getCfg 会把
         codeRes 当旧配置重置，静默丢掉自定义正则（settings_re_test 抓到）。 */
      const fresh = JSON.parse(JSON.stringify(DEFAULT_CFG));
      migrateLegacy(fresh);
      GM_setValue('fl_cfg', JSON.stringify(fresh));
      return fresh;
    }
    if (c.v !== CFG_V) {
      /* 大版本升级：以默认重建 sources，但保留用户手动调过的开关 */
      const keep = ['translate', 'sl', 'tl', 'maxShots', 'autoQueue', 'queueDelay',
                    'uiScale', 'jumpBtns', 'looseCode', 'adBlock', 'killCover',
                    'codeRes', 'cnSourceUrl', 'fc2Re', 'advMode',
                    'imgQuality', 'imgRetry', 'imgConc', 'imgDelay'];
      const fresh = JSON.parse(JSON.stringify(DEFAULT_CFG));
      keep.forEach(k => { if (c[k] !== undefined) fresh[k] = c[k]; });
      /* v1.3.64 #5：迁移标记（_reV7 及未来 _reV8…）必须随配置保留。旧版只 keep 业务键，
         标记丢失后 fresh（来自 DEFAULT_CFG，本身无标记）过 migrateLegacy 时 _reV7 分支
         重新触发：刚 keep 进来的用户自定义 codeRes 被整体重置为 DEF_RE_LIST，并写盘
         _reV7=1 —— 用户正则被静默清掉且不可恢复、无任何提示。 */
      Object.keys(c).forEach(k => { if (/^_re/.test(k)) fresh[k] = c[k]; });
      /* v1.3.65 #6：合并用户自定义 sources——旧版「以默认重建 sources」把用户在设置面板
         改过的选择器、手动新增的站点源整体丢弃，且无任何提示。合并口径：
         ① 默认站：用户 sel / fields 的键覆盖默认（默认里的新键补上，站点加选择器不丢）；
         ② 用户新增的站（默认里没有的 key）：整体保留。 */
      if (c.sources && typeof c.sources === 'object') {
        Object.keys(c.sources).forEach(k => {
          const u = c.sources[k];
          if (!u || typeof u !== 'object') return;
          if (!fresh.sources[k]) { fresh.sources[k] = JSON.parse(JSON.stringify(u)); return; }
          const d = fresh.sources[k];
          fresh.sources[k] = Object.assign({}, d, u, {
            sel: Object.assign({}, d.sel || {}, (u && u.sel) || {}),
            fields: Object.assign({}, d.fields || {}, (u && u.fields) || {})
          });
        });
      }
      migrateLegacy(fresh);
      GM_setValue('fl_cfg', JSON.stringify(fresh));
      return fresh;
    }
    /* 同版本：补缺省 + 一次性迁移旧字段（幂等） */
    Object.keys(DEFAULT_CFG).forEach(k => {
      if (c[k] === undefined) c[k] = Array.isArray(DEFAULT_CFG[k]) ? DEFAULT_CFG[k].slice() : DEFAULT_CFG[k];
    });
    migrateLegacy(c);
    while (c.codeRes.length < RE_SLOTS) c.codeRes.push('');
    Object.keys(DEFAULT_CFG.sources).forEach(k => {
      const d = DEFAULT_CFG.sources[k];
      if (!c.sources[k]) { c.sources[k] = JSON.parse(JSON.stringify(d)); return; }
      if (!c.sources[k].fields) c.sources[k].fields = JSON.parse(JSON.stringify(d.fields || {}));
      if (c.sources[k].tier === undefined) c.sources[k].tier = d.tier;
      if (c.sources[k].codeUse === undefined && d.codeUse) c.sources[k].codeUse = d.codeUse.slice();
      c.sources[k].sel = c.sources[k].sel || {};
      Object.keys(d.sel || {}).forEach(sk => { if (c.sources[k].sel[sk] === undefined) c.sources[k].sel[sk] = d.sel[sk]; });
    });
    return c;
  }
  /* 保存配置（GM 持久化）：先前多处调用却从未定义，导致「保存」按钮点击无反应 */
  /* v1.3.55：返回是否写成功。旧版吞掉所有异常且无返回值——设置面板照常 toast
     「已保存」，GM 写入失败（配额满/隐私模式/存储损坏）时用户配置静默丢失。 */
  function setCfg(c) {
    try { GM_setValue('fl_cfg', JSON.stringify(c)); return true; }
    catch (e) { console.error('[FL Spider] 配置写入失败', e); return false; }
  }
  /* 旧配置一次性迁移（幂等）：v7 删除旧番号正则、重置为新 7 槽位（General / FANZA / MGS / FC2 / X / Y / Z）。 */
  function migrateLegacy(c) {
    let changed = false;
    if (!Array.isArray(c.codeRes)) {
      const a = [String(c.codeRe1 || ''), String(c.codeRe2 || '')];
      delete c.codeRe1; delete c.codeRe2;
      c.codeRes = a; changed = true;
    }
    // v7：删除旧的番号正则，统一改用新 7 槽位命名（General / FANZA / MGS / FC2 / X / Y / Z）
    if (!c._reV7) {
      c.codeRes = DEF_RE_LIST.slice();
      c._reV7 = 1; changed = true;
    }
    /* v1.3.49 BUG-23（P2）：不再把用户正则砍到 RE_SLOTS 条——旧版 slice(0, RE_SLOTS)
       会把第 8 条及以后的自定义正则静默丢弃（设置面板只显示 7 条，多配的那条
       从未生效，用户以为配上了却没生效）。现在只补齐不足的槽位，多余的保留。 */
    const cleaned = c.codeRes.filter(function (x) { return typeof x === 'string'; });
    while (cleaned.length < RE_SLOTS) cleaned.push('');
    if (cleaned.join('\u0001') !== (c.codeRes || []).join('\u0001')) { c.codeRes = cleaned; changed = true; }
    if (c.reLayout3 !== undefined) { delete c.reLayout3; changed = true; }
    if (c.reLayout4 !== undefined) { delete c.reLayout4; changed = true; }
    if (c._reorg8 !== undefined) { delete c._reorg8; changed = true; }
    if (changed) {
      /* v1.3.66 #26：迁移结果写不进去时不再静默——GM 配额满/隐私模式下旧版每次
         getCfg 都重新迁移、重新失败，配置永远停留在旧形态（且 _reV7 没落盘 →
         每次启动都重置一次 codeRes，与 #5 叠加成「自定义正则天天丢」）。 */
      try { GM_setValue('fl_cfg', JSON.stringify(c)); }
      catch (e) { console.error('[FL Spider] 配置迁移写入失败：', e); toast('配置迁移写入失败（浏览器存储可能已满），部分旧设置未更新', 'err'); }
    }
    return c;
  }

  /* ==========================================================================
   * 按钮缩放（uiScale，默认 0.5 = 原始尺寸的一半）
   *   内边距 / 圆角 / 间距 / 直径 严格按比例缩放；
   *   字号按比例缩放但设 9px 下限 —— 13px 的一半是 6.5px，实际不可读。
   * ======================================================================== */
  function uiS() {
    const v = parseFloat(getCfgSafe().uiScale);
    return (v > 0.2 && v <= 1.5) ? v : 0.5;
  }
  function sPx(v, min) { return Math.max(min == null ? 1 : min, Math.round(v * uiS())) + 'px'; }
  function sFs(v, min) { return Math.max(min == null ? 9 : min, Math.round(v * uiS())) + 'px'; }
  /* 悬浮按钮样式 */
  function btnCss(bg, extra) {
    return 'background:' + bg + ';color:#fff;border:none;' +
      'padding:' + sPx(9, 2) + ' ' + sPx(13, 4) + ';border-radius:' + sPx(10, 3) + ';' +
      'font-size:' + sFs(13, 9) + ';line-height:1.25;cursor:pointer;' +
      'box-shadow:0 2px 7px rgba(0,0,0,.32);' + (extra || '');
  }
  /* 圆形小按钮（互跳 / 复制） */
  function roundCss(bg, extra) {
    const d = Math.max(24, Math.round(80 * uiS()));
    return 'width:' + d + 'px;height:' + d + 'px;padding:0;margin:0;border:none;border-radius:50%;' +
      'background:' + bg + ';color:#fff;font-size:' + sFs(28, 13) + ';font-weight:700;line-height:1;' +
      'display:inline-flex;align-items:center;justify-content:center;cursor:pointer;' +
      'box-shadow:0 2px 7px rgba(0,0,0,.32);' + (extra || '');
  }
  /* 图标（无文字）方形按钮：用于右侧竖排的主操作按钮，直径随 uiScale 缩放（默认比旧文字按钮小约一半） */
  function iconBtnCss(bg) {
    const d = Math.max(24, Math.round(80 * uiS()));
    return 'width:' + d + 'px;height:' + d + 'px;padding:0;margin:0;border:none;border-radius:' + sPx(20, 5) + ';' +
      'background:' + bg + ';color:#fff;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;' +
      'box-shadow:0 2px 7px rgba(0,0,0,.32);';
  }
  function ico(name) {
    const m = {
      save: '<path d="M12 3v11m0 0l-4-4m4 4l4-4M5 19h14" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
      list: '<rect x="5" y="4" width="14" height="16" rx="2" stroke="#fff" stroke-width="2" fill="none"/><path d="M9 9h6M9 13h6M9 17h4" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
      dom:  '<path d="M7 3h7l4 4v14H7z" stroke="#fff" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M10 8h4M10 12h4M10 16h4" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
      gear: '<circle cx="12" cy="12" r="3.2" stroke="#fff" stroke-width="2" fill="none"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.2 5.2l1.8 1.8M17 17l1.8 1.8M18.8 5.2L17 7M7 17l-1.8 1.8" stroke="#fff" stroke-width="2" stroke-linecap="round"/>'
,
      form: '<rect x="4" y="3" width="16" height="18" rx="2" stroke="#fff" stroke-width="2" fill="none"/><path d="M8 8h8M8 12h8M8 16h4" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
      queue: '<path d="M12 3l8.5 4.5L12 12 3.5 7.5 12 3z" stroke="#fff" stroke-width="2" fill="none" stroke-linejoin="round"/><path d="M4 12.6L12 16.9l8-4.3M4 16.9L12 21.1l8-4.2" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    };
    return '<svg viewBox="0 0 24 24" width="62%" height="62%" fill="none">' + (m[name] || '') + '</svg>';
  }
  /* ==========================================================================
   * v1.3.52 站点 CSS 免疫（用户报「MISSAV 的 #fl-box 太大，参考 FANZA」）
   *   盒子代码全站同一份，站点间视觉差异全部来自站点样式表覆盖我们「没设」的属性。
   *   Chrome 实测三类代表规则：div{min-width:150px} 把番号标签撑到 150px 宽（整盒
   *   49→150）；body{zoom:1.6} 整盒放大 60%；button{width:80px!important} 直接
   *   吃掉 40px 按钮。普通内联打不过样式表 !important，内联 !important 打得过任何
   *   样式表规则 —— 故把尺寸关键声明逐属性升级为 important。
   * ======================================================================== */
  var BOX_HARD = ['position', 'z-index', 'display', 'flex-direction', 'gap', 'align-items',
    'font-family', 'pointer-events', 'cursor', 'user-select',
    'width', 'min-width', 'max-width', 'font-size', 'line-height',
    'margin', 'padding', 'border', 'box-sizing'];
  var TAG_HARD = ['background', 'color', 'padding', 'border-radius', 'font-size', 'font-weight',
    'letter-spacing', 'width', 'min-width', 'max-width', 'line-height',
    'margin', 'border', 'box-sizing'];
  var ROW_HARD = ['display', 'flex-direction', 'gap', 'align-items', 'width', 'min-width', 'max-width',
    'margin', 'padding', 'border', 'box-sizing'];
  var HR_HARD = ['width', 'height', 'background', 'margin', 'border', 'padding', 'min-width'];
  var BTN_HARD = ['width', 'height', 'padding', 'margin', 'border', 'border-radius', 'background',
    'color', 'font-size', 'font-weight', 'line-height', 'font-family', 'display', 'align-items',
    'justify-content', 'cursor', 'box-shadow', 'min-width', 'max-width', 'box-sizing', 'flex',
    'white-space'];
  /* 把 el 当前内联值按 important 重新落一遍（只升已声明的属性，不新增语义） */
  function hardenStyle(el, props) {
    try {
      for (var i = 0; i < props.length; i++) {
        var v = el.style.getPropertyValue(props[i]);
        if (v) el.style.setProperty(props[i], v, 'important');
      }
    } catch (e) {}
  }
  /* 圆形/图标按钮：补齐四个内联未设、但站点常设的属性后再整体升级 */
  function hardBtn(b) {
    try {
      b.style.minWidth = '0'; b.style.maxWidth = 'none'; b.style.boxSizing = 'border-box';
      b.style.flex = '0 0 auto'; b.style.whiteSpace = 'nowrap';
      if (!b.style.getPropertyValue('font-family'))
        b.style.fontFamily = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
      /* 图标按钮没设过字号（只放 svg）——不设就会被站点 button{font-size!important}
         直接命中：继承打不赢任何直接选中按钮的规则（实测中招 24px） */
      if (!b.style.getPropertyValue('font-size')) b.style.fontSize = '13px';
      hardenStyle(b, BTN_HARD);
    } catch (e) {}
  }
  /* 站点对 html/body 设 zoom（整页缩放）时固定盒子会跟着大 → 读生效 zoom 反向抵消。
   * 注意：zoom 不 inheritance 进 computed style（html 设 1.6 时 body 仍报 1），
   * 生效值 = html 的乘积 × body 的乘积，两个都要读。 */
  function counterBodyZoom(box) {
    try {
      var z = 1;
      var hz = parseFloat(getComputedStyle(document.documentElement).zoom);
      if (hz && hz > 0) z *= hz;
      var bz = parseFloat(getComputedStyle(document.body || document.documentElement).zoom);
      if (bz && bz > 0) z *= bz;
      if (Math.abs(z - 1) > 0.01) box.style.setProperty('zoom', String(Math.round(1000 / z) / 1000), 'important');
    } catch (e) {}
  }
  /* 事后缩放：把已插入 DOM 的按钮（弹窗 / 面板）按同一比例缩一遍 */
  function scaleButtonsIn(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('button').forEach(b => {
      if (b.getAttribute('data-fl-sc')) return;
      b.setAttribute('data-fl-sc', '1');
      const cs = getComputedStyle(b);
      const s = uiS();
      const pt = parseFloat(cs.paddingTop) || 0, pl = parseFloat(cs.paddingLeft) || 0;
      const fs0 = parseFloat(cs.fontSize) || 13, r = parseFloat(cs.borderTopLeftRadius) || 0;
      b.style.paddingTop = Math.max(2, pt * s) + 'px';
      b.style.paddingBottom = Math.max(2, pt * s) + 'px';
      b.style.paddingLeft = Math.max(4, pl * s) + 'px';
      b.style.paddingRight = Math.max(4, pl * s) + 'px';
      b.style.fontSize = Math.max(9, fs0 * s) + 'px';
      if (r) b.style.borderRadius = Math.max(3, r * s) + 'px';
    });
  }

  function currentSourceKey() {
    const h = location.hostname;
    const cfg = getCfg();
    const keys = Object.keys(cfg.sources);
    for (let i = 0; i < keys.length; i++) {
      const _t = cfg.sources[keys[i]].test;
      const _hit = Array.isArray(_t) ? _t.some(x => h.indexOf(x) !== -1) : (h.indexOf(_t) !== -1);
      if (_hit) return keys[i];
    }
    return null;
  }

  /* ==========================================================================
   * Google 翻译：原名 → 中文名
   * 用 GM_xmlhttpRequest 绕过 CORS。client=gtx 是网页版翻译用的公开端点。
   * ======================================================================== */
  function googleTranslate(text, sl, tl) {
    return new Promise((resolve) => {
      /* v1.3.65 #13：竞速兜底。旧版只依赖 GM 的 timeout 参数——若 GM_xmlhttpRequest
         因任何原因不回调（脚本管理器异常/被页面拦截），Promise 永不 settle，调用方
         await 永久挂起（确认弹窗「重新翻译」无结果无提示；parseDetail 的中文名四级链
         卡死）。与 httpJson / fetchCnFromSource 同口径。 */
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { clearTimeout(_race); } catch (e) {} resolve(v || ''); };
      const _race = setTimeout(() => fin(''), 16000);
      text = String(text || '').trim();
      if (!text) return fin('');
      const url = 'https://translate.googleapis.com/translate_a/single?client=gtx' +
        '&sl=' + encodeURIComponent(sl || 'auto') +
        '&tl=' + encodeURIComponent(tl || 'zh-CN') +
        '&dt=t&ie=UTF-8&oe=UTF-8&q=' + encodeURIComponent(text);
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          headers: { 'User-Agent': navigator.userAgent, 'Accept': 'application/json' },
          timeout: 15000,
          onload(r) {
            try {
              const j = JSON.parse(r.responseText);
              let out = '';
              (j[0] || []).forEach(seg => { if (seg && seg[0]) out += seg[0]; });
              fin(out.trim());
            } catch (e) { fin(''); }
          },
          onerror() { fin(''); },
          ontimeout() { fin(''); },
          onabort() { fin(''); }
        });
      } catch (e) { fin(''); }
    });
  }

  /* ==========================================================================
   * 文件桥接：在影片站点选一次 film-library 文件夹，句柄存 IndexedDB
   * ======================================================================== */
  const FS_DB = 'fl_crawler_fs';

  function idbOpenFL() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(FS_DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('dir')) req.result.createObjectStore('dir');
      };
      req.onsuccess = () => {
        const db = req.result;
        /* v1.3.64 #3：版本变更时主动关连接——否则将来 DB 升级版本（open 传 2）时，
           旧版本连接不关会一直阻塞 upgrade。 */
        try { db.onversionchange = () => { try { db.close(); } catch (e) {} }; } catch (e) {}
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      /* v1.3.64 #3：缺 onblocked 时，DB 需升级而别处（另一标签页）持有旧连接 →
         open 既不 success 也不 error，Promise 永不 settle → await ensureFolder()
         永久挂起，整个抓取静默卡死（无超时无提示）。 */
      req.onblocked = () => reject(new Error('IndexedDB 被其他标签页占用，请关闭其他标签页后重试'));
    });
  }
  /* v1.3.64 #3：统一的「开连接 → 用完即关」包装。旧版 idbPutFL/idbGetFL/idbDelFL/
     resetFolder 各自 idbOpenFL() 且从不 db.close()——同源 IDB 连接数有上限，批量模式下
     连接随条目线性增长，满后新 open hang 或抛错。 */
  function idbTx(mode, fn) {
    return idbOpenFL().then(db => new Promise((res, rej) => {
      let settled = false;
      const done = (v, isErr) => {
        if (settled) return;
        settled = true;
        try { db.close(); } catch (e) {}
        isErr ? rej(v) : res(v);
      };
      try {
        const tx = db.transaction('dir', mode);
        fn(tx, done);
      } catch (e) { done(e, true); }
    }));
  }
  function idbPutFL(v) {
    return idbTx('readwrite', (tx, done) => {
      tx.objectStore('dir').put(v, 'handle');
      tx.oncomplete = () => done(true);
      tx.onerror = () => done(tx.error, true);
    });
  }
  function idbGetFL() {
    return idbTx('readonly', (tx, done) => {
      const rq = tx.objectStore('dir').get('handle');
      rq.onsuccess = () => done(rq.result || null);
      rq.onerror = () => done(null);
    });
  }

  let folderHandle = null;
  function permQuery(h) {
    if (!h || !h.queryPermission) return 'none';
    try { return h.queryPermission({ mode: 'readwrite' }); } catch (e) { return 'none'; }
  }
  async function permRequest(h) {
    if (!h || !h.requestPermission) return 'denied';
    try { return await h.requestPermission({ mode: 'readwrite' }); } catch (e) { return 'denied'; }
  }
  /* 环境自检：为什么弹不出文件夹选择框（115 等国产内核常见） */
  function fsEnvDiag() {
    try {
      if (window.top !== window.self) return '页面被嵌在框架里，请在新标签页打开';
      if (!window.isSecureContext) return '不是安全上下文，页面需用 http(s) 打开';
      if (typeof window.showDirectoryPicker !== 'function') {
        return '浏览器没有文件夹直连接口（File System Access API），请用 Chrome / Edge 桌面版';
      }
      return '';
    } catch (e) { return '环境检测失败'; }
  }
  let _folderInflight = null;   /* v1.3.64 #4：ensureFolder 的 in-flight 去重句柄 */
  async function ensureFolder() {
    /* v1.3.64 #4：in-flight 去重。folderHandle 只在所有 await 之后才赋值，两个并发调用
       （recoverBatchBackup × 用户点保存、readJsonFromFolder × writeJsonToFolder）都会看到
       folderHandle === null：各自 idbGetFL 且都走到 showDirectoryPicker——第二次弹框在
       Chrome 抛错被捕获后 toast「选择文件夹失败」，用户只取消一次却收到莫名失败提示，
       且其中一条抓取链路中断。 */
    if (_folderInflight) return _folderInflight;
    _folderInflight = _ensureFolderInner();
    try { return await _folderInflight; }
    finally { _folderInflight = null; }
  }
  async function _ensureFolderInner() {
    if (folderHandle && (await permQuery(folderHandle)) === 'granted') return folderHandle;
    if (!folderHandle) { try { folderHandle = await idbGetFL(); } catch (e) { folderHandle = null; } }
    if (folderHandle) {
      let p = await permQuery(folderHandle);
      if (p === 'prompt') p = await permRequest(folderHandle);
      if (p === 'granted') return folderHandle;
      /* v1.3.57 #8：denied 时不再 fallthrough 到 showDirectoryPicker。
         Chrome 的「阻止」态会持续：旧版每次写入都弹一次系统选择框（用户实测骚扰，
         A-01 的承诺只落实在 hasAuthorizedFolder）。改为抛错+指引——各调用方本来
         就有 catch / guardAct 兜底，句柄也不删（idb 里留着，误点阻止也能恢复）。
         注意：此处只抛不 toast，提示交给调用方，避免和它们的 catch 文案叠成双提示。 */
      folderHandle = null;
      if (p === 'denied') {
        throw new Error('文件夹授权已被拒绝：请点蜘蛛盒子「设置」里的重新授权文件夹后重试（句柄已保留，不会丢数据）');
      }
    }
    const why = fsEnvDiag();
    if (why) {
      toast('无法选择文件夹：' + why, 'err');
      throw new Error(why);
    }
    try {
      folderHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) {
      if (e && e.name !== 'AbortError') {
        toast('选择文件夹失败：' + (e.name ? e.name + ' — ' : '') + ((e && e.message) || e), 'err');
      }
      throw e;
    }
    await idbPutFL(folderHandle);
    return folderHandle;
  }
  /* v1.3.51 A-01（P2）：只探测「已授权文件夹」，绝不弹系统目录选择框。
     ensureFolder 在没有句柄/未授权时会 showDirectoryPicker——批量备份恢复只是被动
     重试，不该在用户打开一个普通影片页面时突然弹框（取消后每次进站还弹，用户实测骚扰）。
     未授权就返回 false：保留 GM 备份，下次进站/用户授权后自然重试，数据不丢。 */
  async function hasAuthorizedFolder() {
    try {
      if (!folderHandle) { try { folderHandle = await idbGetFL(); } catch (e) { folderHandle = null; } }
      if (!folderHandle) return false;
      return (await permQuery(folderHandle)) === 'granted';
    } catch (e) { return false; }
  }
  async function resetFolder() {
    folderHandle = null;
    try {
      await idbTx('readwrite', (tx, done) => {   /* v1.3.64 #3：走统一包装，用完关连接 */
        tx.objectStore('dir').delete('handle');
        tx.oncomplete = () => done(true);
        tx.onerror = () => done(false);
      });
    } catch (e) { /* 静默：断开连接时清 IndexedDB 失败无副作用（重连会覆盖旧句柄）*/ }
  }

  async function readJsonFromFolder(name) {
    const h = await ensureFolder();
    try {
      const fh = await h.getFileHandle(name);
      return JSON.parse(await (await fh.getFile()).text());
    } catch (e) {
      /* v1.3.55：只有「真不存在」才算空收件箱。旧版把 IO 错误/文件被占用/JSON 损坏
         一律吞成 null，四个调用方 `|| {}` 后整文件覆写 —— 读失败 = 收件箱历史条目被
         清空且无备份可恢复。其余错误原样抛出，让调用方走重试/下载兜底/保留备份。 */
      if (e && e.name === 'NotFoundError') return null;
      throw e;
    }
  }
  async function writeJsonToFolder(name, payload) {
    const h = await ensureFolder();
    const fh = await h.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    /* v1.3.64 #2：createWritable 会对文件加锁——旧版 write 抛错（配额/磁盘占用/页面卸载）
       时 close/abort 都不执行，锁挂到流被 GC，此后写同名文件恒抛 NoModificationAllowedError
       （v1.3.55 起 readJson 不再吞错 → 一次失败让整条写入链持续不可用，且提示是误导性的
       锁错误）。abort 后再 close 会抛，被各自的 try 吞掉。 */
    try {
      await w.write(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    } catch (e) {
      try { await w.abort(); } catch (_) {}
      throw e;
    } finally {
      try { await w.close(); } catch (_) {}
    }
  }
  /* v1.3.66 #27：遍历中途抛错（句柄失效/权限被撤/目录被移动）时旧版返回已收集的
     前缀子集且无标记——调用方扫「待补全番号_*.json」漏文件，用户以为没有待补全
     任务。改为返回 {names, partial}，partial=true 时调用方明示目录读取不完整。 */
  async function listFolderNames() {
    const h = await ensureFolder();
    const out = [];
    let partial = false;
    try {
      for await (const [name] of h.entries()) out.push(name);
    } catch (e) { partial = true; console.warn('[FL Spider] 目录遍历中断，返回部分列表：', e); }
    return { names: out, partial: partial };
  }

  function bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  }
  /* GM 跨域取图（DMM 的图在 awsimgsrc.dmm.co.jp，普通 fetch 会被 CORS 拦） */
  function gmFetchImage(url) {
    return new Promise((resolve) => {
      try {
        GM_xmlhttpRequest({
          method: 'GET',
          url: url,
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: { 'Accept': 'image/avif,image/webp,image/*,*/*;q=0.8' },
          onload(r) {
            if (r.status >= 200 && r.status < 300 && r.response && r.response.byteLength) {
              const h = String(r.responseHeaders || '');
              const mm = /content-type\s*:\s*([^;\r\n]+)/i.exec(h);
              const type = mm ? mm[1].trim() : 'image/jpeg';
              resolve('data:' + type + ';base64,' + bufToB64(r.response));
            } else resolve(null);
          },
          onerror() { resolve(null); },
          onabort() { resolve(null); },   /* v1.3.58 #17：缺它时请求被中止 Promise 永不 settle */
          ontimeout() { resolve(null); }
        });
      } catch (e) { resolve(null); }
    });
  }
  /* 取图 → base64 dataURL：GM 跨域优先，失败回落同源 fetch */
  /* ==========================================================================
   * #25 封面/截图质量
   *   · 原图模式：去掉 URL 里的尺寸参数（?w=&h=）与常见缩略图标记（/thumb/、_s.、-s.）
   *   · 关键帧：截图候选多于上限时，按首尾 + 中间均匀取样，而不是只取前 N 张
   *   · 失败重试 + 最小间隔限速 + 并发上限：避免密集请求被站点风控
   * ======================================================================== */
  function upgradeImgUrl(u) {
    let t = String(u || "").trim();
    if (!t) return "";
    try {
      const q = t.indexOf("?");
      if (q >= 0) {
        const base = t.slice(0, q);
        const qs = t.slice(q + 1).split("&").filter(p => {
          const k = p.split("=")[0].toLowerCase();
          return ['w', 'h', 'width', 'height', 'size', 's', 'maxwidth', 'maxheight'].indexOf(k) < 0;
        });
        t = base + (qs.length ? ("?" + qs.join("&")) : "");
      }
    } catch (e) {}
    // 缩略图路径/后缀 → 原图
    t = t.replace(/\/(?:thumbs?|thumbnails?|small|mini)\/([^/]+)$/i, '/$1');
    t = t.replace(/_s(\.(?:jpe?g|png|webp))$/i, '$1');
    t = t.replace(/-s(\.(?:jpe?g|png|webp))$/i, '$1');
    t = t.replace(/\.thumb(\.(?:jpe?g|png|webp))$/i, '$1');
    /* FANZA/dmm 特例（2026-10-16 实测命名规律）：og:image 给的是 ps.jpg（封面小图，
       同目录的 pl.jpg 才是海报大图；若该片无 pl.jpg，调用方 saveItemToInbox 会回退
       到升级前 URL 再抓一次，不会漏封面 */
    if (/dmm\.co\.jp/i.test(t)) t = t.replace(/ps\.(jpe?g|png|webp)$/i, 'pl.$1');
    return t;
  }
  /* 关键帧：候选多于 n 时首尾+中间均匀取样 */
  /* v1.3.63：截图张数上限常量。语义：0 = 不抓截图；1-99 = 最多几张（99 是上限，
     页面样图通常到不了这个数，等于全抓）。
     旧版用 9999 做「无限制」哨兵（v1.3.61）：因为 pickKeyframes 走 parseInt(n)，
     Infinity 会变成 0 返回空数组。v1.3.63 起 0 的语义改为「不抓」，无限制触发点消失，
     上限就用 99 本身，不再需要哨兵常量。 */
  const SHOT_MAX = 99;
  /* v1.3.62/1.3.63：候选采集量 = max(该站默认候选, 用户上限)。旧版只看站点
     （一级站 99 / 其余 12），用户设 20 时二级站顶多采到 12 张候选，上限形同虚设。
     用户设 0（不抓）时直接返回 0——连候选都不采集，省一次无谓的 DOM 扫描与流量。 */
  function shotCandidateLimit(cfg, src) {
    const u = parseInt(cfg && cfg.maxShots, 10);
    if (u === 0) return 0;
    const base = (src && src.tier === 1) ? 99 : 12;
    return Math.max(base, isFinite(u) ? u : SHOT_MAX);
  }
  function pickKeyframes(list, n) {
    const a = (list || []).slice();
    const N = Math.max(0, parseInt(n, 10) || 0);
    if (!N || !a.length) return [];
    if (a.length <= N) return a;
    if (N === 1) return [a[Math.floor(a.length / 2)]];
    const out = [];
    for (let i = 0; i < N; i++) {
      out.push(a[Math.round(i * (a.length - 1) / (N - 1))]);
    }
    return out;
  }
  /* 限速闸门：两次取图之间至少间隔 imgDelay 毫秒 */
  let __lastImgAt = 0;
  async function imgGate() {
    const gap = Math.max(0, parseInt((getCfgSafe() || {}).imgDelay, 10) || 0);
    /* v1.3.50 BUG-26（P3）：先占位后等待（原子预约），不再是「读-睡-写」。
       旧版并发调用会读到同一个 __lastImgAt、算出同样的等待、然后同时放行 →
       并发抓图时 imgDelay 形同虚设（相邻请求间隔 ≈ 0）。
       现在 __lastImgAt 表示「下一条的放行时刻」，进入即预约。 */
    const prev = __lastImgAt || 0;
    const slot = Math.max(Date.now(), prev + gap);
    __lastImgAt = slot;
    const w = slot - Date.now();
    if (w > 0) await new Promise(r => setTimeout(r, w));
  }
  /* 并发受限地取一组图，保持顺序 */
  async function fetchImgsLimited(urls, conc) {
    const list = (urls || []).slice();
    const c = Math.max(1, parseInt(conc, 10) || 1);
    const out = new Array(list.length);
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= list.length) return;
        out[i] = await fetchImgAsDataUrl(list[i]);
      }
    };
    const ws = [];
    for (let k = 0; k < Math.min(c, list.length); k++) ws.push(worker());
    await Promise.all(ws);
    return out;
  }

  async function fetchImgAsDataUrl(rawUrl) {
    if (!rawUrl) return null;
    let url = rawUrl;
    try { url = new URL(rawUrl, location.href).href; } catch (e) { return null; }
    const cfg = getCfgSafe() || {};
    const tries = Math.max(0, Math.min(4, parseInt(cfg.imgRetry, 10) || 0)) + 1;
    for (let i = 0; i < tries; i++) {
      await imgGate();                       // 限速：两次取图之间留间隔
      const d = await gmFetchImage(url);
      if (d) return d;
      try {
        /* v1.3.58 #17：加超时——旧版裸 fetch 无 AbortController，站点挂起时整个抓取
           流程卡死（批量时后面的队列全堵在 await 上）。15s 与 gmFetchImage 对齐。 */
        const ac = new AbortController();
        const _t = setTimeout(() => { try { ac.abort(); } catch (e) {} }, 15000);
        let r;
        try { r = await fetch(url, { credentials: 'include', signal: ac.signal }); }
        finally { clearTimeout(_t); }
        if (r.ok) {
          const blob = await r.blob();
          if (blob && blob.size) {
            const v = await new Promise((resolve) => {
              const fr = new FileReader();
              fr.onload = () => resolve(fr.result);
              fr.onerror = () => resolve(null);
              fr.readAsDataURL(blob);
            });
            if (v) return v;
          }
        } else if (r.status >= 400 && r.status < 500 && r.status !== 429) {
          /* v1.3.58 #17：4xx（除 429 限流）是「这张图就是没有/不许看」，重试无意义
             还白等间隔、放大风控暴露——旧版不管状态码一律重试满 tries 次。 */
          return null;
        }
      } catch (e) {}
    }
    return null;
  }

  /* ==========================================================================
   * 解析：详情页
   * ======================================================================== */
  function imgSrcOf(el) {
    if (!el) return '';
    if (el.tagName === 'META') return el.getAttribute('content') || '';
    return el.getAttribute('data-src') || el.getAttribute('data-original') || el.getAttribute('src') || '';
  }
  /* 缩略图外层常包着指向原图的 <a>，优先拿原图（FANZA 缩略图带 ?w=120&h=90 会糊） */
  function shotSrcOf(el) {
    if (!el) return '';
    const a = el.closest ? el.closest('a[href]') : null;
    if (a) {
      const h = a.getAttribute('href') || '';
      if (/^https?:\/\/.+\.(?:jpe?g|png|webp)(?:\?[^\s]*)?$/i.test(h)) return h;
    }
    return imgSrcOf(el);
  }
  function txtOf(sel) {
    if (!sel) return '';
    const parts = sel.split(',').map(s => s.trim()).filter(Boolean);
    for (const s of parts) {
      const el = $(s);
      if (!el) continue;
      const t = (el.tagName === 'META') ? (el.getAttribute('content') || '') : (el.textContent || '');
      if (t && t.trim()) return t.trim();
    }
    return '';
  }
  /* FANZA/dmm CDN 样图排序键：无序号首图（pl.jpg）排最前，其余按文件名序号数值升序
     （jp-2 应排在 jp-10 前；纯字符串排序会把 jp-10 排到 jp-2 前）。
     命名形态兼容：pl.jpg=首图、pl2/pl3=第 2 张起（通販页）、jp-2/jp-3=第 2 张起（動画页）。
     只对 dmm CDN 域生效——其他站（javdb/missav 等）URL 无此序号规律，保持 DOM 原序。 */
  function dmmShotKey(u) {
    var t = String(u || '').split('?')[0];
    var file = t.split('/').pop() || '';
    var m = file.match(/^(.*?)(\d+)\.(?:jpe?g|png|webp)$/i);
    if (!m) return [0, 0, file];          // 文件名不以数字结尾（pl.jpg 首图）→ 排最前
    return [1, parseInt(m[2], 10), m[1]]; // 序号按数值比，同序号比前缀（稳定排序保原序）
  }
  function allImgSrc(sel, limit) {
    if (!sel) return [];
    const out = [];
    sel.split(',').map(s => s.trim()).filter(Boolean).forEach(s => {
      $$(s).forEach(el => { const u = shotSrcOf(el); if (u) out.push(u); });
    });
    // 去重
    const seen = {}, uniq = [];
    out.forEach(u => { if (!seen[u]) { seen[u] = 1; uniq.push(u); } });
    /* FANZA/dmm 样图按文件名顺序排列；整组都是 dmm CDN 域时才排，混合域保持 DOM 顺序 */
    const allDmm = uniq.length > 1 && uniq.every(u => /dmm\.co\.jp/i.test(u));
    const list = allDmm ? uniq.slice().sort(function (a, b) {
      const ka = dmmShotKey(a), kb = dmmShotKey(b);
      for (let i = 0; i < 3; i++) { if (ka[i] < kb[i]) return -1; if (ka[i] > kb[i]) return 1; }
      return 0;
    }) : uniq;
    /* v1.3.63：`limit || 9` 会把 limit=0（不抓）悄悄变成 9（抓 9 张）。
       只有没传 limit 时才回落到默认 9。 */
    return list.slice(0, limit == null ? 9 : Math.max(0, limit));
  }
  /* 从规格表 DOM 直读 FANZA 番号（标签与值分属不同 <th>/<td> 或 <dt>/<dd>）。
   * 之前只用 infoTxt（= sel.info 选择器文本）正则匹配，若 sel.info 只截到页面局部、
   * 漏掉「メーカー品番」那一行，就会退到「配信品番反解」路径（dsod00009 → DSOD-009）。
   * 这里按行读取「标签单元格 + 值单元格」，优先级：メーカー品番 > 配信品番 > 品番 */
  function pickFanzaCodeDom() {
    const cand = [];
    /* 表格式：一个 <tr> 里可能并列多组 th/td（如「配信品番 / メーカー品番」在同一行），
     * 必须按索引逐一配对，不能只取第一个 th/td —— 否则 メーカー品番 在第二个单元格时会被漏掉，
     * 退化成 配信品番反解（v1.3.43 起 fromFanzaCode 已统一 convert00 口径，短码不再出现）。 */
    $$('tr').forEach(tr => {
      const ths = tr.querySelectorAll('th'), tds = tr.querySelectorAll('td');
      const n = Math.min(ths.length, tds.length);
      for (let i = 0; i < n; i++) cand.push([ths[i].textContent, tds[i].textContent]);
    });
    $$('dl').forEach(dl => {
      const dts = dl.querySelectorAll('dt'), dds = dl.querySelectorAll('dd');
      const n = Math.min(dts.length, dds.length);
      for (let i = 0; i < n; i++) cand.push([dts[i].textContent, dds[i].textContent]);
    });
    /* 兜底：某些页面把规格表放进同域 iframe，主文档查询不到，需进 iframe 内配对 */
    try {
      $$('iframe').forEach(f => {
        let d = null;
        try { d = f.contentDocument; } catch (e) { return; }
        if (!d) return;
        d.querySelectorAll('tr').forEach(tr => {
          const ths = tr.querySelectorAll('th'), tds = tr.querySelectorAll('td');
          const n = Math.min(ths.length, tds.length);
          for (let i = 0; i < n; i++) cand.push([ths[i].textContent, tds[i].textContent]);
        });
        d.querySelectorAll('dl').forEach(dl => {
          const dts = dl.querySelectorAll('dt'), dds = dl.querySelectorAll('dd');
          const n = Math.min(dts.length, dds.length);
          for (let i = 0; i < n; i++) cand.push([dts[i].textContent, dds[i].textContent]);
        });
      });
    } catch (e) {}
    let maker = null, dist = null, plain = null;
    cand.forEach(p => {
      const lab = String(p[0] || '').trim(), val = String(p[1] || '').trim();
      if (!val) return;
      if (lab.indexOf('メーカー品番') >= 0) maker = maker || val;
      else if (lab.indexOf('配信品番') >= 0) dist = dist || val;
      else if (lab.indexOf('品番') >= 0 && lab.indexOf('商品コード') < 0 && lab.indexOf('レンタル') < 0) plain = plain || val;
    });
    if (maker) return { raw: maker, pref: 'maker' };
    if (dist) return { raw: dist, pref: 'dist' };
    if (plain) return { raw: plain, pref: /-/.test(plain) ? 'maker' : 'dist' };
    return null;
  }
  /* 互跳/标签框要用的「当前页番号」：FANZA 优先从规格表直读メーカー品番（DSOD-009），否则退回 DSAI 式整页识别 */
  function pageCodeForJump() {
    const k = currentSourceKey();
    const src = (getCfg().sources || {})[k];
    if (src && src.xf === 'fanza') {
      const fc = pickFanzaCodeDom() || pickFanzaCodeRaw((document.body.innerText || '') + '\n' + (document.body.textContent || ''));
      /* 与 parseDetail 同口径：メーカー品番直接 normCode，配信品番走 fromFanzaCode 反解
         （dsod00009 → DSOD-009）。旧版这里一律 normCode，配信专属页会得出 DSOD-00009（v1.3.43 修） */
      if (fc) return (fc.pref === 'maker') ? normCode(fc.raw) : fromFanzaCode(fc.raw);
    }
    return extractCodeFromPage();
  }
  /* 互跳要用的「当前页原名」：与抓取链路同优先级——
   * ① 信息区标签（MISSAV「标题:」= 日文原名；注意 missav 的 og:title 是中文名，不能直接用）
   * ② sel.title ③ og:title / h1 ④ document.title；
   * 同样剥「 - JavDB」类站点名后缀与标题里的番号前缀，保证跳转搜索词与入库原名一致。
   * 搜索页不取标题（isSearchPage）：那会儿 og:title 是搜索结果页标题，搜过去也是垃圾。 */
  function pageTitleForJump(code) {
    try {
      const k = currentSourceKey();
      const src = (getCfg().sources || {})[k] || {};
      const sel = src.sel || {};
      let title = '';
      if (sel.titleInfo) {
        const ilist = String(sel.info || '').split(',').map(s => s.trim()).filter(Boolean);
        let infoTxt = '';
        for (let i = 0; i < ilist.length && !infoTxt; i++) {
          try {
            const els = $$(ilist[i]);
            if (els && els.length) infoTxt = els.map(function (el) { return (el.innerText || el.textContent || ''); }).join('\n');
          } catch (e) {}
        }
        if (!infoTxt) infoTxt = document.body ? (document.body.innerText || document.body.textContent || '') : '';
        title = pickLabel(infoTxt, sel.titleInfo);
      }
      if (!title) title = txtOf(sel.title);
      if (!title) {
        const og = $('meta[property="og:title"]');
        title = (og && og.getAttribute('content')) || (($('h1') && $('h1').textContent) || '').trim() || document.title || '';
      }
      title = String(title || '').replace(/\s+/g, ' ').trim();
      title = title.replace(/\s*[-|]\s*(JavDB|javdb|MISSAV|MissAV|missav).*$/i, '').trim();
      if (code) title = stripCodePrefix(title, code);
      return title;
    } catch (e) { return ''; }
  }
  /* FANZA 番号：优先「メーカー品番」（人类可读，如 DSOD-009），其次「配信品番」（FANZA 系统号，如 dsod00009）
   * 返回值 {raw, pref}；pref='maker' 已是标准写法直接 norm，pref='dist' 需走 fromFanzaCode 反解（可能丢有效数字 0）
   * 注意：通用「品番」可能是制造商号（含连字符 DSOD-009 → 保留）也可能是配信号（无连字符 dsod00009 → 反解），按连字符区分 */
  function pickFanzaCodeRaw(txt) {
    if (!txt) return null;
    /* 规格表可能位于同域 iframe 内：把每个 iframe 的正文并进来一起匹配 */
    let full = txt;
    try {
      document.querySelectorAll('iframe').forEach(f => {
        let d = null; try { d = f.contentDocument; } catch (e) { return; }
        if (d && d.body) full += '\n' + (d.body.innerText || d.body.textContent || '');
      });
    } catch (e) {}
    /* 捕获上限与 pickCode 对齐（{2,29}）：FANZA 品番虽短，杜绝同类静默截断（v1.3.39） */
    let m = /メーカー品番\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-_]{2,29})/i.exec(full);
    if (m) return { raw: m[1], pref: 'maker' };
    m = /配信品番\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-_]{2,29})/i.exec(full);
    if (m) return { raw: m[1], pref: 'dist' };
    m = /品番\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-_]{2,29})/i.exec(full);
    if (m) return { raw: m[1], pref: /-/.test(m[1]) ? 'maker' : 'dist' };
    return null;
  }
  /* 系列：优先取带「系列 / シリーズ / Series」标签的那块，再剥掉标签文字。
     JAVDB 的 div.panel-block 每个字段都是「.heading 标签 + 值」结构，
     要先看块内有没有以系列标签命名的子元素，而不是退化去拿第一个块（那会是番号）。 */
  /* 系列名里不该出现的导航 / 装饰词。
     FANZA 系列行会在系列名后面跟一个「一覧へ」链接（指向该系列一览），它也命中 a[href*="/series/"]，
     旧兜底逻辑取首个匹配节点，直接把「一覧へ」当成系列名抓走（用户实测反馈）。 */
  var SERIES_JUNK_RE = /(一覧へ|もっと見る|すべて見る|全て見る|すべて|全て|もっと|こちら|詳細|一覧|See\s*more)/gi;
  function cleanSeriesText(t) {
    var s = String(t || '').replace(/\s+/g, ' ').trim();
    s = s.replace(SERIES_JUNK_RE, ' ').replace(/\s+/g, ' ');
    s = s.replace(/^[\s>》›.。、,]+|[\s>》›.。、,]+$/g, '').trim();
    return s;
  }
  function badSeriesText(t) { return !cleanSeriesText(t); }
  var SERIES_LBLS = ['系列', 'シリーズ', 'Series'];
  /* 文本本身就是「系列 / シリーズ / Series」标签（而不是系列名）——
     FANZA 系列行的标签节点也会被选择器命中，拿它当系列值就会抓出「シリーズ」（用户实测反馈）。 */
  function isSeriesLabelOnly(t) {
    const s = cleanSeriesText(t).replace(/[:：\s]+$/, '').trim().toLowerCase();
    if (!s) return true;
    for (const L of SERIES_LBLS) { if (s === L.toLowerCase()) return true; }
    return false;
  }
  /* FANZA 无系列时用「----」占位（实测 <td><span>----</span></td>），不能被当成系列名 */
  var PLACEHOLDER_RE = /^(-{2,}|—{1,}|-{1,}|\u2015{1,}|\uFF3F{1,}|\u306a\u3057|N\/A|n\/a|\u4e0d\u660e|\u672a\u8a2d\u5b9a)$/;
  function isPlaceholder(t) { return PLACEHOLDER_RE.test(String(t == null ? '' : t).trim()); }
  /* FANZA 每页底部都有「人気シリーズ」推荐区：链接形态 /av/list/?series=XXXX&i3_ref=recommend&dmmref=video_list_series_XXXX，
     与信息表里的真系列链接命中同一个选择器 a[href*="series="]。旧代码步骤 3「取最长文本」把推荐系列名
     当成本片系列抓走（用户实测：1nhdtb00063 站点シリーズ=----，被抓成「ガチナンパ！（ピーターズ）」；
     当天 45/45 FANZA 来料全带伪系列，JUL-898 站点=「出張という名の不倫旅行」也被抓成ガチナンパ）。
     带 i3_ref=recommend / dmmref=video_list_series 的一律是推荐位，不是本片资料。 */
  var REC_LINK_RE = /[?&]i3_ref=recommend|dmmref=video_list_series/i;
  function isRecLink(el) {
    if (!el || el.tagName !== 'A') return false;
    return REC_LINK_RE.test(el.getAttribute('href') || '');
  }
  /* scopeEl：信息表容器元素（parseDetail 传入）。系列行一定在信息表里，而推荐区在页面别处——
     限定作用域后推荐链接天然被排除；信息表里没有系列链接时（如「シリーズ：----」无链接），
     parseDetail 还会再试一次全文范围（此时靠 isRecLink 兜底过滤）。 */
  function pickSeries(selStr, scopeEl) {
    if (!selStr) return '';
    const nodes = $$(selStr, scopeEl || document).filter(function (n) { return !isRecLink(n); });
    if (!nodes.length) return '';
    /* 1) 整块文本以「系列:」开头的，直接剥标签 */
    for (let i = 0; i < nodes.length; i++) {
      const t = String(nodes[i].textContent || '').replace(/\s+/g, ' ').trim();
      for (const L of SERIES_LBLS) {
        if (t.indexOf(L) === 0) {
          const v = cleanSeriesText(t.slice(L.length).replace(/^[\s:：]+/, ''));
          if (v && !isSeriesLabelOnly(v) && !isPlaceholder(v)) return v.slice(0, 60);
        }
      }
    }
    /* 2) 块内有「.heading / .label / dt / th」之类标签等于系列名的，取剩余文本作为值 */
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const h = n.querySelector('.heading, .label, dt, th');
      const hTxt = h ? String(h.textContent || '').replace(/\s+/g, ' ').trim() : '';
      let isLbl = false;
      for (const L of SERIES_LBLS) { if (hTxt === L || hTxt.indexOf(L) === 0) isLbl = true; }
      if (isLbl) {
        let val = String(n.textContent || '').replace(/\s+/g, ' ').trim();
        val = val.replace(hTxt, '').trim();
        val = cleanSeriesText(val);
        if (val && !isSeriesLabelOnly(val) && !isPlaceholder(val)) return val.slice(0, 60);
      }
    }
    /* 2.5) 表格型站点（FANZA）：命中的是标签单元格（文本就是「シリーズ」）→ 取同一行的取值单元格。
           td.p-0.5 这类通用单元格选择器会把标签格一并选进来，必须靠这一步跳到真正的取值格。 */
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const t = String(n.textContent || '').replace(/\s+/g, ' ').trim();
      if (badSeriesText(t)) continue;          /* 空 / 纯导航词（「一覧へ」）不算标签格 */
      if (!isSeriesLabelOnly(t)) continue;     /* 必须是「系列 / シリーズ / Series」本身 */
      const cands = [];
      if (n.nextElementSibling) cands.push(n.nextElementSibling);
      if (n.previousElementSibling) cands.push(n.previousElementSibling);
      for (const c of cands) {
        if (!c || c === n) continue;
        if (/^(SCRIPT|STYLE|TEMPLATE)$/.test(String(c.tagName || ''))) continue;
        const v = cleanSeriesText(c.textContent || '');
        if (v && !isSeriesLabelOnly(v) && !isPlaceholder(v)) return v.slice(0, 60);
      }
    }
    /* 3) 兜底：在所有候选里挑最长的那块。
          跳过：纯导航词（FANZA 的「一覧へ」）、纯标签（「シリーズ」本身是标签不是系列名）、
                「某标签: 值」形态（说明命中的不是系列）。
          一个候选都没有就返回空，交给 pickSeriesFromText 从文本兜底。 */
    let best = '';
    for (let i = 0; i < nodes.length; i++) {
      const t0 = String(nodes[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (badSeriesText(t0)) continue;
      if (isSeriesLabelOnly(t0)) continue;
      if (/^[^:：]{1,12}[:：]\s*\S/.test(t0)) continue;
      const v = cleanSeriesText(t0);
      if (v && !isPlaceholder(v) && v.length > best.length) best = v;
    }
    return best ? best.slice(0, 60) : '';
  }
  /* 从信息区文本按「系列: 值」提取系列（与站点 DOM 结构无关，站点改版也不易失效） */
  function pickSeriesFromText(txt) {
    if (!txt) return '';
    const LBLS = SERIES_LBLS;
    const arr = String(txt).split(/[\r\n]+/);
    for (const L of LBLS) {
      for (const ln of arr) {
        const i = ln.indexOf(L);
        if (i >= 0) {
          let rest = String(ln.slice(i + L.length)).replace(/^[\s:：]+/, '');
          /* 整张表常被拼成一行：只取到下一个「标签：」之前，避免把后面字段全当成系列名 */
          /* v1.3.58 #16：截断正则旧版只认全角冒号 \uff1a——同文件的 cutAtNextLabel/
             pickLabel 都认 [:：]，扁平化且用半角冒号的站点，系列名会把后面字段
             （「XXX 監督: 山田…」整段）一起吞进库。 */
          const cut = rest.search(/[^\s:：][\u4e00-\u9fff\u30a0-\u30ff\u3040-\u309fA-Za-z]{0,10}[:：]/);
          if (cut > 0) rest = rest.slice(0, cut);
          const v = cleanSeriesText(rest);
          if (v && !isPlaceholder(v)) return v.slice(0, 60);
        }
      }
    }
    return '';
  }

  /* 商品発売日（发售日） */
  const SALE_LABELS = ['商品発売日', '商品発売', '発売日', '販売日', '發売日', '发售日', '発売', '發売', '發行日期', '发行日期'];
  /* 配信開始日（上线日） */
  const STREAM_LABELS = ['配信開始日', '配信開始', '配信开始日', '配信日', '配信', '上线日'];
  /* 一行里并排多个字段时，把值截到下一个「标签:」之前：innerText 通常一行一字段，
     但表格/弹性容器被拍成一行时（整表 innerText）不截就会把后面字段一起吞。
     番号/日期/厂商名/导演名本身都不含「词+冒号」，可安全截断。 */
  function cutAtNextLabel(v) {
    const s = String(v == null ? '' : v);
    const cut = s.search(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ffA-Za-z]{1,12}\s*[:：]/);
    return (cut > 0 ? s.slice(0, cut) : s).trim();
  }
  /* 影片日期（v1.3.40 单字段）：优先「商品発売日」类标签，其次「配信開始日」类；
     取冒号后整行原样文本（保留页面写法：FANZA/MGS=2024/11/19，MISSAV=2020-02-15，
     FANZA 影院片的配信区间串 2009/01/23 10:00 〜 2027/02/28 23:59 也整体保留） */
  function pickDateLine(txt, labels) {
    if (!txt) return '';
    for (const L of labels) {
      const m = new RegExp(L + '\\s*[:：]?\\s*([^\\n\\r]{1,40})', 'i').exec(txt);
      if (m) {
        const v = cutAtNextLabel(m[1]);
        /* 必须「以四位年份+月」开头：既防误匹配（裸标签「発売」命中「発売記念キャンペーン…」），
           又放过 FANZA 影院片的配信区间串（2009/01/23 10:00 〜 2027/02/28 23:59 整体保留） */
        if (/^\d{4}[-/.年]\d{1,2}/.test(v)) return v;
      }
    }
    return '';
  }
  function pickRelease(txt) {
    return pickDateLine(txt, SALE_LABELS) || pickDateLine(txt, STREAM_LABELS);
  }
  /* 发行商（制造商）：FANZA/MGS=メーカー、MISSAV=製造商(繁)/制造商(简)、JAVDB=片商/發行商 */
  const MAKER_LBLS = ['メーカー', 'Maker', '製造商', '制造商', '制作商', '製作商', '発行商', '发行商', '發行商', '片商'];
  /* 占位符（---- / 未設定 / N/A 等）不是真实值：FANZA 空字段就用「----」占位
     （用户实测 1nhdtb00063：監督=---- 被抓成导演名入库） */
  function pickMaker(txt) {
    if (!txt) return '';
    const v = cutAtNextLabel(pickLabel(txt, MAKER_LBLS.join('|')));
    return isPlaceholder(v) ? '' : v;
  }
  /* 来源（平台）：FANZA / MGS / FC2 / JAVDB / MISSAV / MOTV。
     FC2 番号优先（任何站抓到的 FC2 内容都记 FC2），其余按抓取站点记（v1.3.40 用户规则）。 */
  function platformOfSource(key, code) {
    if (isFc2Code(code)) return 'FC2';
    const k = String(key || '');
    if (k === 'mgs') return 'MGS';
    if (k === 'dmmvideo' || k === 'dmm') return 'FANZA';
    if (k === 'javdb') return 'JAVDB';
    if (k === 'missav') return 'MISSAV';
    if (k === 'motv') return 'MOTV';
    return '';
  }
  /* ---------- 来源分级（v1.3.44，用户拍板：FC2 计一级） ----------
   * 一级 = FANZA(dmm/dmmvideo) / MGS / FC2：官方卖家，字段权威（系列/导演/发行商最准）；
   * 二级 = JAVDB / MISSAV / MOTV 等聚合站：字段可能更全（中文名/截图），但系列等易掺假。
   * FC2 番号无论从哪个站抓到都计一级（官方卖家本人）。
   * 分级用于三处：① 收件箱归并 scoreItem 第一排序键；② 文件夹写入同番号比对；
   *            ③ 来料条目盖 srcTier 字段，供 Film Library 导入时做覆盖决策。 */
  var TIER1_PLATFORMS = ['FANZA', 'MGS', 'FC2'];
  function tierOfSource(srcKey, code) {
    if (isFc2Code(code || '')) return 1;
    const src = (getCfgSafe().sources || {})[srcKey || ''];
    return (src && src.tier === 1) ? 1 : 2;
  }
  /* 取条目的来源层级：优先 srcTier 字段；旧来料没有该字段时按 platform 标签推断 */
  function tierOfItem(it) {
    if (!it) return 0;
    if (it.srcTier === 1 || it.srcTier === 2) return it.srcTier;
    const p = String(it.platform || '').toUpperCase();
    if (TIER1_PLATFORMS.indexOf(p) >= 0) return 1;
    return p ? 2 : 0;
  }
  /* 按信息区标签取值：如「标题: 引っ越し先は…」→ 取冒号后整行。
     label 支持「简体|繁体」多写法：MISSAV 等站按界面语言出「标题:」或「標題:」，
     只配一种在另一种界面下整站匹配失败（回落到 h1 拿到中文标题，用户 2026-10-16
     实测反馈），逐个尝试先匹配先用，单写法行为不变。上限 500：日文原标题常超
     200 字，行尾换行（innerText 按块换行）才是真边界，200 截断属误伤。 */
  function pickLabel(txt, label) {
    if (!txt || !label) return '';
    const labels = String(label).split('|').map(s => s.trim()).filter(Boolean);
    for (const L of labels) {
      const re = new RegExp(L + '\\s*[:：]\\s*([^\\n\\r]{1,500})', 'i');
      const m = re.exec(txt);
      if (m && m[1] && m[1].trim()) return m[1].trim();
    }
    return '';
  }
  /* 去掉标题开头的番号前缀，如「JUL-296 参加町内会…」→「参加町内会…」 */
  function stripCodePrefix(t, code) {
    if (!t || !code) return t;
    const c = String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    /* 结尾锚定：番号后必须是非字母数字或行尾。旧版无边界，短码 DSOD-9 会把
       「DSOD-009 标题」啃成「09 标题」（v1.3.43 修） */
    const out = String(t).replace(new RegExp('^\\s*' + c + '(?![A-Za-z0-9])\\s*[-–—:：]?\\s*', 'i'), '').trim();
    return out || t;
  }
  function pickCode(txt, url) {
    /* v1.3.66 #18：最后的 'code' 加词边界 + 冒号必填——旧版裸 'code' 且冒号可选，
       信息区里出现 sourcecode12345 / barcode / encoded… 都会命中并把后随 3-30 位
       当番号（如 "sourcecode12345" → raw="12345"，matchCodeIn 也不认 → 直接入库）。
       \b 保证 code 前是词边界（sourcecode/barcode 的词中是 word char，不成立）；
       冒号必填挡住无标签巧合。日文标签不靠 \b 断词，不受影响。 */
    const labels = ['メーカー品番', '厂商品番', '番\\s*[號号]', '品番', '識別碼', '识别码', '番号', '\\bcode\\s*[:：]'];
    if (txt) {
      for (const L of labels) {
        /* 捕获上限 {2,20}（总长 21）曾把长串截断：MISSAV 無碼流出頁「番號: MIMK-178-UNCENSORED-LEAK」
           被砍成 MIMK-178-UNCENSORED-L（v1.3.39 修：上限提到 30） */
        const m = new RegExp(L + '\\s*[:：]?\\s*([A-Za-z0-9][A-Za-z0-9\\-_]{2,29})', 'i').exec(txt);
        if (m) {
          const raw = m[1].toUpperCase().replace(/\s+/g, '');
          /* 标签值可能带页面噪声后缀（如上例的 -UNCENSORED-LEAK）：过一遍该站启用的番号正则
             取规范番号（→ MIMK-178）；正则全不命中才保留原值（与旧版行为一致） */
          const canon = matchCodeIn(raw, currentSourceKey());
          return canon || raw;
        }
      }
    }
    // 兜底 1：DSAI 式整页识别（URL → meta/title/h1 → 所有 <strong>）
    const c = extractCodeFromPage();
    if (c) return c;
    // 兜底 2：从 URL 里猜，如 /v/Ab12 或 /ABP-123
    let m = /\/([A-Za-z]{2,8})-?(\d{2,5})(?:[/?#_]|$)/.exec(url || location.href);
    if (m) return (m[1] + '-' + m[2]).toUpperCase();
    const t = document.title || '';
    m = /([A-Za-z]{2,8})-?(\d{2,5})/.exec(t);
    if (m) return (m[1] + '-' + m[2]).toUpperCase();
    return '';
  }

  /* ==========================================================================
   * #22 各站解析适配层
   *   通用解析 parseDetail 只负责「按选择器取值」，站点差异收敛到这里的独立模块：
   *     need     必填字段（用于结构变更检测）
   *     selVer   选择器版本（站点改版后 +1，便于定位）
   *     maxShots 该站截图上限（null = 跟随设置里的 maxShots）
   *     post     站点后处理钩子（番号/片名/性别/磁力等站点专属修正）
   *   新增站点或站点改版，只改这一处对应模块，不动通用解析。
   * ======================================================================== */
  /* 站点后处理默认钩子：原样返回（字段取舍由 per-site fields 门控 gateFields 统一处理） */
  const NOOP_POST = function (raw) { return raw; };

  const SITE_ADAPTERS = {
    javdb: {
      label: 'JAVDB', selVer: 1,
      need: ['code', 'title', 'coverUrl'],
      /* v1.3.48 BUG-07（P1）：补 /actors/——JAVDB 男演员目录实际是 /actors/，
         旧 M 规则漏配 → 男演员不命中任何规则 → 默认归女 → 保存时 learnGender
         把错误归类固化进 fl_gender 记忆表（后续同站同人都错）。 */
      /* v1.3.64 #1：M 移除 /\/actors\//i。JAVDB 演员页是 /actors/<ID> 形态，
         而 F 的 /\/actor\//i 要求 "actor" 后紧跟 "/"——对 /actors/ 永不命中；
         splitByGender 先测 M 再测 F → JAVDB 每个演员都归男（单测实证：
         /actors/KPvv => M，/\/actor\//i.test('/actors/…') === false）。URL 层无性别
         区分能力，移除后回落脚本既定哲学「判不出归女」：男女都先归女，用户在确认
         弹窗纠正后 learnGender 记忆兜底（与 missav 1416 行同款取舍）。
         若日后拿到 JAVDB 男女页的可靠区分特征（查询参数 / DOM 性别标记），再加规则。 */
      gender: { F: [/\/actor\//i, /\/actresses?\//i], M: [/\/male\//i, /\/actor-man\//i] },
      maxShots: function () { return null; },
      post: NOOP_POST
    },
    missav: {
      label: 'MissAV', selVer: 1,
      /* 2026-10-16 起：原名（信息区「标题:/標題:」行，日文）+ 中文名（og:title）都抓，
         演员照抓；封面/截图仍不抓（详情页无样图区），系列/导演/发行商/影片日期按 fields 门控抓。
         旧规则「只抓番号+演员其余清空」已废——那套让入库 25 条 title 全为空。 */
      need: ['code'],
      gender: { F: [/\/actresses?\//i], M: [/\/actors\//i, /\/male/] },
      maxShots: function () { return 0; },   // 详情页没有样图区，避免抓到导航图
      post: NOOP_POST   // 字段取舍改由 per-site fields 门控（gateFields）统一处理
    },
    motv: {
      label: 'MOTV', selVer: 1,
      need: ['code', 'title'],
      gender: { F: [/\/actress/i], M: [/\/actor(?:s|\/|\?|=)/i] },   // /actor 不是 /actress 的子串，可安全区分
      maxShots: function () { return null; },
      post: NOOP_POST
    },
    dmmvideo: {
      label: 'FANZA動画', selVer: 1,
      need: ['code', 'title', 'coverUrl'],
      gender: { F: [/actress=/i, /\/actress\//i], M: [/\/actor\//i, /actor=/i] },
      /* v1.3.62：不再写死 9——用户设置已放宽到 0-99，站点硬压 9 会让
         「设 20 张」实际只抓 9 张。改 null = 跟随设置（默认 0 = 无限制本就能全抓，
         这个值只在用户显式设张数时才参与）。missav 的 0 保留：该站详情页确实没有
         样图区，不是「上限 0 张」。 */
      maxShots: function () { return null; },   // 跟随设置（v1.3.62 起不再写死 9）
      post: NOOP_POST
    },
    dmm: {
      label: 'FANZA通販', selVer: 1,
      need: ['code', 'title', 'coverUrl'],
      /* v1.3.62：不再写死 9——用户设置已放宽到 0-99，站点硬压 9 会让
         「设 20 张」实际只抓 9 张。改 null = 跟随设置（默认 0 = 无限制本就能全抓，
         这个值只在用户显式设张数时才参与）。missav 的 0 保留：该站详情页确实没有
         样图区，不是「上限 0 张」。 */
      maxShots: function () { return null; },
      gender: { F: [/\/actress\//i, /actress=/i], M: [/\/actor\//i, /actor=/i] },
      post: NOOP_POST
    },
    /* MGS —— 演员链接为 /cSearch.php?actor[]=…（均为女演员），MISSAV 式只留番号+演员的逻辑改由 fields 门控 */
    mgs: {
      label: 'MGS', selVer: 1,
      need: ['code', 'title', 'coverUrl'],
      /* v1.3.62：不再写死 9——用户设置已放宽到 0-99，站点硬压 9 会让
         「设 20 张」实际只抓 9 张。改 null = 跟随设置（默认 0 = 无限制本就能全抓，
         这个值只在用户显式设张数时才参与）。missav 的 0 保留：该站详情页确实没有
         样图区，不是「上限 0 张」。 */
      maxShots: function () { return null; },
      gender: { F: [/\/cSearch\.php\?actor/i], M: [] },
      post: NOOP_POST
    }
  };
  /* 设置面板「各站抓取字段」可编辑矩阵：行=字段，列=站点。勾选状态决定该站实际抓哪些字段。
     番号恒抓（不在矩阵里）；命中 RegExp-FC2 时所有资料来源站都抓全部字段（不受矩阵限制）。
     v1.3.40 十字段体系：去 tags（停止抓取），增 maker（发行商）/ platform（来源），release 改单字段「影片日期」。 */
  const FIELD_DEFS = [
    ['title', '原名'], ['titleCn', '中文名(翻译)'], ['actor', '演员'],
    ['series', '系列'], ['director', '导演'], ['maker', '发行商'],
    ['cover', '封面'], ['shots', '截图'], ['release', '影片日期'], ['platform', '来源']
  ];

  function adapterOf(key) { return SITE_ADAPTERS[key] || null; }

  /* 站点后处理 + 挂载诊断信息 */
  function applySiteAdapter(raw, key, ctx) {
    const ad = adapterOf(key);
    /* 用户规则：番号命中 RegExp-FC2 时，「所有资料来源站都抓全部字段」——
       跳过站点后处理（例如 MissAV 只保留番号 + 演员的清空逻辑）。 */
    const allFields = isFc2Code(raw && raw.code);
    if (!allFields && ad && typeof ad.post === 'function') {
      try { raw = ad.post(raw, ctx || {}) || raw; }
      catch (e) { console.warn('[FL Spider] 站点后处理出错', key, e); }
    }
    try { raw._diag = parseDiag(raw, key); } catch (e) {}
    return raw;
  }
  /* 必填字段检查：返回 {need, miss, sig, selVer} */
  function parseDiag(raw, key) {
    const ad = adapterOf(key);
    const src = (getCfg().sources[key]) || {};
    const all = isFc2Code(raw && raw.code);
    const base = ['code', 'title', 'titleCn', 'actor', 'series', 'director', 'maker', 'cover', 'shots', 'release', 'platform'];
    /* need 名 → parseDetail 返回体的真实字段名（#65 字段改名后 cover/shots/release 曾对不上，
       导致诊断永远显示未抓到、签名永不为全 1、结构变更告警钝化） */
    const RAW_KEY = { code: 'code', title: 'title', titleCn: 'titleCn', actor: 'actor', series: 'series', director: 'director', maker: 'maker', cover: 'coverUrl', shots: 'shotUrls', release: 'release', platform: 'platform' };
    const has = (f) => {
      if (f === 'release') return !!(raw && raw.release);   // 影片日期（单字段，v1.3.40）
      const v = raw ? raw[RAW_KEY[f] || f] : '';
      return Array.isArray(v) ? v.length > 0 : !!v;
    };
    const need = base.filter(nm => nm === 'code' || all || (src.fields && src.fields[nm]));
    const miss = need.filter(f => !has(f));
    const sig = need.map(f => (has(f) ? '1' : '0')).join('');
    return { key: key, need: need, miss: miss, sig: sig, selVer: (ad && ad.selVer) || 0 };
  }
  /* 结构变更检测：上次全中、这次缺字段 → 认为站点结构变了 */
  function structureChanged(key, diag) {
    if (!diag || !diag.miss || !diag.miss.length) return false;
    return /^1+$/.test(getSig(key));
  }
  function sigKey(key) { return 'fl_sig_' + key; }
  function saveSig(key, diag) {
    try { GM_setValue(sigKey(key), (diag && diag.sig) || ''); } catch (e) {}
  }
  function getSig(key) {
    try { return String(GM_getValue(sigKey(key), '') || ''); } catch (e) { return ''; }
  }
  function warnStructure(key, diag) {
    if (!getCfgSafe().advMode) return false;  // 默认静默，仅调试模式弹告警
    if (!diag || !diag.miss || !diag.miss.length) return false;
    /* v1.3.60 #20：映射键对齐 parseDiag 的 base 字段名（code/title/.../cover/shots）。
       旧版键是 coverUrl/actorF 等 v1.3.40 字段改名前的旧名，而 diag.miss 来自 base
       数组——names[f] || f 全部落空，告警文案直接显示英文 key（用户看不懂）。 */
    const names = { code: '番号', title: '片名', titleCn: '中文名', actor: '演员', series: '系列',
                    director: '导演', maker: '发行商', cover: '封面', shots: '截图',
                    release: '影片日期', platform: '来源' };
    const msg = '⚠️ ' + ((adapterOf(key) || {}).label || key) + ' 解析异常：' +
      diag.miss.map(f => names[f] || f).join('、') + ' 没抓到。站点可能改版，请点设置 →「解析诊断」核对选择器。';
    toast(msg, 'warn');
    console.warn('[FL Spider] 结构变更告警', key, diag);
    return true;
  }

  /* 解析诊断面板：逐字段列出「抓到的值 + 用的选择器 + 缺失项 + 结构变更」 */
  function openParseDiag(key) {
    const k = key || currentSourceKey();
    let raw = null, err = "";
    try { raw = parseDetail(k); } catch (e) { err = (e && e.message) || String(e); }
    const ad = adapterOf(k);
    const d = (raw && raw._diag) || parseDiag(raw, k);
    const cfg = getCfg();
    const sel = (cfg.sources[k] && cfg.sources[k].sel) || {};
    /* v1.3.65 #14：字段键对齐 parseDiag 的 base（v1.3.40 改名后的新名）。旧版用
       旧键 coverUrl/actorF/actorM/shotUrls 且没有 series：① 面板永远不显示「系列」行；
       ② d.need.indexOf('coverUrl') 恒 -1，封面/截图/演员的必填红星全部失效；
       ③ magnet 行 parseDetail 恒写空，永远显示「（未抓到）」属误导（#20 warnStructure
       已对齐，这个函数当时漏了）。 */
    const names = { code: '番号', title: '原名', titleCn: '中文名', actor: '演员', series: '系列',
                    director: '导演', maker: '发行商', cover: '封面', shots: '截图',
                    release: '影片日期', platform: '来源' };
    const selOf = { title: sel.title, titleCn: sel.titleCn, actor: sel.actor, series: sel.series,
                    director: sel.director, maker: '(信息区标签)', cover: sel.cover, shots: sel.shots,
                    release: '(信息区标签)', platform: '(按来源站点)', code: '(信息区/URL)' };
    const rows = Object.keys(names).map(f => {
      let v = raw ? raw[f] : "";
      if (Array.isArray(v)) v = v.length + ' 个';
      v = String(v == null ? "" : v);
      const ok = !!v;
      const need = d.need.indexOf(f) >= 0;
      /* v1.3.60 #19：页面原文（片名/演员/标题…）与 err 原样进 innerHTML = XSS。
         旧版只给 title 属性转了双引号，正文里的 < > & 照样解析——被篡改的镜像站
         标题可注入脚本（本脚本以页面为食，页面文本即不可信输入）。全部过 esc()。 */
      return '<tr>' +
        '<td style="padding:3px 6px;">' + esc(names[f] || f) + (need ? ' <span style="color:#b91c1c;">*</span>' : '') + '</td>' +
        '<td style="padding:3px 6px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + esc(v) + '">' +
        (ok ? esc(v.slice(0, 60)) : '<span style="color:#b91c1c;">（未抓到）</span>') + '</td>' +
        '<td style="padding:3px 6px;color:#888;font-size:11px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
        esc(String(selOf[f] || '').slice(0, 44)) + '</td></tr>';
    }).join("");
    const changed = structureChanged(k, d);
    /* v1.3.60 #21：只有本次全命中才更新基线。旧版无条件 saveSig——站点临时抽风时
       用户看一眼诊断面板，基线就被写成缺字段签名（structureChanged 要求历史签名
       全 1），之后真改版也永不告警，检测机制被一次围观钝化。miss 非空时保留上次
       基线，「上次全中、这次缺」的变更检测继续有效。 */
    if (!d.miss || !d.miss.length) saveSig(k, d);
    const ov = document.createElement("div");
    ov.id = 'fl-diag';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:' + Z + ';display:flex;align-items:center;justify-content:center;';
    ov.innerHTML = '<div style="background:#fff;color:#222;width:580px;max-width:95vw;max-height:86vh;overflow:auto;border-radius:12px;padding:16px;font-size:13px;">' +
      '<h3 style="margin:0 0 4px;font-size:15px;">解析诊断（' + esc((ad && ad.label) || k || '-') + '）</h3>' +
      '<div style="font-size:12px;color:#888;">选择器版本 selVer=' + ((ad && ad.selVer) || 0) + '　上次签名=' + (getSig(k) || '无') + '　本次=' + (d.sig || '-') + '</div>' +
      (err ? '<div style="color:#b91c1c;margin:6px 0;">解析抛错：' + esc(err) + '</div>' : '') +
      (changed ? '<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:6px 8px;margin:8px 0;font-size:12px;">⚠️ 与上次相比出现字段缺失，站点结构可能已变更。</div>' : '') +
      '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:6px;">' +
      '<thead><tr style="background:#f8fafc;"><th style="text-align:left;padding:4px 6px;">字段</th><th style="text-align:left;padding:4px 6px;">抓到的值</th><th style="text-align:left;padding:4px 6px;">选择器</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end;">' +
      '<button data-fl-act="dom" data-fl-key="' + k + '" style="padding:7px 10px;border:none;border-radius:8px;background:#7c3aed;color:#fff;cursor:pointer;font-size:12px;">导出 DOM 样本</button>' +
      '<button id="fl-diag-close" style="padding:7px 12px;border:none;border-radius:8px;background:#eee;color:#333;cursor:pointer;font-size:12px;">关闭</button>' +
      '</div></div>';
    document.body.appendChild(ov);
    scaleButtonsIn(ov);
    ov.querySelector('#fl-diag-close').addEventListener('click', () => ov.remove());
    console.log('[FL Spider] 解析诊断', { key: k, diag: d, raw: raw });
  }

  /* ==========================================================================
   * #24 演员性别自动识别
   *   两层判定：① 用户纠正过的名字记在 fl_gender（最准）② 站点链接规则
   *   （/actresses/ → 女、/actors/ → 男 等，写在各站适配层的 gender 里）。
   *   都判不出来才回落「女演员」——宁可错归女演员，也不要凭名字瞎猜。
   * ======================================================================== */
  function allActorNodes(sel) {
    if (!sel) return [];
    const out = [];
    sel.split(',').map(x => x.trim()).filter(Boolean).forEach(q => {
      $$(q).forEach(el => {
        const n = (el.textContent || '').trim();
        if (!n) return;
        const h = el.getAttribute('href') || '';
        if (!out.some(x => x.name === n)) out.push({ name: n, href: h });
      });
    });
    return out;
  }
  function gMapKey() { return 'fl_gender'; }
  function getGenderMap() {
    try { return JSON.parse(GM_getValue(gMapKey(), "{}")) || {}; } catch (e) { return {}; }
  }
  function setGenderMap(m) {
    try { GM_setValue(gMapKey(), JSON.stringify(trimLearnMap(m))); return true; }
    catch (e) { console.error('[FL Spider] 演员性别记忆表写入失败', e); toast('演员性别记忆表写入失败（存储可能已满，可在设置里清空）', 'warn'); return false; }
  }
  function genderMapSize() { return Object.keys(getGenderMap()).length; }
  function clearGenderMap() { setGenderMap({}); }
  /* 把用户最终确认的男女演员写进记忆表（下一次自动归类） */
  function learnGender(fStr, mStr) {
    const m = getGenderMap();
    let changed = false;
    const put = (str, g) => {
      String(str || '').split(/[,，、]/).map(x => x.trim()).filter(Boolean).forEach(n => {
        if (m[n] !== g) { m[n] = g; changed = true; }
      });
    };
    put(mStr, 'M');
    put(fStr, 'F');   // 女在后：同名不同框时以女演员框为准（默认归类）
    if (changed) setGenderMap(m);
    return changed;
  }
  /* 按性别拆分演员：{F:[], M:[]} */
  function splitByGender(list, key) {
    const ad = adapterOf(key);
    const rules = (ad && ad.gender) || {};
    const map = getGenderMap();
    const F = [], M = [];
    (list || []).forEach(a => {
      const n = String(a.name || '').trim();
      if (!n) return;
      const k = n.replace(/\s+/g, '');
      let g = map[n] || map[k] || '';
      if (!g) {
        const h = String(a.href || '');
        if ((rules.M || []).some(re => re.test(h))) g = 'M';
        else if ((rules.F || []).some(re => re.test(h))) g = 'F';
      }
      if (g === 'M') M.push(n); else F.push(n);
    });
    return { F: F, M: M };
  }

  /* ==========================================================================
   * #21 中文名来源（四级兜底链，优先级从高到低）
   *   ① 站点自带（MissAV 的 og:title 本身就是中文）
   *   ② 本地映射 fl_cnmap：按番号记住你确认过的中文名（下次同番号自动带出）
   *   ③ 可配中文源：设置里填 URL 模板（含 {code}），跨域抓取 og:title / <title>
   *   ④ Google 翻译原名
   * ======================================================================== */
  function cnMapKey() { return 'fl_cnmap'; }
  function getCnMap() {
    try { return JSON.parse(GM_getValue(cnMapKey(), "{}")) || {}; } catch (e) { return {}; }
  }
  /* v1.3.65 #7：学习表上限 + 淘汰 + 写入失败提示。旧版两条学习表（中文名/性别）
     无上限无修剪，长期使用后 GM 配额满 → setXxxMap 静默失败（try/catch 吞）→
     中文名/性别不再学习，且拖累同命名空间其他键写入。淘汰按插入序保留最近的
     （对象键序即插入序，先进先出——学习表是累积型，FIFO 合理）。 */
  const LEARN_MAP_MAX = 500;
  function trimLearnMap(m) {
    const keys = Object.keys(m || {});
    if (keys.length <= LEARN_MAP_MAX) return m || {};
    const out = {};
    keys.slice(keys.length - LEARN_MAP_MAX).forEach(k => { out[k] = m[k]; });
    return out;
  }
  function setCnMap(m) {
    try { GM_setValue(cnMapKey(), JSON.stringify(trimLearnMap(m))); return true; }
    catch (e) { console.error('[FL Spider] 中文名记忆表写入失败', e); toast('中文名记忆表写入失败（存储可能已满，可在设置里清空）', 'warn'); return false; }
  }
  function cnMapSize() { return Object.keys(getCnMap()).length; }
  function clearCnMap() { setCnMap({}); }
  function learnCn(code, cn) {
    const c = String(code || '').trim().toUpperCase();
    const t = String(cn || '').trim();
    if (!c || !t) return false;
    const m = getCnMap();
    if (m[c] === t) return false;
    m[c] = t;
    /* v1.3.65 #7：向上传递写入结果——旧版 setCnMap 无返回值、这里直接 return true，
       GM 配额满时「学习失败」被报成「学习成功」（调用方据此认为中文名已记住）。 */
    return setCnMap(m);
  }
  function cnFromMap(code) {
    const c = String(code || '').trim().toUpperCase();
    return c ? (getCnMap()[c] || "") : "";
  }
  /* 从中文源 HTML 里挑标题：og:title 优先，其次 <title>；去掉站点后缀与番号前缀 */
  function pickCnFromHtml(html, code) {
    if (!html) return "";
    let t = "";
    let m = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
    if (!m) m = /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i.exec(html);
    if (m) t = m[1];
    if (!t) { m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html); if (m) t = m[1]; }
    if (!t) return "";
    t = String(t).replace(/\s+/g, " ").trim();
    t = t.replace(/\s*[-|]\s*(JavDB|javdb|MISSAV|MissAV|missav|JavBus|javbus|MOTV|motv|FANZA|dmm).*$/i, "").trim();
    try { t = stripCodePrefix(t, code); } catch (e) {}
    t = String(t || "").trim();
    // 至少要有汉字/假名，否则多半只是番号或空壳页
    if (!t || !/[\u4e00-\u9fff\u3040-\u30ff]/.test(t)) return "";
    return t;
  }
  /* 抓中文源（失败静默返回空，不阻塞后续翻译） */
  function fetchCnFromSource(code) {
    return new Promise((resolve) => {
      const cfg = getCfgSafe();
      const tpl = String((cfg && cfg.cnSourceUrl) || '').trim();
      if (!tpl || !code) return resolve("");
      const url = tpl.replace('{code}', encodeURIComponent(code));
      let done = false;
      let timer = null;
      /* v1.3.66 #28：兜底定时器在 fin 时一并 clear——旧版已 resolve 也留着 9s 定时器，
         批量抓取时每个番号残留一个，堆积几百个无用回调（GM 回调只清 done 标志）。 */
      const fin = (v) => { if (!done) { done = true; if (timer) { clearTimeout(timer); timer = null; } resolve(v || ""); } };
      try {
        GM_xmlhttpRequest({
          method: 'GET', url: url, timeout: 8000,
          onload: (r) => fin(pickCnFromHtml(String((r && r.responseText) || ""), code)),
          onerror: () => fin(""),
          ontimeout: () => fin("")
        });
      } catch (e) { fin(""); }
      timer = setTimeout(() => fin(""), 9000);
    });
  }

  /* 导演：优先站点选择器，其次信息区「監督/导演/導演/Director」标签取值 */
  const DIRECTOR_LABELS = ['監督', '导演', '導演', 'Director'];
  function pickDirector(selStr, infoTxt) {
    if (selStr) {
      const el = $(selStr.split(',')[0].trim());
      if (el) { const t = String(el.textContent || '').replace(/\s+/g, ' ').trim(); if (t && !isPlaceholder(t)) return t.slice(0, 40); }
    }
    if (infoTxt) for (const L of DIRECTOR_LABELS) { const v = pickLabel(infoTxt, L); if (v && !isPlaceholder(v)) return v.slice(0, 40); }
    return '';
  }
  /* 按 per-site fields 门控：未勾选的字段清空（番号恒留；命中 FC2 时全部保留） */
  function gateFields(out, src, allFields) {
    const f = (src && src.fields) || null;
    const keep = (nm) => allFields || !f || f[nm] === true || nm === 'code' || nm === 'magnet' || nm === 'note';
    if (!keep('title')) out.title = '';
    if (!keep('titleCn')) out.titleCn = '';
    if (!keep('actor')) { out.actor = ''; out.actorF = ''; out.actorM = ''; }
    if (!keep('series')) out.series = '';
    if (!keep('director')) out.director = '';
    if (!keep('cover')) out.coverUrl = '';
    if (!keep('shots')) out.shotUrls = [];
    if (!keep('release')) out.release = '';
    if (!keep('maker')) out.maker = '';
    if (!keep('platform')) out.platform = '';
  }
  function parseDetail(key) {
    const cfg = getCfg();
    const src = cfg.sources[key] || { sel: {} };
    const sel = src.sel || {};

    // 信息区文本（番号 / 日期都从这来）
    /* #52（v1.3.31）：按顺序遍历 sel.info 里的全部选择器，命中即取（收集该选择器
       所有匹配元素的 innerText 合并）。旧代码只试 split(',')[0] 第一条，javdb 列表
       尾部的 div.column 兜底是死代码——javdb 两栏布局里信息就在 div.column，
       第一条 .movie-panel-info 不存在时本该落到 div.column，实际直接跳过信息区
       去读整页 body 文本，系列/日期/标签提取全部退化。 */
    let infoTxt = '';
    let infoEl = null;
    if (sel.info) {
      const ilist = String(sel.info).split(',').map(s => s.trim()).filter(Boolean);
      for (let i = 0; i < ilist.length && !infoTxt; i++) {
        try {
          const els = $$(ilist[i]);
          if (els && els.length) {
            const txt = els.map(function (el) { return (el.innerText || el.textContent || ''); }).join('\n');
            if (txt.trim()) { infoTxt = txt; infoEl = els[0]; }
          }
        } catch (e) { /* 单个选择器非法（如类名以数字开头）不影响其余选择器 */ }
      }
    }
    if (!infoTxt) infoTxt = document.body.innerText || document.body.textContent || '';

    // 片名：① 信息区标签（如 MISSAV 的「标题:」= 日文原名）② 选择器 ③ og:title / h1 ④ document.title
    let title = sel.titleInfo ? pickLabel(infoTxt, sel.titleInfo) : '';
    if (!title) title = txtOf(sel.title);
    if (!title) {
      const og = $('meta[property="og:title"]');
      title = (og && og.getAttribute('content')) || (($('h1') && $('h1').textContent) || '').trim() || document.title || '';
    }
    title = String(title).replace(/\s*[-|]\s*(JavDB|javdb|MISSAV|MissAV|missav).*$/i, '').trim();
    // 中文名：站点若自带（MISSAV 的 og:title 就是中文）直接用，省掉一次翻译
    let titleCn = sel.titleCn ? txtOf(sel.titleCn) : '';
    if (titleCn) titleCn = String(titleCn).replace(/\s*[-|]\s*(JavDB|javdb|MISSAV|MissAV|missav).*$/i, '').trim();

    const coverUrl = (function () {
      const list = String(sel.cover || '').split(',').map(s => s.trim()).filter(Boolean);
      for (let i = 0; i < list.length; i++) {
        const el = $(list[i]);
        const u = el ? imgSrcOf(el) : '';
        if (u) return u;
      }
      const og = $('meta[property="og:image"]');
      return og ? (og.getAttribute('content') || '') : '';
    })();

    // FANZA 番号：从规格表 DOM 直读（最可靠），兜底用整页文本正则
    // （避免 sel.info 只截到页面局部而漏掉「メーカー品番」，导致退到配信品番反解路径）
    const fanzaBodyTxt = document.body ? (document.body.innerText || document.body.textContent || '') : '';
    const fc = (src && src.xf === 'fanza') ? (pickFanzaCodeDom() || pickFanzaCodeRaw(infoTxt + '\n' + fanzaBodyTxt)) : null;
    let rawCode, code;
    if (fc) {
      rawCode = fc.raw;
      code = (fc.pref === 'maker') ? normCode(rawCode) : fromFanzaCode(rawCode);
    } else {
      rawCode = pickCode(infoTxt, location.href);
      // FANZA 兜底：含连字符（人类可读写法）直接保留，否则反解（dsod00009 → DSOD-009）
      code = (src && src.xf === 'fanza')
        ? (/-/.test(rawCode) ? normCode(rawCode) : fromFanzaCode(rawCode))
        : normCode(rawCode);
    }
    // MGS 番号：剥离前导数字前缀（如 300MIUM-451 → MIUM-451）
    if (key === 'mgs') code = mgsCodeConvert(code);
    // 标题里若带番号前缀，去掉（MISSAV 的 og:title / h1 都有）
    title = stripCodePrefix(title, code);
    titleCn = stripCodePrefix(titleCn, code);
    // 中文名 ②：本地映射（按番号记住的）
    let cnFrom = titleCn ? 'site' : '';
    if (!titleCn && code) {
      const mapped = cnFromMap(code);
      if (mapped) { titleCn = mapped; cnFrom = 'map'; }
    }

    const __g = splitByGender(allActorNodes(sel.actor), key);
    const out = {
      // 库内统一存「字母-数字」大写三段式；FANZA 抓回来的 ABP00123 反解成 ABP-123
      code: code,
      title: title,
      titleCn: titleCn,
      // 影片日期（v1.3.40 单字段）：优先「商品発売日」类标签，其次「配信開始日」类；冒号后整行原样保留
      release: pickRelease(infoTxt),
      // 发行商：FANZA/MGS=メーカー、MISSAV=製造商/制造商、JAVDB=片商/發行商
      maker: (function () { try { return pickMaker(infoTxt); } catch (e) { return ''; } })(),
      // 来源：FANZA / MGS / FC2 / JAVDB / MISSAV / MOTV（FC2 优先，其余按抓取站点记）
      platform: platformOfSource(key, code),
      // 演员：先查用户纠正记忆，再按站点链接规则分男女；都判不出才归女演员
      actorF: __g.F.join(', '),
      actorM: __g.M.join(', '),
      actor: __g.F.concat(__g.M).join(', '),
      series: (function () {
        /* ① 信息表作用域：系列行就在信息表里，推荐区链接天然被排除（最准） */
        try { const d = pickSeries(sel.series, infoEl); if (d) return d; } catch (e) { /* 选择器非法或结构不符：退到下一步 */ }
        /* ② 全文范围：信息表里没有系列链接时（旧结构/选择器没覆盖到），isRecLink 已过滤推荐位 */
        try { const d2 = pickSeries(sel.series); if (d2) return d2; } catch (e) { /* 退到文本兜底 */ }
        return pickSeriesFromText(infoTxt);
      })(),
      director: pickDirector(sel.director, infoTxt),
      coverUrl: coverUrl,
      // 截图张数上限交给站点适配模块的 maxShots 决定（FANZA 全抓 9；MissAV 详情页无样图）
      /* v1.3.61/1.3.62：候选按「无限制 / 用户上限」放开，不再被站点默认候选（99 / 12）卡住 */
      shotUrls: allImgSrc(sel.shots, shotCandidateLimit(cfg, src)),
      // 磁力链接：改由用户在确认弹窗里手动填写（不再自动抓取）
      magnet: '',
      note: '来源: ' + location.href
    };
    out.shotUrls = (function () {
      const ad = adapterOf(key);
      /* v1.3.55：截图上限一律按适配器契约（适配层注释：maxShots = 该站上限，
         null = 跟随设置里的 maxShots）。旧版对一级站（FANZA/MGS）整个绕过契约，
         把上限写死成 999——用户设置「截图最多几张（1-9，默认 3，减小收件箱体积）」
         与适配器的 maxShots:9 双双失效，单条收件箱最多塞 99 张 base64（数 MB），
         拖垮后续每次整文件读写。FC2 番号仍跳过站点 0 上限（RegExp-FC2 抓全部字段
         的既有约定）。 */
      /* 口径（v1.3.63）：0 = 不抓截图；1-99 = 最多几张（默认 99 等于全抓）。
         适配器 maxShots 只许往下压（该站实际可用上限）；适配器返回 0 表示「该站没有
         样图区」（MissAV 详情页无样图），恒不抓——那是站点能力为 0，不是「上限 0 张」。 */
      const uN = parseInt(cfg.maxShots, 10);
      const adN = (!isFc2Code(out.code) && ad && typeof ad.maxShots === "function") ? ad.maxShots() : null;
      let n;
      if (adN === 0) n = 0;                 /* 该站明确没有样图区 */
      else if (uN === 0) n = 0;             /* 用户设 0 = 不抓截图 */
      else {
        n = Math.min(SHOT_MAX, isFinite(uN) ? uN : SHOT_MAX);
        if (adN != null) n = Math.min(n, Math.max(0, adN));
        n = Math.max(0, Math.min(SHOT_MAX, n));
      }
      /* 封面别混进截图：raw URL（ps.jpg）与升级后 URL（pl.jpg，FANZA 封面大图即第 1 张样图）
         都要排除——只比 raw 拦不住升级后与样图首图同 URL 的重复 */
      const coverUp = coverUrl ? (upgradeImgUrl(coverUrl) || coverUrl) : '';
      const sans = (out.shotUrls || []).filter(u => u && u !== coverUrl && u !== coverUp);
      return pickKeyframes(sans, n);
    })();
    out.cnFrom = cnFrom;
    gateFields(out, src, isFc2Code(out.code));
    return applySiteAdapter(out, key, { infoTxt: infoTxt, src: src, sel: sel });
  }

  /* ==========================================================================
   * 解析：搜索页
   * ======================================================================== */
  /* ==========================================================================
   * #20 搜索页抓取：按番号定位 + 结果快照
   *   · 目标番号：先看 URL 查询串（q / key / searchstr / 路径末段），再看队列当前项
   *   · 命中判定用零填充归一化键（DSOD-9 ↔ DSOD-009）
   *   · 快照入库：只用搜索页上就有的番号/片名/封面先建一条，进详情页再补全
   * ======================================================================== */
  function searchTargetCode() {
    let raw = "";
    try {
      const u = new URL(location.href);
      /* v1.3.48 BUG-04（P1）：补 search_word——MGS 适配器 searchUrl 是
         cSearch.php?search_word={code}，旧键列表取不到 → 回退 current.code，
         断点续抓/刷新后 current 丢失时 searchTargetCode 返回空或路径段垃圾
         （实测返回 "CSEARCH.PHP"）→ 搜索结果定位失败，MGS 批量全部卡「请手动选一条」。 */
      ['q', 'key', 'keyword', 'searchstr', 's', 'query', 'search_word'].forEach(k => {
        if (raw) return;
        const v = u.searchParams.get(k);
        if (v) raw = v;
      });
      if (!raw) {
        const m = /\/search\/([^/?#]+)/.exec(u.pathname || "");
        if (m) raw = decodeURIComponent(m[1]);
      }
    } catch (e) {}
    const fromUrl = raw ? (matchCodeIn(raw, currentSourceKey()) || normCode(raw)) : "";
    if (fromUrl) return fromUrl;
    const cur = getCurrent();
    return (cur && cur.code) ? String(cur.code) : "";
  }
  function resultKey(r) {
    const c = (r && (r.code || r.rawCode)) ? String(r.code || r.rawCode) : "";
    const m = /^([A-Za-z]+)-?0*(\d+)$/.exec(c.trim().toUpperCase());
    if (m) return m[1].toUpperCase() + "-" + String(parseInt(m[2], 10));
    return c.trim().toUpperCase();
  }
  /* 在搜索结果里按番号定位：完全命中优先，其次「安全包含」
     安全包含只认两种形态（v1.3.43 修）：
       ① 数字前缀包裹：300MIUM-451 ⊃ MIUM-451（MGS 站把厂商前缀拼在番号前）
       ② 连字符后缀扩展：MIMK-178-UNCENSORED-LEAK ⊃ MIMK-178
     裸包含一律不认——旧版 want.indexOf(k)>=0 无边界，搜 ABP-123 会点进
     ABP-12 / ABP-1234 的详情页，把错片数据入库、目标番号从未抓取 */
  function findResultIndex(results, code) {
    const list = results || [];
    if (!code) return -1;
    const want = resultKey({ code: code });
    for (let i = 0; i < list.length; i++) {
      if (resultKey(list[i]) === want) return i;
    }
    for (let i = 0; i < list.length; i++) {
      const k = resultKey(list[i]);
      if (!k) continue;
      const numPref = /^(\d+)([A-Za-z].*)$/.exec(k);
      if (numPref && numPref[2] === want) return i;
      if (k.indexOf(want + '-') === 0) return i;
    }
    return -1;
  }

  function parseSearchResults() {
    const out = [];
    /* 各站自己的搜索结果选择器（FANZA 用 /av/content/?id= 链接） */
    const k = currentSourceKey();
    const cf = getCfg();
    const lsel = (k && cf.sources[k] && cf.sources[k].sel && cf.sources[k].sel.result) || '';
    if (lsel) {
      $$(lsel).forEach(n => {
        const a = n.tagName === 'A' ? n : n.querySelector('a[href]');
        if (!a) return;
        const href = a.getAttribute('href');
        if (!href) return;
        let url = href;
        try { url = new URL(href, location.href).href; } catch (e) { return; }
        const t = ((a.getAttribute('title') || '') + ' ' + (n.textContent || '')).trim().replace(/\s+/g, ' ');
        /* #20：番号优先取结果里的 <strong>/<code> 等番号元素，其次用你在设置里配的正则（按当前站 codeUse 选） */
        let code = '';
        /* v1.3.66 #24：'[class*="code"]' 无边界会把 encode/decode/barcode/sourcecode
           容器也当番号元素（其文本喂进 matchCodeIn，噪声多时可能撞出错误番号）。
           改令牌精确匹配 + 连字符边界：.code / class~="code" / *-code / code-*，
           encode 这类词中子串不再命中；.video-code 由专属选择器继续覆盖。 */
        const ce = n.querySelector('strong, .code, .video-code, [class~="code"], [class*="-code"], [class*="code-"]');
        if (ce) code = matchCodeIn(ce.textContent || '', k);
        if (!code) code = matchCodeIn(t, k);
        if (!code) {
          const m = /([A-Za-z]{2,8})-?(\d{2,6})/.exec(t);
          if (m) code = (m[1] + '-' + m[2]).toUpperCase();
        }
        const im = n.querySelector('img');
        const cover = im ? (im.getAttribute('data-src') || im.getAttribute('data-original') || im.getAttribute('src') || '') : '';
        if (!out.some(x => x.url === url)) out.push({ code: code, title: t.slice(0, 120), url: url, cover: cover });
      });
      if (out.length) return out;
    }
    const nodes = $$('.movie-list .item, .video-list .item, .item-list .item, .grid-item, .item');
    nodes.forEach(n => {
      const a = n.querySelector('a[href*="/v/"]') || n.querySelector('a[href]');
      if (!a || !a.href) return;
      const strong = n.querySelector('strong') || n.querySelector('.video-title strong');
      let code = strong ? (strong.textContent || '').trim() : '';
      if (!code) {
        const m = /([A-Za-z]{2,8})-?(\d{2,5})/.exec(n.textContent || '');
        if (m) code = (m[1] + '-' + m[2]).toUpperCase();
      }
      const tEl = n.querySelector('.video-title') || n.querySelector('.title') || n;
      let title = (tEl.textContent || '').trim().replace(/\s+/g, ' ');
      if (code) title = title.replace(code, '').trim();
      out.push({ code: code, title: title, url: a.href });
    });
    return out.filter(r => r.url);
  }
  function isSearchPage() {
    return /\/search|\?q=|\?key=|searchstr|\/list\/\?/.test(location.href);
  }

  /* ==========================================================================
   * 确认弹窗
   * ======================================================================== */
  /* ==========================================================================
   * #26 收件箱去重与跨标签同步
   *   · 同一番号（忽略前导零差异，DSOD-9 ↔ DSOD-009）只保留一条
   *   · 多标签并发写：localStorage 互斥锁 + 「最近写入」记录，避免重复追加
   *   · 写入失败：重试一次，仍失败就把这条下载成 json，不丢数据
   * ======================================================================== */
  const TAB_ID = 'tab' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  /* v1.3.59：HTML 转义提为模块级——诊断面板（#19）与队列面板共用。
     只转双引号不够：页面原文（片名/演员/err）里的 < > & 会直接进 innerHTML。 */
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  /* v1.3.60 #29b：剪贴板两级回退（GM_setClipboard → navigator.clipboard）。
     writeText 返回 Promise：rejection 不会被同步 try/catch 捕获——旧版两处调用都是
     `try { writeText(x); ok = true } catch {}`，失败时 ok 已置 true，提示「已复制」
     但剪贴板里什么都没有。这里按 thenable 分流，成功/失败各有明确提示。 */
  function copyText(text, okMsg) {
    try { GM_setClipboard(text, 'text'); toast(okMsg, 'ok'); return; } catch (e) {}
    try {
      const cp = navigator.clipboard.writeText(text);
      if (cp && typeof cp.then === 'function') {
        cp.then(() => toast(okMsg, 'ok'),
          () => toast('复制失败：浏览器拒绝了剪贴板访问，请手动复制', 'err'));
      } else { toast(okMsg, 'ok'); }
    } catch (e) { toast('复制失败：' + ((e && e.message) || e), 'err'); }
  }
  const LOCK_KEY = 'fl_inbox_lock';
  /* v1.3.69 #5：收件箱是「跨源共享的单文件」，而 localStorage 是按「源」隔离的——
     本脚本 @match 覆盖 javdb / missav / motv / dmmvideo / dmm / mgs 六个不同域，
     在 A 站与 B 站各开一个标签页并行抓取（正是设计用途：多站互补）时，两边各自的
     localStorage 互不可见，互斥锁形同虚设 → 后写者基于旧内容整文件覆写，
     先写者的条目整批丢失。
     对策是「两层锁」而不是把锁整体搬到 GM：本源锁继续用 localStorage 直写（GM 存储
     由脚本管理器维护、跨源共享，但读写更重且部分环境不可用），另在 GM 写一份带
     origin 的锁（见下方 crossOriginLock*），只用来拦「别的站点」。
     这样同站多标签仍走原来的 CAS + 写后二次确认路径（#22 语义与 v1.3.67 完全一致），
     只有跨站并行才让出，也不会给本源读写引入新的失败点。 */
  /* ---- v1.3.69 #5：跨源锁（只拦「别的站点」，不拦同站） ----
     收件箱是「跨源共享的单文件」，而 localStorage 按「源」隔离。本脚本 @match
     覆盖 javdb / missav / motv / dmmvideo / dmm / mgs 六个域，在 A 站与 B 站各开
     一个标签页并行抓取（正是设计用途：多站互补）时，两边的 localStorage 互不可见
     → 后写者基于旧内容整文件覆写，先写者的条目整批丢失。
     对策：加锁时额外往 GM 存储（脚本管理器维护、跨源共享）写一份带 origin 的锁；
     拿到本源锁之后再查一次 GM——只有「origin 不同且未过期」才让出锁。
     同站（含同标签页刷新/导航）一律交给本源锁，避免把残留锁误判成别人的。 */
  function crossOriginLocked(now){
    try {
      if (typeof GM_getValue !== 'function') return false;   // 无 GM → 优雅退化
      const v = GM_getValue(LOCK_KEY, null);
      if (v == null) return false;
      const o = JSON.parse(v);
      if (!o || o.id === TAB_ID) return false;               // 自己（同一脚本实例）
      const cur = (typeof location !== 'undefined' && location.origin) ? location.origin : '';
      if (o.origin && cur && o.origin === cur) return false; // 同站：交给本源锁处理
      return (now - (o.t || 0)) <= 60000;                    // 跨站且未过期 → 让出
    } catch (e) { return false; }
  }
  function crossOriginLockSet(now){
    try {
      if (typeof GM_setValue !== 'function') return;
      GM_setValue(LOCK_KEY, JSON.stringify({
        t: now, id: TAB_ID,
        origin: (typeof location !== 'undefined' && location.origin) ? location.origin : ''
      }));
    } catch (e) {}
  }
  function crossOriginLockDel(){
    try { if (typeof GM_deleteValue === 'function') GM_deleteValue(LOCK_KEY); } catch (e) {}
  }
  const RECENT_KEY = 'fl_recent_writes';
  /* 零填充归一化键：DSOD-009 与 DSOD-9 视为同一部 */
  function padKey(code) {
    const str = String(code == null ? "" : code).trim().toUpperCase();
    const m = /^([A-Z]+)-?0*(\d+)$/.exec(str);
    if (m) return m[1] + "-" + String(parseInt(m[2], 10));
    return str;
  }
  function digitLen(code) {
    const m = /(\d+)\s*$/.exec(String(code == null ? "" : code));
    return m ? m[1].length : 0;
  }
  /* 条目信息完整度：字段越多分越高，用于重复时挑保留哪个 */
  function scoreItem(it) {
    if (!it) return -1;
    let n = 0;
    ['title', 'titleCn', 'actorF', 'actorM', 'actor', 'maker', 'release', 'magnet'].forEach(k => {
      if (String(it[k] == null ? '' : it[k]).trim()) n++;
    });
    if (it.cover) n += 2;
    if (Array.isArray(it.shots) && it.shots.length) n += 2;
    /* v1.3.44 分级覆盖：来源层级作第一排序键——一级站（FANZA/MGS/FC2）来料永远赢
       二级站，字段丰富度降为次级（档位差 1000 远大于字段分上限 ~12）。
       注意是「一级加大档」不是「tier 值乘系数」——后者会让 tier=2 比 tier=1 分还高，
       正好把排序搞反（二级富条目赢一级穷条目）。无层级信息的旧来料不占档，凭字段分竞争。
       修复：javdb 二级条目（9 分）曾在收件箱里挤掉缺中文名的 MGS 一级条目（7 分）。 */
    const t = tierOfItem(it);
    if (t === 1) n += 2000;
    else if (t === 2) n += 1000;
    return n;
  }
  /* 收件箱内按归一化键归并（保留信息更全、番号位数更完整的那条） */
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
  /* 跨标签互斥锁（60 秒自动过期，防死锁）。
     v1.3.48 BUG-11（P1）：TTL 必须大于持锁时长——大收件箱（含 base64 图）读+写
     轻松超过旧值 15s，锁提前过期 → 另一标签抢锁 → 两边都基于旧内容整文件覆写 →
     后写者覆盖先写者的条目（二丢一）。60s 覆盖实测最坏路径；持锁方崩溃的残留
     窗口从 15s 放宽到 60s，收件箱写入非高频操作，可接受。 */
  async function acquireInboxLock(maxWait) {
    const t0 = Date.now();
    for (;;) {
      /* v1.3.69 #5：localStorage 按「源」隔离，而收件箱是跨源共享的单个文件——
         本脚本 @match 覆盖六个域，在 A 站与 B 站各开一个标签页并行抓取（正是设计
         用途：多站互补）时，两边的 localStorage 互不可见 → 双方都认为自己持锁 →
         后写者基于旧内容整文件覆写，先写者的条目整批丢失。GM 存储由脚本管理器维护、
         跨源共享，用它做第一道闸门：别人（别的源）持锁时先等，不抢。
         GM 不可用时优雅退化（只保留本源锁的既有行为）。 */
      if (crossOriginLocked(Date.now())) {
        if (Date.now() - t0 >= maxWait) return false;
        await new Promise(r => setTimeout(r, 120));
        continue;
      }
      let l = null;
      try { l = JSON.parse(localStorage.getItem(LOCK_KEY) || "null"); } catch (e) { l = null; }
      const now = Date.now();
      if (!l || l.id === TAB_ID || (now - l.t) > 60000) {
        try { localStorage.setItem(LOCK_KEY, JSON.stringify({ t: now, id: TAB_ID })); } catch (e) {}
        crossOriginLockSet(now);   /* v1.3.69 #5：同时写跨源可见的那一份 */
        /* v1.3.59 #22：localStorage 无 CAS——「读到无锁/过期锁 → 写锁」之间，
           两个标签可同时通过（后者覆盖前者，双方都以为自己持锁 → 基于旧内容
           整文件覆写 → 二丢一）。写后延迟复查一次：锁若已变成别人的，说明踩了
           竞态窗口，继续循环重新竞争（不返回 false，没超时就还有机会）。 */
        await new Promise(r => setTimeout(r, 60));
        let l2 = null;
        try { l2 = JSON.parse(localStorage.getItem(LOCK_KEY) || "null"); } catch (e) { l2 = null; }
        /* v1.3.69 #5：本源锁拿到后即生效——跨源闸门已在抢锁前确认过（见上）。 */
        if (l2 && l2.id === TAB_ID) return true;
        if (Date.now() - t0 >= maxWait) return false;
        await new Promise(r => setTimeout(r, 120));
        continue;
      }
      if (now - t0 >= maxWait) return false;
      await new Promise(r => setTimeout(r, 120));
    }
  }
  /* v1.3.59 #22：持锁方在写盘前复查——大收件箱读+写超过 60s TTL 时锁会「过期」，
     另一标签据此抢锁并基于旧内容覆写（二丢一）。复查发现锁已丢就中止本次写入，
     数据走各自的保命路径（下载兜底 / 写回 GM 备份），绝不覆盖别人的成果。 */
  function lockStillMine() {
    try {
      let l = null;
      try { l = JSON.parse(localStorage.getItem(LOCK_KEY) || "null"); } catch (e) { l = null; }
      return !!l && l.id === TAB_ID && (Date.now() - l.t) <= 60000;
    } catch (e) { return false; }
  }
  function releaseInboxLock() {
    try {
      let l = null;
      try { l = JSON.parse(localStorage.getItem(LOCK_KEY) || "null"); } catch (e) { l = null; }
      if (l && l.id === TAB_ID) { localStorage.removeItem(LOCK_KEY); crossOriginLockDel(); }
    } catch (e) {}
  }
  function markRecentWrite(code) {
    try {
      let rw = {};
      try { rw = JSON.parse(localStorage.getItem(RECENT_KEY) || "{}") || {}; } catch (e) { rw = {}; }
      const now = Date.now();
      /* 顺手修剪：只保留 30 秒内的记录（与 recentWriteFromOtherTab 判断窗口一致），
         防 localStorage 无限堆积、全量 JSON 读写越来越慢（v1.3.46 任务119） */
      Object.keys(rw).forEach(function (k) {
        if (now - ((rw[k] && rw[k].t) || 0) >= 30000) delete rw[k];
      });
      rw[padKey(code)] = { t: now, id: TAB_ID };
      localStorage.setItem(RECENT_KEY, JSON.stringify(rw));
    } catch (e) {}
  }
  /* 别的标签页 30 秒内刚写过同番号 → 跳过，避免重复追加 */
  function recentWriteFromOtherTab(code) {
    try {
      let rw = {};
      try { rw = JSON.parse(localStorage.getItem(RECENT_KEY) || "{}") || {}; } catch (e) { rw = {}; }
      const p = rw[padKey(code)];
      return !!(p && p.id !== TAB_ID && (Date.now() - p.t) < 30000);
    } catch (e) { return false; }
  }
/* ==========================================================================
 * Phase 2（v1.3.28）：FL Server HTTP 通道
 *   服务端（FL Server，默认 127.0.0.1:8787）是唯一有权写数据目录的进程；
 *   爬虫优先走 HTTP，服务不在线 / 数据目录未配置时降级为文件夹写入、再降级为下载。
 *   GM_xmlhttpRequest 不受页面 CORS 限制；另加竞速超时，防测试桩不回调时挂死。
 * ======================================================================== */
const SERVER = 'http://127.0.0.1:8787';
let _srvCache = { at: 0, ok: false, why: '', json: null };
function httpJson(method, p, body, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    /* 竞速兜底：GM_xmlhttpRequest 因任何原因不回调（如测试桩 function(){}）也不会挂死 */
    const timer = setTimeout(() => fin({ ok: false, why: '请求超时（' + SERVER + p + '）' }), timeout || 5000);
    const settle = (v) => { clearTimeout(timer); fin(v); };
    try {
      GM_xmlhttpRequest({
        method: method,
        url: SERVER + p,
        timeout: timeout || 5000,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        data: body ? JSON.stringify(body) : undefined,
        onload: (r) => {
          /* v1.3.59 #24：JSON 解析失败单独分流——旧版与真 HTTP 错误走同一分支，
             j=null 时 why 显示「HTTP 200」（自相矛盾，排障被误导）。 */
          let j = null, bad = false;
          try { j = JSON.parse(r.responseText); } catch (e) { bad = true; }
          if (!bad && r.status >= 200 && r.status < 300 && j && j.ok !== false) settle({ ok: true, status: r.status, json: j });
          else settle({ ok: false, status: r.status, why: bad
            ? ('响应不是合法 JSON（HTTP ' + r.status + '）：' + String(r.responseText == null ? '' : r.responseText).slice(0, 80))
            : ((j && j.error) || ('HTTP ' + r.status)) });
        },
        onerror: () => settle({ ok: false, why: '无法连接 FL Server（' + SERVER + '）' }),
        ontimeout: () => settle({ ok: false, why: 'FL Server 响应超时' }),
        onabort: () => settle({ ok: false, why: '请求被中止' })
      });
    } catch (e) { settle({ ok: false, why: (e && e.message) || String(e) }); }
  });
}
/* 服务在线且数据目录已配置（5s 缓存，避免每次保存都探一次；force=true 强制重探） */
async function serverReady(force) {
  const now = Date.now();
  if (!force && _srvCache.at && now - _srvCache.at < 5000) {
    return _srvCache.ok ? _srvCache : { ok: false, why: _srvCache.why, json: null };
  }
  const r = await httpJson('GET', '/api/status', null, 2500);
  const configured = !!(r.ok && r.json && r.json.configured !== false);
  _srvCache = { at: now, ok: configured, why: configured ? '' : ((r.json && !r.json.configured) ? '数据目录未配置' : (r.why || '服务不可用')), json: r.json || null };
  return configured ? { ok: true, why: '', json: r.json } : { ok: false, why: _srvCache.why, json: null };
}

  /* v1.3.67 库内查询：把识别到的番号发给 FL Server（GET /api/exists），由 Server 直读
     Film Library.json 判定后回传 {found, tier, ...}。油猴脚本读不到 Film Library 的数据
     文件，必须走这条本地 HTTP 桥——Spider 只问「在不在、几级来源」，不回传整库。
     状态机：none=未识别番号 / offline=服务不在线 / miss=库内无此片 /
             nosrc=库内有但无来源信息（用户自建）/ tier1=一级来源 / tier2=二级来源。 */
  var _libBtnBusy = false;
  async function queryLibBtn(btn, code, force) {
    if (!btn) return;
    const c = String(code || '').trim();
    if (!c) { setLibBtn(btn, 'none', null); return; }
    if (_libBtnBusy) return;   /* 自动查与手动点可能撞上，不并发 */
    _libBtnBusy = true;
    try {
      /* force：手动刷新时绕过 serverReady 的 5s 缓存——服务刚掉线时缓存会
         把「不在线」误报成在线，点击刷新必须拿到真实状态（v1.3.67 实测）。 */
      const sr = await serverReady(!!force);
      if (!sr || !sr.ok) { setLibBtn(btn, 'offline', null, sr && sr.why); return; }
      const r = await httpJson('GET', '/api/exists?code=' + encodeURIComponent(c));
      if (!r || !r.ok || !r.json) { setLibBtn(btn, 'offline', null); return; }
      const j = r.json;
      if (!j.found) { setLibBtn(btn, 'miss', j); return; }
      setLibBtn(btn, j.tier === 1 ? 'tier1' : (j.tier === 2 ? 'tier2' : 'nosrc'), j);
    } catch (e) { setLibBtn(btn, 'offline', null); }
    finally { _libBtnBusy = false; }
  }
  function setLibBtn(btn, state, j, why) {
    const M = {
      none:    ['查', '#475569', '未识别到番号，无法查询'],
      offline: ['?', '#64748b', ''],
      miss:    ['无', '#94a3b8', '库内无此片（点击刷新）'],
      nosrc:   ['无', '#94a3b8', '库内有此片，但没有来源信息（用户自建条目，不算一级/二级来源）'],
      tier1:   ['一', '#1f9d55', ''],
      tier2:   ['二', '#f59e0b', '']
    };
    const m = M[state] || M.none;
    let tip = m[2];
    if (state === 'offline') tip = '查不了：' + (why || 'FL Server 不在线') + '（启动本地服务后点此刷新）';
    if ((state === 'tier1' || state === 'tier2') && j) {
      const src = j.platform ? '（来源：' + j.platform + '）' : '';
      const tt = j.title ? '《' + j.title + '》' : '';
      tip = (state === 'tier1' ? '库内已有一级来源信息 ' : '库内仅有二级来源信息 ') + tt + src + '（点击刷新）';
    }
    btn.textContent = m[0];
    btn.style.cssText = roundCss(m[1]);
    btn.title = tip;
    btn.setAttribute('data-fl-lib-state', state);
  }

  /* 写入失败兜底：把这条下载成 json，数据不丢 */
  let _lastFallbackAt = 0;   /* v1.3.64 #11：回退下载节流时间戳 */
  function inboxFallbackDownload(item, err) {
    /* v1.3.64 #11：连续失败连续触发 a.click() —— Chrome 默认拦截「站点尝试下载多个文件」，
       用户不点允许则所有回退 JSON 都没落地，而 toast 却显示「已下载为 …」（假成功）。
       3 秒内的连续失败改为写 GM 备份（BATCH_BK_KEY，recoverBatchBackup 下次进站点自动
       重试），不再逐条下载。 */
    const now = Date.now();
    if (now - _lastFallbackAt < 3000) {
      try {
        let bk = null;
        try { bk = JSON.parse(GM_getValue(BATCH_BK_KEY, 'null')); } catch (e) {}
        const items = (bk && bk.items) ? bk.items.concat([item]) : [item];
        GM_setValue(BATCH_BK_KEY, JSON.stringify({ savedAt: now, items: items }));
      } catch (e) {}
      toast('检测到连续失败，本条已暂存备份（不再逐条下载，避免浏览器拦截）；下次进站点自动重试', 'warn');
      return true;
    }
    _lastFallbackAt = now;
    /* v1.3.51 A-04（P3）：回退文件名旧版连日期都没有——同一番号重试两次下载会撞名，
       浏览器虽自动加 (1) 后缀但目录里难分先后；带上 stamp 后按名排序即时间序。 */
    const name = 'Film Library 收件箱_回退_' + stamp() + '_' + ((item && item.code) || 'unknown') + '.json';
    try {
      const payload = {
        app: 'Film Library', type: 'inbox', source: 'fl-spider',
        updatedAt: new Date().toISOString(), items: [item]
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { URL.revokeObjectURL(a.href); } catch (e) {} try { a.remove(); } catch (e) {} }, 2000);
      toast('写入文件夹失败（' + ((err && err.message) || err) + '）：已下载为 ' + name + '，把它放进同一目录即可', 'err');
      return true;
    } catch (e) {
      toast('写入失败且无法导出备份：' + ((err && err.message) || err), 'err');
      return false;
    }
  }

  /* 抓取图片 → 写入收件箱 → 队列续跑。
     「确认入库」弹窗与「抓取」按钮（直接抓取）共用这一段，保证两条路行为完全一致。 */
  async function saveItemToInbox(key, raw, item, wantShots) {
    /* v1.3.44：来源分级章——所有写入路径（确认弹窗/直抓/批量）统一在这里盖，
       供收件箱归并、文件夹写入比对与 Film Library 导入覆盖使用 */
    item.srcTier = tierOfSource(key, item.code);
    /* v1.3.55：进来先记住有没有批次/队列上下文——下面的 setCurrent(null) 会清掉它，
       而尾部要不要走 finishQueue（弹结果面板+写报告）靠这个判断（与 fl-cancel 同口径） */
    const __wasCur = getCurrent();
    /* v1.3.28：FL Server 在线 → 全程 HTTP，不弹文件夹选择框（服务端唯一写数据目录） */
    const srv = await serverReady();
    const httpMode = !!(srv && srv.ok);
    if (!httpMode) {
      try { await ensureFolder(); }
      catch (e) { toast('选择文件夹失败：' + ((e && e.message) || e), 'err'); return false; }
    }

    const code = item.code;
    toast(httpMode ? '正在抓取图片并写入 FL Server…' : '正在抓取图片并写入文件夹…', 'ok');
    let wrote = false;
    try {
      const cfgQ = getCfg();
      const wantOrigin = String(cfgQ.imgQuality || 'origin') === 'origin';
      const coverU = wantOrigin ? (upgradeImgUrl(raw.coverUrl) || raw.coverUrl) : raw.coverUrl;
      const src = cfgQ.sources[key];
      const asCover = !!(src && (src.xf === 'fanza' || src.tier === 1));  // 一级来源站（FANZA、MGS）的封面即 Film Library 封面；二级站封面仍归为截图
      if (asCover) {
        item.cover = await fetchImgAsDataUrl(coverU);
        if (!item.cover && coverU !== raw.coverUrl) item.cover = await fetchImgAsDataUrl(raw.coverUrl);
      } else {
        item.cover = null;   // 非一级站：封面不写入 cover，改作截图（见下）
        /* v1.3.55：二级站封面的唯一去处就是下面 unshift 进截图数组；用户取消
           「抓截图」（wantShots=false）时封面既不在 cover 也不在 shots，影片无封面
           入库（一级站不受影响，行为不一致）。此时退而求其次：直接写进 cover。 */
        if (!wantShots && coverU) item.cover = await fetchImgAsDataUrl(coverU);
      }
      const shotUrls = (raw.shotUrls || []).slice();
      if (!asCover && coverU) shotUrls.unshift(coverU);   // 把非一级站的封面补到第 1 张截图
      if (wantShots && shotUrls.length) {
        const urls = shotUrls.map(u => (wantOrigin ? (upgradeImgUrl(u) || u) : u));
        const imgs = await fetchImgsLimited(urls, Math.max(1, parseInt(cfgQ.imgConc, 10) || 1));
        imgs.forEach(d => {
          /* v1.3.59 #25：('0'+N).slice(-2) 在第 100 张回绕成 _00 与第 1 张重名。
             padStart(2) 对 ≤99 与旧行为一致（01..99），100 起自然长到三位不重名。 */
          if (d) item.shots.push({ name: code + '_' + String(item.shots.length + 1).padStart(2, '0') + '.jpg', dataUrl: d });
        });
      }
      /* #26：批量模式累积到内存，finishQueue 一次性加锁单写；单部保存仍即时写 */
      if (_inboxBatch !== null) {
        if (recentWriteFromOtherTab(code)) {
          toast('另一个标签页刚写过这个番号，已跳过（不重复追加）', 'ok');
        } else {
          _inboxBatch.push(item);
          markRecentWrite(code);
          /* v1.3.64 #8：只有真写了的才记成功——旧版跳过项也 markDone，
             结果面板/报告把「被跳过」虚报成「本次成功」。
             v1.3.69 #15：入批同样不算「写了」——整批 POST 失败时数据只躺在 GM 备份里，
             却已被报成成功。改为先登记待确认，真落盘后由 flushPendingDone 补记。 */
          _pendingDoneCodes.push(code);
        }
        setCurrent(null);
        wrote = true;
      } else if (recentWriteFromOtherTab(code)) {
        toast('另一个标签页刚写过这个番号，已跳过（不重复追加）', 'ok');
        setCurrent(null);      /* v1.3.64 #8：跳过不记 success（见上） */
        wrote = true;
      } else {
        /* v1.3.28：HTTP 直写（服务端加锁 + padKey 去重，无需本地锁） */
        if (httpMode) {
          const hr = await httpJson('POST', '/api/inbox', item);
          if (hr.ok) {
            markRecentWrite(code);
            wrote = true;
            /* v1.1.3 服务端分级回执：二级来料撞一级存量时记 skipped，明确告知用户 */
            const sk = (hr.json && hr.json.skipped) || [];
            toast('已通过 FL Server 写入收件箱（共 ' + ((hr.json && hr.json.total != null) ? hr.json.total : '?') + ' 条）'
              + (sk.length ? '，' + sk.length + ' 条已有一级来源数据已跳过' : ''), 'ok');
          } else {
            toast('FL Server 写入失败（' + (hr.why || '未知错误') + '），降级写入（文件夹 / 下载备份）', 'warn');
            /* v1.3.57 #9：旧版无条件 ensureFolder()——内部 showDirectoryPicker 先弹
               一次系统框；用户取消/失败后再抛错被这里 catch 又 toast 一次（双提示），
               且文案说的「改为下载备份文件」与实际路径（又弹框）不符。
               改为先只探测不弹框（hasAuthorizedFolder，v1.3.51 A-01 语义）：
               已授权才 ensureFolder（此时直接返回句柄，不会弹框）；未授权则不弹框，
               落到下面的文件夹重试 / 下载兜底，一次性提示由 inboxFallbackDownload 给准。 */
            if (await hasAuthorizedFolder()) {
              try { await ensureFolder(); } catch (e2) { /* 已授权不会抛；防御性 */ }
            }
          }
        }
        let lastErr = null;
        let skippedByTier = false;   /* v1.3.69 #16：二级撞一级 → 按设计跳过 */
        for (let attempt = 0; attempt < 2 && !wrote; attempt++) {
          if (!(await acquireInboxLock(6000))) {
            lastErr = new Error('另一个标签页正在写收件箱，等待超时');
            break;
          }
          try {
            const payload = (await readJsonFromFolder(INBOX_FILE)) || {};
            payload.app = 'Film Library'; payload.type = 'inbox'; payload.source = 'fl-spider';
            payload.updatedAt = new Date().toISOString();
            payload.items = dedupeInbox(payload.items || []);
            const idx = payload.items.findIndex(i => i && i.code && padKey(i.code) === padKey(code));
            if (idx >= 0) {
              const oldIt = payload.items[idx];
              if (digitLen(oldIt.code) > digitLen(item.code)) item.code = oldIt.code;
              /* v1.3.44 分级覆盖：新来料层级低于存量（tier 数值更大，二级撞一级）→ 保留存量并提示；
                 同级或更高 → 替换（与旧行为一致，来料较新） */
              if (tierOfItem(item) > tierOfItem(oldIt)) {
                /* v1.3.69 #16：跳过必须真的跳过。旧版只 toast，后面照常
                   writeJsonToFolder + wrote=true + markDone + 「已写入 N 条」toast，
                   用户同时收到「跳过」和「已写入」两条矛盾提示，该番号还被计入成功。 */
                skippedByTier = true;
                toast('已有一级来源数据（' + (oldIt.platform || '一级') + '），跳过本次二级来源写入', 'ok');
              } else {
                payload.items[idx] = item;
              }
            } else {
              payload.items.push(item);
            }
            /* v1.3.59 #22：写盘前确认锁还在自己手里（TTL 可能已被偷） */
            if (!lockStillMine()) { lastErr = new Error('锁已被其他标签页接管，放弃本次覆写'); break; }
            /* v1.3.69 #16：payload 没被改动就不写盘、不记成功 */
            if (skippedByTier) { lastErr = null; break; }
            await writeJsonToFolder(INBOX_FILE, payload);
            markRecentWrite(code);
            wrote = true;
            toast('已写入 ' + INBOX_FILE + '（' + payload.items.length + ' 条）', 'ok');
          } catch (e) { lastErr = e; }
          finally { releaseInboxLock(); }
          if (!wrote && attempt === 0) await new Promise(r => setTimeout(r, 600));
        }
        if (skippedByTier) {
          setCurrent(null);      /* v1.3.69 #16：按设计跳过——不算成功也不算失败，不触发下载兜底 */
        } else if (wrote) {
          markDone(code);
          setCurrent(null);      // 本条成功，清掉"当前处理项"
        } else {
          inboxFallbackDownload(item, lastErr);
        }
      }
    } catch (e) {
      toast('写入失败：' + ((e && e.message) || e), 'err');
    }
    // 队列：半自动 —— 停 queueDelay 毫秒再跳下一个，避免连续刷新被站点风控
    const q = getQueue();
    if (q.length) {
      const delay = Math.max(0, getCfg().queueDelay || 0);
      toast('队列还剩 ' + q.length + ' 个，' + Math.round(delay / 1000) + ' 秒后继续…', 'ok');
      setTimeout(nextInQueue, delay);
    } else if (__wasCur || _inboxBatch !== null) {
      /* v1.3.55：与「取消」路径（fl-cancel，v1.3.47/v61 修）同口径——只有确有批次/队列
         上下文时才走 finishQueue。旧版无条件走：单部手动保存（无 current、无内存批）
         每次保存都弹全屏「批量抓取结果」挡住界面（同款症状用户实测过），且 getDone
         跨次不清零会把历史所有番号冒充「本次成功」。v61 只修了取消路径，保存路径漏修。 */
      finishQueue();
    }
    return wrote;
  }

  /* 「抓取」按钮：直接抓、直接写，不弹确认框。
     字段取自站点解析结果，中文名仍走四级链（站点自带 → 本地映射 → 中文源 → Google 翻译）；
     想手动核对 / 改字段就点旁边的「确认入库」按钮。 */
  async function quickSave(key) {
    const cfg = getCfg();
    const raw = parseDetail(key);
    /* v1.3.69 #19：站点一次瞬时抽风（该次缺字段）不能把带 0 的签名写成基线——
       structureChanged 要求历史签名 /^1+$/，一旦存入含 0 的签名就永远不再告警。
       v1.3.60 #21 的修复只落在 openParseDiag 一处，这里补上。 */
    if (raw && raw._diag) { warnStructure(key, raw._diag); if (!raw._diag.miss || !raw._diag.miss.length) saveSig(key, raw._diag); }
    if (!raw || !raw.code) {
      toast('没识别到番号，无法直接抓取；可点「确认入库」手动填', 'err');
      return;
    }
    toast('正在抓取 ' + raw.code + ' …', 'ok');
    let cn = String(raw.titleCn || '').trim();
    if (!cn && raw.code) cn = String(cnFromMap(raw.code) || '').trim();
    if (!cn && cfg.cnSourceUrl && raw.code) cn = String((await fetchCnFromSource(raw.code)) || '').trim();
    if (!cn && cfg.translate && raw.title) cn = String((await googleTranslate(raw.title, cfg.sl, cfg.tl)) || '').trim();
    const item = {
      code: normCode(raw.code),
      title: String(raw.title || '').trim(),
      titleCn: cn,
      release: String(raw.release || '').trim(),
      actorF: String(raw.actorF || '').trim(),
      actorM: String(raw.actorM || '').trim(),
      actor: '',
      maker: String(raw.maker || '').trim(),
      platform: String(raw.platform || '').trim(),
      series: String(raw.series || '').trim(),
      director: String(raw.director || '').trim(),
      magnet: '',
      status: '未看',          // 与 Film Library 的状态取值保持一致
      downloaded: false,
      note: raw.note || '',
      cover: null,
      shots: [],
      source: key
    };
    item.actor = String(raw.actor || '').trim() || [item.actorF, item.actorM].filter(Boolean).join(', ');
    if (item.actorF || item.actorM) learnGender(item.actorF, item.actorM);
    if (cn) learnCn(item.code, cn);
    await saveItemToInbox(key, raw, item, true);
  }

  function openConfirmModal(key, preset) {
    /* v1.3.48 BUG-06（P1）：重入守卫——injectCrawlerUI 每次调用都排一个 900ms
       自动开窗定时器（SPA 路由 / FANZA 换 body 会触发多次注入），旧版无守卫 →
       多个 #fl-overlay 叠窗、事件双绑 → 一次点击双写收件箱。
       开新窗前先移除残留遮罩（含上次异常遗留的）。 */
    const stale = document.getElementById('fl-overlay');
    if (stale) stale.remove();
    const cfg = getCfg();
    const raw = preset || parseDetail(key);
    if (!preset && raw && raw._diag) { warnStructure(key, raw._diag); if (!raw._diag.miss || !raw._diag.miss.length) saveSig(key, raw._diag); }
    /* 截图文案与 parseDetail 的上限计算同口径（v1.3.55：一级站也不再写死 999，
       按适配器 maxShots / 用户设置），文案不说谎 */
    /* 与 parseDetail 同口径（含 v1.3.61 的无限制哨兵），文案不说谎 */
    const ad0 = adapterOf(key);
    const uN0 = parseInt(cfg.maxShots, 10);
    const adN0 = (!isFc2Code(raw.code) && ad0 && typeof ad0.maxShots === "function") ? ad0.maxShots() : null;
    let cap0;
    if (adN0 === 0) cap0 = 0;              /* 该站没有样图区 */
    else if (uN0 === 0) cap0 = 0;          /* 用户设 0 = 不抓 */
    else {
      cap0 = Math.min(SHOT_MAX, isFinite(uN0) ? uN0 : SHOT_MAX);
      if (adN0 != null) cap0 = Math.min(cap0, Math.max(0, adN0));
      cap0 = Math.max(0, Math.min(SHOT_MAX, cap0));
    }
    const shotDesc = cap0 <= 0 ? '不抓' : ('最多 ' + cap0 + ' 张');
    const overlay = document.createElement('div');
    overlay.id = 'fl-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:' + Z + ';' +
      'display:flex;align-items:center;justify-content:center;';
    const row = (label, id, val, ph) =>
      '<label style="display:block;margin:8px 0 2px;font-size:12px;color:#555;">' + label + '</label>' +
      '<input id="' + id + '" value="' + String(val == null ? '' : val).replace(/"/g, '&quot;') + '"' +
      ' placeholder="' + (ph || '') + '" style="width:100%;box-sizing:border-box;padding:6px;font-size:13px;">';
    /* 磁力链接：3 个独立文本框，手动填写，最多 3 条 */
    overlay.innerHTML =
      '<div style="background:#fff;color:#222;width:420px;max-width:94vw;max-height:88vh;overflow:auto;' +
      'border-radius:12px;padding:18px;font-size:14px;">' +
        '<h3 style="margin:0 0 6px;font-size:16px;">确认入库（FL Spider v' + VERSION + '）</h3>' +
        '<div id="fl-queue-line"></div>' +
        '<div id="fl-status" style="font-size:12px;color:#888;min-height:16px;"></div>' +
        row('番号 code', 'fl-code', raw.code, '必填') +
        row('影片原名 title', 'fl-title', raw.title, '日文原名') +
        row('影片中文名 titleCn', 'fl-cn', raw.titleCn, '由原名经 Google 翻译得到') +
        '<div style="display:flex;gap:6px;margin-top:4px;">' +
          '<button id="fl-tr" style="flex:1;padding:6px;border:none;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer;font-size:12px;">重新翻译</button>' +
          '<button id="fl-tr-sw" style="padding:6px 8px;border:none;border-radius:6px;background:#eee;color:#333;cursor:pointer;font-size:12px;" title="源语言">' +
            (cfg.sl === 'auto' ? '源语言:自动' : ('源语言:' + cfg.sl)) + '</button>' +
        '</div>' +
        '<div style="display:flex;gap:8px;">' +
          '<div style="flex:1;">' + row('影片日期 release', 'fl-release', raw.release, '商品発売日优先，如 2024/11/19') + '</div>' +
          '<div style="flex:1;">' + row('发行商 maker', 'fl-maker', raw.maker, '如 ムーディーズ、S1') + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;">' +
          '<div style="flex:1;">' + row('<span style="color:#d63384;font-weight:600;">♀ 女演员 actorF</span>', 'fl-actorF', raw.actorF, '抓到的演员默认归这里') + '</div>' +
          '<div style="flex:1;">' + row('<span style="color:#1d6fd6;font-weight:600;">♂ 男演员 actorM</span>', 'fl-actorM', raw.actorM, '手动补，多个用逗号分隔') + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;">' +
          '<div style="flex:1;">' + row('系列 series', 'fl-series', raw.series, '如 SWEET、PREMIUM') + '</div>' +
          '<div style="flex:1;">' + row('来源 platform', 'fl-platform', raw.platform, 'FANZA/MGS/FC2/JAVDB/MISSAV') + '</div>' +
        '</div>' +
        '<div style="margin-top:6px;">' +
        '<label style="display:block;margin:8px 0 2px;font-size:12px;color:#555;">磁力链接 magnet（可选，最多 3 条，每条填一个框）</label>' +
        row('磁力链接 1', 'fl-magnet-0', '', 'magnet:?xt=urn:btih:...') +
        row('磁力链接 2', 'fl-magnet-1', '', 'magnet:?xt=urn:btih:...') +
        row('磁力链接 3', 'fl-magnet-2', '', 'magnet:?xt=urn:btih:...') +
        '</div>' +
        '<label style="display:block;margin:8px 0 2px;font-size:12px;color:#555;">状态</label>' +
        '<select id="fl-status-sel" style="width:100%;padding:6px;font-size:13px;">' +
          STATUS.map(s => '<option value="' + s + '">' + s + '</option>').join('') + '</select>' +
        '<label style="display:flex;gap:6px;align-items:center;margin:10px 0 2px;font-size:12px;color:#555;">' +
          /* v1.3.63：上限为 0（不抓）时不再默认勾选——否则文案写「不抓」而框却勾着，
             用户一点保存就按「抓」走（虽然抓出来也是空，但语义自相矛盾）。 */
          '<input type="checkbox" id="fl-shot"' + (cap0 > 0 ? ' checked' : '') + '> 抓截图（' + shotDesc + '）</label>' +
        '<div style="margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
          '<button id="fl-reset" style="margin-right:auto;padding:8px 10px;border:none;border-radius:8px;background:#eee;color:#333;cursor:pointer;font-size:12px;">更换文件夹</button>' +
          '<button id="fl-cancel" style="padding:8px 12px;border:none;border-radius:8px;cursor:pointer;font-size:13px;">取消</button>' +
          '<button id="fl-ok" style="padding:8px 12px;border:none;border-radius:8px;background:#1f9d55;color:#fff;cursor:pointer;font-size:13px;">保存</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    scaleButtonsIn(overlay);

    const st = overlay.querySelector('#fl-status');
    const cnInput = overlay.querySelector('#fl-cn');

    /* ---- 队列状态行：剩余个数 / 停止队列 / 自动保存倒计时 ---- */
    let qTimer = null;
    const qLeft = getQueue().length;
    if (qLeft) {
      const qline = overlay.querySelector('#fl-queue-line');
      qline.innerHTML = '<div style="font-size:12px;color:#0f766e;margin:2px 0 4px;">队列剩余 ' + qLeft + ' 个 ' +
        '<button id="fl-stop-q" style="padding:2px 6px;border:none;border-radius:4px;background:#fee2e2;' +
        'color:#b91c1c;cursor:pointer;font-size:11px;">停止队列</button></div>';
      qline.querySelector('#fl-stop-q').addEventListener('click', () => {
        if (qTimer) clearInterval(qTimer);
        setQueue([]);
        qline.innerHTML = '<div style="font-size:12px;color:#b91c1c;margin:2px 0 4px;">队列已停止</div>';
        st.textContent = '已停止，本条仍可手动保存';
      });
      if (getCfg().autoQueue) {
        let left = Math.max(1, Math.round((getCfg().queueDelay || 3000) / 1000));
        const tick = () => {
          if (!document.body.contains(overlay)) { clearInterval(qTimer); return; }
          st.textContent = left + ' 秒后自动保存（点「取消」跳过这条 / 「停止队列」中止）';
          left--;
          if (left < 0) { clearInterval(qTimer); overlay.querySelector('#fl-ok').click(); }
        };
        tick();
        qTimer = setInterval(tick, 1000);
      } else {
        st.textContent = '队列进行中：确认后自动跳下一个';
      }
    }

    // 中文名四级链：站点自带 → 本地映射 → 可配中文源 → Google 翻译
    const alive = () => document.body.contains(overlay);
    (async () => {
      if (raw.titleCn && cnInput.value.trim()) {
        st.textContent = (raw.cnFrom === 'map') ? '中文名来自本地映射' : '中文名来自站点';
        return;
      }
      if (!cnInput.value.trim() && raw.code) {
        const mapped = cnFromMap(raw.code);
        if (mapped) {
          if (!alive()) return;
          cnInput.value = mapped; st.textContent = '中文名来自本地映射';
          return;
        }
      }
      if (!cnInput.value.trim() && getCfg().cnSourceUrl && raw.code) {
        st.textContent = '正在从中文源取中文名…';
        const cn = await fetchCnFromSource(raw.code);
        if (!alive()) return;
        if (cn) {
          cnInput.value = cn; st.textContent = '中文名来自中文源（可手动改）';
          return;
        }
        st.textContent = '中文源没拿到，改用翻译…';
      }
      if (cfg.translate && raw.title && !cnInput.value.trim()) {
        st.textContent = '正在翻译中文名…';
        const t = await googleTranslate(raw.title, cfg.sl, cfg.tl);
        if (!alive()) return;
        if (t) { cnInput.value = t; st.textContent = '中文名已由 Google 翻译生成，可手动修改'; }
        else st.textContent = '翻译失败，可手动填中文名';
      }
    })();

    overlay.querySelector('#fl-tr').addEventListener('click', () => {
      const t = overlay.querySelector('#fl-title').value.trim();
      if (!t) { st.textContent = '请先填原名'; return; }
      st.textContent = '正在翻译…';
      googleTranslate(t, cfg.sl, cfg.tl).then(r => {
        if (r) { cnInput.value = r; st.textContent = '翻译完成'; } else st.textContent = '翻译失败';
      });
    });
    overlay.querySelector('#fl-tr-sw').addEventListener('click', (e) => {
      const order = ['auto', 'ja', 'en', 'zh-TW'];
      const c2 = getCfg();
      const i = order.indexOf(c2.sl || 'auto');
      c2.sl = order[(i + 1) % order.length];
      setCfg(c2);
      e.target.textContent = c2.sl === 'auto' ? '源语言:自动' : ('源语言:' + c2.sl);
    });

    overlay.querySelector('#fl-cancel').addEventListener('click', async () => {
      if (qTimer) clearInterval(qTimer);
      overlay.remove();
      const __cur = getCurrent();
      if (__cur && __cur.code) batchMark(__cur.code, "skipped", __cur.retry || 0);
      if (getQueue().length) { toast('已跳过这一条', 'ok'); setTimeout(nextInQueue, 800); }
      /* 队列已空也必须走 finishQueue：把内存批落盘、写汇总报告、清当前项。
         旧版这里直接返回——跳过最后一条会让整批滞留内存 + 无报告 + CUR_KEY 悬挂（v1.3.43 修）
         v1.3.47：仅限确有批次/队列上下文时才走——__cur 有值 = 正在处理队列项，
         或 _inboxBatch 未落盘 = 批次进行中。单部手动确认后取消（无 current、无内存批）
         也走 finishQueue 会弹空的「批量抓取结果 0/0」+「已跳过最后一条」误导 toast，
         且结果弹窗没有自动关闭、会挡住设置等按钮（用户实测：手动取消后设置按钮点不着）——
         无上下文时静默关闭即可（flushInboxBatch 对空批本就是 no-op，无数据可丢） */
      else if (__cur || _inboxBatch !== null) { toast('已跳过最后一条，正在保存已抓内容…', 'ok'); await finishQueue(); }
    });
    overlay.querySelector('#fl-reset').addEventListener('click', async () => {
      await resetFolder();
      st.textContent = '已清除记忆的文件夹，点保存会重新让你选';
    });

    overlay.querySelector('#fl-ok').addEventListener('click', async () => {
      if (qTimer) clearInterval(qTimer);
      const code = normCode(overlay.querySelector('#fl-code').value);
      if (!code) { st.textContent = '番号不能为空'; return; }
      const wantShots = overlay.querySelector('#fl-shot').checked;
      const item = {
        code: code,
        title: overlay.querySelector('#fl-title').value.trim(),
        titleCn: cnInput.value.trim(),
        release: overlay.querySelector('#fl-release').value.trim(),
        actorF: overlay.querySelector('#fl-actorF').value.trim(),
        actorM: overlay.querySelector('#fl-actorM').value.trim(),
        actor: [overlay.querySelector('#fl-actorF').value, overlay.querySelector('#fl-actorM').value]
          .map(s => String(s || '').trim()).filter(Boolean).join(', '),
        maker: overlay.querySelector('#fl-maker').value.trim(),
        platform: overlay.querySelector('#fl-platform').value.trim(),
        series: String((overlay.querySelector('#fl-series') || {}).value || '').trim(),
        magnet: ['#fl-magnet-0', '#fl-magnet-1', '#fl-magnet-2'].map(s => (overlay.querySelector(s).value || '').trim()).filter(Boolean).join('\n'),
        status: overlay.querySelector('#fl-status-sel').value,
        downloaded: false,
        note: raw.note,
        cover: null,
        shots: [],
        source: key
      };
      learnGender(item.actorF, item.actorM);
      learnCn(code, cnInput.value);
      overlay.remove();
      await saveItemToInbox(key, raw, item, wantShots);
    });
  }

  /* ==========================================================================
   * 批量队列：fl_queue = [{code, url, retry}]
   *   - 抓完一条自动跳下一条
   *   - 抓不到（404 / 无结果）→ 重排队尾再试一次；第二次仍失败 → 记入失败清单
   *   - 队列跑完 → 把失败番号写成「Film Library 抓取失败番号_<日期>.json」
   * ======================================================================== */
  function getQueue() {
    try { return JSON.parse(GM_getValue(Q_KEY, '[]')) || []; } catch (e) { return []; }
  }
  function setQueue(q) { GM_setValue(Q_KEY, JSON.stringify(q)); }
  function getCurrent() {
    try { return JSON.parse(GM_getValue(CUR_KEY, 'null')); } catch (e) { return null; }
  }
  function setCurrent(v) { GM_setValue(CUR_KEY, JSON.stringify(v)); }
  function getFailed() {
    try { return JSON.parse(GM_getValue(FAIL_KEY, '[]')) || []; } catch (e) { return []; }
  }
  function setFailed(a) { GM_setValue(FAIL_KEY, JSON.stringify(a)); }
  function getDone() {
    try { return JSON.parse(GM_getValue(OK_KEY, '[]')) || []; } catch (e) { return []; }
  }
  function setDone(a) { GM_setValue(OK_KEY, JSON.stringify(a)); }
  function markDone(code) {
    if (!code) return;
    /* v1.3.58 #12：按 padKey 归一比较——旧版原始串 indexOf，DSOD-9 与 DSOD-009
       算两条，结果面板/报告重复计数；顺带保留最新写入的 code 形态。 */
    const k = padKey(code);
    const d = getDone().filter(x => padKey(x) !== k);
    d.push(code);
    setDone(d);
  }

  /* ==========================================================================
   * #29 批量抓取调度
   *   · 批次账本 fl_batch：每个番号的状态（成功/失败/跳过）、重试次数、耗时
   *   · 限速：两次跳转之间至少间隔 queueDelay（nextInQueue 内置闸门，且防重复排期）
   *   · 断点续抓：队列还在但当前项为空 → 下次进页面自动接着跑
   *   · 汇总报告：跑完写「Film Library 抓取报告_<日期>.json」
   * ======================================================================== */
  function batchKey() { return 'fl_batch'; }
  function batchGet() {
    try { return JSON.parse(GM_getValue(batchKey(), "null")) || null; } catch (e) { return null; }
  }
  function batchSet(b) { try { GM_setValue(batchKey(), JSON.stringify(b || null)); } catch (e) {} }
  function batchStart(codes) {
    beginInboxBatch();
    /* v1.3.59 #26：codes 按 padKey 去重后再建账本——旧版 b.items[String(c)]
       同键覆盖（DSOD-9 与 DSOD-009 撞同一键），total 却用去重前的长度，
       报告里 success+failed+skipped 总数永远对不上。 */
    const uniq = [];
    const seen = {};
    (codes || []).forEach(c => {
      if (!c) return;
      const k = padKey(c);
      if (seen[k]) return;
      seen[k] = 1;
      uniq.push(String(c));
    });
    const b = { startedAt: new Date().toISOString(), total: uniq.length, items: {} };
    uniq.forEach(c => {
      b.items[c] = { status: 'pending', tries: 0, ms: 0, at: '' };
    });
    batchSet(b);
    return b;
  }
  function batchMark(code, status, tries) {
    if (!code) return;
    const b = batchGet();
    if (!b) return;
    const k = String(code);
    b.items[k] = b.items[k] || { status: 'pending', tries: 0, ms: 0, at: '' };
    b.items[k].status = status;
    if (typeof tries === "number") b.items[k].tries = tries;
    b.items[k].at = new Date().toISOString();
    batchSet(b);
  }
  function batchSummary() {
    const b = batchGet();
    if (!b) return { total: 0, success: [], failed: [], skipped: [], pending: [] };
    const out = { total: b.total || 0, success: [], failed: [], skipped: [], pending: [] };
    Object.keys(b.items || {}).forEach(k => {
      const st = (b.items[k] && b.items[k].status) || "pending";
      if (out[st] && out[st].push) out[st].push(k);
      else if (out.pending) out.pending.push(k);
    });
    return out;
  }
  async function batchWriteReport() {
    const b = batchGet();
    if (!b) return false;
    const sum = batchSummary();
    const report = {
      app: 'Film Library', type: 'batch-report', source: 'fl-spider',
      startedAt: b.startedAt, finishedAt: new Date().toISOString(),
      total: sum.total, successCount: sum.success.length,
      failedCount: sum.failed.length, skippedCount: sum.skipped.length,
      success: sum.success, failed: sum.failed, skipped: sum.skipped,
      detail: b.items
    };
    const name = 'Film Library 抓取报告_' + stamp() + '.json';
    /* v1.3.49 BUG-14（P2）：HTTP 在线时走 /api/report 直接写进数据目录 reports/，
       不再无条件 ensureFolder()——旧版批量一结束就突然弹文件夹授权框（用户没预期），
       取消或失败则报告静默丢失（catch 只 return false，界面无任何提示）。
       /api/backup 不能复用：它会把内容重写成 {rows:[...]}，报告明细会被吃掉。 */
    const srv = await serverReady();
    if (srv && srv.ok) {
      const hr = await httpJson('POST', '/api/report', { name: name, payload: report }, 15000);
      if (hr.ok) return true;
    }
    try {
      await ensureFolder();
      await writeJsonToFolder(name, report);
      return true;
    } catch (e) {
      toast('抓取报告写入失败：' + ((e && e.message) || e), 'warn');
      return false;
    }
  }
  function navStampKey() { return 'fl_lastnav'; }
  /* v1.3.66 #15/#19：搜索命中后的自动跳转统一走这里。
     ① #19 校验协议：结果链接来自页面 DOM（不可信），若是 javascript: 等非
        http(s) 协议，直接 location.href = url 会执行该协议。
     ② #15 补写 navStamp：旧版直接 location.href 绕过 nextInQueue 的 queueDelay
        限速门——批量连续搜索跳转不受限速，易触发站点风控。 */
  function jumpToUrl(url) {
    const u = String(url || '');
    if (!/^https?:/i.test(u)) { toast('搜索结果链接不是 http(s) 协议，已停止自动跳转', 'err'); return; }
    try { GM_setValue(navStampKey(), String(Date.now())); } catch (e) {}
    location.href = u;
  }

  let navTimer = null;
  let _inboxBatch = null;   // 批量抓取时累积收件箱条目，finishQueue 一次性落盘
  function nextInQueue() {
    if (navTimer) return true;            // 已有排期，避免重复 shift 跳过番号
    const q0 = getQueue();
    if (!q0.length) { finishQueue(); return false; }
    const go = () => {
      navTimer = null;
      const q = getQueue();
      if (!q.length) { finishQueue(); return; }
      const next = q.shift();
      setQueue(q);
      setCurrent(next);
      try { GM_setValue(navStampKey(), String(Date.now())); } catch (e) {}
      /* v1.3.69 #17：队列跳转必须过协议白名单。next.url 来自 buildSearchUrl(src, c)，
         而 src.searchUrl 是设置面板可编辑 / 可导入的——填 javascript: 或 data: 就会被
         直接执行。v1.3.66 #19 只给 jumpToUrl 加了校验，队列推进这条路径绕过它。 */
      if (next && next.url) jumpToUrl(next.url);
    };
    /* 限速：距上次跳转不足 queueDelay 就先等着 */
    const gap = Math.max(0, parseInt((getCfgSafe() || {}).queueDelay, 10) || 0);
    let last = 0;
    try { last = parseInt(GM_getValue(navStampKey(), "0"), 10) || 0; } catch (e) {}
    const wait = (gap && last) ? (gap - (Date.now() - last)) : 0;
    if (wait > 60) {
      toast('限速等待 ' + Math.round(wait / 1000) + ' 秒再跳下一条…', 'ok');
      navTimer = setTimeout(go, wait);
      return true;
    }
    go();
    return true;
  }

  /* 抓不到：重排队尾重试一次，第二次失败则记入失败清单 */
  function handleFailure(reason) {
    const cur = getCurrent();
    if (!cur) return;
    if ((cur.retry || 0) < 1) {
      cur.retry = (cur.retry || 0) + 1;
      const q = getQueue();
      q.push(cur);
      setQueue(q);
      setCurrent(null);
      batchMark(cur.code, "pending", cur.retry);
      toast('「' + (cur.code || '?') + '」' + reason + '，已重排队尾（再试一次）', 'err');
    } else {
      const f = getFailed();
      /* v1.3.66 #20：失败清单也按 padKey 归一比较——markDone 早已 padKey 化，
         这里漏修：DSOD-9 与 DSOD-009 会在失败清单记两条（与成功账本口径不一致，
         结果面板「失败」数虚高）。 */
      const fk = padKey(cur.code);
      if (cur.code && !f.some(x => padKey(x) === fk)) f.push(cur.code);
      setFailed(f);
      setCurrent(null);
      batchMark(cur.code, "failed", cur.retry);
      toast('「' + (cur.code || '?') + '」重试后仍抓不到，已记入失败清单', 'err');
    }
    setTimeout(nextInQueue, 1200);
  }

  /* 批量收件箱：队列期间把条目累积进内存，结束时一次性加锁单写（减少 N 次整文件读写 + 锁竞争） */
  function beginInboxBatch() { _inboxBatch = []; }
  /* v1.3.58 #7：批量进行中每页加载即重建内存批。旧版 beginInboxBatch 只在 batchStart
     调一次，而队列每步 location.href 整页跳转 → 新页 IIFE 重跑 → _inboxBatch 复位 null
     → 第 2..N 条全走单条写，「一把写完整个批量」的累积设计落空（beforeunload 的 GM
     备份对它们也从不生效）。判定：batchGet() 存在且有非 success 项 = 批次进行中。 */
  function resumeInboxBatchIfActive() {
    try {
      if (_inboxBatch !== null) return;
      const b = batchGet();
      if (!b || !b.items) return;
      const rest = Object.keys(b.items).filter(k => ((b.items[k] || {}).status || 'pending') !== 'success');
      if (rest.length) _inboxBatch = [];
    } catch (e) {}
  }
  /* v1.3.43：落盘前合并 GM 备份批——批量中途导航/关页时 beforeunload 会把内存批备份进 GM，
     下一轮 finishQueue（或无活动队列时的 recoverBatchBackup）把它一起写回收件箱，不再丢数据。 */
  /* v1.3.69 #15：入批 ≠ 落盘。旧版在「把条目推进内存批」时就 markDone(code)，
     而 flushInboxBatch 整批写失败（锁超时 / HTTP 挂 / GM 配额）时，结果面板与
     抓取报告仍把这批全部报成「成功」，实际数据只在 GM 备份里——用户据此认为抓完了。
     现在：入批只登记待确认，真写入成功才 markDone。 */
  let _pendingDoneCodes = [];
  function flushPendingDone(doneItems) {
    /* 记账是次要行为：绝不能因为它抛错而中断主流程（否则备份清不掉、toast 发不出） */
    try {
      const done = {};
      (doneItems || []).forEach(it => {
        if (it && it.code) { done[padKey(it.code)] = 1; markDone(it.code); }
      });
      _pendingDoneCodes = _pendingDoneCodes.filter(c => !done[padKey(c)]);
    } catch (e) {}
  }
  function flushInboxBatch() {
    let items = (_inboxBatch || []).slice();
    _inboxBatch = null;
    try {
      const bk = JSON.parse(GM_getValue(BATCH_BK_KEY, 'null'));
      if (bk && bk.items && bk.items.length) items = items.concat(bk.items);
    } catch (e) {}
    /* v1.3.48 BUG-01（P0）：GM 备份不再「先清后写」——旧版在此处同步清空备份，
       随后才异步写收件箱；HTTP 与文件夹两条路都失败时 items 已从内存和备份中
       同时消失 → 整批抓取数据丢失。现在清备份只发生在写入成功之后；失败路径
       （锁超时 / 写异常）把 items 写回备份，由 recoverBatchBackup 下次重试。 */
    /* 内存批与备份批理论上不重叠（分属不同页面实例），防御性去重：同 padKey 保留靠前的（内存批较新） */
    if (items.length > 1) {
      const seen = {};
      items = items.filter(it => {
        const k = (it && it.code) ? padKey(it.code) : null;
        if (!k) return true;
        if (seen[k]) return false;
        seen[k] = 1;
        return true;
      });
    }
    if (!items.length) return Promise.resolve(false);
    /* v1.3.59 #23：返回真实 Promise——旧版同步 return true 而把实际写盘丢进后台
       IIFE，finishQueue await 之后立刻弹「已写入收件箱」结果面板，此时写入可能
       还在锁等待中或即将失败（抢报成功，用户以为存好了）。 */
    return (async () => {
      /* v1.3.28：HTTP 优先，一把写完整个批量（服务端逐条 padKey 去重） */
      const srv = await serverReady();
      if (srv && srv.ok) {
        /* v1.3.65 #10：分片 POST。旧版一次发整个批——配合默认 99 张截图，单批可达
           数十条 × 99 张 base64（数百 MB），HTTP 20s 超时或服务端拒收 → 整批失败
           走 GM 备份（同样巨大，配额满则降级去图）。改为每片 5 条、单片超时 60s，
           单片失败只把未发出的部分写回备份，已成功的部分不重发。 */
        const CHUNK = 5;
        let sent = 0, failed = false, lastWhy = '';
        for (let i = 0; i < items.length; i += CHUNK) {
          const part = items.slice(i, i + CHUNK);
          const hr = await httpJson('POST', '/api/inbox', part, 60000);
          if (hr.ok) { sent += part.length; part.forEach(it => markRecentWrite(it.code)); flushPendingDone(part); continue; }
          failed = true; lastWhy = hr.why || '未知错误'; break;
        }
        if (!failed) {
          try { GM_setValue(BATCH_BK_KEY, 'null'); } catch (e) {}
          toast('批量写入收件箱完成（共 ' + sent + ' 条）', 'ok');
          return;
        }
        /* 有失败：已成功的部分落账，未发出的部分写回备份下次重试 */
        const rest = items.slice(sent);
        try { GM_setValue(BATCH_BK_KEY, JSON.stringify({ savedAt: Date.now(), items: rest })); } catch (e) {}
        toast('批量写入部分失败（' + lastWhy + '）：已写入 ' + sent + ' 条，剩余 ' + rest.length + ' 条已暂存，下次进站点自动重试', 'err');
        return;
      }
      if (!(await acquireInboxLock(6000))) {
        /* BUG-01：拿不到锁也先保住数据——写回 GM 备份，下次 recoverBatchBackup 重试 */
        try { GM_setValue(BATCH_BK_KEY, JSON.stringify({ savedAt: Date.now(), items: items })); } catch (e) {}
        toast('另一个标签页正在写收件箱，本条批量已暂存，稍后自动重试', 'err');
        return;
      }
      try {
        const payload = (await readJsonFromFolder(INBOX_FILE)) || {};
        payload.app = 'Film Library'; payload.type = 'inbox'; payload.source = 'fl-spider';
        payload.updatedAt = new Date().toISOString();
        payload.items = dedupeInbox((payload.items || []).concat(items));
        await writeJsonToFolder(INBOX_FILE, payload);
        flushPendingDone(items);   /* v1.3.69 #15：文件夹路径确认落盘后才记成功 */
        try { GM_setValue(BATCH_BK_KEY, 'null'); } catch (e) {}
        toast('批量写入收件箱完成（' + payload.items.length + ' 条）', 'ok');
      } catch (e) {
        /* BUG-01：写失败 → 写回备份保命（旧版只 toast，数据已无处可寻） */
        try { GM_setValue(BATCH_BK_KEY, JSON.stringify({ savedAt: Date.now(), items: items })); } catch (e) {}
        toast('批量写入失败，已暂存（' + ((e && e.message) || e) + '），下次进站点自动重试', 'err');
      }
      finally { releaseInboxLock(); }
    })();
    return true;
  }
  /* 批量中断恢复（v1.3.43）：上次 beforeunload 备份的条目，在没有活动队列时直接落收件箱。
     写失败（服务端没起 / 文件夹没授权）则保留备份，下次进支持站点再试，不 toast 骚扰。 */
  function recoverBatchBackup() {
    let bk = null;
    try { bk = JSON.parse(GM_getValue(BATCH_BK_KEY, 'null')); } catch (e) {}
    if (!bk || !bk.items || !bk.items.length) return;
    if (getQueue().length || getCurrent()) return;   // 队列进行中：留给 finishQueue 合并，避免双写
    (async () => {
      const items = bk.items;
      const srv = await serverReady();
      if (srv && srv.ok) {
        /* v1.3.69 #18：恢复备份也要分片。旧版整批一次性 POST（20s 超时），
           v1.3.65 #10 给 flushInboxBatch 加的 CHUNK=5 分片没覆盖这条路径——
           批里带 base64 截图时必然超时 → 备份永不落地，且每进一个页面重发一次整批。 */
        const RCHUNK = 5;
        let rsent = 0, rfail = false, rwhy = '';
        for (let i = 0; i < items.length; i += RCHUNK) {
          const part = items.slice(i, i + RCHUNK);
          const hr = await httpJson('POST', '/api/inbox', part, 60000);
          if (hr.ok) { rsent += part.length; flushPendingDone(part); continue; }
          rfail = true; rwhy = hr.why || '未知错误'; break;
        }
        if (!rfail) {
          try { GM_setValue(BATCH_BK_KEY, 'null'); } catch (e) {}
          toast('已恢复保存上次未来得及写入的 ' + rsent + ' 条抓取', 'ok');
          return;
        }
        /* 部分成功：只把未发出的写回备份，已成功的不重发 */
        const rrest = items.slice(rsent);
        try { GM_setValue(BATCH_BK_KEY, JSON.stringify({ savedAt: Date.now(), items: rrest })); } catch (e) {}
        toast('恢复备份部分失败（' + rwhy + '）：已写入 ' + rsent + ' 条，剩余 ' + rrest.length + ' 条继续暂存', 'err');
        return;
      }
      /* v1.3.51 A-01（P2）：HTTP 不在线时，只有「已授权文件夹」才走文件夹回退。
         旧版无条件 readJsonFromFolder → ensureFolder：用户只是打开一个影片页面就弹系统
         目录选择框，取消则每次进站都弹（有 GM 备份 + 服务没起 + 没选过文件夹时必现）。 */
      if (!(await hasAuthorizedFolder())) return;
      if (!(await acquireInboxLock(6000))) return;
      try {
        const payload = (await readJsonFromFolder(INBOX_FILE)) || {};
        payload.app = 'Film Library'; payload.type = 'inbox'; payload.source = 'fl-spider';
        payload.updatedAt = new Date().toISOString();
        payload.items = dedupeInbox((payload.items || []).concat(items));
        await writeJsonToFolder(INBOX_FILE, payload);
        try { GM_setValue(BATCH_BK_KEY, 'null'); } catch (e) {}
        toast('已恢复保存上次未来得及写入的 ' + items.length + ' 条抓取', 'ok');
      } catch (e) { /* 保留备份，下次再试 */ }
      finally { releaseInboxLock(); }
    })();
  }
  /* 队列跑完：弹窗汇总成功 / 失败，并把失败番号写成文件 */
  async function finishQueue() {
    await flushInboxBatch();
    setCurrent(null);
    const f = getFailed();
    const d = getDone();
    (d || []).forEach(c => batchMark(c, "success"));
    showQueueResult(d, f);
    /* v1.3.58 #12：done 账本清零——旧版 getDone 跨次累积（单部保存与批量混用时，
       结果面板把历史所有番号冒充「本次成功」）。清零放在面板取数之后。 */
    setDone([]);
    /* #29：无论成败都产出一份汇总报告（成功/失败/跳过 + 每番号明细） */
    const repOk = await batchWriteReport().catch(() => false);
    if (repOk) toast("已写出「Film Library 抓取报告_" + stamp() + ".json」", "ok");
    if (!f.length) { setFailed([]); return; }
    try {
      await ensureFolder();
      await writeJsonToFolder('Film Library 抓取失败番号_' + stamp() + '.json', {
        app: 'Film Library', type: 'failed-codes',
        exportedAt: new Date().toISOString(), codes: f
      });
    } catch (e) {}
    setFailed([]);
  }

  /* 抓取结果告知面板 */
  function showQueueResult(done, failed) {
    const overlay = document.createElement('div');
    overlay.id = 'fl-modal-result';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:' + Z + ';' +
      'display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML =
      '<div style="background:#fff;color:#222;width:520px;max-width:94vw;max-height:86vh;overflow:auto;' +
      'border-radius:12px;padding:18px;font-size:13px;">' +
        '<h3 style="margin:0 0 10px;font-size:16px;">批量抓取结果</h3>' +
        '<div style="display:flex;gap:14px;margin-bottom:10px;">' +
          '<div style="flex:1;background:#ecfdf5;border-radius:8px;padding:10px;">' +
            '<div style="font-size:12px;color:#047857;">成功</div>' +
            '<div style="font-size:22px;font-weight:700;color:#047857;">' + done.length + '</div></div>' +
          '<div style="flex:1;background:#fef2f2;border-radius:8px;padding:10px;">' +
            '<div style="font-size:12px;color:#b91c1c;">失败</div>' +
            '<div style="font-size:22px;font-weight:700;color:#b91c1c;">' + failed.length + '</div></div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;margin:0 0 10px;">' +
          '<button id="fl-res-all"  style="flex:1;padding:6px 0;border:none;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer;font-size:12px;">全部</button>' +
          '<button id="fl-res-ok"   style="flex:1;padding:6px 0;border:none;border-radius:8px;background:#e2e8f0;color:#334155;cursor:pointer;font-size:12px;">仅成功</button>' +
          '<button id="fl-res-fail" style="flex:1;padding:6px 0;border:none;border-radius:8px;background:#e2e8f0;color:#334155;cursor:pointer;font-size:12px;">仅失败</button>' +
        '</div>' +
        '<div id="fl-res-done-wrap" style="margin:6px 0 2px;">' +
          /* #50（v1.3.31）：成功番号默认折叠——批量一跑就是几十上百条，全展开会把面板撑爆。
             超过 10 条才折叠（少量没有折叠的必要）；点标题栏展开/收起。 */
          '<div id="fl-res-done-toggle" title="点击展开/收起" style="font-size:12px;color:#666;cursor:pointer;user-select:none;">' +
            '<span id="fl-res-done-arrow">' + (done.length > 10 ? '▸' : '▾') + '</span> 成功番号（' + done.length + '）—— 已写入收件箱，回 Film Library 点「读取收件箱」合并' +
            (done.length > 10 ? '<span style="color:#2563eb;">（点击展开）</span>' : '') +
          '</div>' +
          /* v1.3.66 #16：番号原文未转义拼 innerHTML——来源含服务端 pending 队列与页面
             解析异常串，< 未转义即注入面（与 #19 诊断面板同类，这里漏改）。 */
          '<div id="fl-res-done" style="font-family:Consolas,monospace;font-size:12px;color:#047857;word-break:break-all;line-height:1.7;' + (done.length > 10 ? 'display:none;' : '') + '">' + done.map(esc).join('、') + '</div>' +
        '</div>' +
        '<div id="fl-res-fail-wrap" style="font-size:12px;color:#666;margin:10px 0 2px;">失败番号（已重试一次仍抓不到，可手动补或重新导出）</div>' +
        '<div id="fl-res-fail-list" style="font-family:Consolas,monospace;font-size:12px;color:#b91c1c;word-break:break-all;line-height:1.7;">' + failed.map(esc).join('、') + '</div>' +
        '<div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;">' +
          '<button id="fl-res-copy" style="padding:8px 12px;border:none;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer;font-size:12px;">复制失败番号</button>' +
          '<button id="fl-res-close" style="padding:8px 12px;border:none;border-radius:8px;background:#eee;color:#333;cursor:pointer;font-size:12px;">关闭</button>' +
        '</div></div>';
    document.body.appendChild(overlay);
    scaleButtonsIn(overlay);
    const resPanel = overlay.firstElementChild;
    const resTip = document.createElement('div');
    resTip.style.cssText = 'margin-top:8px;font-size:11px;color:#94a3b8;text-align:right;';
    resTip.textContent = '点击面板以外的区域关闭';
    if (resPanel) resPanel.appendChild(resTip);
    const dwrap = overlay.querySelector('#fl-res-done-wrap');
    const fwrap = overlay.querySelector('#fl-res-fail-wrap');
    const flist = overlay.querySelector('#fl-res-fail-list');
    /* #50：成功列表展开/收起（默认 >10 条折叠；筛选「仅成功」自动展开、「仅失败」自动收起） */
    const dlist = overlay.querySelector('#fl-res-done');
    const darrow = overlay.querySelector('#fl-res-done-arrow');
    function setDoneOpen(open) {
      if (dlist) dlist.style.display = open ? '' : 'none';
      if (darrow) darrow.textContent = open ? '▾' : '▸';
    }
    const dtoggle = overlay.querySelector('#fl-res-done-toggle');
    if (dtoggle) dtoggle.addEventListener('click', function () {
      setDoneOpen(!!(dlist && dlist.style.display === 'none'));
    });
    function applyFilter(mode) {
      const showAll = mode === 'all';
      if (dwrap) dwrap.style.display = (showAll || mode === 'ok') ? '' : 'none';
      if (fwrap) fwrap.style.display = (showAll || mode === 'fail') ? '' : 'none';
      if (flist) flist.style.display = (showAll || mode === 'fail') ? '' : 'none';
      /* 筛选联动：仅成功 → 展开成功列表；仅失败 → 收起；全部 → 恢复默认（>10 条折叠） */
      if (mode === 'ok') setDoneOpen(true);
      else if (mode === 'fail') setDoneOpen(false);
      else setDoneOpen(done.length <= 10);
      const a = overlay.querySelector('#fl-res-all'), o = overlay.querySelector('#fl-res-ok'), f = overlay.querySelector('#fl-res-fail');
      if (a) { a.style.background = showAll ? '#2563eb' : '#e2e8f0'; a.style.color = showAll ? '#fff' : '#334155'; }
      if (o) { o.style.background = mode === 'ok' ? '#2563eb' : '#e2e8f0'; o.style.color = mode === 'ok' ? '#fff' : '#334155'; }
      if (f) { f.style.background = mode === 'fail' ? '#2563eb' : '#e2e8f0'; f.style.color = mode === 'fail' ? '#fff' : '#334155'; }
    }
    overlay.querySelector('#fl-res-all').addEventListener('click', function () { applyFilter('all'); });
    overlay.querySelector('#fl-res-ok').addEventListener('click', function () { applyFilter('ok'); });
    overlay.querySelector('#fl-res-fail').addEventListener('click', function () { applyFilter('fail'); });
    overlay.addEventListener('click', function (ev) { if (ev.target === overlay) overlay.remove(); });
    overlay.querySelector('#fl-res-close').addEventListener('click', function () { overlay.remove(); });
    overlay.querySelector('#fl-res-copy').addEventListener('click', function () {
      copyText(failed.join('\n'), '已复制 ' + failed.length + ' 个失败番号');   /* v1.3.60 #29b */
    });
  }

  /* 页面是否"没有资料"（用于判定 404 / 无结果） */
  function pageLooksEmpty(key) {
    /* v1.3.48 BUG-05（P1）：有效页面优先 + 404 加错误上下文共现约束。
       旧版 title+body 前 1500 字裸测 /404|not found|.../：番号含 404 的影片
       （如 ABC-404）或相关推荐里的 404 字样直接误杀 → 批量整批记失败。
       新版顺序：① parseDetail 拿到番号/片名即判有资料；② 搜索页看结果数；
       ③ 最后才测错误特征词，且 404 必须与错误上下文 60 字内共现。 */
    const raw = parseDetail(key);
    if (raw && (raw.code || raw.title)) return false;
    if (isSearchPage()) return parseSearchResults().length === 0;
    const t = (document.title || '') + ' ' +
      ((document.body && document.body.innerText ? document.body.innerText.slice(0, 1500) : ''));
    if (/404[\s\S]{0,60}(?:not\s*found|見つかりません|找不到|不存在|无此影片|無此影片)/i.test(t)) return true;
    if (/(?:not\s*found|見つかりません|找不到|不存在|无此影片|無此影片|no results?)/i.test(t)) return true;
    return false;
  }

  function pushQueue(list) {
    /* v1.3.59 #26：入队前按 padKey 去重——旧版直接 concat，待补全文件里重复的
       番号（或与队列里已有的撞车）会排两遍，同一影片被抓两次、报告总数虚高。 */
    const q = getQueue();
    const seen = {};
    q.forEach(x => { if (x && x.code) seen[padKey(x.code)] = 1; });
    const add = [];
    (list || []).forEach(x => {
      if (!x || !x.code) return;
      const k = padKey(x.code);
      if (seen[k]) return;
      seen[k] = 1;
      add.push({ code: x.code, url: x.url, retry: x.retry || 0 });
    });
    const nq = q.concat(add);
    setQueue(nq);
    return nq.length;
  }

  /* 从文件夹读取「Film Library 待补全番号_*.json」→ 生成搜索 URL 队列 */
  async function consumePendingCodes(key) {
    const cfg = getCfg();
    const src = cfg.sources[key];
    if (!src) { toast('当前站点没有配置', 'err'); return; }
    /* v1.3.28：先读 FL Server 的待补全队列（Film Library「FANZA 待抓清单」导出到这里） */
    let codes = [];
    let fromServer = false;
    const srv = await serverReady();
    if (srv && srv.ok) {
      const hr = await httpJson('GET', '/api/pending');
      if (hr.ok && hr.json && Array.isArray(hr.json.codes) && hr.json.codes.length) {
        codes = hr.json.codes;
        fromServer = true;
      }
    }
    if (!codes.length) {
      /* 降级：文件夹里的「Film Library 待补全番号_*.json」 */
      await ensureFolder();
      const lf = await listFolderNames();
      if (lf.partial) toast('文件夹目录读取不完整，待补全清单可能遗漏文件', 'warn');
      const files = lf.names.filter(n => n.indexOf(PENDING_PREFIX) === 0 && /\.json$/i.test(n)).sort();
      if (!files.length) { toast('没有待补全番号：FL Server 队列为空，文件夹里也没有「' + PENDING_PREFIX + '*.json」', 'err'); return; }
      /* v1.3.55：readJsonFromFolder 现在只对「不存在」返 null，读取失败会抛——
         这里接住并明示，否则变成未处理的 rejection（比旧版的静默更糟） */
      let payload = null;
      try { payload = await readJsonFromFolder(files[files.length - 1]); }
      catch (e) { toast('读取待补全文件失败：' + ((e && e.message) || e), 'err'); return; }
      codes = (payload && payload.codes) || [];
      if (!codes.length) { toast('待补全文件里没有番号', 'err'); return; }
    }
    const list = codes.map(c => ({ code: normCode(c), url: buildSearchUrl(src, c), retry: 0 }));
    /* v1.3.58 #11：旧版无条件 setFailed([])/setDone([])/batchStart()——批量进行中再点
       「批量」，旧批次账本被静默清空（失败清单从此无迹可寻），新队列还追加在旧队列
       后面，报告只覆盖新批次。入口先检测未完成批次，用户确认才继续。 */
    {
      const ob = batchGet();
      if (ob && ob.items) {
        const keys = Object.keys(ob.items);
        const rest = keys.filter(k => ((ob.items[k] || {}).status || 'pending') !== 'success');
        if (rest.length && !window.confirm('上一批还有 ' + rest.length + ' 个番号未完成（已完成 ' +
          (keys.length - rest.length) + ' 个）。重新开始会清空旧批次记录，失败清单将丢失。确定继续吗？')) return;
      }
    }
    setFailed([]);
    setDone([]);
    batchStart(list.map(x => x.code));
    const n = pushQueue(list);
    toast('已排入 ' + n + ' 个番号（来源：' + (fromServer ? 'FL Server' : '文件夹文件') + '），正在打开第一个…', 'ok');
    /* 服务端队列是一次性交接：读入后清空，避免下次点「批量」重复排同一批。
       v1.3.58 #18：await + 判果——旧版 fire-and-forget，600ms 后页面就跳转，
       POST 可能被导航打断且失败无提示 → 服务端队列没清 → 下次点「批量」重复排同一批。 */
    if (fromServer) {
      let cr = null;
      try { cr = await httpJson('POST', '/api/pending', { codes: [] }); }
      catch (e) { cr = null; }
      if (!cr || !cr.ok) toast('服务端待补全队列清空失败（不影响本次抓取；下次点「批量」可能重复排队）', 'warn');
    }
    setTimeout(() => nextInQueue(), 600);
  }

  /* ==========================================================================
   * v1.3.53 #fl-box 尺寸诊断
   *   用户报「MISSAV 与 FANZA 观感不一致」——本地看不到用户浏览器里的真实渲染，
   *   把下面这些一次导出：盒子/每个后代的实测矩形与计算样式、命中盒内元素的站点
   *   规则（含 @media 递归）、跨域不可读样式表计数。复制给 AI 即可精确对齐。
   * ======================================================================== */
  var DIAG_PROPS = ["width", "height", "min-width", "max-width", "padding", "margin",
    "border", "border-radius", "font-size", "line-height", "font-family", "letter-spacing",
    "display", "position", "zoom", "box-sizing", "flex", "gap", "align-items",
    "flex-direction", "justify-content", "white-space", "text-transform", "transform",
    "opacity", "visibility", "background", "color", "cursor", "z-index"];
  function diagCs(el, props) {
    try {
      const st = getComputedStyle(el), o = {};
      (props || DIAG_PROPS).forEach(x => { o[x] = st.getPropertyValue(x); });
      return o;
    } catch (e) { return { err: String(e && e.message || e) }; }
  }
  function diagRect(el) {
    try {
      const r = el.getBoundingClientRect();
      return Math.round(r.width) + "x" + Math.round(r.height) + " @(" + Math.round(r.left) + "," + Math.round(r.top) + ")";
    } catch (e) { return "?"; }
  }
  function boxDiagText() {
    const L = [];
    const p = (k, v) => L.push(k + ": " + v);
    p("SPIDER_VERSION", VERSION);
    p("URL", location.href);
    p("VIEWPORT", window.innerWidth + "x" + window.innerHeight + " dpr=" + (window.devicePixelRatio || 1));
    p("HTML_ZOOM", diagCs(document.documentElement, ["zoom"]).zoom);
    p("BODY_ZOOM", diagCs(document.body, ["zoom"]).zoom);
    p("BODY_INLINE_STYLE", (document.body && document.body.getAttribute("style")) || "(无)");
    const box = document.querySelector("#fl-box");
    if (!box) { p("FL_BOX", "未找到 #fl-box（本页未注入或已被移除）"); return L.join("\n"); }
    p("FL_BOX_RECT", diagRect(box));
    p("BOX_FIT_SCALE", box.__flScale || 1);
    p("FL_BOX_INLINE_STYLE", box.getAttribute("style") || "(无)");
    p("FL_BOX_COMPUTED", JSON.stringify(diagCs(box)));
    /* 逐个后代：标签 / 互跳行 / hr / 按钮（含文字，便于对应到具体站点） */
    Array.prototype.forEach.call(box.children, (el, i) => {
      const label = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") +
        " [" + ((el.textContent || "").trim().slice(0, 12) || "(无字)") + "]";
      p("CHILD" + i + " " + label, diagRect(el));
      p("CHILD" + i + "_CS", JSON.stringify(diagCs(el)));
    });
    /* 命中盒内元素的站点规则（顶层 + @media/@supports 递归；跨域样式表读不到规则，计数即可） */
    const els = Array.prototype.slice.call(box.querySelectorAll("*"));
    const hits = [];
    let readable = 0, blocked = 0;
    const walk = (rules, ctx) => {
      Array.prototype.forEach.call(rules, r => {
        if (r.cssRules && (r.media || r.supportsText || r.conditionText)) {
          walk(r.cssRules, ctx + (r.media ? "@media " + r.media.mediaText + " " : "@layer "));
          return;
        }
        if (!r.selectorText || !r.style) return;
        const txt = r.style.cssText || "";
        const low = txt.toLowerCase();
        if (!DIAG_PROPS.some(x => low.indexOf(x) !== -1)) return;
        const targets = [];
        els.forEach(el => {
          try { if (el.matches(r.selectorText)) targets.push(el.tagName.toLowerCase() + (el.id ? "#" + el.id : "")); } catch (e) {}
        });
        if (targets.length) hits.push(ctx + r.selectorText + " { " + txt + " }  <<< 命中: " + targets.join(", "));
      });
    };
    Array.prototype.forEach.call(document.styleSheets, sh => {
      let rules;
      try { rules = sh.cssRules; readable++; } catch (e) { blocked++; return; }
      if (rules) walk(rules, "");
    });
    p("STYLESHEETS", readable + " 可读 / " + blocked + " 跨域不可读");
    p("SITE_RULES_HITTING_BOX", hits.length ? ("\n" + hits.slice(0, 60).join("\n")) : "(无站点规则命中盒内元素)");
    return L.join("\n");
  }
  /* ==========================================================================
   * DOM 样本导出：把页面关键结构导出给我（AI）用于填准选择器
   * ======================================================================== */
  function openDomSample(key) {
    const cfg = getCfg();
    const src = cfg.sources[key] || { sel: {} };
    /* v1.3.32：dump 全部匹配元素——旧版用 $() 只取第一个，样图区有多张 img 时
       只显示第一张（2026-10-16 排查「只抓到 1 张截图」被这个局限误导过一轮：
       页面其实有 11 张，导出只给了第 1 张的 outerHTML）。每个元素截 1500 字符、
       最多 5 个，前面加 [i/N] 序号。 */
    const grab = (sel) => {
      try {
        const one = String(sel).split(',')[0].trim();
        const els = $$(one);
        if (!els || !els.length) return '(未命中: ' + sel + ')';
        return els.slice(0, 5).map(function (el, i) {
          return (els.length > 1 ? ('[' + (i + 1) + '/' + els.length + '] ') : '') + el.outerHTML.slice(0, 1500);
        }).join('\n');
      } catch (e) { return '(选择器无效: ' + sel + ')'; }
    };
    const sample = [
      '=== URL ===', location.href,
      '=== TITLE ===', document.title,
      '=== INFO 区 ===', grab(src.sel && src.sel.info || '.panel'),
      '=== 片名区 ===', grab(src.sel && src.sel.title || 'h1'),
      '=== 封面区 ===', grab(src.sel && src.sel.cover || 'img'),
      '=== 截圖区 ===', grab(src.sel && src.sel.shots || '.preview-images'),
      '=== 演员/标签链接样本 ===',
      ($$('a').slice(0, 60).map(a => a.getAttribute('href') + ' | ' + (a.textContent || '').trim()).join('\n').slice(0, 3000))
    ].join('\n');

    /* v1.3.53：附一节 #fl-box 尺寸诊断（观感偏差取数用，详见 boxDiagText 注释） */
    const sample2 = sample + '\n\n=== FL-BOX DIAGNOSTIC (v' + VERSION + ') ===\n' + boxDiagText();

    const overlay = document.createElement('div');
    overlay.id = 'fl-modal-dom';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:' + Z + ';' +
      'display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML =
      '<div style="background:#fff;color:#222;width:640px;max-width:95vw;max-height:88vh;overflow:auto;' +
      'border-radius:12px;padding:16px;font-size:13px;">' +
        '<h3 style="margin:0 0 6px;font-size:15px;">DOM 样本 + #fl-box 尺寸诊断（整段复制给 AI）</h3>' +
        '<textarea id="fl-dom" style="width:100%;height:48vh;box-sizing:border-box;font-size:11px;' +
        'font-family:Consolas,monospace;white-space:pre;">' + sample2.replace(/</g, '&lt;') + '</textarea>' +
        '<div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end;">' +
          '<button id="fl-dom-copy" style="padding:8px 12px;border:none;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer;">复制</button>' +
          '<button id="fl-dom-close" style="padding:8px 12px;border:none;border-radius:8px;cursor:pointer;">关闭</button>' +
        '</div></div>';
    document.body.appendChild(overlay);
    scaleButtonsIn(overlay);
    const ta = overlay.querySelector('#fl-dom');
    overlay.querySelector('#fl-dom-close').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#fl-dom-copy').addEventListener('click', () => {
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      if (!ok) { try { GM_setClipboard(ta.value, 'text'); ok = true; } catch (e) {} }
      toast(ok ? '已复制到剪贴板' : '复制失败，请手动 Ctrl+C', ok ? 'ok' : 'err');
    });
  }

  /* ==========================================================================
   * 设置面板
   * ======================================================================== */
  /* 设置面板：番号正则单行 HTML（增/删行复用；bindSettingsEvents 共用） */
  function settingsReRowHtml(i, v) {
    return (
      '<div style="display:flex;gap:6px;align-items:center;margin-bottom:4px;">' +
        '<span style="flex:none;width:64px;font-size:11px;color:#475569;">' + (RE_NAMES[i] || ('自定义 ' + (i + 1))) + '</span>' +
        '<input class="fl-c-re" data-i="' + i + '" value="' + String(v == null ? '' : v).replace(/"/g, '&quot;') + '"' +
        ' placeholder="留空 = 跳过这条" style="flex:1;min-width:0;box-sizing:border-box;padding:5px;font-size:12px;font-family:Consolas,monospace;">' +
        '<button type="button" class="fl-c-re-del" data-i="' + i + '" title="删除这一条"' +
        ' style="flex:none;padding:3px 7px;border:none;border-radius:6px;background:#fee2e2;color:#b91c1c;cursor:pointer;font-size:11px;">×</button>' +
      '</div>');
  }
  /* 设置面板整体 HTML：基本 / 图片 / 队列 / 正则 / 字段矩阵 / 界面 / 选择器 / 底部按钮
     （v55 由 openSettings 内联 115 行拼接串提取，顺序与原版完全一致） */
  function settingsPanelHtml(key, cfg) {
    const src = cfg.sources[key] || { sel: {} };
    const f = (id, label, val) =>
      '<label style="display:block;margin:8px 0 2px;font-size:12px;color:#555;">' + label + '</label>' +
      '<input id="' + id + '" value="' + String(val == null ? '' : val).replace(/"/g, '&quot;') +
      '" style="width:100%;box-sizing:border-box;padding:5px;font-size:12px;font-family:Consolas,monospace;">';
    const reList0 = (Array.isArray(cfg.codeRes) ? cfg.codeRes.slice() : DEF_RE_LIST.slice());
    while (reList0.length < RE_SLOTS) reList0.push('');
    const reHtml = '<div id="fl-c-re-wrap">' + reList0.map((p, i) => settingsReRowHtml(i, p)).join('') + '</div>';
    return (
      '<div style="background:#fff;color:#222;width:520px;max-width:95vw;max-height:88vh;overflow:auto;' +
      'border-radius:12px;padding:16px;font-size:13px;">' +
        '<h3 style="margin:0 0 6px;font-size:15px;">FL Spider 设置（站点：' + (key || '-') + '）' +
          '<span style="margin-left:8px;font-size:11px;color:#888;font-weight:400;">v' + VERSION + '</span></h3>' +
        '<div style="font-size:12px;color:#888;margin:2px 0 4px;">基本</div>' +
        '<label style="display:flex;gap:6px;align-items:center;font-size:13px;">' +
          '<input type="checkbox" id="fl-c-tr"' + (cfg.translate ? ' checked' : '') + '> 用 Google 翻译原名生成中文名</label>' +
        '<div style="display:flex;gap:8px;">' +
          '<div style="flex:1;">' + f('fl-c-sl', '源语言 sl（auto/ja/en）', cfg.sl) + '</div>' +
          '<div style="flex:1;">' + f('fl-c-tl', '目标语言 tl', cfg.tl) + '</div>' +
        '</div>' +
        f('fl-c-shots', '截图最多几张（0 = 不抓，1-99）', cfg.maxShots) +   /* v1.3.63 */
        '<div style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;color:#555;">' +
          '<span>演员性别记忆：<b id="fl-g-count">' + genderMapSize() + '</b> 条（保存时自动记住你的归类）</span>' +
          '<button id="fl-s-gclear" style="padding:3px 8px;border:none;border-radius:6px;background:#fee2e2;color:#b91c1c;cursor:pointer;font-size:11.5px;">清空</button>' +
        '</div>' +
        f('fl-c-cnurl', '中文源 URL 模板（含 {code}，如 https://www.javbus.com/{code}）', cfg.cnSourceUrl) +
        '<div style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;color:#555;">' +
          '<span>中文名记忆：<b id="fl-cn-count">' + cnMapSize() + '</b> 条（按番号记住你确认过的中文名）</span>' +
          '<button id="fl-s-cnclear" style="padding:3px 8px;border:none;border-radius:6px;background:#fee2e2;color:#b91c1c;cursor:pointer;font-size:11.5px;">清空</button>' +
        '</div>' +
        '<div style="font-size:11px;color:#999;line-height:1.6;margin-top:4px;">' +
          '中文名优先级：站点自带 → 本地记忆 → 中文源 → Google 翻译。中文源需该域名允许跨域（脚本已声明 @connect *）。</div>' +
        '<div style="font-size:12px;color:#888;margin:10px 0 2px;">图片</div>' +
        '<div style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;color:#555;">' +
          '<span style="flex:none;width:86px;">图片质量</span>' +
          '<select id="fl-c-q" style="flex:1;padding:4px;font-size:12px;">' +
          '<option value="origin"' + (String(cfg.imgQuality || 'origin') === 'origin' ? ' selected' : '') + '>原图（去尺寸参数/缩略图标记，体积大）</option>' +
          '<option value="thumb"' + (String(cfg.imgQuality || 'origin') === 'thumb' ? ' selected' : '') + '>页面原样（多为缩略图，体积小）</option>' +
          '</select></div>' +
        '<div style="display:flex;gap:8px;">' +
          '<div style="flex:1;">' + f('fl-c-retry', '取图失败重试次数（0-4）', cfg.imgRetry) + '</div>' +
          '<div style="flex:1;">' + f('fl-c-conc', '取图并发数（1-4）', cfg.imgConc) + '</div>' +
          '<div style="flex:1;">' + f('fl-c-delay2', '取图最小间隔（毫秒）', cfg.imgDelay) + '</div>' +
        '</div>' +
        '<div style="font-size:12px;color:#888;margin:10px 0 2px;">批量队列</div>' +
        f('fl-c-delay', '队列间隔（毫秒，半自动默认 3000）', cfg.queueDelay) +
        '<label style="display:flex;gap:6px;align-items:center;font-size:13px;margin-top:6px;">' +
          '<input type="checkbox" id="fl-c-auto"' + (cfg.autoQueue ? ' checked' : '') + '> 队列中自动抓取并跳下一个</label>' +
        '<hr style="margin:12px 0;">' +
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;flex-wrap:wrap;">' +
          '<span style="font-size:12px;color:#888;">番号正则（全局定义，各站按自己的启用清单取用；至少 ' + RE_SLOTS + ' 条，留空 = 跳过该条）</span>' +
          '<button id="fl-c-re-add" style="padding:3px 8px;border:none;border-radius:6px;background:#eef2f7;color:#334155;cursor:pointer;font-size:11.5px;">+ 增加一条</button>' +
          '<button id="fl-c-re-def" style="padding:3px 8px;border:none;border-radius:6px;background:#eef2f7;color:#334155;cursor:pointer;font-size:11.5px;">恢复默认</button>' +
        '</div>' +
        reHtml +
        '<div style="font-size:11px;color:#999;line-height:1.6;margin-top:4px;">' +
          '共 ' + RE_SLOTS + ' 条槽位：General / FANZA / MGS / FC2 为预置，X / Y / Z 留空待用。<br>' +
          '每站启用（2026-10-16 规则）：FANZA（dmm / dmmvideo）= General + FANZA；MGS = MGS；MISSAV / JAVDB = General + FC2；MOTV 等未配置站 = 全部槽位。<br>' +
          'General 认「字母-数字」与「字母00数字」两种形态（3~6 位），支持 <code>-U</code>（无码）/ <code>-C</code>（中文字幕）/ <code>-E</code> / <code>-数字</code> 后缀；<br>' +
          'FANZA 在 General 基础上额外认「数字前缀 + 厂牌」形态（如 300MIUM451 / 300MIUM-451）；MGS 认「数字前缀 + 厂牌 + 连字符 + 数字」；<br>' +
          'FC2 认 FC2-PPV-1234567（分隔符允许「-」或空格）。<br>' +
          '命中后统一做「00 → -」换算（DSOD00009 → DSOD-009）；符合 FANZA / MGS 的自动转换成 General 形态（300MIUM-451 → MIUM-451）；多条都命中时取最长的那条，所以后缀不会被截掉。</div>' +
        '<div style="margin-top:8px;padding:8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">' +
          '<div style="font-size:12px;color:#475569;margin-bottom:4px;">正则实时测试（按当前面板里的正则即时匹配，不影响已保存设置）</div>' +
          '<input id="fl-c-re-test" placeholder="粘贴含番号的样本，如 DSOD00009 / ABP-123 / 番号:SSNI-456" ' +
            'style="width:100%;box-sizing:border-box;padding:5px;font-size:12px;font-family:Consolas,monospace;">' +
          '<div id="fl-c-re-test-res" style="font-size:12px;margin-top:4px;font-family:Consolas,monospace;min-height:16px;"></div>' +
        '</div>' +
        '<hr style="margin:12px 0;">' +
        '<div style="font-size:12px;color:#888;margin-bottom:4px;">各站抓取字段（可修改：勾选=该站实际抓哪些字段，番号恒抓）</div>' +
        (function(){
          var tiers = [[1,'一级来源站（FANZA / MGS）'],[2,'二级来源站（JAVDB / MISSAV / MOTV）']];
          var h = '<div style="border:1px solid #e2e8f0;border-radius:8px;overflow:auto;">';
          tiers.forEach(function(t){
            var keys = Object.keys(cfg.sources).filter(function(k){ return (cfg.sources[k].tier||2) === t[0]; });
            if (!keys.length) return;
            h += '<div style="padding:4px 8px;font-size:11px;color:#0f766e;background:#f0fdfa;font-weight:600;">' + t[1] + '</div>';
            h += '<div style="display:flex;gap:4px;padding:4px 8px;font-size:11px;border-top:1px solid #f1f5f9;align-items:center;">' +
                 '<span style="flex:none;width:96px;color:#475569;">字段 / 站点</span>' +
                 keys.map(function(k){ return '<span style="flex:1;text-align:center;color:#475569;font-weight:600;">' + (cfg.sources[k].label||k) + '</span>'; }).join('') +
                 '</div>';
            FIELD_DEFS.forEach(function(fd){
              h += '<div style="display:flex;gap:4px;padding:3px 8px;font-size:11px;border-top:1px solid #f1f5f9;align-items:center;">' +
                   '<span style="flex:none;width:96px;color:#334155;">' + fd[1] + '</span>' +
                   keys.map(function(k){ var on = (cfg.sources[k].fields && cfg.sources[k].fields[fd[0]]); return '<span style="flex:1;text-align:center;"><input type="checkbox" id="fl-fld-' + k + '-' + fd[0] + '"' + (on ? ' checked' : '') + '></span>'; }).join('') +
                   '</div>';
            });
          });
          h += '</div>';
          return h;
        })() +
        '<div style="font-size:11px;color:#999;line-height:1.6;margin-top:4px;">番号恒抓；命中 <code>RegExp-FC2</code> 时所有资料来源站都抓全部字段（不受上表限制）。</div>' +
        '<div style="font-size:12px;color:#888;margin-bottom:4px;">界面（改完刷新页面生效）</div>' +
        f('fl-c-uiscale', '按钮缩放 uiScale（0.2-1.5；0.5 = 一半大小）', cfg.uiScale) +   /* v1.3.60 #30：文案与代码校验（>0.2）对齐 */
        '<label style="display:flex;gap:6px;align-items:center;font-size:13px;">' +
          '<input type="checkbox" id="fl-c-jump"' + (cfg.jumpBtns ? ' checked' : '') + '> 显示番号互跳 / 复制番号按钮组</label>' +
        '<label style="display:flex;gap:6px;align-items:center;font-size:13px;">' +
          '<input type="checkbox" id="fl-c-loose"' + (cfg.looseCode ? ' checked' : '') + '> 番号宽松匹配（不带连字符也认，可能误匹配）</label>' +
        '<label style="display:flex;gap:6px;align-items:center;font-size:13px;">' +
          '<input type="checkbox" id="fl-c-ad"' + (cfg.adBlock ? ' checked' : '') + '> 自动清理广告 iframe / MissAV 右下角弹窗</label>' +
        '<label style="display:flex;gap:6px;align-items:center;font-size:13px;">' +
          '<input type="checkbox" id="fl-c-kill"' + (cfg.killCover ? ' checked' : '') + '> 点击穿透（按钮被全屏浮层盖住时自动掀开）</label>' +
          '<input type="checkbox" id="fl-c-adv"' + (cfg.advMode ? ' checked' : '') + '> 高级/调试模式（弹出「站点结构变更」告警、记录解析诊断）</label>' +
        '<hr style="margin:12px 0;">' +
        '<div style="font-size:12px;color:#888;margin-bottom:4px;">选择器（CSS，逗号分隔表示依次尝试）</div>' +
        f('fl-s-title', '片名', src.sel && src.sel.title) +
        f('fl-s-cover', '封面', src.sel && src.sel.cover) +
        f('fl-s-actor', '演员', src.sel && src.sel.actor) +
        f('fl-s-shots', '截图', src.sel && src.sel.shots) +
        f('fl-s-info', '信息区（番号/日期从这里读）', src.sel && src.sel.info) +
        f('fl-s-search', '搜索页 URL 模板', src.searchUrl) +
        f('fl-s-result', '搜索页结果项（CSS）', src.sel && src.sel.result) +
        '<div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;align-items:center;flex-wrap:wrap;">' +
          '<button data-fl-act="pdiag" data-fl-key="' + key + '" style="margin-right:8px;padding:8px 10px;border:none;border-radius:8px;background:#0891b2;color:#fff;cursor:pointer;font-size:12px;">解析诊断</button>' +
          '<button data-fl-act="diag" style="margin-right:8px;padding:8px 10px;border:none;border-radius:8px;background:#f1f5f9;color:#334155;cursor:pointer;font-size:12px;">环境自检</button>' +
          '<button id="fl-s-diagx" style="margin-right:8px;padding:8px 10px;border:none;border-radius:8px;background:#f1f5f9;color:#334155;cursor:pointer;font-size:12px;" title="把版本/环境/服务端连通性/配置摘要打包成 JSON 下载，排障时直接发这个文件">导出诊断</button>' +
          '<button id="fl-s-export" style="margin-right:8px;padding:8px 10px;border:none;border-radius:8px;background:#0ea5e9;color:#fff;cursor:pointer;font-size:12px;">导出设置</button>' +
          '<button id="fl-s-import" style="margin-right:8px;padding:8px 10px;border:none;border-radius:8px;background:#8b5cf6;color:#fff;cursor:pointer;font-size:12px;">导入设置</button>' +
          '<button data-fl-act="refolder" style="margin-right:8px;padding:8px 10px;border:none;border-radius:8px;background:#f59e0b;color:#fff;cursor:pointer;font-size:12px;">重选文件夹</button>' +
          '<button id="fl-s-default" style="padding:8px 10px;border:none;border-radius:8px;background:#eee;color:#333;cursor:pointer;font-size:12px;">恢复默认</button>' +
          '<button id="fl-s-cancel" style="padding:8px 12px;border:none;border-radius:8px;cursor:pointer;">取消</button>' +
          '<button id="fl-s-save" style="padding:8px 12px;border:none;border-radius:8px;background:#1f9d55;color:#fff;cursor:pointer;">保存</button>' +
        '</div></div>');
  }
  /* 设置面板事件：记忆清空 / 正则增删与恢复默认 / 正则实时测试 */
  function bindSettingsEvents(overlay) {
    const reWrap = overlay.querySelector('#fl-c-re-wrap');
    const gclr = overlay.querySelector('#fl-s-gclear');
    const cnclr = overlay.querySelector('#fl-s-cnclear');
    if (cnclr) cnclr.addEventListener("click", () => {
      clearCnMap();
      const ccn = overlay.querySelector('#fl-cn-count'); if (ccn) ccn.textContent = '0';
      toast('已清空中文名记忆', 'ok');
    });
    if (gclr) gclr.addEventListener("click", () => {
      clearGenderMap();
      const gcn = overlay.querySelector('#fl-g-count'); if (gcn) gcn.textContent = '0';
      toast('已清空演员性别记忆', 'ok');
    });
    function renumberRe() {
      Array.from(reWrap.children).forEach((d, i) => {
        const s = d.querySelector('span'); if (s) s.textContent = RE_NAMES[i] || ('自定义 ' + (i + 1));
        const inp = d.querySelector('input.fl-c-re'); if (inp) inp.setAttribute('data-i', String(i));
        const del = d.querySelector('.fl-c-re-del'); if (del) del.setAttribute('data-i', String(i));
      });
    }
    overlay.querySelector('#fl-c-re-add').addEventListener('click', () => {
      const d = document.createElement('div');
      d.innerHTML = settingsReRowHtml(reWrap.children.length, '');
      const node = d.firstElementChild;
      reWrap.appendChild(node);
      renumberRe();
    });
    overlay.querySelector('#fl-c-re-def').addEventListener('click', () => {
      const ins = reWrap.querySelectorAll('input.fl-c-re');
      ins.forEach((inp, i) => { inp.value = (i < DEF_RE_LIST.length ? DEF_RE_LIST[i] : ''); });
      toast('已填入默认番号正则（第 ① 条），点「保存」生效', 'ok');
    });
    reWrap.addEventListener('click', (e) => {
      const b = e.target.closest ? e.target.closest('.fl-c-re-del') : null;
      if (!b) return;
      if (reWrap.children.length <= 1) { toast('至少保留 1 条', 'err'); return; }
      b.parentNode.remove();
      renumberRe();
    });
    /* 番号正则实时测试：按面板当前输入即时匹配，不改已保存设置 */
    const testInp = overlay.querySelector('#fl-c-re-test');
    const testRes = overlay.querySelector('#fl-c-re-test-res');
    function liveMatch(text) {
      const vals = Array.from(reWrap.querySelectorAll('input.fl-c-re'))
                        .map(i => String(i.value || '').trim()).filter(Boolean);
      for (const p of vals) {
        try { const re = new RegExp(p); const m = text.match(re); if (m && m[0]) return convert00(m[0]); } catch (e) {}
      }
      const re = (overlay.querySelector('#fl-c-loose') && overlay.querySelector('#fl-c-loose').checked) ? RE_LOOSE : RE_STRICT;
      const m = text.match(re);
      return (m && m[0]) ? convert00(m[0]) : '';
    }
    function runTest() {
      const t = testInp.value.trim();
      if (!t) { testRes.textContent = ''; return; }
      const r = liveMatch(t);
      testRes.textContent = r ? ('→ 命中：' + r) : '未命中（回落内置正则或留空）';
      testRes.style.color = r ? '#16a34a' : '#b91c1c';
    }
    testInp.addEventListener('input', runTest);
    reWrap.addEventListener('input', runTest);   // 编辑任意一条正则时同步重新测试
    if (overlay.querySelector('#fl-c-loose')) overlay.querySelector('#fl-c-loose').addEventListener('change', runTest);
  }
  /* 设置面板动作：取消 / 恢复默认 / 保存（含番号正则校验与字段矩阵写回） */
  function bindSettingsActions(overlay, key) {
    overlay.querySelector('#fl-s-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#fl-s-default').addEventListener('click', () => {
      if (!setCfg(JSON.parse(JSON.stringify(DEFAULT_CFG)))) toast('恢复默认失败：浏览器存储写入异常', 'err');
      overlay.remove();
      toast('已恢复默认设置', 'ok');
    });
    overlay.querySelector('#fl-s-save').addEventListener('click', () => {
      const c = getCfg();
      c.translate = overlay.querySelector('#fl-c-tr').checked;
      c.cnSourceUrl = (overlay.querySelector("#fl-c-cnurl").value || "").trim();
      c.imgQuality = (overlay.querySelector("#fl-c-q") || {}).value === "thumb" ? "thumb" : "origin";
      c.imgRetry = Math.max(0, Math.min(4, parseInt(overlay.querySelector("#fl-c-retry").value, 10) || 0));
      c.imgConc = Math.max(1, Math.min(4, parseInt(overlay.querySelector("#fl-c-conc").value, 10) || 1));
      c.imgDelay = Math.max(0, parseInt(overlay.querySelector("#fl-c-delay2").value, 10) || 0);
      c.sl = overlay.querySelector('#fl-c-sl').value.trim() || 'auto';
      c.tl = overlay.querySelector('#fl-c-tl').value.trim() || 'zh-CN';
      /* v1.3.63：0 = 不抓，1-99 = 最多几张（默认 99）；非法输入回落到默认 99 */
      const shRaw = parseInt(overlay.querySelector('#fl-c-shots').value, 10);
      c.maxShots = Math.max(0, Math.min(SHOT_MAX, isNaN(shRaw) ? SHOT_MAX : shRaw));
      c.queueDelay = Math.max(0, Math.min(60000, parseInt(overlay.querySelector('#fl-c-delay').value, 10) || 0));
      c.autoQueue = overlay.querySelector('#fl-c-auto').checked;
      /* v1.3.60 #30：非法输入明示回退——旧版静默变 0.5，用户输入 \"abc\"/\"\" 得 NaN
         后面板照常关 + toast「设置已保存」，实际缩放被悄悄恢复默认（排查无线索）。 */
      const usRaw = String(overlay.querySelector('#fl-c-uiscale').value).trim();
      const us = parseFloat(usRaw);
      const usOk = us > 0.2 && us <= 1.5;
      c.uiScale = usOk ? us : 0.5;
      if (!usOk) toast('按钮缩放「' + usRaw + '」不是 0.2-1.5 之间的数，已恢复默认 0.5', 'warn');
      c.jumpBtns = overlay.querySelector('#fl-c-jump').checked;
      c.looseCode = overlay.querySelector('#fl-c-loose').checked;
      c.adBlock = overlay.querySelector('#fl-c-ad').checked;
      c.killCover = overlay.querySelector('#fl-c-kill').checked;
      c.advMode = overlay.querySelector('#fl-c-adv').checked;
      /* 番号正则：按顺序收集，非法的给提示并保留该条原值 */
      const oldRes = Array.isArray(c.codeRes) ? c.codeRes.slice() : DEF_RE_LIST.slice();
      const reVals = Array.from(overlay.querySelectorAll('#fl-c-re-wrap input.fl-c-re'))
                          .map(i => String(i.value || '').trim());
      const reBad = [];
      const reOk = reVals.map((p, i) => {
        if (!p) return '';
        try { new RegExp(p); return p; } catch (e) { reBad.push(String(i + 1)); return null; }
      });
      if (reBad.length) toast('番号正则 第 ' + reBad.join('、') + ' 条不是合法正则，已保留原值', 'err');
      c.codeRes = reOk.map((p, i) => (p === null ? String(oldRes[i] || '') : p));
      while (c.codeRes.length < RE_SLOTS) c.codeRes.push('');
      /* 各站抓取字段矩阵：读勾选状态写回 sources[*].fields（番号恒抓，不在矩阵里） */
      Object.keys(c.sources).forEach(function(k){
        const f = c.sources[k].fields = c.sources[k].fields || {};
        FIELD_DEFS.forEach(function(fd){
          /* v1.3.66 #21：站点 key 含特殊字符（用户自建站名带空格/引号/点）时
             '#fl-fld-' + k 会抛 SyntaxError——旧版异常穿透 forEach 中断整个保存，
             或把字段矩阵静默清空。CSS.escape 转义 id 选择器；老浏览器没有
             CSS.escape 时退回属性选择器（值在引号内，双引号转成 CSS 转义 \22 ）。 */
          const fldId = 'fl-fld-' + k + '-' + fd[0];
          let cb = null;
          try { cb = overlay.querySelector('#' + (window.CSS && CSS.escape ? CSS.escape(fldId) : fldId)); } catch (e) { cb = null; }
          if (!cb) { try { cb = overlay.querySelector('[id="' + fldId.replace(/"/g, '\\22 ') + '"]'); } catch (e2) { cb = null; } }
          f[fd[0]] = !!(cb && cb.checked);
        });
      });
      if (key) {
        const s = c.sources[key];
        s.sel.title = overlay.querySelector('#fl-s-title').value.trim();
        s.sel.cover = overlay.querySelector('#fl-s-cover').value.trim();
        s.sel.actor = overlay.querySelector('#fl-s-actor').value.trim();
        s.sel.shots = overlay.querySelector('#fl-s-shots').value.trim();
        s.sel.info  = overlay.querySelector('#fl-s-info').value.trim();
        s.searchUrl = overlay.querySelector('#fl-s-search').value.trim();
        s.sel.result = overlay.querySelector("#fl-s-result").value.trim();
      }
      /* v1.3.55：写入失败时面板不关（可重试或先「导出设置」保住配置）并明确告知——
         旧版无条件关面板 + toast「已保存」是假成功。 */
      if (setCfg(c)) {
        overlay.remove();
        toast('设置已保存', 'ok');
      } else {
        toast('保存失败：浏览器存储写入异常（存储配额已满或隐私模式？）。面板保持打开，可先点「导出设置」保住配置', 'err');
      }
    });
  }
  /* 设置面板 IO：导出 / 导入 JSON */
  function bindSettingsIO(overlay) {
    /* 导出诊断（v1.3.46 任务119）：一键打包排障材料，用户不熟悉 DevTools，
       拿这个文件即可定位问题（含服务端连通性实探） */
    const diagx = overlay.querySelector('#fl-s-diagx');
    if (diagx) diagx.addEventListener('click', async () => {
      toast('正在收集诊断信息…', 'ok');
      const c = getCfg();
      let srv = null;
      try { srv = await httpJson('GET', '/api/status', null, 4000); } catch (e) { srv = { ok: false, why: String(e && e.message || e) }; }
      const lsKeys = {};
      try {
        ['fl_recent_writes', 'fl_queue', 'fl_current', 'fl_inbox_batch'].forEach(k => {
          const v = localStorage.getItem(k);
          lsKeys[k] = v == null ? null : (v.length > 200 ? ('<'+v.length+' chars>') : v);
        });
      } catch (e) {}
      const diag = {
        app: 'FL Spider', version: VERSION, cfgV: CFG_V, exportedAt: new Date().toISOString(),
        page: { url: location.href, host: location.hostname, sourceKey: currentSourceKey(), tier: tierOfSource(currentSourceKey(), '') },
        env: {
          secureContext: !!window.isSecureContext,
          dirPicker: typeof window.showDirectoryPicker === 'function',
          folderHandle: !!folderHandle,
          gmXhr: typeof GM_xmlhttpRequest === 'function',
          fsWhy: fsEnvDiag() || '环境正常'
        },
        server: srv,
        cfg: c,
        localStorage: lsKeys
      };
      const blob = new Blob([JSON.stringify(diag, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'FL Spider 诊断_v' + VERSION + '_' + location.hostname + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      toast('诊断文件已下载（排障时直接发送此文件）', 'ok');
    });
    overlay.querySelector('#fl-s-export').addEventListener('click', () => {
      const c = getCfg();
      const blob = new Blob([JSON.stringify(c, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'FL Spider 设置_v' + (c.v || CFG_V) + '.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
      toast('已导出设置文件', 'ok');
    });
    /* 导入设置：读 JSON 覆盖当前配置（下次读取时由 getCfg 自动补齐默认值/迁移版本） */
    const impInp = document.createElement('input');
    impInp.type = 'file'; impInp.accept = 'application/json,.json'; impInp.style.display = 'none';
    overlay.appendChild(impInp);
    overlay.querySelector('#fl-s-import').addEventListener('click', () => impInp.click());
    impInp.addEventListener('change', () => {
      const file = impInp.files && impInp.files[0];
      if (!file) return;
      const reader = new FileReader();
      /* v1.3.66 #23：读取失败（文件被占用/权限/超大）时旧版静默无提示——
         用户以为导入了，实际配置没变。 */
      reader.onerror = () => { toast('导入失败：设置文件读取错误', 'err'); };
      reader.onload = () => {
        try {
          const c = JSON.parse(String(reader.result));
          if (!c || typeof c !== 'object' || !('sources' in c)) throw new Error('不是有效的 FL Spider 设置文件');
          /* v1.3.55：setCfg 不再抛错（返回布尔）——失败必须自己抛，
             否则会被下面 catch 到之前就 toast 假成功 */
          if (!setCfg(c)) throw new Error('浏览器存储写入失败，配置未保存');
          overlay.remove();
          toast('设置已导入，刷新页面后生效', 'ok');
        } catch (e) { toast('导入失败：' + (e.message || e), 'err'); }
      };
      reader.readAsText(file);
    });
  }
  /* 打开设置面板（v55 由 296 行巨函数拆分为主干 + 4 个分区函数） */
  function openSettings(key) {
    const cfg = getCfg();
    const overlay = document.createElement('div');
    overlay.id = 'fl-modal-set';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:' + Z + ';' +
      'display:flex;align-items:center;justify-content:center;';
    overlay.innerHTML = settingsPanelHtml(key, cfg);
    document.body.appendChild(overlay);
    scaleButtonsIn(overlay);
    bindSettingsEvents(overlay);
    bindSettingsActions(overlay, key);
    bindSettingsIO(overlay);
  }

  /* ==========================================================================
   * 抓取端 UI
   * ======================================================================== */
  const Z = 2147483647;   // int32 上限：压过站点那些 z-index 拉满的全屏浮层
  let dragMoved = false;   // 刚拖动过 → 吞掉这一次 click

  /* ---------- 按钮动作：统一走 window 捕获阶段委托 ----------
   * 挂在 window + capture：比站点自己的 document 级拦截更早拿到事件，
   * 避免某些站点（含 MissAV）在 document 上 stopPropagation 导致「点了没反应」。 */
  function guardAct(p, what){ if(p && typeof p.catch === 'function') p.catch(function(err){ console.error('[FL Spider] ' + what + '失败：', err); toast(what + '失败：' + ((err && err.message) || err), 'err'); }); return p; }
  function runAction(act, el) {
    const key = (el && el.getAttribute('data-fl-key')) || currentSourceKey();
    try {
      if (act === 'save') return guardAct(quickSave(key), '抓取');          // 抓取按钮：直接抓，不弹确认框
      if (act === 'confirm') return guardAct(openConfirmModal(key), '确认入库'); // 确认入库按钮：打开编辑弹窗

      /* v1.3.57 #10：consumePendingCodes 是唯一没包 guardAct 的异步动作——它在文件夹
         降级路径上调 ensureFolder，用户取消系统选择框（AbortError）时 runAction 的同步
         try/catch 捕不住 async 拒绝 → 无 toast 无反应，用户以为点了没触发。 */
      if (act === 'pending') return guardAct(consumePendingCodes(key), '批量');
      if (act === 'queue') return openQueuePanel();
      if (act === 'dom') return openDomSample(key);
      if (act === 'gdom') {
        const c = getCfg();
        if (!c.sources.generic) {
          c.sources.generic = {
            label: 'generic', test: location.hostname, searchUrl: '',
            sel: { title: 'h1', cover: 'meta[property="og:image"]', actor: '', tags: '', shots: '', info: 'main, body' }
          };
          setCfg(c);
        }
        return openDomSample('generic');
      }
      if (act === 'settings') return openSettings(key);
      if (act === 'refolder') {
        resetFolder().then(() => ensureFolder()).then(() => toast('已重新选择文件夹', 'ok'))
          .catch((e) => { toast('重新授权失败：' + ((e && e.message) || e), 'err'); });
        return;
      }
      if (act === 'pdiag') return openParseDi(key, el);
      if (act === 'diag') {
        const why = fsEnvDiag();
        const lines = [
          '页面：' + location.hostname,
          '安全上下文：' + (window.isSecureContext ? '是' : '否'),
          '文件夹接口：' + (typeof window.showDirectoryPicker === 'function' ? '可用' : '不可用'),
          '已存句柄：' + (folderHandle ? '有' : '无（未选过或已失效）'),
          '结论：' + (why ? why : '环境正常')
        ];
        alert('FL Spider 环境自检\n\n' + lines.join('\n'));
        console.log('[FL Spider] 环境自检', lines);
        return;
      }
      if (act && act.indexOf('jump:') === 0) {
        const k = act.slice(5), s = JUMP_SITES[k];
        if (!s) return;
        let code = (el && el.getAttribute('data-fl-code')) || extractCodeFromPage();
        if (s.url.indexOf('{title}') !== -1) {
          /* 按原名搜索的站（MGS）：优先当前页原名；取不到退回番号（MGS 也认番号搜） */
          let title = (el && el.getAttribute('data-fl-title')) || pageTitleForJump(code);
          if (!title) title = code;
          if (!title) { toast('没识别到原名或番号，无法跳转', 'err'); return; }
          window.open(s.url.replace('{title}', encodeURIComponent(title)), '_blank', 'noopener');
          return;
        }
        if (!code) { toast('没识别到番号，无法跳转', 'err'); return; }
        /* FANZA 的 key= 要 FANZA 写法（EBWH-346 → EBWH00346），其他站用库内标准写法 */
        if (k === 'fanza') code = fanzaCodeOf(code);
        window.open(s.url.replace('{code}', encodeURIComponent(code)), '_blank', 'noopener');
        return;
      }
      if (act === 'copy') {
        const code = (el && el.getAttribute('data-fl-code')) || extractCodeFromPage();
        if (!code) { toast('没识别到番号', 'err'); return; }
        copyText(code, '已复制番号 ' + code);   /* v1.3.60 #29b */
        return;
      }
      if (act === 'lib') {
        /* v1.3.67：点击 = 手动刷新查询。data-fl-code 是注入时识别的番号；
           取不到再现场识别一次（SPA 换页后按钮可能还没重建）。 */
        const btn = document.getElementById('fl-lib-btn');
        const code = (el && el.getAttribute('data-fl-code')) || (btn && btn.getAttribute('data-fl-code')) || extractCodeFromPage();
        if (!code) { toast('没识别到番号，无法查询', 'err'); return; }
        queryLibBtn(btn, code, true);   /* 手动刷新：绕过 5s 服务状态缓存 */
        return;
      }
    } catch (err) {
      console.error('[FL Spider] 按钮动作出错：', err);
      toast('出错了：' + ((err && err.message) || err), 'err');
    }
  }
  /* ---------- 批量队列面板（v1.3.28）----------
   * 一屏看全：FL Server 状态 / 本地队列进度与统计 / 服务端待补全番号 / 写入方式 */
  function openQueuePanel() {
    const old = document.getElementById('fl-queue-mask');
    if (old) { old.remove(); return; }   // 再点一次按钮 = 关闭
    const mask = document.createElement('div');
    mask.id = 'fl-queue-mask';
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:' + Z + ';' +
      'display:flex;align-items:center;justify-content:center;';
    mask.innerHTML =
      '<div style="background:#fff;color:#222;width:470px;max-width:94vw;max-height:86vh;overflow:auto;' +
      'border-radius:12px;padding:18px;font-size:13px;">' +
        '<h3 style="margin:0 0 4px;font-size:16px;">批量队列 · FL Spider v' + VERSION + '</h3>' +
        '<div id="qq-srv" style="font-size:12px;color:#666;margin-bottom:10px;">正在探测 FL Server…</div>' +
        '<div id="qq-local" style="margin-bottom:10px;"></div>' +
        '<div id="qq-stat" style="display:flex;gap:8px;margin-bottom:10px;"></div>' +
        '<div style="font-size:12px;color:#555;margin:0 0 4px;">本地队列（GM 存储，刷新页面不丢）</div>' +
        '<div id="qq-list" style="font-family:Consolas,monospace;font-size:12px;color:#0f766e;word-break:break-all;line-height:1.7;' +
          'background:#f0fdfa;border-radius:8px;padding:8px;min-height:20px;margin-bottom:10px;"></div>' +
        '<div style="font-size:12px;color:#555;margin:0 0 4px;">服务端待补全番号（Film Library 导出到这里）</div>' +
        '<div id="qq-pending" style="font-family:Consolas,monospace;font-size:12px;color:#1d4ed8;word-break:break-all;line-height:1.7;' +
          'background:#eff6ff;border-radius:8px;padding:8px;min-height:20px;margin-bottom:10px;"></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
          '<button id="qq-start" style="flex:1;padding:8px 10px;border:none;border-radius:8px;background:#1f9d55;color:#fff;cursor:pointer;font-size:12px;">读入待补全并开始抓取</button>' +
          '<button id="qq-clear-pending" style="padding:8px 10px;border:none;border-radius:8px;background:#e2e8f0;color:#334155;cursor:pointer;font-size:12px;">清空服务端队列</button>' +
          '<button id="qq-stop" style="padding:8px 10px;border:none;border-radius:8px;background:#fee2e2;color:#b91c1c;cursor:pointer;font-size:12px;">停止队列</button>' +
          '<button id="qq-refresh" style="padding:8px 10px;border:none;border-radius:8px;background:#e2e8f0;color:#334155;cursor:pointer;font-size:12px;">刷新</button>' +
          '<button id="qq-close" style="padding:8px 12px;border:none;border-radius:8px;background:#eee;color:#333;cursor:pointer;font-size:12px;">关闭</button>' +
        '</div>' +
        '<div style="font-size:11px;color:#999;margin-top:10px;line-height:1.6;">' +
          '写入方式：FL Server 在线 → 抓取结果直接 HTTP 写进数据目录收件箱；服务不在 → 降级写所选文件夹，再不行下载 json 手动放入。</div>' +
      '</div>';
    document.body.appendChild(mask);
    scaleButtonsIn(mask);

    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const alive = () => document.body.contains(mask);
    const paintLocal = () => {
      const qq = getQueue(), cc = getCurrent();
      mask.querySelector('#qq-local').innerHTML =
        '<div style="font-size:13px;line-height:1.8;">' +
          (cc && cc.code ? ('正在处理：<b style="color:#0f766e;">' + esc(cc.code) + '</b>') : '当前没有处理项') +
          ' · 队列剩余 <b>' + qq.length + '</b> 个</div>';
      mask.querySelector('#qq-list').textContent = qq.length
        ? qq.slice(0, 20).map(x => (x && x.code) || '?').join('、') + (qq.length > 20 ? ' …还有 ' + (qq.length - 20) + ' 个' : '')
        : '（空）——点「读入待补全并开始抓取」，或从文件夹里的待补全文件启动';
      mask.querySelector('#qq-stat').innerHTML =
        '<div style="flex:1;background:#ecfdf5;border-radius:8px;padding:8px;text-align:center;">' +
          '<div style="font-size:11px;color:#047857;">已完成</div>' +
          '<div style="font-size:20px;font-weight:700;color:#047857;">' + getDone().length + '</div></div>' +
        '<div style="flex:1;background:#fef2f2;border-radius:8px;padding:8px;text-align:center;">' +
          '<div style="font-size:11px;color:#b91c1c;">失败</div>' +
          '<div style="font-size:20px;font-weight:700;color:#b91c1c;">' + getFailed().length + '</div></div>';
    };
    const paintServer = async () => {
      const srv = await serverReady(true);
      if (!alive()) return;
      const srvEl = mask.querySelector('#qq-srv'), pEl = mask.querySelector('#qq-pending');
      if (srv && srv.ok) {
        srvEl.innerHTML = '🟢 FL Server 在线 · 数据目录已配置 · 写入方式：HTTP';
        const hr = await httpJson('GET', '/api/pending');
        if (!alive()) return;
        if (hr.ok && hr.json && Array.isArray(hr.json.codes)) {
          const cs = hr.json.codes;
          pEl.textContent = cs.length
            ? cs.slice(0, 20).map(String).join('、') + (cs.length > 20 ? ' …还有 ' + (cs.length - 20) + ' 个' : '')
            : '（空）——在 Film Library 的「FANZA 待抓清单」里导出待补全番号';
        } else { pEl.textContent = '读取失败：' + (hr.why || '未知错误'); }
      } else {
        srvEl.innerHTML = '🔴 FL Server 不在线（' + esc((srv && srv.why) || '未运行') + '）· 写入方式：文件夹 / 下载降级';
        pEl.textContent = '（服务不在线，读不到服务端队列；可用文件夹里的「' + PENDING_PREFIX + '*.json」）';
      }
    };
    paintLocal();
    paintServer();
    const t1 = setInterval(() => { if (!alive()) { clearInterval(t1); return; } paintLocal(); }, 2000);
    const t2 = setInterval(() => { if (!alive()) { clearInterval(t2); return; } paintServer(); }, 5000);
    const close = () => { clearInterval(t1); clearInterval(t2); mask.remove(); };
    mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
    mask.querySelector('#qq-close').addEventListener('click', close);
    mask.querySelector('#qq-refresh').addEventListener('click', () => { paintLocal(); paintServer(); });
    mask.querySelector('#qq-stop').addEventListener('click', () => {
      setQueue([]);
      toast('队列已停止（已完成 / 失败记录保留）', 'ok');
      paintLocal();
    });
    mask.querySelector('#qq-clear-pending').addEventListener('click', async () => {
      /* v1.3.58 #18：改 async/await——旧版 .then 链里 httpJson 的 rejection 无人接，
         清空失败时无任何反馈（用户以为清过了）。 */
      let srv = null;
      try { srv = await serverReady(true); }
      catch (e) { toast('FL Server 连接失败：' + ((e && e.message) || e), 'err'); return; }
      if (!srv || !srv.ok) { toast('FL Server 不在线，无法清空', 'err'); return; }
      try {
        const hr = await httpJson('POST', '/api/pending', { codes: [] });
        toast(hr.ok ? '服务端待补全队列已清空' : ('清空失败：' + (hr.why || '')), hr.ok ? 'ok' : 'err');
      } catch (e) { toast('清空失败：' + ((e && e.message) || e), 'err'); }
      paintServer();
    });
    mask.querySelector('#qq-start').addEventListener('click', () => {
      close();
      consumePendingCodes(currentSourceKey());
    });
  }

  function openParseDi(key, el) {
    try { openParseDiag((el && el.getAttribute("data-fl-key")) || key || currentSourceKey()); }
    catch (e) { toast("诊断失败：" + ((e && e.message) || e), "err"); }
  }
  function setupGlobalHandlers() {
    window.addEventListener('click', (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const btn = t.closest('[data-fl-act]');
      /* v1.3.56：dragMoved 的检查必须早于 !btn 早退。旧版顺序是 !btn → dragMoved：
         从盒子空白处拖动松手时 click 落在非按钮区域，被 !btn 提前 return，dragMoved
         保持 true；随后用户 Tab+Enter 激活按钮，这次 click 被静默拦掉（表现为
         「键盘操作失灵一次」）。现在无论 click 落在哪，拖动态的这一跳都消费掉
         dragMoved；只有落在按钮上时才需要 stopPropagation/preventDefault。 */
      if (dragMoved) {
        if (btn) { e.stopPropagation(); e.preventDefault(); }
        dragMoved = false;
        return;
      }
      if (!btn) return;
      runAction(btn.getAttribute('data-fl-act'), btn);
    }, true);
  }

  /* ---------- 悬浮按钮位置：按站点记忆，可拖动 ---------- */
  function boxPosKey() { return 'fl_boxpos2_' + (location.hostname || 'x'); }   // v2：丢弃旧版的左侧记忆位置
  /* ==========================================================================
   * v1.3.54 小视口自适应（双站诊断实证：免疫后两站盒子渲染完全一致，差异全在视口——
   *   MISSAV 894x597/dpr2 下占视口高 89%，FANZA 1788x1194 下只占 44%）
   *   超过视口高度预算时按比例缩小：transform scale 保留设计比例（不改成横排/网格，
   *   那会改变信息架构）；锚点随定位方式（左上定位锚左上，右下定位锚右下）。
   *   联动：拖动位移 /k、saveBoxPos 改存 layout left/top、resize 重算、dropBox 回收。
   * ======================================================================== */
  var BOX_FIT_RATIO = 0.65;   /* 盒子高度不超过视口高的 65%（留 16px 呼吸） */
  var BOX_FIT_FLOOR = 0.5;    /* 缩放下限：再小按钮就点不准了 */
  function fitBoxToViewport(box) {
    try {
      const vh = window.innerHeight || 768;
      const budget = Math.max(200, Math.round(vh * BOX_FIT_RATIO) - 16);
      const h = box.getBoundingClientRect().height;
      let k = 1;
      if (h > budget) k = Math.max(BOX_FIT_FLOOR, Math.round((budget / h) * 100) / 100);
      box.__flScale = k;
      const anchoredLeft = box.style.left && box.style.left !== "auto";
      const anchoredTop = box.style.top && box.style.top !== "auto";
      box.style.setProperty("transform-origin", (anchoredLeft || anchoredTop) ? "left top" : "right bottom", "important");
      if (k === 1) box.style.removeProperty("transform");
      else box.style.setProperty("transform", "scale(" + k + ")", "important");
      /* 缩放后若仍超出视口底部（用户拖到过半后又缩窗），把 top 钳回视口内（不落盘，
         下次加载按存档位置重放后再钳，避免和用户手动位置打架） */
      if (anchoredTop) {
        const hs = box.getBoundingClientRect().height;
        const maxTop = Math.max(0, vh - 12 - hs);
        const t = parseFloat(box.style.top);
        if (isFinite(t) && t > maxTop) box.style.top = Math.round(maxTop) + "px";
      }
      /* v1.3.56：left 同款钳位——旧版只钳 top，窗口变窄后盒子可整个留在右屏外
         （按钮点不到且没有任何自我修正路径）。与拖动逻辑 onMove 的两轴钳位对齐。 */
      if (anchoredLeft) {
        const ws = box.getBoundingClientRect().width;
        const maxLeft = Math.max(0, (window.innerWidth || 1024) - 12 - ws);
        const l = parseFloat(box.style.left);
        if (isFinite(l) && l > maxLeft) box.style.left = Math.round(maxLeft) + "px";
      }
      /* 窗口尺寸变化时重算；监听只挂一次，随盒子回收（A-05 同款防累积） */
      if (!box.__flFitBound) {
        box.__flFitBound = true;
        const onResize = () => fitBoxToViewport(box);
        window.addEventListener("resize", onResize);
        box.__flOffFit = () => window.removeEventListener("resize", onResize);
      }
    } catch (e) {}
  }
  function applyBoxPos(box) {
    let p = null;
    try { p = JSON.parse(GM_getValue(boxPosKey(), 'null')); } catch (e) { p = null; }
    if (p && typeof p.x === 'number' && typeof p.y === 'number') {
      /* 上下限都钳：只钳下限时，保存位置若超出当前窗口（窗口变窄 / 换页面）盒子会跑到屏幕外 */
      const maxX = Math.max(0, (window.innerWidth || 1024) - 80);
      const maxY = Math.max(0, (window.innerHeight || 768) - 80);
      box.style.left = Math.min(Math.max(0, p.x), maxX) + 'px';
      box.style.top = Math.min(Math.max(0, p.y), maxY) + 'px';
      box.style.right = 'auto';
      box.style.bottom = 'auto';
    }
  }
  function saveBoxPos(box) {
    /* v1.3.54：改存内联 left/top（layout 值）。getBoundingClientRect 是视觉值，
       自动缩放后两者差 (1-k)×宽——存视觉值再按 layout 还原，盒子每次加载都会漂移。 */
    try {
      const x = parseFloat(box.style.left), y = parseFloat(box.style.top);
      if (isFinite(x) && isFinite(y)) GM_setValue(boxPosKey(), JSON.stringify({ x: Math.round(x), y: Math.round(y) }));
    } catch (e) {}
  }
  /* ---------- 点击穿透：站点用全屏浮层（广告 / 反拦截层）盖住按钮时，
   *            pointerdown 的瞬间把它临时隐藏，让 click 能落到我们的按钮上 ---------- */
  function isOurs(el) {
    if (!el) return true;
    if (el.id && String(el.id).indexOf('fl-') === 0) return true;
    try { return !!(el.closest && el.closest('[id^="fl-"]')); } catch (e) { return false; }
  }
  /* v1.3.51 A-07（P3）：全屏浮层的「临时隐藏」——记录原 inline display 值，
     指针抬起（或 1.5s 兜底）后原样还原。旧版 display:none important 后永不还原，
     误判时站点元素对用户永久消失（还查不出原因）。killCoverAt 与 scanAds 误伤防御共用。 */
  let _coverHidden = [];
  let _coverRestoreTimer = null;
  let _coverRestoreBound = false;
  function restoreCovers() {
    if (_coverRestoreTimer) { try { clearTimeout(_coverRestoreTimer); } catch (e) {} _coverRestoreTimer = null; }
    _coverRestoreBound = false;
    const list = _coverHidden; _coverHidden = [];
    list.forEach(x => {
      try {
        if (x.d) x.el.style.setProperty('display', x.d, x.p || '');
        else x.el.style.removeProperty('display');
      } catch (e) {}
    });
  }
  function hideCoverTemp(el) {
    _coverHidden.push({ el: el, d: el.style.getPropertyValue('display'), p: el.style.getPropertyPriority('display') });
    el.style.setProperty('display', 'none', 'important');
    if (!_coverRestoreBound) {
      _coverRestoreBound = true;
      const done = () => restoreCovers();
      try {
        window.addEventListener('pointerup', done, { once: true, capture: true });
        window.addEventListener('pointercancel', done, { once: true, capture: true });
      } catch (e) {
        window.addEventListener('pointerup', done, true);
        window.addEventListener('pointercancel', done, true);
      }
    }
    if (_coverRestoreTimer) { try { clearTimeout(_coverRestoreTimer); } catch (e) {} }
    _coverRestoreTimer = setTimeout(restoreCovers, 1500);
  }
  function killCoverAt(x, y) {
    if (!getCfgSafe().killCover) return false;
    let el = null;
    try { el = document.elementFromPoint(x, y); } catch (e) { return false; }
    if (!el || isOurs(el)) return false;
    let n = el, guard = 0;
    while (n && n !== document.body && n !== document.documentElement && guard++ < 14) {
      /* 视频 / 音频 / iframe 播放器：绝不隐藏，否则 FANZA 等站点播放器被隐藏导致无法观看 */
      if (n.matches && (n.matches('video, audio, iframe') || (n.querySelector && n.querySelector('video, audio, iframe')))) return false;
      let st = null;
      try { st = getComputedStyle(n); } catch (e) { return false; }
      const r = n.getBoundingClientRect();
      const big = r.width >= window.innerWidth * 0.5 && r.height >= window.innerHeight * 0.5;
      if ((st.position === 'fixed' || st.position === 'absolute') && big) {
        hideCoverTemp(n);
        console.log('[FL Spider] 🧹 已临时隐藏遮挡按钮的全屏浮层（松手还原）：', (n.id || n.className || n.tagName));
        return true;
      }
      n = n.parentElement;
    }
    return false;
  }
  /* 让全屏浮层不再拦截点击（不隐藏它，只关掉它的命中，避免误伤页面视觉） */
  function neutralizeCover(el) {
    let n = el, guard = 0;
    while (n && n !== document.body && n !== document.documentElement && guard++ < 14) {
      /* 视频 / 音频 / iframe 播放器：绝不能关它的命中，否则 FANZA 等站点的播放器会点不动 */
      if (n.matches && (n.matches('video, audio, iframe') || (n.querySelector && n.querySelector('video, audio, iframe')))) return false;
      let st = null;
      try { st = getComputedStyle(n); } catch (e) { return false; }
      const r = n.getBoundingClientRect();
      const big = r.width >= window.innerWidth * 0.5 && r.height >= window.innerHeight * 0.5;
      if ((st.position === 'fixed' || st.position === 'absolute') && big) {
        n.style.setProperty('pointer-events', 'none', 'important');
        console.log('[FL Spider] 🧹 已让全屏浮层不再拦截点击：', (n.id || n.className || n.tagName));
        return true;
      }
      n = n.parentElement;
    }
    return false;
  }
  /* 主动体检：按钮上方若被非本站的东西盖住，就把遮挡层打穿 */
  function guardBoxClickable() {
    if (!getCfgSafe().killCover) return;
    /* FANZA 的播放器就在右下角（盒子正下方），且 FANZA 没有 MissAV 那种吞点击的全屏浮层，
     * 这里直接跳过，避免误把播放器打穿导致无法播放/暂停/拖动进度。 */
    /* v1.3.51 A-06（P3）：旧版取了 k 却没用上（死代码）——上面注释承诺的 FANZA 跳过
       实际不存在，FANZA 上 neutralizeCover 会把播放器容器 pointer-events 关掉导致播不动。
       以 xf==='fanza' 判定（覆盖 dmm/dmmvideo 两个源），与 codeForSite 同口径。 */
    const k = currentSourceKey();
    const src = (getCfgSafe().sources || {})[k];
    if (src && src.xf === 'fanza') return;
    const box = $('#fl-box') || $('#fl-generic-dom');
    if (!box) return;
    const r = box.getBoundingClientRect();
    if (!r.width) return;
    const pts = [[r.left + 6, r.top + 6],
                 [r.left + r.width - 6, r.top + r.height - 6],
                 [r.left + r.width / 2, r.top + r.height / 2]];
    for (const p of pts) {
      let el = null;
      try { el = document.elementFromPoint(p[0], p[1]); } catch (e) { return; }
      if (!el || isOurs(el)) continue;
      if (neutralizeCover(el)) break;
    }
  }
  function startClickGuard() {
    [400, 1500, 3000].forEach(ms => setTimeout(guardBoxClickable, ms));
    let t = null;
    const kick = () => { clearTimeout(t); t = setTimeout(guardBoxClickable, 500); };
    try {
      const ob = new MutationObserver(muts => {
        for (const m of muts) { if (m.addedNodes.length) { kick(); break; } }
      });
      ob.observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }
  /* v1.3.51 A-05（P3）：移除盒子时先回收它挂在 window 上的拖拽监听。
     makeBoxDraggable 每次注入都新挂三个 capture 监听，旧版盒子移除后监听不回收，
     SPA 长时间使用会无限累积（旧盒已死但监听仍挂着）。box.__flOffDrag 幂等。 */
  function dropBox(b) {
    try { if (b && b.__flOffDrag) b.__flOffDrag(); } catch (e) {}
    try { if (b && b.__flOffFit) b.__flOffFit(); } catch (e) {}   /* v1.3.54：resize 监听回收 */
    try { if (b && b.remove) b.remove(); } catch (e) {}
  }
  function makeBoxDraggable(box) {
    let on = false, sx = 0, sy = 0, ox = 0, oy = 0;
    box.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      killCoverAt(e.clientX, e.clientY);      // 先把可能的遮挡层清掉
      on = true; dragMoved = false;
      /* v1.3.54：缩放中且锚点在右下（未拖过）时，先把锚点换成左上——按当前视觉位置
         写 layout left/top 再切锚点（同一任务内无绘制，视觉不跳），之后拖动数学才准确 */
      const k0 = box.__flScale || 1;
      /* v1.3.55：left 可能是 ""（从未定位过）也可能是 "auto"（dblclick 复位后）——
         旧版只认 ""，复位后首次拖动跳过换算：视觉坐标被写进布局坐标，盒子瞬移
         (1-k)×W，且错位被 saveBoxPos 持久化，每次加载都漂移。与 fitBoxToViewport
         的口径（left && left !== "auto"）对齐。 */
      if (k0 !== 1 && (box.style.left === "" || box.style.left === "auto")) {
        const r0 = box.getBoundingClientRect();
        box.style.left = Math.round(r0.left) + "px";
        box.style.top = Math.round(r0.top) + "px";
        box.style.right = "auto";
        box.style.bottom = "auto";
        box.style.setProperty("transform-origin", "left top", "important");
      }
      const r = box.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      /* 注意：这里刻意不用 setPointerCapture —— 指针捕获会把随后的 click
       * 重定向到捕获元素（box）上，按钮自己的 click 监听器永远收不到事件，
       * 表现就是「点了没反应」。改为在 window 上监听 move/up。 */
    });
    const onMove = (e) => {
      if (!on) return;
      /* v1.3.54 实测修正：transform-origin 随元素走，平移对视觉位移恒为 1:1（与 k 无关）——
         初版按「视觉=布局×k」除了 k，实测 60px 拖成 103px，已改回 1:1。
         缩放锚点的换算在 pointerdown 里做（见上），这里只管平移。 */
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!dragMoved && Math.abs(dx) + Math.abs(dy) < 5) return;
      dragMoved = true;
      const maxX = Math.max(0, window.innerWidth - 60);
      const maxY = Math.max(0, window.innerHeight - 30);
      box.style.left = Math.min(maxX, Math.max(0, ox + dx)) + 'px';
      box.style.top = Math.min(maxY, Math.max(0, oy + dy)) + 'px';
      box.style.right = 'auto';
      box.style.bottom = 'auto';
    };
    const offDrag = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
    };
    /* A-05：盒子不在了就自我回收监听（覆盖站点 innerHTML 清盒等非常规路径） */
    const onUp = () => {
      /* v1.3.66 #22：站点「移除再插回」迁移盒子时 isConnected 会瞬时为 false——
         旧版立即 offDrag 把监听永久摘掉（注入只跑一次，之后该盒子拖拽全废且没有
         自愈路径：ensureBodyWatch 只看「盒子在不在」，迁移回来了就不重建）。
         延后到下一帧复查：真被移除才回收，迁移回来则监听继续有效。 */
      if (!box.isConnected) { setTimeout(() => { if (!box.isConnected) offDrag(); }, 0); return; }
      if (on && dragMoved) saveBoxPos(box);
      on = false;
      /* v1.3.56：兜底复位。down/up 不在同一元素时浏览器不派发 click，dragMoved 会
         残留并吞掉之后第一次键盘激活。click 与 pointerup 在同一任务派发（早于本
         setTimeout），所以正常路径的拖动态拦截不受影响。 */
      setTimeout(() => { dragMoved = false; }, 0);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    box.__flOffDrag = offDrag;
    /* 兜底：body 被整体替换 / 盒子以任何方式被移除时，观察器触发回收并自我断开。
       两个轻量观察器（都不开 subtree）：documentElement 管换 body，body 管直接子节点增减。 */
    try {
      const mo = new MutationObserver(() => {
        /* v1.3.66 #22：移除与插回可能跨任务——先延后复查，别把「迁移中」判成
           「已删除」（误摘监听 + 断开观察器，双重永久失效）。 */
        if (box.isConnected) return;
        setTimeout(() => { if (!box.isConnected) { offDrag(); mo.disconnect(); } }, 0);
      });
      if (document.documentElement) mo.observe(document.documentElement, { childList: true });
      if (document.body && document.body !== document.documentElement) mo.observe(document.body, { childList: true });
    } catch (e) {}
    box.addEventListener('dblclick', (e) => {
      /* v1.3.56：双击落在按钮上时只当按钮的双击，不触發盒子复位——旧版不查 e.target，
         双击 toggle/设置/DOM 按钮会「冒泡」到本处理器：盒子被复位到右下角，动作本身
         也因面板一闪即逝/遮罩叠两层而表现成触发两次（批量时 nextInQueue 双调推进）。
         e.target 可能是按钮内的 svg/path，closest 照样能找到 button。 */
      try { if (e.target && e.target.closest && e.target.closest('button')) return; } catch (err) {}
      try { GM_setValue(boxPosKey(), ''); } catch (e) {}
      box.style.right = '18px'; box.style.bottom = '18px';
      box.style.left = 'auto'; box.style.top = 'auto';
      box.style.setProperty("transform-origin", "right bottom", "important");   /* v1.3.54：复位后锚点跟定位走 */
      toast('按钮已复位到右侧', 'ok');
    });
  }
  /* 兜底去重：无论何种原因（旧脚本未卸载 / FANZA 克隆 body / 多次注入）导致出现多个按钮盒子，
   * 都只保留最后一个，彻底杜绝「按钮重复」。 */
  function dedupeBox() {
    try {
      const boxes = $$('#fl-box');
      if (boxes.length <= 1) return;
      // 优先保留本脚本（data-fl-owner=fl-spider），否则保留最后一个；其余一律移除
      const keep = boxes.find(b => b.getAttribute('data-fl-owner') === 'fl-spider') || boxes[boxes.length - 1];
      boxes.forEach(b => { if (b !== keep) dropBox(b); });
      const gens = $$('#fl-generic-dom');
      for (let i = 0; i < gens.length - 1; i++) dropBox(gens[i]);
    } catch (e) {}
  }
  /* 一键复制番号按钮（点击复制当前页识别到的番号） */
  const COPY_BTN = { short: '📋', bg: '#0ea5e9' };

  /* 互跳站配置（移植自 番号提取转换DSAI v2.0.0；2026-10-16 按站点改版更新）：
   * short = 按钮文字 / label = 站名 / bg = 按钮底色 / url = 搜索地址模板
   * 占位符：{code} = 番号（FANZA 的 key= 会自动转 FANZA 写法）；{title} = 当前页原名
   * missav 改路径式 /search/{code}（查询式 ?q= 已废）；
   * fanza 改 FANZA動画 video.dmm.co.jp/list/?key=（原通販站搜索页已废），
   * 且 key= 需 FANZA 写法（EBWH-346 → EBWH00346，jump 分支里过 fanzaCodeOf）；
   * mgs 按 2026-10-16 用户实测形态：cSearch.php?search_word= 原名搜索
   * （取不到原名时退回番号搜，MGS 也认番号）。
   * ⚠ bg 字段勿删：渲染处 roundCss(s.bg) 直接吃它，缺了按钮背景变 transparent（v1.3.35 踩过）。 */
  const JUMP_SITES = {
    javdb:  { short: 'DB', label: 'JAVDB',  bg: '#e74c3c', url: 'https://javdb.com/search?q={code}&f=all' },
    missav: { short: 'AV', label: 'MissAV', bg: '#ff6b9d', url: 'https://missav.ws/search/{code}' },
    motv:   { short: 'MT', label: 'MOTV',   bg: '#f39c12', url: 'https://motv.app/search?q={code}' },
    fanza:  { short: 'FZ', label: 'FANZA',  bg: '#1d4ed8', url: 'https://video.dmm.co.jp/list/?key={code}' },
    mgs:    { short: 'MG', label: 'MGS',    bg: '#0d9488', url: 'https://www.mgstage.com/search/cSearch.php?search_word={title}&x=56&y=17&search_shop_id=&type=top' }
  };
  /* 当前站 key：javdb / missav / motv / fanza / mgs；不在任何已配置站时返回 null（此时全部站都给跳转按钮） */
  function jumpSiteOf() {
    const h = location.hostname;
    if (/javdb/.test(h)) return 'javdb';
    if (/missav/.test(h)) return 'missav';
    if (/motv/.test(h)) return 'motv';
    if (/mgstage/.test(h)) return 'mgs';
    if (/dmm\.(co\.jp|com)$/.test(h) || /fanza\.jp$/.test(h)) return 'fanza';
    return null;
  }

  /* v1.3.51 A-03（P2）：队列自动开窗的前置校验。
     900ms 自动开窗定时器排下后，页面可能被 SPA 导航换掉（FANZA 站内点击影片链接，
     或站点自身跳转）：重排的定时器 firing 时 parseDetail 抓到的是新页面数据，而
     getCurrent() 还是队列里的旧番号——用户没想抓的影片被入库、队列账本错乱。
     校验「本页识别番号 == 队列当前项」才允许开窗；不一致就不开（用户仍可手动抓取，
     队列当前项留待下次满足条件时自动继续）。resultKey 口径与 findResultIndex 一致，
     容忍 DSOD-009/DSOD-9 前导零差异。返回 raw 供 openConfirmModal 作 preset，避免二次解析。 */
  function autoOpenAllowed(key) {
    const c = getCurrent();
    if (!c || !c.code) return null;
    let raw = null;
    try { raw = parseDetail(key); } catch (e) { return null; }
    const pageCode = (raw && raw.code) ? normCode(raw.code) : '';
    if (!pageCode) return null;
    if (resultKey({ code: pageCode }) !== resultKey({ code: c.code })) return null;
    return raw;
  }
  function injectCrawlerUI() {
    const key = currentSourceKey();
    if (!key) return;
    /* 注意：本函数是「让 UI 反映当前页面」，允许显式重建（SPA 换页、测试重入都靠它）；
       「盒子还活着就别重复建」是调用方策略——所有调用点都必须自行检查 #fl-box，
       见 main() 的兜底重试与 ensureBodyWatch/ensureHtmlWatch/保活三处（v1.3.55 补齐）。 */
    /* 检测旧版「FL爬虫」脚本是否仍在运行（双脚本会重复出现按钮） */
    const strayOld = $$('#fl-box').filter(b => b.getAttribute('data-fl-owner') && b.getAttribute('data-fl-owner') !== 'fl-spider').length;
    /* 防重复注入：先移除页面上全部（本脚本多次调用 / 旧版「FL爬虫」未卸载）的盒子，再重建唯一一个 */
    $$('#fl-box').forEach(dropBox);
    $$('#fl-generic-dom').forEach(dropBox);
    if (!document.body) { setTimeout(injectCrawlerUI, 300); return; }

    /* 队列进行中：先判断这一页有没有资料，没有就走「重排队尾重试一次」 */
    /* 队列进行中：先判断这一页有没有资料，没有就走「重排队尾重试一次」。
       只认 getCurrent()：旧写法把「队列残留但无进行项」也纳入判断，一旦该页 parseDetail
       取不到番号/标题就 return 不建盒子 —— 批量中断后队列残留在 GM 里，之后打开的每个
       页面都建不出按钮（cinema 页「没按钮」的元凶之一，v1.3.19 修）。 */
    if (getCurrent()) {
      if (pageLooksEmpty(key)) {
        handleFailure(isSearchPage() ? '搜索无结果' : '页面无资料（可能 404）');
        return;
      }
      // 队列跑到搜索页 → 按番号定位命中项，不再盲目打开第一条
      if (isSearchPage()) {
        const rs = parseSearchResults();
        if (rs.length) {
          const want = searchTargetCode();
          const at = findResultIndex(rs, want);
          if (at >= 0) {
            toast('搜索命中「' + want + '」，自动打开该条', 'ok');
            setTimeout(() => { jumpToUrl(rs[at].url); }, 800);
          } else if (rs.length === 1) {
            toast('搜索只有 1 条，自动打开', 'ok');
            setTimeout(() => { jumpToUrl(rs[0].url); }, 800);
          } else {
            toast('搜索 ' + rs.length + ' 条但没匹配到「' + (want || '?') + '」，请手动选一条', 'warn');
          }
          return;
        }
      }
    }

    const cfg2 = getCfg();
    const box = document.createElement('div');
    box.id = 'fl-box';
    box.setAttribute('data-fl-owner', 'fl-spider');   // 标记本脚本的盒子，去重时优先保留、并识别旧版「FL爬虫」
    /* 默认右侧竖排（避开 FANZA 的右下角迷你播放器 / MISSAV 右下角的复制番号按钮）
     * 可整块拖动，位置按站点记忆；双击复位回右侧。 */
    box.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:' + Z + ';display:flex;flex-direction:column;' +
      'gap:' + sPx(12, 3) + ';align-items:flex-end;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
      'pointer-events:auto;cursor:move;user-select:none;';
    /* v1.3.52：站点 CSS 免疫 —— 补内联未设的属性后整体升级为 important。
       div{padding/margin/border !important} 这类规则专打我们没设的属性（实测整盒被
       撑到 125×652），故这四个全部显式设 0 再升级。 */
    box.style.width = 'auto'; box.style.minWidth = '0'; box.style.maxWidth = 'none';
    box.style.fontSize = '13px'; box.style.lineHeight = '1.25';
    box.style.margin = '0'; box.style.padding = '0'; box.style.border = '0'; box.style.boxSizing = 'border-box';
    hardenStyle(box, BOX_HARD);
    box.title = '拖动可改变位置，双击复位到右侧';

    /* ---- 番号识别 + 互跳/复制按钮组（移植自 番号提取转换DSAI v2.0.0） ---- */
    const code = pageCodeForJump();
    /* 原名搜索站（MGS）的搜索词：详情页才取；搜索页的 og:title 是结果页标题（垃圾） */
    const title = isSearchPage() ? '' : pageTitleForJump(code);
    if (cfg2.jumpBtns) {
      if (code) {
        const tag = document.createElement('div');
        /* v1.3.52：sPx() 自带 px 单位——旧版又拼了个 'px ' 产出 "padding:2pxpx 4pxpx"，
           非法声明被 CSS 解析器静默丢弃：标签一直没有内边距，站点 div{padding!important} 也因此长驱直入 */
        tag.style.cssText = 'background:rgba(15,118,110,.94);color:#fff;padding:' + sPx(4, 1) + ' ' + sPx(8, 3) + ';' +
          'border-radius:' + sPx(6, 3) + ';font-size:' + sFs(12, 9) + ';font-weight:700;letter-spacing:.4px;';
        tag.style.width = 'auto'; tag.style.minWidth = '0'; tag.style.maxWidth = 'none'; tag.style.lineHeight = '1.25';
        tag.style.margin = '0'; tag.style.border = '0'; tag.style.boxSizing = 'border-box';
        hardenStyle(tag, TAG_HARD);
        tag.textContent = code;
        tag.title = '识别到的番号（点 📋 可复制）';
        box.appendChild(tag);
      }
      const row = document.createElement('div');
      row.id = 'fl-jump';
      row.style.cssText = 'display:flex;flex-direction:column;gap:' + sPx(14, 4) + ';align-items:flex-end;';
      row.style.width = 'auto'; row.style.minWidth = '0'; row.style.maxWidth = 'none';
      row.style.margin = '0'; row.style.padding = '0'; row.style.border = '0'; row.style.boxSizing = 'border-box';
      hardenStyle(row, ROW_HARD);
      const cur = jumpSiteOf();
      Object.keys(JUMP_SITES).forEach(k => {
        if (cur && k === cur) return;                    // 当前站不给跳自己的按钮
        const s = JUMP_SITES[k];
        const kw = s.url.indexOf('{title}') !== -1 ? (title || code) : code;   // MGS 按原名搜，其余按番号
        const b = document.createElement('button');
        b.textContent = s.short;
        b.style.cssText = roundCss(s.bg);
        hardBtn(b);
        b.setAttribute('data-fl-act', 'jump:' + k);
        b.setAttribute('data-fl-code', code);
        if (title) b.setAttribute('data-fl-title', title);
        b.title = '在 ' + s.label + ' 搜索：' + (kw || '(未识别到)');
        row.appendChild(b);
      });
      const cb = document.createElement('button');
      cb.textContent = COPY_BTN.short;
      cb.style.cssText = roundCss(COPY_BTN.bg);
      hardBtn(cb);
      cb.setAttribute('data-fl-act', 'copy');
      cb.setAttribute('data-fl-code', code);
      cb.title = '复制番号：' + (code || '(未识别到番号)');
      row.appendChild(cb);
      /* v1.3.67：库内查询按钮（互跳行末尾，圆形）——把识别到的番号发给 FL Server
         查 Film Library：一级来源显示「一」/二级「二」/库内无此片或用户自建「无」。
         注入后自动查一次；点击手动刷新；服务不在线显示「?」。 */
      const lb = document.createElement('button');
      lb.id = 'fl-lib-btn';
      lb.textContent = '查';
      lb.style.cssText = roundCss('#475569');
      hardBtn(lb);
      lb.setAttribute('data-fl-act', 'lib');
      lb.setAttribute('data-fl-code', code);
      lb.title = code ? ('查库：' + code + ' 在 Film Library 有没有（自动查询，点击刷新）') : '未识别到番号，无法查询';
      row.appendChild(lb);
      if (code) queryLibBtn(lb, code);
      box.appendChild(row);
      const hr = document.createElement('div');
      hr.style.cssText = 'width:100%;height:1px;background:rgba(150,150,150,.55);';
      hr.style.margin = '0'; hr.style.border = '0'; hr.style.padding = '0'; hr.style.minWidth = '0';
      hardenStyle(hr, HR_HARD);
      box.appendChild(hr);
    }

    /* ---- 抓取功能按钮（图标，无文字，右侧竖排）---- */
    const mk = (id, icon, bg, act, title) => {
      const b = document.createElement('button');
      b.id = id; b.innerHTML = ico(icon);
      b.title = title;
      b.style.cssText = iconBtnCss(bg);
      hardBtn(b);
      /* svg 的 width/height 是 HTML 属性（优先级最低），站点 svg{width:100%} 会吃掉它 → 升内联 */
      var _svg = b.querySelector('svg');
      if (_svg) { _svg.style.width = '62%'; _svg.style.height = '62%'; hardenStyle(_svg, ['width', 'height']); }
      b.setAttribute('data-fl-act', act);
      b.setAttribute('data-fl-key', key);
      box.appendChild(b);
      return b;
    };
    mk('fl-save-btn', 'save', '#1f9d55', 'save', '抓取：直接抓当前页并写入收件箱（不弹确认框）');
    mk('fl-confirm-btn', 'form', '#0f766e', 'confirm', '确认入库：打开编辑弹窗，核对 / 修改字段后再保存');

    mk('fl-queue-btn', 'queue', '#0891b2', 'queue', '批量队列：进度 / 待补全番号 / 服务状态');
    mk('fl-pending-btn', 'list', '#2563eb', 'pending', '批量：读取待补全番号并开始抓取');
    mk('fl-dom-btn', 'dom', '#7c3aed', 'dom', '导出当前页 DOM 样本 + #fl-box 尺寸诊断（选择器校准 / 观感偏差取数）');
    mk('fl-set-btn', 'gear', '#475569', 'settings', '设置');
    document.body.appendChild(box);

    applyBoxPos(box);
    makeBoxDraggable(box);
    counterBodyZoom(box);   /* v1.3.52：站点 zoom 整页缩放时反向抵消 */
    fitBoxToViewport(box);  /* v1.3.54：小视口按比例缩小（双站诊断：差异全在视口） */
    console.log('[FL Spider] ✅ 按钮已注入（站点=' + key + '，识别番号=' + (code || '无') + '）');
    /* 可见的启动信号：不用打开控制台也能确认脚本已运行（每页加载只弹一次） */
    if (!window.__flStartToast) {
      window.__flStartToast = 1;
      const lb = (cfg2.sources[key] && cfg2.sources[key].label) || key;
      toast('FL Spider v' + VERSION + ' 已启动 · 站点=' + lb, 'ok');
    }

    // 检测到旧版「FL爬虫」脚本仍在运行 → 提示用户停用它（节流 30s）
    if (strayOld && (!window.__flWarnedOld || Date.now() - window.__flWarnedOld > 30000)) {
      window.__flWarnedOld = Date.now();
      toast('⚠️ 检测到旧版「FL爬虫」脚本仍在运行，会重复出现按钮。请在 Tampermonkey 管理页停用/删除旧的「FL爬虫」，只保留「FL Spider」。', 'warn');
    }

    // 队列自动模式：进详情页自动抓取
    const q = getQueue();
    if (q.length && !isSearchPage()) {
      /* #29 断点续抓：队列还在但没有「当前项」（上次中断了）→ 接着跑，
         不要在当前这个无关页面上直接开抓取弹窗 */
      if (!getCurrent()) {
        /* v1.3.65 #9：先确认再续跑。旧版检测到队列残留就直接 setTimeout(nextInQueue, 1200)
           ——用户手动打开的任一影片页，1.2 秒后被强制跳走到队列 URL，页面上的操作
           被打断且没有取消机会（只有一个 toast）。 */
        let go = false;
        try { go = window.confirm('检测到未完成的批量队列（剩 ' + q.length + ' 个）。\n\n点「确定」继续抓取（页面将自动跳转）；点「取消」暂停，之后点盒子上的 📋 批量按钮手动继续。'); } catch (e) { go = true; }
        if (!go) { toast('已暂停自动续跑；想继续时点盒子上的「批量」按钮', 'ok'); return; }
        toast('检测到未完成的批量队列（剩 ' + q.length + ' 个），继续抓取…', 'ok');
        setTimeout(nextInQueue, 1200);
      } else {
        /* BUG-06：自动开窗定时器单例化——重复注入不再叠弹窗 */
        if (window.__flAutoOpen) clearTimeout(window.__flAutoOpen);
        window.__flAutoOpen = setTimeout(() => {
          window.__flAutoOpen = null;
          /* v1.3.51 A-03（P2）：页面可能已在 900ms 内被 SPA 导航换掉——先对账
             「本页就是队列当前项」，不是就不开窗（详见 autoOpenAllowed）。 */
          const raw2 = autoOpenAllowed(key);
          if (!raw2) return;
          if (raw2._diag) { warnStructure(key, raw2._diag); if (!raw2._diag.miss || !raw2._diag.miss.length) saveSig(key, raw2._diag); }
          toast('队列剩余 ' + q.length + ' 个，自动抓取中…', 'ok');
          openConfirmModal(key, raw2);
        }, 900);
      }
    }
    ensureBodyWatch();   // 把盒子观察器挂到当前（可能是新建的）body 上，抗 FANZA 替换
  }

  /* ==========================================================================
   * 广告清理（移植自 番号提取转换DSAI v2.0.0 的 startMissavAdBlocker）
   *   · 全站：移除 src 含广告关键词的 iframe
   *   · MissAV：额外清理右下角弹窗容器（先试着点关闭，点不掉就隐藏）
   * ======================================================================== */
  /* v1.3.58 #15：旧版 ['ad','ads',...] 是裸子串——src 里任何含 "ad" 的路径都中枪：
     javdb/missav/motv 的播放器/嵌入 iframe（…/loader、…/upload、shadow、read、header）
     被直接 remove() 且无还原路径（FANZA 有 isFanza 豁免，其他站没有）。改为「广告
     域名/路径段」形态匹配：ad/ads 必须是独立路径段或查询键（/ads/、?ad=、ad.html、
     _ad_），词中的 ad（download/shadow/header/loader/read）不再误伤。 */
  const AD_IFRAME_PATTERNS = [
    /(?:^|[\/_.?\-])ads?(?:[\/_.?\-]|$)/,                                                  /* ad / ads 独立段 */
    /(?:^|[\/_.?\-])ad(?:s|v|vert|vertisement|server|slot|box|frame|layer)(?:[\/_.?\-]|$)/i, /* adv/advert/adserver… */
    /doubleclick/i, /googlesyndication/i, /banner/i, /popup/i, /promo/i, /sponsor/i
  ];
  const AD_CLOSE_TEXTS = ['close', '关闭', '閉じる', 'fermer', 'schließen', '×', '✕', 'x'];
  const AD_CLOSE_SELECTORS = [
    '[class*="close"]', '[id*="close"]', '[aria-label*="close"]',
    '.ad-close', '.popup-close', '.dismiss', '.btn-close',
    'button[title*="关闭"]', 'button[aria-label*="关闭"]',
    'svg[class*="close"]', '.vjs-close-button'
  ];
  function tryClickClose(container) {
    for (const sel of AD_CLOSE_SELECTORS) {
      try {
        const btn = container.querySelector(sel);
        if (btn && !isOurs(btn)) { btn.click(); console.log('[FL Spider] 🧹 已点击广告关闭按钮'); return true; }
      } catch (e) {}
    }
    const nodes = container.querySelectorAll('*');
    for (const node of nodes) {
      if (isOurs(node)) continue;
      const txt = (node.textContent || '').trim().toLowerCase();
      /* v1.3.66 #17：裸 'x' 太宽——任何 textContent 恰为 "x" 的可见元素都会被 click()
         （"x" 在页面里常见，误伤范围虽限于已判定的广告容器内，仍属误点）。
         单字符且是字母时要求元素本身是关闭控件（button/a/[role=button] 或其子孙）；
         ×/✕ 等符号不设限（字形本身即关闭语义，不具备误伤面）。 */
      const isSym = /^[×✕✖]$/.test(txt);
      const btnLike = node.tagName === 'BUTTON' || node.tagName === 'A' || node.getAttribute('role') === 'button' ||
        (typeof node.closest === 'function' && node.closest('button, a[href], [role="button"]'));
      if (txt && AD_CLOSE_TEXTS.indexOf(txt) !== -1 && node.offsetParent !== null &&
          (isSym || txt.length > 1 || btnLike)) {
        node.click();
        console.log('[FL Spider] 🧹 已点击关闭图标：', txt);
        return true;
      }
    }
    return false;
  }
  function scanAds() {
    const isMissav = /missav/i.test(location.hostname);
    /* FANZA（dmm.co.jp / video.dmm.co.jp）的视频播放器常为 iframe，且内容番号形如 adn00789 含 "ad" 子串，
       朴素匹配会误删播放器导致「视频不显示」。FANZA 上不靠移除 iframe 清广告，故整段跳过以免误伤播放器。 */
    const isFanza = /(^|\.)dmm\.(co\.jp|com)$/i.test(location.hostname);
    document.querySelectorAll('iframe').forEach(f => {
      if (isOurs(f)) return;
      if (isFanza) return;   // 保护 FANZA 视频播放器 iframe
      const src = (f.src || '').toLowerCase();
      if (AD_IFRAME_PATTERNS.some(p => p.test(src))) {
        f.remove();
        console.log('[FL Spider] 🧹 移除广告 iframe：', src.slice(0, 90));
      }
    });
    if (!isMissav) return;   // 只在 MissAV 上动右下角容器，避免误伤 FANZA 迷你播放器
    /* v1.3.51 A-02（P2）：旧版只凭「fixed/absolute + 右下角 + ≥50×50」就 display:none——
       MissAV 站点原生的「复制番号」按钮同在右下角，被误伤后永久消失（用户无恢复手段）。
       新版双重收紧（误伤代价远大于漏一个广告，宁可留着）：
        ① 站点原生交互控件（button/a/input/[role=button]/[onclick]，含容器内的）
           或复制相关文案（复制/番号/copy/クリップ…）→ 一律不碰；
        ② 隐藏前必须有正向广告证据：类名/ID 分词命中广告词、或 z-index≥1000 的浮层、
           或内含 iframe；先试显式关闭按钮（tryClickClose 是用户可见的关闭，安全）。 */
    const AD_TOKENS = ['ad', 'ads', 'adv', 'advert', 'advertisement', 'adslot', 'adbox',
      'sponsor', 'popup', 'promo', 'banner', 'doubleclick', 'adframe', 'adlayer'];
    const NATIVE_UI_RE = /复制|番号|copied|copy|clipboard|クリップ|コピー/i;
    document.querySelectorAll('div, section, aside, article, iframe, span').forEach(el => {
      if (isOurs(el)) return;
      const st = getComputedStyle(el);
      if (st.position !== 'fixed' && st.position !== 'absolute') return;
      const r = el.getBoundingClientRect();
      if (r.width < 50 || r.height < 50) return;
      if (!(r.right >= window.innerWidth - 20 && r.bottom >= window.innerHeight - 80)) return;
      /* ① 站点原生交互控件不碰 */
      if (el.matches && el.matches('button, a, input, [role="button"], [onclick]')) return;
      if (el.querySelector && el.querySelector('button, a[href], input, [role="button"], [onclick]')) return;
      if (NATIVE_UI_RE.test(String((el.textContent || '')).slice(0, 300))) return;
      /* 先试显式关闭按钮 */
      if (tryClickClose(el)) return;
      /* ② 正向广告证据：类名/ID 分词命中、高 z-index 浮层、或内含 iframe */
      const toks = (String(el.className || '') + ' ' + String(el.id || ''))
        .split(/[^A-Za-z0-9]+/).filter(Boolean);
      const adTok = toks.some(t => AD_TOKENS.indexOf(t.toLowerCase()) !== -1);
      const z = parseInt(st.zIndex, 10);
      const adZ = (!isNaN(z) && z >= 1000);
      if (!adTok && !adZ && !(el.querySelector && el.querySelector('iframe'))) return;
      el.style.setProperty('display', 'none', 'important');
      console.log('[FL Spider] 🧹 已隐藏右下角广告容器：', el.id || el.className || el.tagName);
    });
  }
  function startAdBlocker() {
    if (!getCfgSafe().adBlock) return;
    /* v1.3.66 #30：首次扫描定时器也纳入 timer 管理（旧版裸 setTimeout 无引用，
       卸载时漏清）；beforeunload 里一并 clearTimeout——旧版只 disconnect 观察器。 */
    let timer = setTimeout(scanAds, 1200);
    let ob = null;
    try {
      ob = new MutationObserver(muts => {
        for (const m of muts) {
          if (m.addedNodes.length) { clearTimeout(timer); timer = setTimeout(scanAds, 800); break; }
        }
      });
      ob.observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (e) { ob = null; }
    window.addEventListener('beforeunload', () => {
      clearTimeout(timer);
      if (ob) { try { ob.disconnect(); } catch (e) {} }
    });
  }

  /* ==========================================================================
   * 主分流
   *   v0.2.0：导入端已删除 —— Film Library 已内置「读取收件箱」，
   *   爬虫只负责「写对格式」，不再重复实现导入。
   * ======================================================================== */
  /* 抗 FANZA 等 SPA 整体替换 document.body：盒子被移除或 body 被重建时，补回唯一一个
   * （injectCrawlerUI 内部已保证「先清掉全部、再建一个」，所以无论触发多少次都只有 1 个盒子） */
  function ensureBodyWatch() {
    if (!document.body) return;
    if (!window.__flBodyObs) {
      window.__flBodyObs = new MutationObserver(function () {
        if (!document.getElementById('fl-box') && currentSourceKey()) injectCrawlerUI();
      });
    }
    try { window.__flBodyObs.disconnect(); } catch (e) {}
    try { window.__flBodyObs.observe(document.body, { childList: true }); } catch (e) {}
  }
  function ensureHtmlWatch() {
    if (window.__flHtmlObs) return;
    window.__flHtmlObs = new MutationObserver(function () {
      // body 被整体替换：旧 body 观察器随之失效，重建并补回盒子
      window.__flBodyObs = null;
      ensureBodyWatch();
      if (!document.getElementById('fl-box') && currentSourceKey()) injectCrawlerUI();
    });
    try { window.__flHtmlObs.observe(document.documentElement, { childList: true }); } catch (e) {}
  }

  /* ==========================================================================
   * SPA 导航适配（v1.3.20）
   * --------------------------------------------------------------------------
   * FANZA（Next.js App Router）站内点击影片链接走客户端路由：URL 变、页面不刷新，
   * 油猴 content script 不会重跑 → 新"页面"的按钮盒被冲掉后补不回。
   * 劫持 history.pushState/replaceState + 监听 popstate，URL 一变就
   * injectCrawlerUI() 重建按钮盒（换页后盒子要反映新页面：番号/互跳/队列逻辑全变）。
   * 注意这里是有意重建、不是重复建盒——「盒子还活着就别建」的守卫在各调用方
   * （保活/观察器/兜底重试），不在本函数里。保活定时器里也会比对 URL，双保险。 */
  var __flLastUrl = location.href;
  function flOnSpaNav() {
    try {
      if (location.href === __flLastUrl) return;
      __flLastUrl = location.href;
      if (currentSourceKey()) injectCrawlerUI();
    } catch (e) {}
  }
  function hookSpaNav() {
    try {
      ['pushState', 'replaceState'].forEach(function (m) {
        const orig = history[m];
        if (typeof orig !== 'function') return;
        history[m] = function () {
          const r = orig.apply(this, arguments);
          setTimeout(flOnSpaNav, 80);
          return r;
        };
      });
      window.addEventListener('popstate', function () { setTimeout(flOnSpaNav, 80); });
    } catch (e) {}
  }

  function main() {
    /* ★ 按钮重复的真凶：FANZA 播放器是独立 iframe
     *   https://www.dmm.co.jp/service/digitalapi/-/html5_player/=/cid=xxx/
     * 该 URL 同样命中 @match https://www.dmm.co.jp/*，于是 iframe 内部也会注入一个 #fl-box。
     * 顶层与 iframe 是两个 document，各自只会看到「自己那一个」盒子，
     * 所以 dedupeBox() 永远判定「没有重复」—— 用户看到的却是右下角叠着两组按钮。
     * 修复：只在顶层窗口注入 UI；iframe 内一律清掉已有盒子并彻底退出
     *（不注入、不设 observer、不跑点击守卫，避免再误伤播放器导致看不了视频）。 */
    if (window.top !== window.self) {
      try {
        document.querySelectorAll('#fl-box').forEach(b => b.remove());
        document.querySelectorAll('#fl-generic-dom').forEach(b => b.remove());
        if (window.__flDedupe) { clearInterval(window.__flDedupe); window.__flDedupe = null; }
        if (window.__flBodyObs) { try { window.__flBodyObs.disconnect(); } catch (e) {} window.__flBodyObs = null; }
        if (window.__flHtmlObs) { try { window.__flHtmlObs.disconnect(); } catch (e) {} window.__flHtmlObs = null; }
      } catch (e) {}
      return;
    }
    const h = location.hostname;
    if (h === 'localhost' || h === '127.0.0.1') return;   // Film Library 页面：不注入任何东西
    /* 批量抓取中途离开页面（含队列自身的页面跳转）/ 关标签页：把内存批同步落 GM 备份。
       与既有备份合并（防连续批次互相覆盖）；整份超 GM 配额时退化为「去图元数据」，
       至少保住番号与文本字段（图可重抓）。恢复见 recoverBatchBackup（v1.3.43）。 */
    try {
      window.addEventListener('beforeunload', function () {
        try {
          if (!_inboxBatch || !_inboxBatch.length) return;
          let prev = [];
          try {
            const bk = JSON.parse(GM_getValue(BATCH_BK_KEY, 'null'));
            if (bk && bk.items && bk.items.length) prev = bk.items;
          } catch (e) {}
          const merged = prev.concat(_inboxBatch);
          try { GM_setValue(BATCH_BK_KEY, JSON.stringify({ savedAt: Date.now(), items: merged })); return; } catch (e) {}
          const slim = { savedAt: Date.now(), slim: true, items: merged.map(it => {
            const c = Object.assign({}, it);
            if (c.cover) c.cover = '';
            if (c.shots) c.shots = [];
            return c;
          }) };
          try { GM_setValue(BATCH_BK_KEY, JSON.stringify(slim)); } catch (e) {}
        } catch (e) {}
      });
    } catch (e) {}
    /* v1.3.58 #7：批量进行中（batchGet 有未完成项）→ 新页加载即重建内存批，
       否则第 2..N 条全走单条写，累积设计落空。放在 recoverBatchBackup 之前。 */
    resumeInboxBatchIfActive();
    /* 上次批量中断的备份恢复：无活动队列时才直接落收件箱（队列进行中留给 finishQueue 合并） */
    recoverBatchBackup();
    setupGlobalHandlers();
    startAdBlocker();
    startClickGuard();
    if (!currentSourceKey()) {
      // 未知站点：仍给一个「导出 DOM 样本」，方便配置新源
      const b = document.createElement('button');
      b.textContent = '\u{1F9E9} 导出 DOM 样本（配置 FL Spider）';
      b.id = 'fl-generic-dom';
      b.style.cssText = btnCss('#7c3aed', 'position:fixed;right:18px;bottom:18px;z-index:' + Z + ';');
      b.setAttribute('data-fl-act', 'gdom');
      document.body.appendChild(b);
      return;
    }
    /* 注入逻辑单独容错：extractCodeFromPage 等偶发抛错不能拖垮整个 main()
       （否则按钮盒、保活定时器全都不启动，用户完全失去爬虫功能，v1.3.21 修） */
    const safeInject = function () {
      try { injectCrawlerUI(); } catch (e) {
        try { console.error('[FL Spider] 注入失败：', e); } catch (_) {}
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { if (!document.getElementById('fl-box')) safeInject(); });
    } else safeInject();
    /* 兜底重试：SPA 晚渲染 / body 被替换时补一次。
       v1.3.55：这条注释从旧版起就写着「有 #fl-box 守卫，不会重复」，但守卫从来没
       出现在这里——injectCrawlerUI 是无条件删旧建新，于是每次页面加载后 1.2s/3s 都把
       盒子删掉重建：用户头两秒内的拖动/双击全部作废（拖拽拖到一半，指针事件持续写进
       已分离的旧节点，视觉上盒子不动），还白白重建 11 个按钮 + 重算位置/缩放。
       守卫按调用方策略补齐（与 ensureBodyWatch/保活两处同口径）。 */
    [1200, 3000].forEach(ms => setTimeout(function () {
      if (!document.getElementById('fl-box')) safeInject();
    }, ms));
    // 周期性去重：彻底杜绝按钮重复（兼容旧版「FL爬虫」脚本未卸载等场景）
    if (!window.__flDedupe) { window.__flDedupe = setInterval(dedupeBox, 800); }
    /* 保活：FANZA 这类 Next.js CSR 页面会整体替换 body / 走 SPA 路由切换，
       #fl-box 被冲掉后挂在旧节点上的 observer 可能失效 → 这里兜底周期性补回（先判存在，不会重复建盒） */
    if (!window.__flKeepAlive) {
      window.__flKeepAlive = setInterval(function () {
        try {
          flOnSpaNav();
          if (!currentSourceKey()) return;
          if (document.getElementById('fl-box')) return;
          injectCrawlerUI();
        } catch (e) {}
      }, 1500);
    }
    // FANZA 等 SPA 会整体替换 body：用 MutationObserver 在盒子被移除 / body 重建后补回唯一一个
    ensureHtmlWatch();
    ensureBodyWatch();
  }

  /* 兜底：main() 抛错时在页面弹错误提示（v1.3.27 起不再写标签页标题前缀），
     不用控制台也能看到「跑了但崩了」；启动 toast 看不到 = 油猴根本没加载脚本 */
  hookSpaNav();
  try {
    main();
  } catch (e) {
    try {
      toast('\u2716 FL Spider 启动失败：' + String((e && e.message) || e || '未知错误').slice(0, 40));
    } catch (_) {}
  }
})();
