# Film Library & FL Spider

影片记录工作台（Film Library）与配套油猴爬虫（FL Spider）的源码备份。

## 版本

| 组件 | 版本 | 位置 |
|---|---|---|
| Film Library | v2.1.33 | `Film Library.html`（构建产物，浏览器直接打开即用） |
| FL Spider | v1.3.67 | `fl-crawler/FL Spider.user.js`（Tampermonkey 导入） |
| FL Server | v1.1.9 | `FL Server/server.js`（Node）/ `server.py`（Python）双端 HTTP 桥，127.0.0.1:8787 |

## 目录结构

- `Film Library.html` — 构建产物（页面本体）
- `_build/` — 源部件：`v2_app.js` / `v2_core.html` / `part_*.js` + 构建脚本 `build_v2.js`
- `FL Server/` — 双端桥服务（读 `G:\film library`）
- `fl-crawler/FL Spider.user.js` — 油猴爬虫主文件
- `output/` — 方案文档（仅顶层 `.md`）

## 重建 / 启动

```bash
# 重建页面（需 Node）
node _build/build_v2.js

# 起本地服务（二选一）
node "FL Server/server.js"
python -u "FL Server/server.py"

# 装爬虫：Tampermonkey → 导入 fl-crawler/FL Spider.user.js
```

## 数据说明

影片数据在 `G:\film library`（data-dir），视频在 `F:\Film Library F`（video-dir），**均不在此仓库内**。
恢复时把本仓库放回 `BT` 目录，按需配置 `FL Server/data-dir.txt` / `video-dir.txt` 即可。

## 已按 .gitignore 排除

- 测试套件 `_test/`（18M 回归资产）
- 旧备份 `_backup/`、运行日志 `logs/`
- WorkBuddy 本地记忆 `.workbuddy/`（含个人项目记忆）
- Spider 副本 / 备份 / 夹具、`output/` 中间产物
