#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FL Server · Film Library 本地服务（Python 备服务，零第三方依赖，3.8+）

与 server.js（Node 主服务）功能完全等价：同一套 HTTP 契约、同一套原子写、
同一套收件箱去重规则。启动 Film Library.cmd 会优先用 node，找不到再用本脚本。

契约详见 server.js 头部注释。数据目录由 data-dir.txt 指定。

v1.1.1：修 /api/videos 抛 NameError（urllib.parse 漏导入 quote）→ Video 页列不出视频、
无法播放；quote 同时收紧为 safe=''，与 Node 的 encodeURIComponent 行为一致。
"""
import json
import os
import re
import sys
import threading
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote, quote

# v1.1.8（附录批次 6）：A-15 _send_file 分块流式（不再整文件读内存）/ A-16 对拍
# Node error 监听 / A-17 配置 GBK 回退解码 / A-18 双端错误码对齐（400/403/404、
# 码点序、损坏收件箱拒绝导入）/ A-19 原子写 fsync / A-20 socket 超时 + 负 CL 守卫。
VERSION = '1.1.12'
PORT_FIRST = 8787
PORT_LAST = 8796
HERE = os.path.dirname(os.path.abspath(__file__))

APP_DEFAULT = os.path.join(HERE, '..', 'Film Library.html')
APP_OVERRIDE_FILE = os.path.join(HERE, 'app-file.txt')
DATA_DIR_FILE = os.path.join(HERE, 'data-dir.txt')
VIDEO_DIR_FILE = os.path.join(HERE, 'video-dir.txt')

MAIN_FILE = 'Film Library.json'
MAIN_FILE_OLD = '影片档案馆.json'
INBOX_FILE = 'Film Library 收件箱.json'
INBOX_DONE = 'Film Library 收件箱_已导入.json'
PENDING_FILE = 'Film Library 待补全番号.json'
META_FILE = 'meta.json'

MAX_JSON_BODY = 128 * 1024 * 1024
MAX_UPLOAD_BODY = 128 * 1024 * 1024

MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm',
    '.ogg': 'video/ogg', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
}
VIDEO_EXT = ['.mp4', '.webm', '.ogg', '.mov', '.mkv', '.avi', '.flv', '.ts', '.wmv']

WRITE_LOCK = threading.Lock()


# ---------------------------------------------------------------- 文件工具
# v1.1.10 #2：单文件读入上限（64MB，与 Node 端 MAX_TEXT_BYTES 一致）。
# 收件箱归档长期累积可达数百 MB（实测 866MB），整读会把数 GB 吃进内存，
# 且与 Node 端「读不动就降级」的行为不一致。超过门限按读不到返回 None。
MAX_TEXT_BYTES = 64 * 1024 * 1024


def file_too_large(p):
    try:
        return os.path.isfile(p) and os.path.getsize(p) > MAX_TEXT_BYTES
    except Exception:
        return False


def read_text(p):
    # v1.1.8 A-17：配置文件可能被记事本另存为 GBK/ANSI。旧版 utf8 严格解码失败
    # 直接返回 None → 全端 409「data dir not configured」（Node 端则是静默替换
    # 字符后报乱码路径）。现在 utf-8 失败回退 GBK，两端行为对齐。
    try:
        if file_too_large(p):
            return None
        with open(p, 'rb') as f:
            raw = f.read()
    except Exception:
        return None
    try:
        for enc in ('utf-8', 'gbk'):
            try:
                return raw.decode(enc)
            except UnicodeDecodeError:
                continue
        return raw.decode('utf-8', 'replace')
    except Exception:
        return None


def clean_path_text(s):
    if s is None:
        return ''
    s = str(s).lstrip('\ufeff').strip()
    if len(s) >= 2 and s.startswith('"') and s.endswith('"'):
        s = s[1:-1].strip()
    return s


def write_text_atomic(p, text):
    d = os.path.dirname(p)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = '%s.tmp-%d-%s' % (p, os.getpid(), os.urandom(4).hex())
    with open(tmp, 'w', encoding='utf-8', newline='') as f:   # 无 BOM
        f.write(text)
        f.flush()
        os.fsync(f.fileno())          # v1.1.8 A-19：内容落盘后再 rename
    os.replace(tmp, p)                                        # 同卷替换 ≈ 原子


def write_buf_atomic(p, buf):
    d = os.path.dirname(p)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = '%s.tmp-%d-%s' % (p, os.getpid(), os.urandom(4).hex())
    with open(tmp, 'wb') as f:
        f.write(buf)
        f.flush()
        os.fsync(f.fileno())          # v1.1.8 A-19：同上
    os.replace(tmp, p)


def safe_join(base, rel):
    if not base:
        return None
    r = str(rel or '').replace('\\', '/').lstrip('/')
    if not r or '..' in r.split('/'):
        return None
    abs_ = os.path.realpath(os.path.join(base, r))
    b = os.path.realpath(base)
    if abs_ != b and not abs_.startswith(b + os.sep):
        return None
    return abs_


# Windows 保留设备名：这类名字会被重定向到设备句柄，文件"写入成功"却根本不存在（BUG-13）
WIN_RESERVED_NAMES = set(['CON', 'PRN', 'AUX', 'NUL'] +
                         ['COM%d' % i for i in range(1, 10)] +
                         ['LPT%d' % i for i in range(1, 10)])


def origin_allowed(origin):
    """CORS 白名单（BUG-22）：无 Origin（同域/非浏览器）、127.0.0.1、localhost、
    file:// 页面（Origin: null）放行；其余来源不回 ACAO → 浏览器预检失败，
    跨域网页既读不到数据也发不出写请求。油猴 GM_xmlhttpRequest 不走 CORS 检查。"""
    if not origin:
        return True
    o = str(origin).strip()
    if o == 'null':
        return True
    return bool(re.match(r'^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$', o, re.I))


def safe_name(name):
    n = os.path.basename(str(name or '').replace('\\', '/')).strip()
    n = n.lstrip('.').replace('\x00', '')
    n = re.sub(r'[\x01-\x1f]', '', n)
    n = n.rstrip(' .')          # Windows 文件名不能以空格或点结尾
    if not n or len(n) > 200:
        return None
    if n.split('.')[0].upper() in WIN_RESERVED_NAMES:
        return None
    return n


def get_data_dir():
    return clean_path_text(read_text(DATA_DIR_FILE))


def get_video_dir():
    v = clean_path_text(read_text(VIDEO_DIR_FILE))
    return v or get_data_dir()


def get_app_file():
    o = clean_path_text(read_text(APP_OVERRIDE_FILE))
    if o:
        return o if os.path.isabs(o) else os.path.join(HERE, o)
    return APP_DEFAULT


# ---------------------------------------------------------------- 番号归一化（与 server.js / FL Spider 一致）
def pad_key(code):
    s = str('' if code is None else code).strip().upper()
    # v1.1.7 BUG-30：re.ASCII —— Python 的 \d 默认匹配全角数字，JS 的 \d 只认 ASCII；
    # 两端对含全角数字的番号归一化结果会不同（dedupe 归并到不同桶 → 收件箱内容随端点漂移）
    m = re.match(r'^([A-Z]+)-?0*(\d+)$', s, re.ASCII)
    if m:
        return m.group(1) + '-' + str(int(m.group(2)))
    return s


def digit_len(code):
    # v1.1.7 BUG-30：re.ASCII —— Python 的 \d 默认会匹配全角数字，
    # JS 的 \d 只认 ASCII，两端对全角番号打分会不同（dedupe 结果随端点漂移）
    # v1.1.11 #24：与 Node 端一致——先 strip 再匹配（两端都用各自 trim/strip
    # 去掉统一的空白集合），消除 re.ASCII 造成的 \s 语义差异
    m = re.search(r'(\d+)\s*$', str('' if code is None else code).strip(), re.ASCII)
    return len(m.group(1)) if m else 0


# ---------------------------------------------------------------- 来源分级（v1.1.3，与 server.js / FL Spider v1.3.45 一致；FC2 计一级）
TIER1_PLATFORMS = ['FANZA', 'MGS', 'FC2']


def is_fc2_code(v):
    return re.search(r'FC2[- ]PPV[- ]\d{3,10}', str('' if v is None else v), re.I | re.ASCII) is not None


def tier_of_item(it):
    """来源层级：优先 srcTier 字段；旧来料按 FC2 番号 / platform 标签推断"""
    if not isinstance(it, dict):
        return 0
    if it.get('srcTier') in (1, 2):
        return it['srcTier']
    if is_fc2_code(it.get('code')):
        return 1                      # FC2 番号一律一级（官方卖家本人）
    p = str(it.get('platform') or '').upper()
    if p in TIER1_PLATFORMS:
        return 1
    return 2 if p else 0              # 无层级信息的旧来料不占档


# 图片有效性判定（v1.1.7 BUG-30）：与 server.js 的 hasImg 严格同义——
# 字符串非空 / 对象至少有一个非空值；空字符串、空对象都算「没有图」
def _has_img(v):
    if isinstance(v, str):
        return bool(v.strip())
    if isinstance(v, dict):
        # v1.1.11 #25：同 score_item，假值不能当空
        return any(x is not None and str(x).strip() for x in v.values())
    return bool(v)


def score_item(it):
    if not isinstance(it, dict):
        return -1
    n = 0
    # v1.1.3：对齐 FL Spider v1.3.40 十字段字段体系——tags/releaseSale/releaseStream 已废
    for k in ('title', 'titleCn', 'actorF', 'actorM', 'actor', 'maker', 'release', 'magnet'):
        # v1.1.11 #25：与 Node 端一致——只看「非 None 且去空白非空」。
        # 旧版用 or '' 把 0 / false 当空，与 Node 的 ==null 判定差 1 分
        v = it.get(k)
        if v is not None and str(v).strip():
            n += 1
    if _has_img(it.get('cover')):
        n += 2
    if isinstance(it.get('shots'), list) and it['shots']:
        n += 2
    # 来源层级作第一排序键：一级 2000 / 二级 1000，档位差远大于字段分上限（~12）
    t = tier_of_item(it)
    if t == 1:
        n += 2000
    elif t == 2:
        n += 1000
    return n


def dedupe_inbox(items):
    buckets, at = [], {}
    for it in (items or []):
        k = pad_key(it.get('code')) if isinstance(it, dict) and it.get('code') else ('#%d' % len(buckets))
        if k not in at:
            at[k] = len(buckets)
            buckets.append(it)
            continue
        cur = buckets[at[k]]
        a, b = score_item(it), score_item(cur)
        if a > b or (a == b and digit_len(it.get('code')) > digit_len(cur.get('code'))):
            buckets[at[k]] = it
    return buckets


def parse_inbox(txt):
    """返回 list；文件损坏返回 None（与「空」区分）"""
    if not txt:
        return []
    try:
        p = json.loads(txt.lstrip('\ufeff'))
        if isinstance(p, list):
            return p
        if isinstance(p, dict) and isinstance(p.get('items'), list):
            return p['items']
        return []
    except Exception:
        return None


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def inbox_payload(items):
    return json.dumps({'app': 'Film Library', 'type': 'inbox', 'source': 'fl-spider',
                       'updatedAt': now_iso(),
                       'items': items}, ensure_ascii=False, indent=2)


def count_films(data_dir):
    txt = read_text(os.path.join(data_dir, MAIN_FILE)) or read_text(os.path.join(data_dir, MAIN_FILE_OLD))
    if not txt:
        return 0
    try:
        p = json.loads(txt.lstrip('\ufeff'))
        return len(p['rows']) if isinstance(p.get('rows'), list) else 0
    except Exception:
        return -1


# ---------------------------------------------------------------- Range
def parse_range(header, size):
    m = re.match(r'^bytes=(\d*)-(\d*)$', str(header or ''))
    if not m:
        return None
    if m.group(1) == '':
        if m.group(2) == '':
            return None
        n = int(m.group(2))
        if not n:
            return None
        start, end = max(0, size - n), size - 1
    else:
        start = int(m.group(1))
        end = size - 1 if m.group(2) == '' else int(m.group(2))
    if start > end or start >= size:
        return None
    return start, min(end, size - 1)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'FLServer/' + VERSION
    # v1.1.8 A-20：连接 socket 读超时（秒）。默认 None = 永不到期——客户端把
    # 连接挂住不关时，ThreadingHTTPServer 的该连接线程永远阻塞在 rfile 上，
    # 累积下去拖垮服务。到期时 BaseHTTPRequestHandler 会优雅关闭连接。
    timeout = 120

    def send_error(self, code, message=None, explain=None):
        # v1.1.2：基类默认回 HTML 错误页（<!DOCTYPE HTML PUBLIC...），前端
        # r.json() 只会抛 "Unexpected token '<'"。统一改回 JSON，让页面能显示
        # 可读错误（含 501 Unsupported method 这类协议层错误）。
        ver = getattr(self, 'request_version', 'HTTP/0.9')
        if ver not in ('HTTP/1.0', 'HTTP/1.1'):
            return BaseHTTPRequestHandler.send_error(self, code, message, explain)
        try:
            self.close_connection = True
            self._json(code, {'ok': False, 'error': str(message or code)}, close=True)
        except Exception:
            pass

    def handle_one_request(self):
        # v1.1.8 A-18：每个请求重置 body 缓存。do_POST 入口原有的重置只覆盖
        # POST；PUT/DELETE 等非 POST 方法复用同一 keep-alive 连接时会拿到上
        # 一个 POST 请求的缓存体，当前请求的真实 body 留在 rfile 里，下一个
        # 请求行被拼成 "{}DELETE /api/data HTTP/1.1" → 畸形 method → 501
        # （r23 绿源二轮实测铁证）。在协议层重置可覆盖所有方法。
        self._body = None
        return BaseHTTPRequestHandler.handle_one_request(self)

    # 静默访问日志（用户不需要看）
    def log_message(self, fmt, *args):
        pass

    # ---------------------------------------------------------- 基础
    def _cors(self):
        # v1.1.5 BUG-22：不再无差别回 '*'，只对本机/同域来源回显 ACAO
        origin = self.headers.get('Origin')
        if origin_allowed(origin):
            self.send_header('Access-Control-Allow-Origin', origin if origin else '*')
            self.send_header('Vary', 'Origin')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range')

    def _json(self, code, obj, close=False):
        b = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(b)))
        if close:
            self.send_header('Connection', 'close')
        self.send_header('Cache-Control', 'no-store')
        self._cors()
        self.end_headers()
        # v1.1.8 A-18：HEAD 请求不得带响应体。Node 的 http server 自动抑制，
        # BaseHTTPRequestHandler 没这个智能——客户端按 HEAD 语义不读 body，
        # 残留字节留在 keep-alive 连接里，下一个请求响应解析直接炸
        # （HPE_INVALID_CONSTANT，r23 实测）。Content-Length 按 HTTP 语义保留。
        if self.command != 'HEAD':
            self.wfile.write(b)

    def _err(self, code, msg):
        self._json(code, {'ok': False, 'error': msg})

    def _html(self, code, html):
        b = html.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(b)))
        self.send_header('Cache-Control', 'no-store')
        self._cors()
        self.end_headers()
        if self.command != 'HEAD':      # v1.1.8 A-18：同上（HEAD 不带响应体）
            self.wfile.write(b)

    def _read_body(self, limit):
        # v1.1.2：请求体只读一次并缓存。_route_post 入口已无条件排空 body，
        # 各路由重复调用时取同一份缓存（否则第二次会读到 0 字节）。
        # 这是 keep-alive 连接腐蚀的根治点，详见 _route_post 顶部注释。
        if getattr(self, '_body', None) is None:
            te = (self.headers.get('Transfer-Encoding') or '').lower()
            if 'chunked' in te:
                self._body = self._read_chunked()
            else:
                try:
                    length = int(self.headers.get('Content-Length') or 0)
                except ValueError:
                    # v1.1.8 A-20：畸形 Content-Length——连接已无法安全复用
                    self.close_connection = True
                    raise ValueError('bad content-length')
                if length < 0:
                    # v1.1.8 A-20：负 Content-Length。rfile.read(负数) 在
                    # BufferedReader 上抛 ValueError → 500；更糟的是异常路径不关
                    # 连接，keep-alive 上后续请求被腐蚀成 501（r23 实测铁证）。
                    # 显式拒绝 + 关连接，与 Node 端 http parser 的 400 对齐。
                    self.close_connection = True
                    raise ValueError('bad content-length')
                if length > MAX_JSON_BODY:
                    # v1.1.5 BUG-19：超限必须先把请求体读完再报 413，否则残留
                    # 字节会被当成 keep-alive 上下一个请求的头部（连接腐蚀）
                    self._drain_body(length)
                    raise ValueError('body too large')
                self._body = self.rfile.read(length) if length else b''
        if len(self._body) > limit:
            raise ValueError('body too large')
        return self._body

    def _drain_body(self, length):
        """排空请求体（413 时保住连接可用，v1.1.5 BUG-19）"""
        try:
            left = int(length or 0)
            while left > 0:
                b = self.rfile.read(min(65536, left))
                if not b:
                    break
                left -= len(b)
        except Exception:
            self.close_connection = True

    def _read_chunked(self):
        """解析 Transfer-Encoding: chunked（v1.1.5 BUG-20：旧版当空体 → 500）"""
        out = bytearray()
        try:
            while True:
                line = self.rfile.readline(65536)
                if not line:
                    break
                try:
                    size = int(line.strip().split(b';')[0], 16)
                except ValueError:
                    break
                if size == 0:
                    self.rfile.readline(65536)
                    break
                out += self.rfile.read(size)
                self.rfile.read(2)
                if len(out) > MAX_JSON_BODY:
                    self.close_connection = True
                    raise ValueError('body too large')
        except ValueError:
            raise
        except Exception:
            self.close_connection = True
        return bytes(out)

    def _parse_json(self, buf):
        return json.loads(buf.decode('utf-8').lstrip('\ufeff'))

    def _send_file(self, abs_):
        """发送数据目录/视频目录里的文件（支持 Range；/data/ 与 /video/ 共用）"""
        if not abs_ or not os.path.isfile(abs_):
            self._err(404, 'not found')
            return
        size = os.path.getsize(abs_)
        ext = os.path.splitext(abs_)[1].lower()
        mime = MIME.get(ext, 'application/octet-stream')
        rng = parse_range(self.headers.get('Range'), size)
        # v1.1.8 A-15：分块流式发送。旧版 data = f.read() 把整个文件读进内存——
        # Video 页播放 4GB 视频直接 MemoryError（Node 端 createReadStream 无此问题）。
        CHUNK = 256 * 1024
        try:
            with open(abs_, 'rb') as f:
                if rng:
                    start, end = rng
                    f.seek(start)
                    left = end - start + 1
                    self.send_response(206)
                    self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
                else:
                    left = size
                    self.send_response(200)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(left))
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('Cache-Control', 'no-cache')
                self._cors()
                self.end_headers()
                while left > 0:
                    b = f.read(min(CHUNK, left))
                    if not b:
                        break
                    self.wfile.write(b)
                    left -= len(b)
        except BrokenPipeError:
            # 客户端中途断开（拖动进度条/切走页面）：正常现象，不是服务端错误
            self.close_connection = True

    # ---------------------------------------------------------- 未实现的方法
    def _method_not_found(self):
        # v1.1.8 A-18：BaseHTTPRequestHandler 默认对缺失的 do_XXX 回 501；
        # Node 主端对任何未匹配路由的请求一律 404 JSON。统一成 404——前端/爬虫
        # 只发 GET/POST，此项纯粹是主备端契约对齐。
        u = urlparse(self.path)
        try:
            # 排空请求体再回 404。旧版（v1.1.8 首版补丁）漏了这一步：带 body 的
            # PUT/DELETE 把残留字节留在 keep-alive 连接里，下一个请求行被拼成
            # "{}GET /api/videos HTTP/1.1" → 畸形 method → 501，且错误会顺着
            # 连接池传染给后续每个请求（r23 绿源实测：A18c-2 的 DELETE body
            # 污染了 A18d 的 GET）。Node 端无此问题——http parser 按
            # Content-Length 自动跳过 body。
            self._read_body(MAX_JSON_BODY)
        except Exception:
            self.close_connection = True     # 排空失败（含坏 Content-Length）→ 关连接
        self._err(404, 'not found: ' + unquote(u.path))

    do_PUT = do_DELETE = do_PATCH = do_HEAD = do_TRACE = do_CONNECT = _method_not_found

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    # ---------------------------------------------------------- GET
    def do_GET(self):
        try:
            self._route_get()
        except BrokenPipeError:
            pass
        except Exception as e:
            self._err(500, str(e))

    def _route_get(self):
        u = urlparse(self.path)
        path = unquote(u.path)
        qs = parse_qs(u.query, keep_blank_values=True)

        if path in ('/', '/index.html'):
            html = read_text(get_app_file())
            if html is None:
                self._html(500, '<!DOCTYPE html><meta charset="utf-8"><title>FL Server</title>'
                           '<body style="font-family:sans-serif;padding:40px;line-height:1.8">'
                           '<h2>Film Library.html not found</h2><p>Expected: <code>' + APP_DEFAULT + '</code></p>'
                           '<p>Or write its full path into <code>' + APP_OVERRIDE_FILE + '</code>.</p></body>')
                return
            self._html(200, html)
            return

        if path == '/favicon.ico':
            self.send_response(204)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return

        if path.startswith('/data/'):
            data_dir = get_data_dir()
            if not data_dir:
                self._err(409, 'data dir not configured')
                return
            abs_ = safe_join(data_dir, path[len('/data/'):])
            # v1.1.8 A-18：safe_join 拒绝（空 rel / 含 .. 段）旧版落进 _send_file
            # 报 404；Node 主端明确回 403 'path denied'。与主端对齐。
            if abs_ is None:
                self._err(403, 'path denied')
                return
            self._send_file(abs_)
            return

        if path.startswith('/video/'):
            vd = get_video_dir()
            if not vd:
                self._err(409, 'video dir not configured')
                return
            name = safe_name(path[len('/video/'):])
            if not name:
                self._err(400, 'bad name')
                return
            self._send_file(os.path.join(vd, name))
            return

        if path == '/api/status':
            data_dir = get_data_dir()
            st = {'ok': True, 'server': 'python', 'version': VERSION,
                  'configured': bool(data_dir), 'dataDir': data_dir or ''}
            if data_dir:
                inbox_p = os.path.join(data_dir, INBOX_FILE)
                done_p = os.path.join(data_dir, INBOX_DONE)
                inbox_txt = read_text(inbox_p)
                done_txt = read_text(done_p)
                # v1.1.10 #2：与 Node 端对齐——超大文件读不动时计数记 0，
                # 但置 oversize 标记，避免前端把「读不动」误显示成「收件箱是空的」
                inbox_big = file_too_large(inbox_p)
                done_big = file_too_large(done_p)
                st['exists'] = {
                    'main': os.path.isfile(os.path.join(data_dir, MAIN_FILE)),
                    'mainOld': os.path.isfile(os.path.join(data_dir, MAIN_FILE_OLD)),
                    'inbox': inbox_txt is not None or inbox_big,
                }
                st['counts'] = {
                    'films': count_films(data_dir),
                    'inbox': len(parse_inbox(inbox_txt) or []),
                    'archive': len(parse_inbox(done_txt) or []),
                }
                if inbox_big or done_big:
                    st['oversize'] = {'inbox': inbox_big, 'archive': done_big}
                # v1.1.12 #31：原子写 tmp 残留的只读报告（与 Node 主端一致，不自动删）
                try:
                    tmp_n = 0
                    tmp_b = 0
                    for _n in os.listdir(data_dir):
                        if not re.match(r'^.*\.tmp-\d+-[0-9a-z]+$', _n):
                            continue
                        try:
                            _s = os.stat(os.path.join(data_dir, _n))
                            if os.path.isfile(os.path.join(data_dir, _n)):
                                tmp_n += 1
                                tmp_b += _s.st_size
                        except Exception:
                            pass
                    if tmp_n:
                        st['staleTmp'] = {'count': tmp_n, 'bytes': tmp_b}
                except Exception:
                    pass
            self._json(200, st)
            return

        if path == '/api/data':
            data_dir = get_data_dir()
            if not data_dir:
                self._err(409, 'data dir not configured')
                return
            txt = read_text(os.path.join(data_dir, MAIN_FILE))
            fname = MAIN_FILE
            if txt is None:
                txt = read_text(os.path.join(data_dir, MAIN_FILE_OLD))
                fname = MAIN_FILE_OLD
            if txt is None:
                self._json(200, {'ok': True, 'exists': False, 'file': None,
                                 'payload': {'app': 'Film Library', 'version': 3, 'rows': []}})
                return
            try:
                payload = json.loads(txt.lstrip('\ufeff'))
            except Exception:
                self._err(500, 'main data is not valid JSON')
                return
            if not isinstance(payload, dict) or not isinstance(payload.get('rows'), list):
                self._err(500, 'main data shape unexpected')
                return
            self._json(200, {'ok': True, 'exists': True, 'file': fname, 'payload': payload})
            return

        if path == '/api/exists':
            # v1.1.9：FL Spider「一/二/无」库内查询（与 Node 主端同语义）。
            # pad_key 归一匹配（DSOD-9 ↔ DSOD-009 同一部），多行同番号取最高 tier
            # （与收件箱归并「一级覆盖二级」同哲学）。tier_of_item 行级判定：
            # srcTier 章 → FC2 番号 → platform ∈ TIER1 → 2 → 0。
            data_dir = get_data_dir()
            if not data_dir:
                self._err(409, 'data dir not configured')
                return
            code = pad_key((qs.get('code') or [''])[0])
            if not code:
                self._err(400, 'code required')
                return
            txt = read_text(os.path.join(data_dir, MAIN_FILE))
            if txt is None:
                txt = read_text(os.path.join(data_dir, MAIN_FILE_OLD))
            if txt is None:
                self._json(200, {'ok': True, 'found': False, 'tier': 0, 'code': code})
                return
            try:
                payload = json.loads(txt.lstrip('\ufeff'))
            except Exception:
                self._err(500, 'main data is not valid JSON')
                return
            rows = payload.get('rows') if isinstance(payload, dict) else None
            if not isinstance(rows, list):
                self._err(500, 'main data shape unexpected')
                return
            best, hit = 0, None
            # 同番号多行取「最优」来源层级：一级(1) > 二级(2) > 无来源(0)——
            # tier 数字越小来源越硬；0 只在不输给任何有来源行时才胜出。
            for r in rows:
                if not isinstance(r, dict) or pad_key(r.get('code')) != code:
                    continue
                t = tier_of_item(r)
                if hit is None or (t != 0 and (best == 0 or t < best)):
                    best, hit = t, r
            if hit is None:
                self._json(200, {'ok': True, 'found': False, 'tier': 0, 'code': code})
                return
            self._json(200, {'ok': True, 'found': True, 'tier': best, 'code': code,
                             'libCode': str(hit.get('code') or ''),
                             'platform': str(hit.get('platform') or ''),
                             'title': str(hit.get('title') or hit.get('titleCn') or '')[:80]})
            return

        if path == '/api/inbox':
            data_dir = get_data_dir()
            if not data_dir:
                self._err(409, 'data dir not configured')
                return
            inbox_path = os.path.join(data_dir, INBOX_FILE)
            cur = parse_inbox(read_text(inbox_path))
            if cur is None:
                self._err(500, 'inbox file is corrupted')
                return
            self._json(200, {'ok': True, 'exists': os.path.isfile(inbox_path), 'items': cur})
            return

        if path == '/api/pending':
            data_dir = get_data_dir()
            if not data_dir:
                self._err(409, 'data dir not configured')
                return
            txt = read_text(os.path.join(data_dir, PENDING_FILE))
            codes = []
            if txt:
                try:
                    j = json.loads(txt.lstrip('\ufeff'))
                    codes = j if isinstance(j, list) else (j.get('codes') or [])
                except Exception:
                    pass
            self._json(200, {'ok': True, 'exists': txt is not None, 'codes': codes})
            return

        if path == '/api/videos':
            vd = get_video_dir()
            if not vd:
                self._json(200, {'ok': True, 'configured': False, 'files': []})
                return
            try:
                names = os.listdir(vd)
            except Exception as e:
                self._json(200, {'ok': True, 'configured': True, 'error': str(e), 'files': []})
                return
            files = []
            for n in names:
                if os.path.splitext(n)[1].lower() in VIDEO_EXT:
                    p = os.path.join(vd, n)
                    if os.path.isfile(p):
                        st = os.stat(p)
                        files.append({'name': n, 'size': st.st_size, 'mtime': st.st_mtime * 1000,
                                      'url': '/video/' + quote(n, safe='')})
            # v1.1.8 A-18：码点序与 Node 主端修复后的比较器一致（Node 旧版
            # localeCompare 在 ICU 默认 locale 下与本序在大小写/数字串上相反）
            files.sort(key=lambda x: x['name'])
            self._json(200, {'ok': True, 'configured': True, 'dir': vd, 'files': files})
            return

        if path == '/api/files':
            data_dir = get_data_dir()
            if not data_dir:
                self._err(409, 'data dir not configured')
                return
            prefix = (qs.get('prefix') or [''])[0]
            try:
                names = os.listdir(data_dir)
            except Exception:
                names = []
            files = [n for n in names
                     if n.lower().endswith('.json') and (not prefix or n.find(prefix) == 0)][:50]
            self._json(200, {'ok': True, 'files': files})
            return

        if path == '/api/meta':
            data_dir = get_data_dir()
            if not data_dir:
                self._err(409, 'data dir not configured')
                return
            p = os.path.join(data_dir, META_FILE)
            txt = read_text(p)
            meta = None
            if txt is not None:
                try:
                    meta = json.loads(txt.lstrip('\ufeff'))
                except Exception:
                    self._err(500, 'meta.json is not valid JSON')
                    return
            self._json(200, {'ok': True, 'exists': txt is not None,
                             'meta': meta or {'actors': [], 'tagMeta': {}}})
            return

        self._err(404, 'not found: ' + path)

    # ---------------------------------------------------------- POST
    def do_POST(self):
        # v1.1.2：每请求重置 body 缓存——同一 keep-alive 连接上的连续请求由同一个
        # Handler 实例处理，不重置会把上一个请求的 body 带给下一个请求
        self._body = None
        try:
            self._route_post()
        except BrokenPipeError:
            pass
        except Exception as e:
            msg = str(e)
            if msg == 'body too large':
                self._err(413, msg)
            elif msg == 'bad content-length':
                self._err(400, msg)   # v1.1.8 A-20：与 Node 端 http parser 对齐
            else:
                self._err(500, msg)

    def _route_post(self):
        u = urlparse(self.path)
        path = unquote(u.path)
        qs = parse_qs(u.query, keep_blank_values=True)

        # v1.1.2 关键修复：无条件读掉整个请求体再进路由。
        # 背景：/api/inbox/import 不消费 body，而页面 POST 时发了 '{}'；
        # 残留字节留在 keep-alive 连接里，下一个请求行被拼成
        # "{}POST /api/data HTTP/1.1"，基类解析出畸形 method → send_error(501)
        # 回 HTML 错误页 → 前端保存被丢弃，报 "Unexpected token '<'"。
        # 读一次进缓存，各路由原有 _read_body 逻辑不变。
        self._read_body(MAX_JSON_BODY)
        if 'chunked' in (self.headers.get('Transfer-Encoding') or '').lower():
            # 不支持 chunked 请求体：读不完就无法安全复用连接，响应后直接关连接
            self.close_connection = True

        if path == '/api/config':
            body = self._parse_json(self._read_body(1024 * 1024))
            # v1.1.8 A-18：非 dict body（如数组）旧版 body.get 抛 AttributeError
            # → 500；Node 主端同场景回 400。与主端对齐。
            d = clean_path_text(body.get('dataDir') if isinstance(body, dict) else None)
            if not d:
                self._err(400, 'dataDir required')
                return
            if not os.path.isdir(d):
                self._err(400, 'directory does not exist: ' + d)
                return
            write_text_atomic(DATA_DIR_FILE, d)
            if 'videoDir' in body:
                v = clean_path_text(body.get('videoDir'))
                if v:
                    write_text_atomic(VIDEO_DIR_FILE, v)
            self._json(200, {'ok': True, 'dataDir': d})
            return

        if path == '/api/data':
            data_dir = get_data_dir()
            if not data_dir:
                self._err(409, 'data dir not configured')
                return
            body = self._parse_json(self._read_body(MAX_JSON_BODY))
            payload = body.get('payload') if isinstance(body, dict) else None
            if not isinstance(payload, dict) or not isinstance(payload.get('rows'), list):
                self._err(400, 'payload.rows must be an array')
                return
            
            out = {'app': 'Film Library', 'version': 3,
                   'updatedAt': now_iso(),
                   'rows': payload['rows']}
            with WRITE_LOCK:
                write_text_atomic(os.path.join(data_dir, MAIN_FILE),
                                  json.dumps(out, ensure_ascii=False, indent=2))
            self._json(200, {'ok': True, 'rows': len(out['rows'])})
            return

        if path == '/api/upload':
            data_dir = get_data_dir()
            if not data_dir:
                self._err(409, 'data dir not configured')
                return
            sub = {'covers': 'covers', 'shots': 'shots', 'thumb': 'covers/thumb',
                   'avatars': 'actors'}.get((qs.get('kind') or [''])[0])
            if not sub:
                self._err(400, 'kind must be covers/shots/thumb/avatars')
                return
            name = safe_name((qs.get('name') or [''])[0])
            if not name:
                self._err(400, 'bad name')
                return
            buf = self._read_body(MAX_UPLOAD_BODY)
            if not buf:
                self._err(400, 'empty body')
                return
            rel = sub + '/' + name
            with WRITE_LOCK:
                write_buf_atomic(os.path.join(data_dir, rel), buf)
            self._json(200, {'ok': True, 'path': rel})
            return

        if path == '/api/meta':
            data_dir = get_data_dir()
            if not data_dir:
                self._err(409, 'data dir not configured')
                return
            body = self._parse_json(self._read_body(MAX_JSON_BODY))
            actors = body.get('actors') if isinstance(body, dict) else None
            tag_meta = body.get('tagMeta') if isinstance(body, dict) else None
            if not isinstance(actors, list):
                self._err(400, 'actors must be an array')
                return
            if not isinstance(tag_meta, dict):
                self._err(400, 'tagMeta must be an object')
                return
            if len(actors) > 5000 or len(tag_meta) > 5000:
                self._err(400, 'too many meta entries')
                return
            out = {'app': 'Film Library', 'type': 'meta',
                   'updatedAt': now_iso(), 'actors': actors, 'tagMeta': tag_meta}
            with WRITE_LOCK:
                write_text_atomic(os.path.join(data_dir, META_FILE),
                                  json.dumps(out, ensure_ascii=False, indent=2))
            self._json(200, {'ok': True, 'actors': len(actors)})
            return

        if path == '/api/backup':
            data_dir = get_data_dir()
            if not data_dir:
                self._err(409, 'data dir not configured')
                return
            body = self._parse_json(self._read_body(MAX_JSON_BODY))
            # v1.1.8 A-18：同上——数组 body 旧版 500，Node 主端 400
            name = safe_name(body.get('name') if isinstance(body, dict) else None)
            if not name or not name.lower().endswith('.json'):
                self._err(400, 'bad backup name')
                return
            payload = body.get('payload')
            if not isinstance(payload, dict) or not isinstance(payload.get('rows'), list):
                self._err(400, 'payload.rows must be an array')
                return
            
            out = {'app': 'Film Library', 'version': 3,
                   'updatedAt': now_iso(),
                   'rows': payload['rows']}
            with WRITE_LOCK:
                write_text_atomic(os.path.join(data_dir, 'backups', name),
                                  json.dumps(out, ensure_ascii=False, indent=2))
            self._json(200, {'ok': True, 'name': name})
            return

        # ---- 抓取报告（FL Spider 批量汇总；v1.1.6 BUG-14） ----
        # 通用 JSON 落盘：内容原样保存（/api/backup 会重写成 rows 结构，不能用）
        if path == '/api/report':
            data_dir = get_data_dir()
            if not data_dir:
                self._err(409, 'data dir not configured')
                return
            body = self._parse_json(self._read_body(MAX_JSON_BODY))
            name = safe_name(body.get('name')) if isinstance(body, dict) else None
            if not name or not name.lower().endswith('.json'):
                self._err(400, 'bad report name')
                return
            payload = body.get('payload') if isinstance(body, dict) else None
            if payload is None:
                self._err(400, 'payload required')
                return
            rel = 'reports/' + name
            with WRITE_LOCK:
                out_dir = os.path.join(data_dir, 'reports')
                if not os.path.isdir(out_dir):
                    os.makedirs(out_dir, exist_ok=True)
                write_text_atomic(os.path.join(data_dir, rel),
                                  json.dumps(payload, ensure_ascii=False, indent=2))
            self._json(200, {'ok': True, 'path': rel})
            return

        if path == '/api/inbox':
            data_dir = get_data_dir()
            if not data_dir:
                self._err(409, 'data dir not configured')
                return
            body = self._parse_json(self._read_body(MAX_JSON_BODY))
            incoming = body if isinstance(body, list) else [body]
            valid = [it for it in incoming if isinstance(it, dict) and str(it.get('code') or '').strip()]
            if not valid:
                self._err(400, 'no item with code')
                return
            inbox_path = os.path.join(data_dir, INBOX_FILE)
            with WRITE_LOCK:
                # v1.1.10 #1：损坏/超大的收件箱绝不能被「空列表」兜底。旧版
                # parse_inbox(...) or [] 把「解析失败(None)」当「空」，于是 Spider
                # POST 一条新来料就把整箱旧数据覆盖成 [新条目]——整箱丢失且回 200，
                # 与同文件 /api/inbox/import 的既有修复自相矛盾。
                # 现在：文件存在但读不动/解析不了 → 抛错回 500，一个字节都不写。
                if os.path.isfile(inbox_path):
                    if file_too_large(inbox_path):
                        raise ValueError('inbox file is too large')
                    cur = parse_inbox(read_text(inbox_path))
                    if cur is None:
                        raise ValueError('inbox file is corrupted')
                else:
                    cur = []
                added, updated, skipped = [], [], []
                for it in valid:
                    idx = next((i for i, x in enumerate(cur)
                                if isinstance(x, dict) and x.get('code') and pad_key(x['code']) == pad_key(it['code'])), -1)
                    if idx >= 0:
                        if digit_len(cur[idx]['code']) > digit_len(it['code']):
                            it['code'] = cur[idx]['code']
                        # v1.1.3 分级覆盖：新来料层级低于存量（tier 数值更大）→ 保留存量
                        if tier_of_item(it) > tier_of_item(cur[idx]):
                            skipped.append(it['code'])
                            continue
                        cur[idx] = it
                        updated.append(it['code'])
                    else:
                        cur.append(it)
                        added.append(it['code'])
                write_text_atomic(inbox_path, inbox_payload(dedupe_inbox(cur)))
            self._json(200, {'ok': True, 'added': added, 'updated': updated, 'skipped': skipped,
                             'total': len(parse_inbox(read_text(inbox_path)) or [])})
            return

        if path == '/api/inbox/import':
            data_dir = get_data_dir()
            if not data_dir:
                self._err(409, 'data dir not configured')
                return
            inbox_path = os.path.join(data_dir, INBOX_FILE)
            with WRITE_LOCK:
                # v1.1.8 A-18：收件箱/归档损坏时拒绝导入并保留原文件（旧版 `or []`
                # 把损坏当空 → 归档后顺手清空收件箱 = 无声数据丢失）
                # v1.1.12 #31：read_text 超 64MB 返回 None，而 parse_inbox(None) 是 []——
                # 「读不动」被当成「空」，866MB 归档会被 merged 的「只剩新来料」整文件覆盖。
                # 与 Node 主端同口径：存在但读不动 → 拒绝导入，一个字节都不写。
                if os.path.isfile(inbox_path) and file_too_large(inbox_path):
                    self._err(500, 'inbox file is too large')
                    return
                cur = parse_inbox(read_text(inbox_path))
                if cur is None:
                    self._err(500, 'inbox file is corrupted')
                    return
                archived = 0
                if cur:
                    done_path = os.path.join(data_dir, INBOX_DONE)
                    if os.path.isfile(done_path) and file_too_large(done_path):
                        self._err(500, 'archive file is too large')
                        return
                    old = parse_inbox(read_text(done_path))
                    if old is None:
                        self._err(500, 'archive file is corrupted')
                        return
                    
                    merged = dedupe_inbox(old + cur)
                    write_text_atomic(done_path, json.dumps(
                        {'app': 'Film Library', 'type': 'inbox-archive',
                         'updatedAt': now_iso(),
                         'items': merged}, ensure_ascii=False, indent=2))
                    write_text_atomic(inbox_path, inbox_payload([]))
                    archived = len(cur)
            self._json(200, {'ok': True, 'archived': archived})
            return

        if path == '/api/pending':
            data_dir = get_data_dir()
            if not data_dir:
                self._err(409, 'data dir not configured')
                return
            body = self._parse_json(self._read_body(1024 * 1024))
            # v1.1.5 BUG-21：畸形 body（非对象 / codes 非数组）旧版静默写成空队列
            # 并返回 200 —— 用户的待抓清单被无声清空
            if not isinstance(body, dict) or not isinstance(body.get('codes'), list):
                self._err(400, 'codes must be an array')
                return
            codes = [str(c) for c in body['codes']]
            with WRITE_LOCK:
                write_text_atomic(os.path.join(data_dir, PENDING_FILE), json.dumps(
                    {'app': 'Film Library', 'type': 'pending',
                     'updatedAt': now_iso(),
                     'codes': codes}, ensure_ascii=False, indent=2))
            self._json(200, {'ok': True, 'count': len(codes)})
            return

        self._err(404, 'not found: ' + path)


def main():
    port = PORT_FIRST
    while True:
        try:
            httpd = ThreadingHTTPServer(('127.0.0.1', port), Handler)
            break
        except OSError:
            if port >= PORT_LAST:
                print('[FL Server] no free port in %d-%d' % (PORT_FIRST, PORT_LAST))
                sys.exit(1)
            port += 1
    url = 'http://127.0.0.1:%d/' % port
    print('[FL Server] v%s (python) listening on %s' % (VERSION, url))
    print('[FL Server] data dir: %s' % (get_data_dir() or '(not configured - set it in the page)'))
    if not os.environ.get('FL_NO_OPEN'):
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
