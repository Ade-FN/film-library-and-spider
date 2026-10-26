'use strict';
/* patch_server_report.js — 新增 /api/report（v1.1.6）
 *   用途：FL Spider 批量抓取报告写进数据目录 reports/ 子目录。
 *   背景（BUG-14）：没有通用写 JSON 的接口，Spider 的 batchWriteReport 只能走
 *   文件夹写入 → 无条件 ensureFolder() 在 HTTP 在线时也会突然弹授权框，
 *   用户取消即报告静默丢失。/api/backup 不能复用：它会把内容重写成
 *   {app,version,updatedAt,rows}，报告的 success/failed/detail 会被吃掉。
 */
const fs = require('fs');
const vm = require('vm');
const PJS = 'C:/Users/Li-ieng-ou/WorkBuddy/BT/FL Server/server.js';
const PPY = 'C:/Users/Li-ieng-ou/WorkBuddy/BT/FL Server/server.py';

/* ---- Node ---- */
let js = fs.readFileSync(PJS, 'utf8');
const hadCrlf = /\r\n/.test(js);
js = js.replace(/\r\n/g, '\n');
const jsAnchor = "      sendJson(res, 200, { ok: true, name });\n      return;\n    }\n";
const jsBlock = jsAnchor +
  "\n    /* ---- 抓取报告（FL Spider 批量汇总；v1.1.6 BUG-14） ----\n" +
  "       通用 JSON 落盘：内容原样保存（/api/backup 会重写成 rows 结构，不能用）。 */\n" +
  "    if (req.method === 'POST' && pathname === '/api/report') {\n" +
  "      const dataDir = getDataDir();\n" +
  "      if (!dataDir) { sendErr(res, 409, 'data dir not configured'); return; }\n" +
  "      const body = parseJsonBuf(await readBody(req, MAX_JSON_BODY));\n" +
  "      const name = safeName(body && body.name);\n" +
  "      if (!name || !/\\.json$/i.test(name)) { sendErr(res, 400, 'bad report name'); return; }\n" +
  "      const payload = (body && body.payload !== undefined) ? body.payload : null;\n" +
  "      if (payload === null) { sendErr(res, 400, 'payload required'); return; }\n" +
  "      const rel = 'reports/' + name;\n" +
  "      await withWriteLock(() => {\n" +
  "        fs.mkdirSync(path.join(dataDir, 'reports'), { recursive: true });\n" +
  "        writeTextAtomic(path.join(dataDir, rel), JSON.stringify(payload, null, 2));\n" +
  "      });\n" +
  "      sendJson(res, 200, { ok: true, path: rel });\n" +
  "      return;\n" +
  "    }\n";
{
  const c = js.split(jsAnchor).length - 1;
  if (c !== 1) { console.log('FAIL js anchor 计数=' + c); process.exit(1); }
  js = js.replace(jsAnchor, () => jsBlock);
}
{
  const c = js.split("const VERSION = '1.1.5';").length - 1;
  if (c !== 1) { console.log('FAIL js version 计数=' + c); process.exit(1); }
  js = js.replace("const VERSION = '1.1.5';", () => "const VERSION = '1.1.6';");
}
try { new vm.Script(js); } catch (e) { console.log('FAIL js 语法: ' + e.message); process.exit(1); }
if (hadCrlf) js = js.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
fs.writeFileSync(PJS, js);
console.log('OK   server.js /api/report + v1.1.6');

/* ---- Python ---- */
let py = fs.readFileSync(PPY, 'utf8');
const pyAnchor = "            self._json(200, {'ok': True, 'name': name})\n            return\n";
const pyBlock = pyAnchor +
  "\n        # ---- 抓取报告（FL Spider 批量汇总；v1.1.6 BUG-14） ----\n" +
  "        # 通用 JSON 落盘：内容原样保存（/api/backup 会重写成 rows 结构，不能用）\n" +
  "        if path == '/api/report':\n" +
  "            data_dir = get_data_dir()\n" +
  "            if not data_dir:\n" +
  "                self._err(409, 'data dir not configured')\n" +
  "                return\n" +
  "            body = self._parse_json(self._read_body(MAX_JSON_BODY))\n" +
  "            name = safe_name(body.get('name')) if isinstance(body, dict) else None\n" +
  "            if not name or not name.lower().endswith('.json'):\n" +
  "                self._err(400, 'bad report name')\n" +
  "                return\n" +
  "            payload = body.get('payload') if isinstance(body, dict) else None\n" +
  "            if payload is None:\n" +
  "                self._err(400, 'payload required')\n" +
  "                return\n" +
  "            rel = 'reports/' + name\n" +
  "            with WRITE_LOCK:\n" +
  "                out_dir = os.path.join(data_dir, 'reports')\n" +
  "                if not os.path.isdir(out_dir):\n" +
  "                    os.makedirs(out_dir, exist_ok=True)\n" +
  "                write_text_atomic(os.path.join(data_dir, rel),\n" +
  "                                  json.dumps(payload, ensure_ascii=False, indent=2))\n" +
  "            self._json(200, {'ok': True, 'path': rel})\n" +
  "            return\n";
{
  const c = py.split(pyAnchor).length - 1;
  if (c !== 1) { console.log('FAIL py anchor 计数=' + c); process.exit(1); }
  py = py.replace(pyAnchor, () => pyBlock);
}
{
  const c = py.split("VERSION = '1.1.5'").length - 1;
  if (c !== 1) { console.log('FAIL py version 计数=' + c); process.exit(1); }
  py = py.replace("VERSION = '1.1.5'", () => "VERSION = '1.1.6'");
}
fs.writeFileSync(PPY, py);
console.log('OK   server.py /api/report + v1.1.6');
