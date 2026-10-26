// ==UserScript==
// @name         FL Ping（临时诊断用，用完可删）
// @namespace    https://github.com/your-name/fl-crawler
// @version      1.0.0
// @description  【临时诊断】极简脚本：不使用任何 GM 接口、不做任何抓取，只在标签页标题最前面加「【PING✓】」。
//   用途：判断油猴（Tampermonkey / Violentmonkey）到底有没有在 FANZA 页面上执行脚本。
//   ① 标题出现【PING✓】→ 油猴工作正常，问题在 FL Spider 本体；
//   ② 标题没有【PING✓】→ 油猴根本没在这个页面跑脚本（脚本未启用 / 未匹配 / 浏览器未放行），与 FL Spider 代码无关。
//   诊断结束后请在油猴里删除本脚本。
// @match        https://video.dmm.co.jp/*
// @match        https://www.dmm.co.jp/*
// @match        https://*.dmm.co.jp/*
// @match        https://fanza.jp/*
// @match        https://*.fanza.jp/*
// @grant        none
// @run-at       document-idle
// @noframes
// ==/UserScript==
(function () {
  'use strict';
  var MARK = '【PING✓】';
  function apply() {
    try {
      if (String(document.title || '').indexOf(MARK) === 0) return;
      document.title = MARK + (document.title || '');
    } catch (e) {}
  }
  apply();
  // 页面是客户端渲染（Next.js），标题会被重设，故持续校正
  setInterval(apply, 1500);
})();
