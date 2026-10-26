'use strict';
/* patch_server_batch2.js — Server 第二批修复（v1.1.5，BUG-13/19/20/21/22）
 *   13  safe_name / safeName：挡 Windows 保留设备名（CON/NUL/COM1…）与尾随空格点
 *   19  413 前先排空请求体（否则残留字节腐蚀 keep-alive 上的下一个请求）
 *   20  支持 Transfer-Encoding: chunked（旧版当空体 → 含义不明的 500）
 *   21  /api/pending 畸形 body 不再静默清空队列（校验 codes 必须是数组）
 *   22  CORS 不再无差别 '*'：只对本机/同域/file:// 回显 ACAO（油猴不受 CORS 限制）
 * 纪律：唯一锚点替换（计数==1）→ 语法校验 → 行尾守恒
 */
const fs = require('fs');
const vm = require('vm');
const PJS = 'C:/Users/Li-ieng-ou/WorkBuddy/BT/FL Server/server.js';
const PPY = 'C:/Users/Li-ieng-ou/WorkBuddy/BT/FL Server/server.py';

/* ============ Python 端 ============ */
let py = fs.readFileSync(PPY, 'utf8');
const pyJobs = [
  { n: 'PY1 safe_name 保留名 + origin_allowed',
    f: "def safe_name(name):\n    n = os.path.basename(str(name or '').replace('\\\\', '/')).strip()\n    n = n.lstrip('.').replace('\\x00', '')\n    n = re.sub(r'[\\x01-\\x1f]', '', n)\n    if not n or len(n) > 200:\n        return None\n    return n",
    t: "# Windows 保留设备名：这类名字会被重定向到设备句柄，文件\"写入成功\"却根本不存在（BUG-13）\nWIN_RESERVED_NAMES = set(['CON', 'PRN', 'AUX', 'NUL'] +\n                         ['COM%d' % i for i in range(1, 10)] +\n                         ['LPT%d' % i for i in range(1, 10)])\n\n\ndef origin_allowed(origin):\n    \"\"\"CORS 白名单（BUG-22）：无 Origin（同域/非浏览器）、127.0.0.1、localhost、\n    file:// 页面（Origin: null）放行；其余来源不回 ACAO → 浏览器预检失败，\n    跨域网页既读不到数据也发不出写请求。油猴 GM_xmlhttpRequest 不走 CORS 检查。\"\"\"\n    if not origin:\n        return True\n    o = str(origin).strip()\n    if o == 'null':\n        return True\n    return bool(re.match(r'^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\])(:\\d+)?$', o, re.I))\n\n\ndef safe_name(name):\n    n = os.path.basename(str(name or '').replace('\\\\', '/')).strip()\n    n = n.lstrip('.').replace('\\x00', '')\n    n = re.sub(r'[\\x01-\\x1f]', '', n)\n    n = n.rstrip(' .')          # Windows 文件名不能以空格或点结尾\n    if not n or len(n) > 200:\n        return None\n    if n.split('.')[0].upper() in WIN_RESERVED_NAMES:\n        return None\n    return n" },
  { n: 'PY2 _cors 收紧',
    f: "    def _cors(self):\n        self.send_header('Access-Control-Allow-Origin', '*')\n        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')\n        self.send_header('Access-Control-Allow-Headers', 'Content-Type')",
    t: "    def _cors(self):\n        # v1.1.5 BUG-22：不再无差别回 '*'，只对本机/同域来源回显 ACAO\n        origin = self.headers.get('Origin')\n        if origin_allowed(origin):\n            self.send_header('Access-Control-Allow-Origin', origin if origin else '*')\n            self.send_header('Vary', 'Origin')\n        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')\n        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range')" },
  { n: 'PY3 _read_body 排空 + chunked',
    f: "        if getattr(self, '_body', None) is None:\n            length = int(self.headers.get('Content-Length') or 0)\n            if length > MAX_JSON_BODY:\n                raise ValueError('body too large')\n            self._body = self.rfile.read(length) if length else b''\n        if len(self._body) > limit:\n            raise ValueError('body too large')\n        return self._body",
    t: "        if getattr(self, '_body', None) is None:\n            te = (self.headers.get('Transfer-Encoding') or '').lower()\n            if 'chunked' in te:\n                self._body = self._read_chunked()\n            else:\n                length = int(self.headers.get('Content-Length') or 0)\n                if length > MAX_JSON_BODY:\n                    # v1.1.5 BUG-19：超限必须先把请求体读完再报 413，否则残留\n                    # 字节会被当成 keep-alive 上下一个请求的头部（连接腐蚀）\n                    self._drain_body(length)\n                    raise ValueError('body too large')\n                self._body = self.rfile.read(length) if length else b''\n        if len(self._body) > limit:\n            raise ValueError('body too large')\n        return self._body\n\n    def _drain_body(self, length):\n        \"\"\"排空请求体（413 时保住连接可用，v1.1.5 BUG-19）\"\"\"\n        try:\n            left = int(length or 0)\n            while left > 0:\n                b = self.rfile.read(min(65536, left))\n                if not b:\n                    break\n                left -= len(b)\n        except Exception:\n            self.close_connection = True\n\n    def _read_chunked(self):\n        \"\"\"解析 Transfer-Encoding: chunked（v1.1.5 BUG-20：旧版当空体 → 500）\"\"\"\n        out = bytearray()\n        try:\n            while True:\n                line = self.rfile.readline(65536)\n                if not line:\n                    break\n                try:\n                    size = int(line.strip().split(b';')[0], 16)\n                except ValueError:\n                    break\n                if size == 0:\n                    self.rfile.readline(65536)\n                    break\n                out += self.rfile.read(size)\n                self.rfile.read(2)\n                if len(out) > MAX_JSON_BODY:\n                    self.close_connection = True\n                    raise ValueError('body too large')\n        except ValueError:\n            raise\n        except Exception:\n            self.close_connection = True\n        return bytes(out)" },
  { n: 'PY4 /api/pending 校验',
    f: "            body = self._parse_json(self._read_body(1024 * 1024))\n            codes = [str(c) for c in (body.get('codes') or [])] if isinstance(body, dict) else []",
    t: "            body = self._parse_json(self._read_body(1024 * 1024))\n            # v1.1.5 BUG-21：畸形 body（非对象 / codes 非数组）旧版静默写成空队列\n            # 并返回 200 —— 用户的待抓清单被无声清空\n            if not isinstance(body, dict) or not isinstance(body.get('codes'), list):\n                self._err(400, 'codes must be an array')\n                return\n            codes = [str(c) for c in body['codes']]" },
  { n: 'PY5 bump', f: "VERSION = '1.1.4'", t: "VERSION = '1.1.5'" }
];
for (const p of pyJobs) {
  const c = py.split(p.f).length - 1;
  if (c !== 1) { console.log('FAIL ' + p.n + ' 计数=' + c); process.exit(1); }
  py = py.replace(p.f, () => p.t);
  console.log('OK   ' + p.n);
}
fs.writeFileSync(PPY, py);

/* ============ Node 端 ============ */
let js = fs.readFileSync(PJS, 'utf8');
const hadCrlf = /\r\n/.test(js);
js = js.replace(/\r\n/g, '\n');
const jsJobs = [
  { n: 'JS1 safeName 保留名 + originAllowed',
    f: "/* 文件名净化：只要 basename，拒绝对目录逃逸 */\nfunction safeName(name) {\n  let n = path.basename(String(name || '').replace(/\\\\/g, '/')).trim();\n  n = n.replace(/^\\.+/, '').replace(/[\\x00-\\x1f]/g, '');\n  if (!n || n.length > 200) return null;\n  return n;\n}",
    t: "/* Windows 保留设备名：写入会被重定向到设备句柄，文件\"上传成功\"却不存在（BUG-13） */\nconst WIN_RESERVED_NAMES = new Set(['CON', 'PRN', 'AUX', 'NUL',\n  ...Array.from({ length: 9 }, (_, i) => 'COM' + (i + 1)),\n  ...Array.from({ length: 9 }, (_, i) => 'LPT' + (i + 1))]);\n/* 文件名净化：只要 basename，拒绝对目录逃逸 */\nfunction safeName(name) {\n  let n = path.basename(String(name || '').replace(/\\\\/g, '/')).trim();\n  n = n.replace(/^\\.+/, '').replace(/[\\x00-\\x1f]/g, '');\n  n = n.replace(/[ .]+$/, '');          // Windows 文件名不能以空格或点结尾\n  if (!n || n.length > 200) return null;\n  if (WIN_RESERVED_NAMES.has(n.split('.')[0].toUpperCase())) return null;\n  return n;\n}\n/* CORS 白名单（BUG-22）：无 Origin（同域/非浏览器）、127.0.0.1、localhost、\n   file:// 页面（Origin: null）放行；其余来源不回 ACAO → 浏览器预检失败，\n   跨域网页读不到数据也发不出写请求。油猴 GM_xmlhttpRequest 不走 CORS 检查。 */\nfunction originAllowed(origin) {\n  if (!origin) return true;\n  const o = String(origin).trim();\n  if (o === 'null') return true;\n  return /^https?:\\/\\/(127\\.0\\.0\\.1|localhost|\\[::1\\])(:\\d+)?$/i.test(o);\n}" },
  { n: 'JS2 cors 收紧',
    f: "function cors(res) {\n  res.setHeader('Access-Control-Allow-Origin', '*');\n  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');\n  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');\n}",
    t: "function cors(res, req) {\n  const origin = req && req.headers && req.headers.origin;\n  if (originAllowed(origin)) {\n    res.setHeader('Access-Control-Allow-Origin', origin || '*');\n    res.setHeader('Vary', 'Origin');\n  }\n  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');\n  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');\n}" },
  { n: 'JS3 cors 调用传 req',
    f: "  cors(res);\n  if (req.method === 'OPTIONS')",
    t: "  cors(res, req);\n  if (req.method === 'OPTIONS')" },
  { n: 'JS4 bump', f: "const VERSION = '1.1.4';", t: "const VERSION = '1.1.5';" }
];
for (const p of jsJobs) {
  const c = js.split(p.f).length - 1;
  if (c !== 1) { console.log('FAIL ' + p.n + ' 计数=' + c); process.exit(1); }
  js = js.replace(p.f, () => p.t);
  console.log('OK   ' + p.n);
}
try { new vm.Script(js.replace(/^#!.*/, '')); } catch (e) { console.log('FAIL JS 语法: ' + e.message); process.exit(1); }
if (js.indexOf('\uFFFD') >= 0) { console.log('FAIL U+FFFD'); process.exit(1); }
if (hadCrlf) js = js.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
fs.writeFileSync(PJS, js);
console.log('DONE server.js / server.py 已写入（v1.1.5）');
