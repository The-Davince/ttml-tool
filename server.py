#!/usr/bin/env python3
"""test-1
TTML Tool 本地启动器（含 AI 助手后端）

用法:
    python3 server.py            # 默认端口 26013
    python3 server.py 8080       # 自定义端口

零依赖, 仅需 Python 3.8+ 标准库。
启动后自动打开浏览器。

内置 API (供前端 AI 助手调用, 仅监听 127.0.0.1):
    POST /api/ai/chat          代理转发 OpenAI 兼容的 chat/completions 请求
    POST /api/web-search       网页搜索 (Bing 中国 → Bing 国际 → DuckDuckGo 多引擎回退)
    POST /api/fetch-page       抓取网页正文 (供 AI 阅读网页)
    POST /api/test-ai          测试 AI 接口连通性
    POST /api/qq-music-search  QQ 音乐歌曲搜索
    POST /api/qq-music-lyric   QQ 音乐歌词获取 (QRC 逐字轴 + 翻译 + 罗马音, 自动解密, 附 Ruby TTML)
    POST /api/qrc-to-ttml      QRC 文件 → Ruby TTML 转换 (加密/明文/分段三种输入)
"""
import json
import os
import re
import socketserver
import ssl
import subprocess
import sys
import time
import webbrowser
import zlib
import html as _html
from html.parser import HTMLParser
from http.client import RemoteDisconnected, responses as HTTP_RESPONSES
from http.server import SimpleHTTPRequestHandler
from urllib import parse as urlparse
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 26013
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist")

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

CHAT_TIMEOUT = 180          # LLM 生成可能较慢
SEARCH_TIMEOUT = 20
SEARCH_FETCH_TIMEOUT = 10   # 单个搜索引擎抓取超时(秒), 比默认更激进, 避免慢站点卡住整轮
SEARCH_FETCH_RETRIES = 2    # 搜索抓取重试次数(含首次), 压低最坏情况尾延迟
FETCH_TIMEOUT = 20
MAX_PAGE_CHARS = 6000       # 返回给 AI 的网页正文长度上限
SEARCH_TTL = 120            # 搜索结果内存缓存有效期(秒): AI 同轮/短时间重复查询可瞬时返回
_search_cache: dict = {}    # key -> (过期时间戳, 结果 payload)

# 与原版线上一致的安全头 (见 vercel.json / vite.config.ts dev server)
SECURITY_HEADERS = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
}

# wasm / 字体 / 清单等 MIME 补全
EXTRA_MIME = {
    ".wasm": "application/wasm",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".webmanifest": "application/manifest+json",
    ".mjs": "text/javascript",
    ".svgz": "image/svg+xml",
}


class JSONError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------------------
# 网页搜索: 多引擎回退 (国内环境优先 Bing, 海外环境 DuckDuckGo 兜底)
# ---------------------------------------------------------------------------

class DDGParser(HTMLParser):
    """解析 DuckDuckGo lite 页面: 链接 + 摘要按顺序成对出现"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.results = []
        self._links = []
        self._snippets = []
        self._cur = None
        self._buf = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get("class", "")
        if tag == "a" and ("result-link" in cls or "result__a" in cls or a.get("rel") == "nofollow"):
            href = a.get("href", "")
            self._cur = {"href": href, "title": ""}
            self._buf = []
        elif tag in ("td", "div", "a") and (
            "result-snippet" in cls or "result__snippet" in cls
        ):
            self._cur = {"snippet": True}
            self._buf = []

    def handle_data(self, data):
        if self._cur is not None:
            self._buf.append(data)

    def handle_endtag(self, tag):
        if self._cur is None:
            return
        text = " ".join("".join(self._buf).split())
        if self._cur.get("snippet"):
            if text:
                self._snippets.append(text)
        elif "href" in self._cur:
            self._cur["title"] = text
            self._links.append(self._cur)
        self._cur = None
        self._buf = []


class BingParser(HTMLParser):
    """解析 Bing 结果页: li.b_algo 内 h2>a 标题链接 + 摘要段落"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.results = []
        self._algo_depth = 0
        self._cur = None
        self._got_link = False
        self._buf = []
        self._capture = None  # "title" | "snippet"

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get("class", "") or ""
        if tag == "li" and "b_algo" in cls.split() and self._algo_depth == 0:
            self._algo_depth = 1
            self._cur = {"title": "", "url": "", "snippet": ""}
            self._got_link = False
        elif self._algo_depth == 1 and self._cur is not None:
            if tag == "a" and not self._got_link and a.get("href", "").startswith("http"):
                self._cur["url"] = a["href"]
                self._capture = "title"
                self._buf = []
                self._got_link = True
            elif tag == "p" and not self._cur.get("snippet"):
                self._capture = "snippet"
                self._buf = []
            elif tag == "li":  # 嵌套 li
                self._algo_depth = 2

    def handle_data(self, data):
        if self._capture:
            self._buf.append(data)

    def handle_endtag(self, tag):
        if self._capture == "title" and tag == "a":
            self._cur["title"] = " ".join("".join(self._buf).split())
            self._capture = None
            self._buf = []
        elif self._capture == "snippet" and tag == "p":
            text = " ".join("".join(self._buf).split())
            if text:
                self._cur["snippet"] = text
            self._capture = None
            self._buf = []
        if tag == "li" and self._algo_depth > 0:
            if self._algo_depth == 1:
                if self._cur and self._cur.get("url") and self._cur.get("title"):
                    self.results.append(self._cur)
                self._cur = None
                self._algo_depth = 0
            else:
                self._algo_depth = 1


def _clean_ddg_url(href: str) -> str:
    """DuckDuckGo 结果链接有时是跳转链接, 解出真实 URL"""
    try:
        if "//duckduckgo.com/l/" in href or href.startswith("/l/") or href.startswith("//l/"):
            if href.startswith("//") or href.startswith("/"):
                href = "https://duckduckgo.com" + href
            q = urlparse.urlparse(href).query
            params = urlparse.parse_qs(q)
            if "uddg" in params:
                return params["uddg"][0]
        return href
    except Exception:
        return href


def _decode_bing_url(href: str) -> str:
    """Bing 结果链接可能是 bing.com/ck/a 跳转链, u=a1<base64url> 参数里是真实 URL"""
    try:
        if "/ck/a" not in href:
            return href
        q = urlparse.urlparse(href).query
        params = urlparse.parse_qs(q)
        u = params.get("u", [""])[0]
        if u.startswith("a1"):
            import base64
            padded = u[2:] + "=" * (-len(u[2:]) % 4)
            decoded = base64.urlsafe_b64decode(padded).decode("utf-8", errors="replace")
            if decoded.startswith("http"):
                return decoded
        return href
    except Exception:
        return href


def _strip_url_prefix(title: str) -> str:
    """Bing 部分结果标题前面会拼上显示 URL, 去掉形如 domain.com 后紧贴 http 的前缀"""
    return re.sub(r"^[A-Za-z0-9.-]+\.[a-z]{2,}(?:\.[a-z]{2,})?(https?://)", r"\1", title)


# Windows 下 Python 自带 SSL 时常因系统证书链不全而报
# "unable to get local issuer certificate", 这里在证书校验失败时
# 自动用免校验上下文重试一次 (本地工具场景下可接受)。
_SSL_RETRY_CTX = ssl._create_unverified_context()


def _is_ssl_verify_error(e: Exception) -> bool:
    if isinstance(e, ssl.SSLError):
        return "CERTIFICATE_VERIFY_FAILED" in str(e).upper()
    reason = getattr(getattr(e, "reason", None), "args", None)
    if reason and isinstance(reason[0], ssl.SSLError):
        return "CERTIFICATE_VERIFY_FAILED" in str(reason[0]).upper()
    return False


# 瞬态网络错误 (Cloudflare 等边缘节点偶发 RST, 如 WinError 10054) 应重试;
# 真实的 HTTP 4xx/5xx 响应 (HTTPError) 默认不重试, 仅重试少数边缘超时码。
_TRANSIENT_CODES = (408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 524)
_TRANSIENT_EXC = (
    ConnectionResetError,
    ConnectionAbortedError,
    BrokenPipeError,
    RemoteDisconnected,
    TimeoutError,
)


def _is_transient_conn(e: Exception) -> bool:
    if isinstance(e, HTTPError):
        return e.code in _TRANSIENT_CODES
    if isinstance(e, _TRANSIENT_EXC):
        return True
    if isinstance(e, URLError):
        reason = e.reason
        if isinstance(reason, _TRANSIENT_EXC):
            return True
        s = str(reason).upper()
        return any(k in s for k in ("10054", "10053", "RESET", "ABORT", "REMOTE", "TIMED OUT"))
    return False


def _urlopen_tls(req: Request, timeout: int, retries: int = 3):
    """urlopen 包装: 证书校验失败时改用免校验上下文; 瞬态连接错误重试几次

    注: 每次重试都重建一个相同内容的 Request, 避免部分请求对象在一次失败后
    内部状态 (如已发送的 body) 不可复用。
    """
    last_exc: Exception | None = None
    for attempt in range(retries):
        retry_req = Request(
            req.full_url, data=req.data, headers=dict(req.headers),
            method=req.get_method(),
        )
        try:
            try:
                return urlopen(retry_req, timeout=timeout)
            except Exception as e:
                if _is_ssl_verify_error(e):
                    return urlopen(retry_req, timeout=timeout, context=_SSL_RETRY_CTX)
                raise
        except Exception as e:
            last_exc = e
            if _is_transient_conn(e) and attempt < retries - 1:
                time.sleep(0.6 * (attempt + 1))
                continue
            raise
    raise last_exc  # 理论上不可达


def _fetch_html(url: str, data: bytes = None, timeout: int = SEARCH_TIMEOUT,
                retries: int = 3) -> str:
    headers = {
        "User-Agent": BROWSER_UA,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept": "text/html,application/xhtml+xml",
    }
    req = Request(url, data=data, headers=headers)
    with _urlopen_tls(req, timeout=timeout, retries=retries) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _parse_bing_rss(xml_text: str, max_results: int) -> list:
    """解析 Bing RSS 输出: 干净的 title/link/description。

    相比 cn.bing.com 的 HTML 结果页, RSS 不会被首字词典/百科知识面板污染,
    也不会把面包屑显示 URL 误当标题。"""
    root = ET.fromstring(xml_text)
    results = []
    for it in root.findall("./channel/item"):
        link = _decode_bing_url((it.findtext("link") or "").strip())
        if not link.startswith("http"):
            continue
        title = _strip_url_prefix((it.findtext("title") or "").strip())
        snippet = " ".join(
            re.sub(r"<[^>]+>", "", it.findtext("description") or "").split()
        )
        results.append({"title": title, "url": link, "snippet": snippet})
        if len(results) >= max_results:
            break
    return results


def _parse_ddg_html(html: str, cleaner, max_results: int) -> list:
    parser = DDGParser()
    parser.feed(html)
    results = []
    links = getattr(parser, "_links", None) or []
    snippets = parser._snippets
    for i, link in enumerate(links):
        url2 = cleaner(link.get("href", ""))
        if not url2 or not url2.startswith("http"):
            continue
        if "duckduckgo.com" in urlparse.urlparse(url2).netloc:
            continue
        results.append(
            {
                "title": link.get("title", ""),
                "url": url2,
                "snippet": snippets[i] if i < len(snippets) else "",
            }
        )
        if len(results) >= max_results:
            break
    return results


# 汉字词典/字形/单字百科面板的识别特征。
# 这类结果在 Bing 抓取版 SERP 里会占据多词中文查询的顶部, 挤掉真正相关内容。
_DICT_DOMAINS = (
    "zdic.net", "hgcha.com", "hanyuguoxue.com", "hanzipi.com", "zidian",
    "danci", "cidian", "dict.cn", "iciba.com", "youdao.com", "wiktionary",
)
_DICT_MARKERS = (
    "拼音", "部首", "笔画", "笔顺", "结构", "组词", "释义", "解释",
    "汉语汉字", "维基词典", "汉字", "读音", "近义词", "反义词", "五笔",
    "郑码", "仓颉", "四角号码", "Unicode",
)


def _is_dict_like(r: dict) -> bool:
    """判断一条结果是否为汉字词典/字形/单字百科面板 (而非真正检索目标)。"""
    blob = f"{r.get('title', '')} {r.get('snippet', '')}"
    hit = sum(1 for m in _DICT_MARKERS if m in blob)
    url = r.get("url", "")
    if hit >= 2:
        return True
    if hit >= 1 and any(d in url for d in _DICT_DOMAINS):
        return True
    return False


def _demote_dictionary(results: list, query: str) -> list:
    """多词查询时，把汉字词典/字形/百科单字面板结果沉到底部。

    仅当查询含≥ 2 个词时才降级（避免“周是什么意思”这类真正需要词典的查询被误伤）。"""
    if len(query.split()) < 2 or len(results) < 2:
        return results
    good = [r for r in results if not _is_dict_like(r)]
    if not good or len(good) == len(results):  # 全命中或全未命中 → 保持原序
        return results
    bad = [r for r in results if _is_dict_like(r)]
    return good + bad


def _dict_ratio(results: list) -> float:
    """词典面板结果占比。多词查询下占比高 => Bing 把请求当成了单字词典查询(SERP 退化)。"""
    if not results:
        return 1.0
    return sum(1 for r in results if _is_dict_like(r)) / len(results)


def _distinctive_tokens(query: str) -> list:
    """提取查询中的“实体性”关键词: 先取引号内短语, 再按空白分词,
    只保留去标点后长度 >= 2 的词(单字最易触发首字词典退化, 不作为区分信号)。"""
    quoted = re.findall(r"[\"“”『「]([^\"“”』」]+)[\"“”』」]", query)
    bare = re.sub(r"[\"“”『「][^\"“”』」]*[\"“”』」]", " ", query)
    toks = quoted + re.split(r"\s+", bare)
    out = []
    seen = set()
    for t in toks:
        c = re.sub(r"[^0-9A-Za-z\u3040-\u30ff\u4e00-\u9fff]", "", t)
        if len(c) >= 2 and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def _coverage(results: list, query: str) -> float:
    """区分性关键词在结果集(title+snippet+url)中的命中率。
    命中率低 => 结果与查询实体不相干(如日文歌名查询返回中文“花”百科)。"""
    dt = _distinctive_tokens(query)
    if not dt:
        return 1.0
    blob = " ".join(
        f"{r.get('title', '')} {r.get('snippet', '')} {r.get('url', '')}" for r in results
    )
    return sum(1 for t in dt if t in blob) / len(dt)


def _badness(results: list, query: str) -> float:
    """综合 SERP 质差分数: 词典污染与低相关性各占一半, 越低越好。"""
    return 0.5 * _dict_ratio(results) + 0.5 * (1.0 - _coverage(results, query))


def do_web_search(query: str, max_results: int = 8) -> dict:
    """带内存缓存的搜索入口: 短时间内相同(查询, 条数)直接回缓存,
    避免 AI 反复用同一关键词时重复抓取。仅缓存有结果的成功查询。"""
    key = f"{query}|{max_results}"
    now = time.time()
    hit = _search_cache.get(key)
    if hit and hit[0] > now:
        out = dict(hit[1])
        out["cached"] = True
        return out
    out = _do_web_search_core(query, max_results)
    if out.get("results"):
        _search_cache[key] = (now + SEARCH_TTL, out)
        if len(_search_cache) > 128:  # 粗略清理过期项, 防无限增长
            for k in [k for k, v in _search_cache.items() if v[0] <= now]:
                _search_cache.pop(k, None)
    return out


def _do_web_search_core(query: str, max_results: int = 8) -> dict:
    """多引擎搜索: 优先 Bing RSS。用“SERP 质差分数”(词典污染 + 低相关性) 判断是否退化,
    退化时才试 &ensearch=1 国际索引, 且仅当它明显更相关才采纳(ensearch 对部分查询反而变差)。
    国际站失败回退国内站, 最后退 DuckDuckGo。"""
    attempts = []
    q = urlparse.quote_plus(query)
    count = max(10, min(max_results * 3, 50))
    multi = len(query.split()) >= 2

    def fetch_rss(host: str, ensearch: bool) -> list:
        url = f"https://{host}/search?q={q}&format=rss&count={count}"
        if ensearch:
            url += "&ensearch=1"
        return _parse_bing_rss(
            _fetch_html(url, timeout=SEARCH_FETCH_TIMEOUT, retries=SEARCH_FETCH_RETRIES),
            max_results,
        )

    # 1) Bing RSS: www(国际索引, 质量最好) → cn(国内兑底)
    for base_engine, host in (("bing-rss", "www.bing.com"), ("bing-rss-cn", "cn.bing.com")):
        try:
            results = fetch_rss(host, False)
            attempts.append({"engine": base_engine, "ok": bool(results), "count": len(results)})
        except Exception as e:
            attempts.append({"engine": base_engine, "ok": False, "error": f"{type(e).__name__}: {e}"})
            continue
        if not results:
            continue
        engine_used = base_engine
        base_bad = _badness(results, query)
        # 多词查询且普通 SERP 明显退化(词典污染 或 关键词不命中) => 用 ensearch 重取国际索引
        if multi and base_bad >= 0.45:
            try:
                alt = fetch_rss(host, True)
                attempts.append({"engine": base_engine + "-ensearch", "ok": bool(alt), "count": len(alt)})
                # 仅当 ensearch 确实明显更相关/更干净才采纳, 否则保留原结果
                if alt and _badness(alt, query) <= base_bad - 0.1 and len(alt) >= 3:
                    results = alt
                    engine_used = base_engine + "-ensearch"
            except Exception as e:
                attempts.append({"engine": base_engine + "-ensearch", "ok": False, "error": f"{type(e).__name__}: {e}"})
        results = _demote_dictionary(results, query)
        final_bad = _badness(results, query)
        out = {"engine": engine_used, "results": results, "attempts": attempts}
        # 结果与查询实体低相关时主动提示, 避免 AI 拿着无关结果反复重试、空转时间
        # (仅当查询能拆出 >=2 个区分性关键词时才判断, 无空格单串查询覆盖度不可靠)
        if (
            len(_distinctive_tokens(query)) >= 2
            and final_bad >= 0.5
            and _coverage(results, query) < 0.34
        ):
            out["relevance"] = "low"
            out["hint"] = (
                "这些结果可能与查询实体不相关(Bing 对部分中日文查询会退化为首字百科/词典)。"
                "建议: 简化关键词、去掉引号, 或改用 search_qq_music 直接按歌名/歌手名查。"
            )
        return out

    # 2) DuckDuckGo HTML 兑底 (海外网络下更稳)
    data = urlparse.urlencode({"q": query}).encode()
    for engine, url in (
        ("duckduckgo-html", "https://html.duckduckgo.com/html/"),
        ("duckduckgo-lite", "https://lite.duckduckgo.com/lite/"),
    ):
        try:
            results = _parse_ddg_html(_fetch_html(url, data=data), _clean_ddg_url, max_results)
            attempts.append({"engine": engine, "ok": bool(results), "count": len(results)})
            if results:
                return {"engine": engine, "results": _demote_dictionary(results, query), "attempts": attempts}
        except Exception as e:
            attempts.append({"engine": engine, "ok": False, "error": f"{type(e).__name__}: {e}"})

    return {"engine": None, "results": [], "attempts": attempts}


# ---------------------------------------------------------------------------
# 网页正文提取
# ---------------------------------------------------------------------------

class TextExtractor(HTMLParser):
    SKIP_TAGS = {"script", "style", "noscript", "svg", "iframe", "template", "head"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ""
        self._in_title = False
        self._skip_depth = 0
        self._chunks = []
        self._block_tags = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article"}

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP_TAGS:
            self._skip_depth += 1
        elif tag == "title":
            self._in_title = True
        elif tag in self._block_tags:
            self._chunks.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1
        elif tag == "title":
            self._in_title = False
        elif tag in self._block_tags:
            self._chunks.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif self._skip_depth == 0 and data.strip():
            self._chunks.append(data)


def do_fetch_page(url: str) -> dict:
    parsed = urlparse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise JSONError(400, "仅支持 http/https 链接")
    req = Request(url, headers={"User-Agent": BROWSER_UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"})
    with urlopen(req, timeout=FETCH_TIMEOUT) as resp:
        content_type = resp.headers.get("Content-Type", "")
        raw = resp.read(2 * 1024 * 1024)  # 最多读 2MB
    if "html" not in content_type and "xml" not in content_type:
        text = raw.decode("utf-8", errors="replace")
        return {"title": parsed.netloc, "text": text[:MAX_PAGE_CHARS], "contentType": content_type}
    # 尝试从 meta 探测 charset
    head = raw[:4096].decode("utf-8", errors="replace").lower()
    charset = "utf-8"
    m = re.search(r'charset=["\']?([\w-]+)', head)
    if m:
        charset = m.group(1)
    try:
        html = raw.decode(charset, errors="replace")
    except LookupError:
        html = raw.decode("utf-8", errors="replace")
    extractor = TextExtractor()
    extractor.feed(html)
    text = re.sub(r"\n{3,}", "\n\n", "".join(extractor._chunks))
    text = "\n".join(line.strip() for line in text.splitlines() if line.strip())
    return {
        "title": extractor.title.strip(),
        "text": text[:MAX_PAGE_CHARS],
        "truncated": len(text) > MAX_PAGE_CHARS,
    }


# ---------------------------------------------------------------------------
# QQ 音乐: 搜索 / 歌词 (QRC 逐字轴自动解密)
# ---------------------------------------------------------------------------

QQ_REFERER = "https://y.qq.com/"


def _qq_post_json(url: str, payload: dict, timeout: int = 15) -> dict:
    req = Request(
        url,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "User-Agent": BROWSER_UA,
            "Referer": QQ_REFERER,
        },
    )
    with _urlopen_tls(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def _qq_get_json(url: str, timeout: int = 15) -> dict:
    req = Request(url, headers={"User-Agent": BROWSER_UA, "Referer": "https://y.qq.com/portal/player.html"})
    with _urlopen_tls(req, timeout=timeout) as resp:
        txt = resp.read().decode("utf-8", errors="replace")
    if txt.startswith("callback"):
        txt = txt[txt.index("(") + 1 : txt.rindex(")")]
    return json.loads(txt)


def _norm_qq_song(item: dict) -> dict:
    """QQ 搜索结果归一化: 移动端/桌面端/soso 三种字段命名都兼容"""
    mid = item.get("songmid") or item.get("mid") or ""
    name = item.get("songname") or item.get("name") or ""
    singers = "/".join(
        s.get("name", "") for s in (item.get("singer") or []) if s.get("name")
    )
    album_obj = item.get("album") or {}
    album = album_obj.get("name") or item.get("albumname") or ""
    album_mid = album_obj.get("mid") or item.get("albummid") or ""
    interval = item.get("interval") or 0
    song_id = item.get("songid") or item.get("id") or item.get("songId") or ""
    return {
        "songMid": mid,
        "songId": str(song_id) if song_id else "",
        "name": name,
        "singers": singers,
        "album": album,
        "albumMid": album_mid,
        "durationSec": int(interval) if interval else 0,
        "songUrl": f"https://y.qq.com/n/ryqq/songDetail/{mid}" if mid else "",
    }


def do_qq_music_search(query: str, max_results: int = 20, page: int = 1) -> dict:
    """QQ 音乐歌曲搜索, 三接口回退"""
    attempts = []

    def collect_songs(body: dict) -> list:
        body = body or {}
        song = body.get("song") or {}
        lst = song.get("list")
        if not lst:
            # 移动端 DoSearchForQQMusicMobile 接口的歌曲在 item_song 字段
            lst = body.get("item_song") or []
        return lst

    # 1) 官方移动端接口 (用户提供的 curl 格式)
    try:
        payload = {
            "comm": {
                "ct": 11,
                "cv": "1003006",
                "v": "1003006",
                "QIMEI36": "c2cff9d0d3310d40ea444083100014717907",
                "QIMEI": "c2cff9d0d3310d40ea444083100014717907",
                "os_ver": "12",
                "phonetype": "Redmi K30 Pro",
                "devicelevel": "31",
                "tmeAppID": "qqmusiclight",
                "nettype": "NETWORK_WIFI",
            },
            "req": {
                "module": "music.search.SearchCgiService",
                "method": "DoSearchForQQMusicMobile",
                "param": {
                    "query": query,
                    "search_type": 0,
                    "num_per_page": max_results,
                    "page_num": page,
                    "highlight": 1,
                    "nqc_flag": 0,
                    "page_id": 1,
                    "grp": 1,
                    "searchid": str(int(time.time() * 1000) % 10**18),
                },
            },
        }
        data = _qq_post_json("http://u6.y.qq.com/cgi-bin/musicu.fcg", payload)
        songs = collect_songs((data.get("req", {}).get("data", {}) or {}).get("body", {}))
        attempts.append({"api": "mobile", "ok": len(songs) > 0, "count": len(songs)})
        if songs:
            return _dedupe_songs(songs, max_results, "mobile", attempts)
    except Exception as e:
        attempts.append({"api": "mobile", "ok": False, "error": f"{type(e).__name__}: {e}"})

    # 2) 桌面端接口
    try:
        payload = {
            "comm": {"ct": 19, "cv": 1859, "uin": 0},
            "req": {
                "module": "music.search.SearchCgiService",
                "method": "DoSearchForQQMusicDesktop",
                "param": {
                    "search_type": 0,
                    "query": query,
                    "page_num": page,
                    "num_per_page": max_results,
                },
            },
        }
        data = _qq_post_json("https://u.y.qq.com/cgi-bin/musicu.fcg", payload)
        songs = collect_songs((data.get("req", {}).get("data", {}) or {}).get("body", {}))
        attempts.append({"api": "desktop", "ok": len(songs) > 0, "count": len(songs)})
        if songs:
            return _dedupe_songs(songs, max_results, "desktop", attempts)
    except Exception as e:
        attempts.append({"api": "desktop", "ok": False, "error": f"{type(e).__name__}: {e}"})

    # 3) 老 soso 接口兜底
    try:
        params = {
            "g_tk": 5381,
            "format": "json",
            "inCharset": "utf-8",
            "outCharset": "utf-8",
            "notice": 0,
            "platform": "yqq.json",
            "needNewCode": 0,
            "w": query,
            "p": page,
            "n": max_results,
            "t": 0,
            "aggr": 1,
            "cr": 1,
            "lossless": 0,
            "flag_qc": 0,
        }
        url = "https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?" + urlparse.urlencode(params)
        data = _qq_get_json(url)
        songs = collect_songs((data.get("data", {}) or {}).get("body", {}))
        attempts.append({"api": "soso", "ok": len(songs) > 0, "count": len(songs)})
        if songs:
            return _dedupe_songs(songs, max_results, "soso", attempts)
    except Exception as e:
        attempts.append({"api": "soso", "ok": False, "error": f"{type(e).__name__}: {e}"})

    detail = "；".join(
        f"{a['api']}: {a.get('error', '返回 0 首')}" for a in attempts
    )
    return {
        "success": False,
        "results": [],
        "error": f"QQ 音乐搜索失败（{detail}）",
        "attempts": attempts,
    }


def _dedupe_songs(songs: list, max_results: int, api: str, attempts: list) -> dict:
    seen = {}
    for s in songs:
        norm = _norm_qq_song(s)
        if norm["songMid"] and norm["songMid"] not in seen:
            seen[norm["songMid"]] = norm
    results = list(seen.values())[:max_results]
    return {"success": True, "api": api, "results": results, "attempts": attempts}


# ----- QRC 解密 (腾讯魔改 3DES) -----
#
# QQ 音乐的歌词密文用的不是标准 3DES: 内嵌的 B-Con/crypto-algorithms des.c
# S-box 有两处笔误且 32 位字内字节序相反, 因此标准库解出的是乱码。
# 下面这份实现按公开资料重新移植 (参考 MIT 许可的 WXRIW/QQMusicDecoder
# 与 Mihaly-Ma/karaoke-video-maker 的 Python 实现核对了表值), 纯标准库。

QRC_KEY = b"!@#)(*$%123ZXC!@!@#)(NHL"  # 24 字节 = 3DES 三段子密钥

# fmt: off
# 标准 DES 的 8 张 S-box, 其中两处是腾讯沿用的笔误值:
#   SBOX2[23] = 15 (标准 14); SBOX4[53] = 10 (标准 1)
QRC_SBOX = (
    (14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
     0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
     4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
     15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13),
    (15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
     3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5,
     0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
     13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9),
    (10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
     13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
     13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
     1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12),
    (7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
     13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
     10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
     3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14),
    (2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
     14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
     4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
     11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3),
    (12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
     10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
     9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
     4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13),
    (4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
     13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
     1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
     6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12),
    (13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
     1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
     7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
     2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11),
)
QRC_KEY_PERM_C = (
    56, 48, 40, 32, 24, 16, 8, 0, 57, 49, 41, 33, 25, 17,
    9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35,
)
QRC_KEY_PERM_D = (
    62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21,
    13, 5, 60, 52, 44, 36, 28, 20, 12, 4, 27, 19, 11, 3,
)
QRC_KEY_COMPRESSION = (
    13, 16, 10, 23, 0, 4, 2, 27, 14, 5, 20, 9,
    22, 18, 11, 3, 25, 7, 15, 6, 26, 19, 12, 1,
    40, 51, 30, 36, 46, 54, 29, 39, 50, 44, 32, 47,
    43, 48, 38, 55, 33, 52, 45, 41, 49, 35, 28, 31,
)
QRC_KEY_RND_SHIFT = (1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1)
QRC_IP_L = (
    57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
    61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
)
QRC_IP_R = (
    56, 48, 40, 32, 24, 16, 8, 0, 58, 50, 42, 34, 26, 18, 10, 2,
    60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6,
)
QRC_P_PERM = (
    (15, 0), (6, 1), (19, 2), (20, 3), (28, 4), (11, 5), (27, 6), (16, 7),
    (0, 8), (14, 9), (22, 10), (25, 11), (4, 12), (17, 13), (30, 14), (9, 15),
    (1, 16), (7, 17), (23, 18), (13, 19), (31, 20), (26, 21), (2, 22), (8, 23),
    (18, 24), (12, 25), (29, 26), (5, 27), (21, 28), (10, 29), (3, 30), (24, 31),
)
QRC_INVIP_BYTE_ORDER = (3, 2, 1, 0, 7, 6, 5, 4)
# fmt: on


def _qrc_bitnum(buf: bytes, b: int, c: int) -> int:
    idx = (b // 32) * 4 + 3 - (b % 32) // 8
    return ((buf[idx] >> (7 - (b % 8))) & 1) << c


def _qrc_bit_r(a: int, b: int, c: int) -> int:
    return ((a >> (31 - b)) & 1) << c


def _qrc_bit_l(a: int, b: int, c: int) -> int:
    return ((a << b) & 0x80000000) >> c


def _qrc_sboxbit(a: int) -> int:
    return (a & 0x20) | ((a & 0x1F) >> 1) | ((a & 0x01) << 4)


def _qrc_key_schedule(key8: bytes, mode: int) -> list:
    schedule = [[0] * 6 for _ in range(16)]
    c = d = 0
    for i in range(28):
        c |= _qrc_bitnum(key8, QRC_KEY_PERM_C[i], 31 - i)
        d |= _qrc_bitnum(key8, QRC_KEY_PERM_D[i], 31 - i)
    for i in range(16):
        s = QRC_KEY_RND_SHIFT[i]
        c = ((c << s) | (c >> (28 - s))) & 0xFFFFFFF0
        d = ((d << s) | (d >> (28 - s))) & 0xFFFFFFF0
        to_gen = (15 - i) if mode == 0 else i
        rk = schedule[to_gen]
        for j in range(24):
            rk[j >> 3] |= _qrc_bit_r(c, QRC_KEY_COMPRESSION[j], 7 - (j & 7))
        for j in range(24, 48):
            rk[j >> 3] |= _qrc_bit_r(d, QRC_KEY_COMPRESSION[j] - 27, 7 - (j & 7))
    return schedule


def _qrc_ip(block: bytes):
    left = right = 0
    for k in range(32):
        left |= _qrc_bitnum(block, QRC_IP_L[k], 31 - k)
        right |= _qrc_bitnum(block, QRC_IP_R[k], 31 - k)
    return left, right


def _qrc_inv_ip(s0: int, s1: int) -> bytes:
    out = bytearray(8)
    for k in range(8):
        base = 7 - k
        v = 0
        for t in range(4):
            v |= _qrc_bit_r(s1, base + 8 * t, 7 - 2 * t)
            v |= _qrc_bit_r(s0, base + 8 * t, 6 - 2 * t)
        out[QRC_INVIP_BYTE_ORDER[k]] = v
    return bytes(out)


def _qrc_f(state: int, key6: list) -> int:
    t1 = (
        _qrc_bit_l(state, 31, 0) | ((state & 0xF0000000) >> 1)
        | _qrc_bit_l(state, 4, 5) | _qrc_bit_l(state, 3, 6)
        | ((state & 0x0F000000) >> 3) | _qrc_bit_l(state, 8, 11)
        | _qrc_bit_l(state, 7, 12) | ((state & 0x00F00000) >> 5)
        | _qrc_bit_l(state, 12, 17) | _qrc_bit_l(state, 11, 18)
        | ((state & 0x000F0000) >> 7) | _qrc_bit_l(state, 16, 23)
    )
    t2 = (
        _qrc_bit_l(state, 15, 0) | ((state & 0x0000F000) << 15)
        | _qrc_bit_l(state, 20, 5) | _qrc_bit_l(state, 19, 6)
        | ((state & 0x00000F00) << 13) | _qrc_bit_l(state, 24, 11)
        | _qrc_bit_l(state, 23, 12) | ((state & 0x000000F0) << 11)
        | _qrc_bit_l(state, 28, 17) | _qrc_bit_l(state, 27, 18)
        | ((state & 0x0000000F) << 9) | _qrc_bit_l(state, 0, 23)
    )
    t1 &= 0xFFFFFFFF
    t2 &= 0xFFFFFFFF
    b0 = ((t1 >> 24) & 0xFF) ^ key6[0]
    b1 = ((t1 >> 16) & 0xFF) ^ key6[1]
    b2 = ((t1 >> 8) & 0xFF) ^ key6[2]
    b3 = ((t2 >> 24) & 0xFF) ^ key6[3]
    b4 = ((t2 >> 16) & 0xFF) ^ key6[4]
    b5 = ((t2 >> 8) & 0xFF) ^ key6[5]
    state = (
        (QRC_SBOX[0][_qrc_sboxbit(b0 >> 2)] << 28)
        | (QRC_SBOX[1][_qrc_sboxbit(((b0 & 0x03) << 4) | (b1 >> 4))] << 24)
        | (QRC_SBOX[2][_qrc_sboxbit(((b1 & 0x0F) << 2) | (b2 >> 6))] << 20)
        | (QRC_SBOX[3][_qrc_sboxbit(b2 & 0x3F)] << 16)
        | (QRC_SBOX[4][_qrc_sboxbit(b3 >> 2)] << 12)
        | (QRC_SBOX[5][_qrc_sboxbit(((b3 & 0x03) << 4) | (b4 >> 4))] << 8)
        | (QRC_SBOX[6][_qrc_sboxbit(((b4 & 0x0F) << 2) | (b5 >> 6))] << 4)
        | QRC_SBOX[7][_qrc_sboxbit(b5 & 0x3F)]
    )
    out = 0
    for b, c in QRC_P_PERM:
        out |= _qrc_bit_l(state, b, c)
    return out & 0xFFFFFFFF


def _qrc_des_block(block: bytes, schedule: list) -> bytes:
    s0, s1 = _qrc_ip(block)
    for idx in range(15):
        t = s1
        s1 = _qrc_f(s1, schedule[idx]) ^ s0
        s0 = t
    s0 = _qrc_f(s1, schedule[15]) ^ s0
    return _qrc_inv_ip(s0, s1)


def _qrc_triple_des_ecb(data: bytes, key24: bytes, mode: int) -> bytes:
    if mode == 1:  # encrypt
        sched = [
            _qrc_key_schedule(key24[0:8], 1),
            _qrc_key_schedule(key24[8:16], 0),
            _qrc_key_schedule(key24[16:24], 1),
        ]
    else:  # decrypt
        sched = [
            _qrc_key_schedule(key24[16:24], 0),
            _qrc_key_schedule(key24[8:16], 1),
            _qrc_key_schedule(key24[0:8], 0),
        ]
    out = bytearray()
    for i in range(0, len(data), 8):
        blk = _qrc_des_block(data[i : i + 8], sched[0])
        blk = _qrc_des_block(blk, sched[1])
        blk = _qrc_des_block(blk, sched[2])
        out.extend(blk)
    return bytes(out)


def qrc_decrypt(encrypted_hex: str) -> bytes:
    """QRC 密文 (hex) → 魔改 3DES-ECB 解密 → zlib 解压 → 明文"""
    raw = bytes.fromhex(encrypted_hex.strip())
    plain = _qrc_triple_des_ecb(raw, QRC_KEY, 0)
    return zlib.decompress(plain)


# ----- QRC / LRC 歌词解析 -----

_QRC_CONTENT_RE = re.compile(r'LyricContent="(.*)"\s*/>', re.S)
_QRC_LINE_RE = re.compile(r"^\[(\d+),(\d+)\](.*)$")
_QRC_TOKEN_RE = re.compile(r"(.*?)\((\d+),(\d+)\)", re.S)
_QRC_TAG_RE = re.compile(r"^\[([a-zA-Z_]+):(.*)\]$", re.S)
_CREDIT_RE = re.compile(
    r"^(词|曲|编曲|制作人|作词|作曲|监制|混音|母带|歌词|作曲编曲|MV|PV)[:：]"
    r"|(Lyrics|Composed|Written|Produce|Arranged|Vocal|Guitar|Bass|Drum|Mix(?:ed|ing)?|Master(?:ed|ing)?|Keyboard|Strings|Programming|Recorded|Chorus|Remix)[A-Za-z ]*[:：]",
)
_KANJI_RE = re.compile(r"[㐀-䶿一-鿿々〆]")
_LRC_TAG_RE = re.compile(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]")


def _html_unescape(s: str) -> str:
    import html as _html

    return _html.unescape(s)


def _parse_qrc_content(xml_text: str):
    """QRC XML → (元数据, 行列表)。行: [start, dur, [(text, start, dur), ...]]"""
    if "LyricContent=" not in xml_text:
        content = xml_text
    else:
        m = _QRC_CONTENT_RE.search(xml_text)
        if not m:
            raise JSONError(422, "QRC XML 中找不到 LyricContent 属性")
        content = _html_unescape(m.group(1))
    meta = {}
    lines = []
    for raw in content.splitlines():
        text_line = raw.rstrip("\r")
        if not text_line.strip():
            continue
        m = _QRC_LINE_RE.match(text_line)
        if not m:
            tag = _QRC_TAG_RE.match(text_line.strip())
            if tag:
                meta[tag.group(1)] = tag.group(2)
            continue
        start, dur, body = int(m.group(1)), int(m.group(2)), m.group(3)
        tokens = [
            (tm.group(1), int(tm.group(2)), int(tm.group(3)))
            for tm in _QRC_TOKEN_RE.finditer(body)
        ]
        lines.append([start, dur, tokens])
    return meta, lines


def _parse_kana_track(kana: str) -> list:
    """[kana:] 轨: <单个数字N><读音>(逐拍时间)... N 表示覆盖的连续汉字数"""
    out = []
    i, n = 0, len(kana)
    while i < n:
        if not kana[i].isdigit():
            break
        cover = int(kana[i])
        i += 1
        reading = []
        while i < n:
            ch = kana[i]
            if ch == "(":
                j = kana.find(")", i)
                if j < 0:
                    break
                i = j + 1
            elif ch.isdigit():
                break
            else:
                reading.append(ch)
                i += 1
        out.append((cover, "".join(reading)))
    return out


def _parse_lrc_lines(content: str) -> list:
    """LRC → [(timeMs, text)]"""
    entries = []
    for raw in content.splitlines():
        text_line = raw.rstrip("\r")
        if not text_line.strip():
            continue
        tags = list(_LRC_TAG_RE.finditer(text_line))
        if not tags:
            continue
        text = text_line[tags[-1].end() :].strip()
        if not text:
            continue
        for m in tags:
            minutes, seconds, frac = int(m.group(1)), int(m.group(2)), m.group(3) or "0"
            ms = minutes * 60000 + seconds * 1000 + int(frac.ljust(3, "0")[:3])
            entries.append((ms, text))
    entries.sort(key=lambda e: e[0])
    return entries


def _parse_qrc_or_lrc(text: str) -> list:
    """同时兼容 QRC (逐字 XML) 与 LRC 两种时间轴文本 → [(timeMs, text)]"""
    if "LyricContent=" in text:
        try:
            _meta, raw_lines = _parse_qrc_content(text)
            entries = []
            for start, _dur, tokens in raw_lines:
                words = "".join(t for t, _ws, _wd in tokens).strip()
                if words:
                    entries.append((start, words))
            entries.sort(key=lambda e: e[0])
            return entries
        except Exception:
            return []
    return _parse_lrc_lines(text)


def _is_credit_line(text: str, start_ms: int, first_vocal_ms: int) -> bool:
    if start_ms >= first_vocal_ms:
        return False
    if _CREDIT_RE.match(text):
        return True
    return " - " in text


def do_qq_music_lyric(
    song_mid: str,
    with_translation: bool = True,
    include_credits: bool = False,
    meta_extra: dict = None,
) -> dict:
    """拉取并解密 QQ 音乐歌词: QRC 逐字轴 + 翻译 + 罗马音 + Ruby TTML

    meta_extra: 前端搜索结果提供的歌曲信息 (name/singers/album/qqMusicId),
    会写入 TTML 元数据 (键名 musicName/artists/album/qqMusicId)"""
    payload = {
        "comm": {"ct": 19, "cv": 1859, "uin": 0},
        "req": {
            "module": "music.musichallSong.PlayLyricInfo",
            "method": "GetPlayLyricInfo",
            "param": {
                "songMID": song_mid,
                "songID": 0,
                "crypt": 1,
                "qrc": 1,
                "roma": 1,
                "trans": 1 if with_translation else 0,
                "lrc_t": 0,
                "qrc_t": 0,
                "roma_t": 0,
                "trans_t": 0,
                "interval": 0,
                "type": 0,
                "format": "json",
                "ct": 19,
                "cv": 1859,
            },
        },
    }
    data = _qq_post_json("https://u.y.qq.com/cgi-bin/musicu.fcg", payload)
    d = (data.get("req", {}).get("data", {}) or {})
    lyric_hex = d.get("lyric") or ""
    if not lyric_hex:
        raise JSONError(404, "QQ音乐未返回该歌曲的歌词")
    try:
        lyric_text = qrc_decrypt(lyric_hex).decode("utf-8", errors="replace")
    except Exception as e:
        raise JSONError(502, f"歌词解密失败: {e}")

    trans_text = ""
    roma_text = ""
    if with_translation and d.get("trans"):
        try:
            trans_text = qrc_decrypt(d["trans"]).decode("utf-8", errors="replace")
        except Exception:
            trans_text = ""
    if d.get("roma"):
        try:
            roma_text = qrc_decrypt(d["roma"]).decode("utf-8", errors="replace")
        except Exception:
            roma_text = ""

    is_qrc = "LyricContent=" in lyric_text
    meta = {}
    raw_lines = []
    if is_qrc:
        meta, raw_lines = _parse_qrc_content(lyric_text)
        if not raw_lines:
            raise JSONError(422, "QRC 内容解析出 0 行")
    else:
        # 纯 LRC: 整行一个词, 行级时间
        for t, text in _parse_lrc_lines(lyric_text):
            raw_lines.append([t, 0, [(text, t, 0)]])
        if not raw_lines:
            raise JSONError(422, "歌词内容既不是 QRC 也不是 LRC")
        meta = {"ti": "", "ar": "", "al": ""}

    # 组装行结构
    lines = []
    for start, dur, tokens in raw_lines:
        words = [
            {"word": text, "start": ws, "end": ws + wd if wd else start + dur, "ruby": []}
            for text, ws, wd in tokens
            if text
        ]
        line_text = "".join(w["word"] for w in words)
        if not words:
            continue
        lines.append(
            {
                "start": words[0]["start"],
                "end": max(w["end"] for w in words) if is_qrc else start + (dur or 2000),
                "words": words,
                "text": line_text,
            }
        )

    # 首句人声时间 → 识别制作名单行
    first_vocal = 0
    for ln in lines:
        if not _CREDIT_RE.match(ln["text"]) and " - " not in ln["text"]:
            first_vocal = ln["start"]
            break
    for ln in lines:
        ln["isCredit"] = _is_credit_line(ln["text"], ln["start"], first_vocal)

    # [kana:] 注音轨 → 挂到词上
    # 注意: kana 序列包含 credits 行 (词/曲/编曲…) 的汉字, 必须对全部行做位置展开
    # 并按顺序消费完 kana 序列, 之后再清掉 credits 行的注音, 否则整首歌注音错位
    kana_entries = _parse_kana_track(meta.get("kana", "")) if is_qrc else []
    if kana_entries:
        # kana 的 cover 数按"单个汉字"计数, 位置展开也必须到字符级:
        # 一个含 2 个汉字的词占 kana 流的 2 个位置
        positions = []  # (lineIdx, wordIdx)
        for li, ln in enumerate(lines):
            for wi, w in enumerate(ln["words"]):
                for ch in w["word"]:
                    if _KANJI_RE.match(ch):
                        positions.append((li, wi))
        pi = 0
        for cover, reading in kana_entries:
            if pi >= len(positions):
                break
            group = positions[pi : pi + cover]
            pi += cover
            if not reading or not group:
                continue
            li, wi = group[0]
            lines[li]["words"][wi]["ruby"].append(reading)
        # credits 行不保留注音
        for ln in lines:
            if ln["isCredit"]:
                for w in ln["words"]:
                    w["ruby"] = []

    # 翻译/罗马音 (LRC 或逐字 QRC 时间轴) → 就近挂到行
    trans_entries = [
        (t, text)
        for t, text in _parse_qrc_or_lrc(trans_text)
        if text not in ("//", "") and "著作权" not in text and "贡献" not in text
    ] if trans_text else []
    roma_entries = [
        (t, text)
        for t, text in _parse_qrc_or_lrc(roma_text)
        if text not in ("//", "")
    ] if roma_text else []

    def nearest(entries, t):
        best = None
        best_diff = 2500
        for et, text in entries:
            diff = abs(et - t)
            if diff < best_diff:
                best_diff = diff
                best = text
        return best

    for ln in lines:
        if ln["isCredit"]:
            ln["translation"] = ""
            ln["roman"] = ""
        else:
            ln["translation"] = nearest(trans_entries, ln["start"]) or ""
            ln["roman"] = nearest(roma_entries, ln["start"]) or ""

    # Ruby TTML 高保真转换 (逐假名时间轴 + 逐词音译), LRC 歌曲不适用
    ttml_out = ""
    ttml_stats = {}
    if is_qrc:
        try:
            eff_meta = dict(meta_extra or {})
            # qqMusicId: 优先数字歌曲 ID, 回退 songMid (两者都能打开歌曲页)
            if not str(eff_meta.get("qqMusicId") or "").strip():
                eff_meta["qqMusicId"] = song_mid
            ttml_out, ttml_stats = qrc_to_ttml_ruby(
                lyric_text,
                trans_text,
                roma_text,
                include_credits=include_credits,
                meta_extra=eff_meta,
            )
        except Exception:
            ttml_out = ""

    return {
        "success": True,
        "songMid": song_mid,
        "wordTiming": is_qrc,
        "meta": meta,
        "lines": lines,
        "lineCount": len(lines),
        "creditCount": sum(1 for ln in lines if ln["isCredit"]),
        "hasTranslation": len(trans_entries) > 0,
        "hasRoma": len(roma_entries) > 0,
        "ttml": ttml_out,
        "ttmlStats": ttml_stats,
    }


# ---------------------------------------------------------------------------
# QRC → TTML (Ruby) 转换器 — 移植自用户提供的 PHP 实现 (qrc2ttml.php)
# 输出: 逐词 span + 汉字词 tts:ruby 逐假名时间轴注音 + 逐词音译 + 整行翻译
# ---------------------------------------------------------------------------
#!/usr/bin/env python3
"""QRC → TTML (Ruby) 转换器 — 移植自用户提供的 PHP 实现 (qrc2ttml.php)

输出 TTML 结构:
  - 正文: 逐词 span; 汉字词用 tts:ruby 容器逐假名时间轴注音
  - 翻译: head/iTunesMetadata/translations
  - 逐字罗马音: head/iTunesMetadata/transliterations (逐词对齐)

时间规则 (全时间轴无倒流):
  - 正文词使用 QRC lyric 词时间 (行内单调化钳制)
  - 假名时间锚定在词时间范围内 (kana 字段时间戳 / roma 时长比例分割)
  - 音译逐正文词输出, 与正文词 1:1 对齐
"""
# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------

def ms2amll_time(ms: int) -> str:
    """AMLL 时间: <60s 纯秒 (1.662), >=60s 分:秒.毫秒 (4:09.872, 分不补零)"""
    if ms < 60000:
        return "%.3f" % (ms / 1000.0)
    total_s = ms // 1000
    return "%d:%02d.%03d" % (total_s // 60, total_s % 60, ms % 1000)


def ms2amll_seconds(ms: int) -> str:
    """纯秒格式 (音译部分专用)"""
    return "%.3f" % (ms / 1000.0)


def escape_xml_amll(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def contains_kanji(text: str) -> bool:
    return _KANJI_RE.search(text) is not None


# LyricContent XML → 纯 QRC 文本 (带 HTML 实体还原)
_LYRIC_CONTENT_ENDS = ('"/>\n</LyricInfo>\n</QrcInfos>', '"/>')


def extract_lyric_content(text: str) -> str:
    if "LyricContent=" not in text:
        return text
    if text.lstrip().startswith("[ti:"):
        return text
    marker = 'LyricContent="'
    s = text.index(marker) + len(marker)
    for end_pat in _LYRIC_CONTENT_ENDS:
        i = text.find(end_pat, s)
        if i >= 0:
            return _html.unescape(text[s:i])
    return text


_YOUON_SMALL = set("ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ")


def is_youon_small(ch: str) -> bool:
    return ch in _YOUON_SMALL


def merge_kana_units(elements):
    """拗音小假名并入前一单元 (き+ょ=きょ), 时间取并集; 促音っ独立"""
    units = []
    for el in elements:
        ch = el["text"]
        if (
            units
            and is_youon_small(ch)
            and not units[-1]["text"].endswith("っ")
        ):
            last = units[-1]
            last["text"] += ch
            if el["start"] is not None and (
                last["start"] is None or el["start"] < last["start"]
            ):
                last["start"] = el["start"]
            if el["end"] is not None and (
                last["end"] is None or el["end"] > last["end"]
            ):
                last["end"] = el["end"]
        else:
            units.append({"text": ch, "start": el["start"], "end": el["end"]})
    return units


# ---------------------------------------------------------------------------
# [kana:] 注音轨解析
# ---------------------------------------------------------------------------

_KANA_TOKEN_RE = re.compile(r"(\d)|([^\d()]+)|\((\d+),(\d+)\)")


def parse_kana_groups(kana_raw):
    """解析 [kana:] 字段为注音组序列

    数字标记按单个数字解析 (无注音的汉字词用单个空数字占位, 连续空标记
    写成 "111" = 1+1+1), 空组也入列, 保持与汉字词严格 1:1 对齐。
    每组: {"kana": 整组假名, "units": [拗音合并后的音节单元]}
    """
    groups = []
    if not kana_raw:
        return groups
    matches = list(_KANA_TOKEN_RE.finditer(kana_raw))
    n = len(matches)
    current = None  # None = 尚未开始任何组
    i = 0
    while i < n:
        m = matches[i]
        if m.group(3) is not None:
            # 时间戳: 分配给当前组最后一个尚无时间的单元
            if current:
                for j in range(len(current) - 1, -1, -1):
                    if current[j]["start"] is None:
                        current[j]["start"] = int(m.group(3))
                        current[j]["end"] = int(m.group(3)) + int(m.group(4))
                        break
            i += 1
            continue
        if m.group(1) is not None:
            # 单个数字标记: 结束当前组 (空组也入列), 开启新组
            if current is not None:
                units = merge_kana_units(current)
                groups.append(
                    {"kana": "".join(u["text"] for u in units), "units": units}
                )
            current = []
        else:
            # 假名文本: 逐字符展开
            if current is None:
                current = []
            chars = list(m.group(2))
            char_count = len(chars)
            next_is_time = (
                i + 1 < n and matches[i + 1].group(3) is not None
            )
            if next_is_time and char_count > 1:
                # 多字符假名块整体带一个时间戳 (罕见): 均分到各字符
                ts = int(matches[i + 1].group(3))
                td = int(matches[i + 1].group(4))
                per = td / char_count
                for j, ch in enumerate(chars):
                    current.append(
                        {
                            "text": ch,
                            "start": int(ts + j * per),
                            "end": int(ts + (j + 1) * per),
                        }
                    )
                i += 1  # 消费掉时间戳
            else:
                for ch in chars:
                    current.append({"text": ch, "start": None, "end": None})
        i += 1
    if current:
        units = merge_kana_units(current)
        groups.append({"kana": "".join(u["text"] for u in units), "units": units})
    return groups


# ---------------------------------------------------------------------------
# QRC / 翻译 / 罗马音轨道解析
# ---------------------------------------------------------------------------

_QRC_LINE_SPLIT_RE = re.compile(r"\[(\d+),(\d+)\]((?:(?!\[\d+,\d+\]).)*)", re.S)
_QRC_WORD_TS_RE = re.compile(r"\(\s*(\d+)\s*,\s*(\d+)\s*\)")
_QRC_HEADER_PATTERNS = {
    key: re.compile(r"\[%s:([^\]]*)\]" % key)
    for key in ("ti", "ar", "al", "by", "offset", "kana", "roma", "trans")
}
_WS_EDGE_RE = re.compile(r"^([\s\u3000\u00A0]*)([\s\S]*?)([\s\u3000\u00A0]*)$")


def parse_qrc_line_words(text):
    """词级时间戳解析: 文本1(开始1,持续1)文本2(开始2,持续2)...

    保留词文本中的附着空格 (英文歌 "This "), 时间戳后的剩余文本被忽略。
    """
    parts = _QRC_WORD_TS_RE.split(text)
    words = []
    i = 0
    part_count = len(parts)
    while i < part_count:
        current_text = parts[i]
        i += 1
        if i + 1 < part_count:
            start_time = int(parts[i])
            duration = int(parts[i + 1])
            i += 2
            if current_text != "":
                words.append(
                    {
                        "text": current_text,
                        "start": start_time,
                        "end": start_time + duration,
                    }
                )
        else:
            break
    return words


def parse_qrc_header(content):
    header = {}
    for key, pat in _QRC_HEADER_PATTERNS.items():
        m = pat.search(content)
        if m:
            header[key] = m.group(1)
    return header


def parse_qrc_lyrics(qrc_content):
    """主歌词: [start,dur] + 词级时间戳 → header + lines"""
    qrc_content = extract_lyric_content(qrc_content)
    header = parse_qrc_header(qrc_content)
    lines = []
    for m in _QRC_LINE_SPLIT_RE.finditer(qrc_content):
        start_ms = int(m.group(1))
        duration_ms = int(m.group(2))
        raw_text = m.group(3)
        clean = _QRC_WORD_TS_RE.sub("", raw_text).strip()
        if clean == "":
            continue
        lines.append(
            {
                "start": start_ms,
                "duration": duration_ms,
                "end": start_ms + duration_ms,
                "text": raw_text,
                "words": parse_qrc_line_words(raw_text),
            }
        )
    return {"header": header, "lines": lines}


def parse_translation_lyrics(trans_content):
    """翻译: QRC 时间行优先, LRC 兜底"""
    if not trans_content:
        return []
    content = extract_lyric_content(trans_content)
    translations = []
    for m in _QRC_LINE_SPLIT_RE.finditer(content):
        start_ms = int(m.group(1))
        text = _QRC_WORD_TS_RE.sub("", m.group(3)).strip()
        if text == "" or "//" in text or text.startswith("TME"):
            continue
        translations.append(
            {"start": start_ms, "end": start_ms + int(m.group(2)), "text": text}
        )
    if not translations:
        # LRC 兜底
        for m in re.finditer(
            r"\[(\d{1,3}):(\d{2})\.(\d{1,3})\]([^\n]*)", content
        ):
            text = m.group(4).strip()
            if text == "" or "//" in text or text.startswith("TME"):
                continue
            ms = (int(m.group(1)) * 60 + int(m.group(2))) * 1000 + int(
                m.group(3).ljust(3, "0")[:3]
            )
            translations.append({"start": ms, "end": ms + 3000, "text": text})
    return translations


def parse_romaji_lyrics(roma_content):
    """罗马音: QRC 逐字格式 (词级时间戳)"""
    if not roma_content:
        return []
    content = extract_lyric_content(roma_content)
    romaji = []
    for m in _QRC_LINE_SPLIT_RE.finditer(content):
        start_ms = int(m.group(1))
        text = m.group(3)
        if _QRC_WORD_TS_RE.sub("", text).strip() == "":
            continue
        romaji.append(
            {
                "start": start_ms,
                "end": start_ms + int(m.group(2)),
                "text": text,
                "words": parse_qrc_line_words(text),
            }
        )
    return romaji


def _is_credit_text(text: str) -> bool:
    if " - " in text:
        return True
    if _CREDIT_STYLE_RE.match(text):
        return True
    # 通用角色行: 前 12 字内出现冒号且前缀无空格/假名
    # (QQ 制作名单全部是 角色：名字 形态, 如 联合出品方：xxx / 人声录音棚：xxx)
    m = _GENERIC_ROLE_RE.match(text)
    if m:
        prefix = m.group(1)
        if " " not in prefix and not re.search(r"[ぁ-ゖァ-ヺ]", prefix):
            return True
    return False


_GENERIC_ROLE_RE = re.compile(r"^([^：:]{1,12})[:：]")


def find_matching_lyrics(original_start, lyrics_list, time_tolerance=100):
    for lyric in lyrics_list:
        if abs(lyric["start"] - original_start) <= time_tolerance:
            return lyric
    return None


# ---------------------------------------------------------------------------
# 时间修正与词合并
# ---------------------------------------------------------------------------

def fix_line_end(line):
    """行时长矛盾修正: 行结束 = max(行结束, 最末词结束) (QQ 偶发数据缺陷)"""
    if line.get("words"):
        max_end = max(w["end"] for w in line["words"])
        if max_end > line["end"]:
            line["end"] = max_end


def clamp_line_words(line):
    """行内词时间单调化 (源数据偶发 1ms 重叠) + 词结束不超行结束"""
    words = line["words"]
    n = len(words)
    for idx in range(n):
        if words[idx]["end"] > line["end"]:
            words[idx]["end"] = line["end"]
        if words[idx]["end"] < words[idx]["start"]:
            words[idx]["end"] = words[idx]["start"]
        if idx == 0:
            continue
        if words[idx]["start"] < words[idx - 1]["end"]:
            if words[idx]["start"] > words[idx - 1]["start"]:
                # 缩短前词, 保留后词
                words[idx - 1]["end"] = words[idx]["start"]
            else:
                # 前词无缩减空间, 后移当前词开始
                words[idx]["start"] = words[idx - 1]["end"]
                if words[idx]["end"] < words[idx]["start"]:
                    words[idx]["end"] = words[idx]["start"]


def merge_small_kana_words(lines):
    """拗音小假名词并入前一词 (じゃ/しゃ/きょ → 一个词 span, 音译拿合并形单音节)

    仅当: 当前词是单个小假名且前一词非空、不含汉字。促音っ不并入。行首不合并。
    """
    merged = 0
    for line in lines:
        if not line.get("words"):
            continue
        out = []
        for word in line["words"]:
            t = word["text"].strip()
            is_small = len(t) == 1 and is_youon_small(t)
            if out and is_small:
                prev = out[-1]
                pt = prev["text"].strip()
                if pt != "" and not contains_kanji(pt):
                    core = re.sub(r"[\s\u3000\u00A0]+$", "", word["text"])
                    trail = word["text"][len(core) :]
                    prev["text"] = pt + t + trail
                    if word["end"] > prev["end"]:
                        prev["end"] = word["end"]
                    merged += 1
                    continue
            out.append(word)
        line["words"] = out
    return merged


# ---------------------------------------------------------------------------
# Ruby 假名时间轴
# ---------------------------------------------------------------------------

def match_ruby_syllables(word_start, word_end, roma_words, unit_count):
    """按时间为假名单元匹配罗马音音节 (重叠超音节时长一半才算)"""
    if not roma_words or unit_count <= 0:
        return None
    matched = []
    for w in roma_words:
        ov_s = max(w["start"], word_start)
        ov_e = min(w["end"], word_end)
        if ov_e <= ov_s:
            continue
        dur = w["end"] - w["start"]
        if dur > 0 and (ov_e - ov_s) / dur > 0.5:
            matched.append(w)
    if len(matched) != unit_count:
        return None
    matched.sort(key=lambda x: x["start"])
    return matched


def normalize_boundaries(word_start, word_end, n, interior):
    """n 个单元的内部边界规整为严格递增且落在词时间范围内"""
    if n <= 0:
        return None
    if word_end - word_start < n:
        return None
    boundaries = [word_start]
    cnt = len(interior)
    for i in range(cnt):
        b = interior[i]
        if b is None:
            b = word_start + len(boundaries)
        last = boundaries[-1]
        if b <= last:
            b = last + 1
        if b >= word_end:
            b = word_end - (n - len(boundaries))
            if b <= boundaries[-1]:
                return None
        boundaries.append(b)
    boundaries.append(word_end)
    # 回扫保证严格递增 (末尾固定为词结束)
    for i in range(len(boundaries) - 2, 0, -1):
        if boundaries[i] >= boundaries[i + 1]:
            boundaries[i] = boundaries[i + 1] - 1
        if boundaries[i] <= boundaries[i - 1]:
            return None
    if boundaries[0] >= boundaries[1]:
        return None
    return boundaries


def build_ruby_unit_spans(word, roma_words):
    """计算 ruby 词的假名逐单元时间 (锚定于词时间轴内)

    优先级 1: [kana:] 自带时间戳 → 边界锚定
    优先级 2: roma 音节数与单元数一致 → 按 roma 时长比例分割
    优先级 3: None (调用方回退为整块假名使用词时间轴)
    """
    units = word.get("ruby_units")
    if not units:
        return None
    n = len(units)
    ws = word["start"]
    we = word["end"]

    all_timed = all(u["start"] is not None and u["end"] is not None for u in units)
    if all_timed:
        interior = [units[i]["start"] for i in range(1, n)]
        boundaries = normalize_boundaries(ws, we, n, interior)
        if boundaries is not None:
            return [
                {
                    "text": units[i]["text"],
                    "start": boundaries[i],
                    "end": boundaries[i + 1],
                }
                for i in range(n)
            ]

    matched = match_ruby_syllables(ws, we, roma_words, n)
    if matched:
        weights = [m["end"] - m["start"] for m in matched]
        total = sum(weights)
        if total > 0:
            interior = []
            acc = 0
            for i in range(n - 1):
                acc += weights[i]
                interior.append(ws + int(round((we - ws) * acc / total)))
            boundaries = normalize_boundaries(ws, we, n, interior)
            if boundaries is not None:
                return [
                    {
                        "text": units[i]["text"],
                        "start": boundaries[i],
                        "end": boundaries[i + 1],
                    }
                    for i in range(n)
                ]
    return None


def assign_syllables_to_words(words, roma_words):
    """每个 roma 音节分配给时间重叠最大的正文词 (音译逐词合并)"""
    assign = {}
    if not words or not roma_words:
        return assign
    for s in roma_words:
        if s["text"].strip() == "":
            continue
        best_idx = -1
        best_ov = 0
        for wi, w in words.items():
            ov = min(s["end"], w["end"]) - max(s["start"], w["start"])
            if ov > best_ov:
                best_ov = ov
                best_idx = wi
        if best_idx >= 0:
            assign.setdefault(best_idx, []).append(s)
    return assign


# ---------------------------------------------------------------------------
# 元数据辅助: QrcHeadInfo / 值清洗 / 艺术家拆分 / 词曲作者提取
# 键名约定与工具内建元数据一致: musicName / artists / songwriter / album / qqMusicId
# ---------------------------------------------------------------------------

_QRC_HEAD_INFO_RE = re.compile(r"<QrcHeadInfo\b[^>]*>", re.I)
_HEAD_ATTR_RE = re.compile(r'(\w+)\s*=\s*"([^"]*)"')
_TRAILING_PAREN_RE = re.compile(r"^(.+?)\s*[（(][^()（）]*[)）]\s*$")
_ARTIST_SPLIT_RE = re.compile(r"\s*[/、，,]\s*")


def parse_qrc_head_info(content):
    """QRC XML 的 <QrcHeadInfo Title= Author=> 属性是官方干净值

    优先于 LyricContent 里的 [ti:]/[ar:] 标签 (后者常带 "(日剧主题曲)" 类注释)"""
    info = {}
    m = _QRC_HEAD_INFO_RE.search(content or "")
    if not m:
        return info
    for am in _HEAD_ATTR_RE.finditer(m.group(0)):
        key = am.group(1).lower()
        val = am.group(2).strip()
        if not val:
            continue
        if key == "title":
            info["ti"] = val
        elif key == "author":
            info["ar"] = val
    return info


def clean_meta_value(value):
    """去掉尾部注释式括号 (QQ 惯例 "(读音)"/"(中文译名)"), 保留主值"""
    v = re.sub(r"\s+", " ", str(value or "")).strip()
    m = _TRAILING_PAREN_RE.match(v)
    if m and m.group(1).strip():
        v = m.group(1).strip()
    return v


def split_artist_names(value):
    """多艺术家拆分: QQ 约定用 "/" 连接, 兼容 、，,"""
    return [p.strip() for p in _ARTIST_SPLIT_RE.split(str(value or "")) if p.strip()]


# 词曲作者标签 (词/曲/作词/作詞/Lyrics by/Composed by…), 冒号必填避免误匹配歌词正文
_SONGWRITER_PAIR_RE = re.compile(
    r"(作词作曲|作詞作曲|作词|作詞|词曲|歌词|作曲|编曲|词|曲"
    r"|Lyrics\s+by|Words\s+(?:and|&)\s+(?:Music|Composed)\s+by"
    r"|Written\s+(?:and|&)\s+Composed\s+by"
    r"|Composed\s+by|Music\s+by|Written\s+by|Words|Lyrics|Music)"
    r"\s*[：:]\s*([^：:]+)",
    re.I,
)
_SW_NOISE_TAIL_RE = re.compile(
    r"\s*(?:作词作曲|作詞作曲|作词|作詞|词曲|歌词|作曲|编曲|混音|词|曲"
    r"|Lyrics\s+by|Composed\s+by|Music\s+by|Written\s+by|Arranged\s+by"
    r"|Produced\s+by|Recorded\s+by|Mixed\s+by|Words|Lyrics|Music)\s*$",
    re.I,
)
_SW_NAME_SPLIT_RE = re.compile(r"\s*[/、，,；;&＆]\s*")
_SW_JUNK_RE = re.compile(r"^[\d.:：\-－\s]+$")


def extract_songwriters(lines):
    """从制作名单行提取词曲作者名 → songwriter 元数据 (多条目、去重)"""
    names = []
    for ln in lines:
        text = _QRC_WORD_TS_RE.sub("", ln.get("text", "")).strip()
        if not text or not _is_credit_text(text):
            continue
        for m in _SONGWRITER_PAIR_RE.finditer(text):
            value = _SW_NOISE_TAIL_RE.sub("", m.group(2)).strip(" \t·・-－ー")
            for part in _SW_NAME_SPLIT_RE.split(value):
                part = part.strip()
                if (
                    1 <= len(part) <= 40
                    and part not in names
                    and not _SW_JUNK_RE.match(part)
                ):
                    names.append(part)
                if len(names) >= 8:
                    return names
    return names


# ---------------------------------------------------------------------------
# 主转换: QRC → Ruby TTML
# ---------------------------------------------------------------------------

def qrc_to_ttml_ruby(
    qrc_content,
    trans_content="",
    roma_content="",
    include_credits=False,
    meta_extra=None,
):
    lyrics_data = parse_qrc_lyrics(qrc_content)
    translations = parse_translation_lyrics(trans_content)
    romaji = parse_romaji_lyrics(roma_content)

    # 过滤翻译中的版权行 / 纯音乐占位行
    translations = [
        t
        for t in translations
        if "QQ音乐享有" not in t["text"]
        and "著作权" not in t["text"]
        and "纯音乐" not in t["text"]
    ]

    kana_raw = lyrics_data["header"].get("kana", "")
    kana_groups = parse_kana_groups(kana_raw)

    lines = lyrics_data["lines"]

    # 第零步: 行时长矛盾修正 + 行内词时间单调化
    for line in lines:
        fix_line_end(line)
        clamp_line_words(line)

    # 第 0.5 步: 拗音小假名并入前一词
    merge_small_kana_words(lines)

    # 第一步: 按顺序为所有汉字词分配假名注音 (必须在过滤行之前)
    gi = 0
    group_count = len(kana_groups)
    for line in lines:
        for word in line.get("words", []):
            word["ruby"] = None
            word["ruby_units"] = None
            trimmed = word["text"].strip()
            if trimmed != "" and gi < group_count and contains_kanji(trimmed):
                word["ruby"] = kana_groups[gi]["kana"]
                word["ruby_units"] = kana_groups[gi]["units"]
                gi += 1

    # 第一步半: 从制作名单行提取词曲作者 (必须在过滤行之前)
    extracted_songwriters = extract_songwriters(lines)

    # 第二步: 裁掉开头的元数据行
    # (a) PHP 原始逻辑: 跳过开头没有罗马音音节的行 (歌曲标题/词曲信息)
    # (b) 制作名单样式过滤: 首句人声前, 词：/曲：/Lyrics by：… 等角色行
    if not include_credits:
        if romaji:
            first_idx = None
            for i, line in enumerate(lines):
                roma_line = find_matching_lyrics(line["start"], romaji)
                if roma_line and any(
                    w["text"].strip() != "" for w in roma_line["words"]
                ):
                    first_idx = i
                    break
            if first_idx is not None and first_idx > 0:
                lines = lines[first_idx:]
        # 首句人声时间 → 制作名单行过滤 (与在线导入路径同源)
        first_vocal = None
        for ln in lines:
            t = _QRC_WORD_TS_RE.sub("", ln["text"]).strip()
            if not _is_credit_text(t) and " - " not in t:
                first_vocal = ln["start"]
                break
        if first_vocal is not None:
            kept = [
                ln
                for ln in lines
                if not (
                    ln["start"] < first_vocal
                    and _is_credit_text(_QRC_WORD_TS_RE.sub("", ln["text"]).strip())
                )
            ]
            lines = kept or lines

    if not lines:
        return "", {"lineCount": 0}

    # 第三步: 构建 body 与音译/翻译内容
    p_parts = []
    trans_texts = []
    translit_texts = []
    ruby_word_count = 0

    for i, line in enumerate(lines):
        key = "L%d" % (i + 1)
        roma_line = find_matching_lyrics(line["start"], romaji)
        roma_words = roma_line["words"] if roma_line else []

        p = '<p begin="%s" end="%s" itunes:key="%s" ttm:agent="v1">' % (
            ms2amll_time(line["start"]),
            ms2amll_time(line["end"]),
            key,
        )

        # 音译: 先把每个 roma 音节分配给时间重叠最大的正文词
        nonempty_words = {
            wi: w
            for wi, w in enumerate(line.get("words") or [])
            if w["text"].strip() != ""
        }
        assign = (
            assign_syllables_to_words(nonempty_words, roma_words)
            if roma_words
            else {}
        )

        translit_spans = []
        for wi, word in enumerate(line.get("words") or []):
            # 拆分附着空白: 前导/尾部空白 → 裸文本节点, 主体进 span
            m = _WS_EDGE_RE.match(word["text"])
            lead, core, trail = (m.group(1), m.group(2), m.group(3)) if m else (
                "",
                word["text"],
                "",
            )
            if core == "":
                # 纯空白词: 裸空格文本节点 (不带时间轴)
                p += escape_xml_amll(word["text"])
                continue
            if lead:
                p += escape_xml_amll(lead)
            trimmed = core.strip()
            esc = escape_xml_amll(trimmed)
            if word.get("ruby"):
                # 汉字词: ruby 容器, 假名逐音节时间轴
                ruby_word_count += 1
                units = build_ruby_unit_spans(word, roma_words)
                if units:
                    ruby_spans = "".join(
                        '<span tts:ruby="text" begin="%s" end="%s">%s</span>'
                        % (
                            ms2amll_time(u["start"]),
                            ms2amll_time(u["end"]),
                            escape_xml_amll(u["text"]),
                        )
                        for u in units
                    )
                else:
                    # 回退: 整块假名, 使用词时间轴
                    ruby_spans = (
                        '<span tts:ruby="text" begin="%s" end="%s">%s</span>'
                        % (
                            ms2amll_time(word["start"]),
                            ms2amll_time(word["end"]),
                            escape_xml_amll(word["ruby"]),
                        )
                    )
                p += (
                    '<span tts:ruby="container"><span tts:ruby="base">%s</span>'
                    '<span tts:ruby="textContainer">%s</span></span>'
                    % (esc, ruby_spans)
                )
            else:
                p += '<span begin="%s" end="%s">%s</span>' % (
                    ms2amll_time(word["start"]),
                    ms2amll_time(word["end"]),
                    esc,
                )
            if trail:
                p += escape_xml_amll(trail)

            # 该词对应的音译 span (时间 = 词时间轴)
            if roma_words:
                syls = assign.get(wi) or []
                if syls:
                    translit_text = " ".join(s["text"].strip() for s in syls)
                else:
                    translit_text = trimmed
                translit_spans.append(
                    '<span begin="%s" end="%s">%s</span>'
                    % (
                        ms2amll_seconds(word["start"]),
                        ms2amll_seconds(word["end"]),
                        escape_xml_amll(translit_text),
                    )
                )

        p += "</p>"
        p_parts.append(p)

        if translit_spans:
            translit_texts.append(
                '<text for="%s">%s</text>' % (key, "".join(translit_spans))
            )

        trans_line = find_matching_lyrics(line["start"], translations)
        if trans_line and trans_line["text"]:
            trans_texts.append(
                '<text for="%s">%s</text>'
                % (key, escape_xml_amll(trans_line["text"]))
            )

    # 第四步: 组装文档
    # 元数据键名与工具内建约定一致 (实测 wasm 导入/导出):
    #   <amll:meta key="musicName|artists|album|qqMusicId" value="…"/>
    #   词曲作者 → <iTunesMetadata><songwriters><songwriter>… (多条目)
    header = lyrics_data["header"]
    head_info = parse_qrc_head_info(qrc_content)
    extra = meta_extra or {}

    def meta_source(src):
        # 优先级: 在线搜索结果 (meta_extra, 原样) > QrcHeadInfo > [ti:]/[ar:]/[al:] 标签
        # 后两者是 QQ 歌词文件自带值, 需清洗尾部括号注释
        val = str(extra.get(src) or "").strip()
        if val:
            return val
        if head_info.get(src):
            return clean_meta_value(head_info[src])
        return clean_meta_value(header.get(src) or "")

    music_name = meta_source("ti")
    if str(extra.get("ar") or "").strip():
        artist_names = split_artist_names(str(extra["ar"]))
    elif head_info.get("ar"):
        artist_names = split_artist_names(clean_meta_value(head_info["ar"]))
    elif header.get("ar"):
        artist_names = split_artist_names(clean_meta_value(header["ar"]))
    else:
        artist_names = []
    album = meta_source("al")
    qq_music_id = str(extra.get("qqMusicId") or "").strip()
    if extra.get("songwriters"):
        songwriters = [str(s).strip() for s in extra["songwriters"] if str(s).strip()]
    else:
        songwriters = extracted_songwriters

    head_inner = '<ttm:agent type="person" xml:id="v1"/>'
    if music_name:
        head_inner += '<amll:meta key="musicName" value="%s"/>' % escape_xml_amll(
            music_name
        )
    for name in artist_names:
        head_inner += '<amll:meta key="artists" value="%s"/>' % escape_xml_amll(
            name
        )
    if album:
        head_inner += '<amll:meta key="album" value="%s"/>' % escape_xml_amll(album)
    if qq_music_id:
        head_inner += '<amll:meta key="qqMusicId" value="%s"/>' % escape_xml_amll(
            qq_music_id
        )
    im_parts = []
    if songwriters:
        im_parts.append(
            "<songwriters>%s</songwriters>"
            % "".join(
                "<songwriter>%s</songwriter>" % escape_xml_amll(s) for s in songwriters
            )
        )
    if trans_texts:
        im_parts.append(
            '<translations><translation xml:lang="zh-Hans">%s</translation></translations>'
            % "".join(trans_texts)
        )
    if translit_texts:
        im_parts.append(
            '<transliterations><transliteration>%s</transliteration></transliterations>'
            % "".join(translit_texts)
        )
    if im_parts:
        head_inner += '<iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal">%s</iTunesMetadata>' % (
            "".join(im_parts)
        )

    first_start = lines[0]["start"]
    last_end = lines[-1]["end"]
    ttml = (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<tt xmlns="http://www.w3.org/ns/ttml" '
        'xmlns:itunes="http://music.apple.com/lyric-ttml-internal" '
        'xmlns:ttm="http://www.w3.org/ns/ttml#metadata" '
        'xmlns:tts="http://www.w3.org/ns/ttml#styling" '
        'xmlns:amll="http://www.example.com/ns/amll">'
        "<head><metadata>%s</metadata></head>"
        '<body dur="%s"><div begin="%s" end="%s">%s</div></body></tt>'
        % (
            head_inner,
            ms2amll_time(last_end),
            ms2amll_time(first_start),
            ms2amll_time(last_end),
            "".join(p_parts),
        )
    )

    stats = {
        "lineCount": len(lines),
        "rubyWordCount": ruby_word_count,
        "hasRoma": len(translit_texts) > 0,
        "hasTrans": len(trans_texts) > 0,
        "kanaGroupsUsed": min(gi, group_count),
        "title": music_name,
        "songwriters": songwriters,
    }
    return ttml, stats


# 制作名单行识别 (与 server.py 在线导入路径同源, 补齐 QQ 常见角色)
_CREDIT_STYLE_RE = re.compile(
    r"^(词|曲|编曲|制作人|作词|作曲|作词作曲|作曲编曲|监制|混音|母带|歌词|吉他|贝斯|鼓手|键盘|弦乐|和声|和音|录音|人声录音|发行|出品|企划|统筹|音乐总监|版权|词版权|曲版权|制作|编|混|录)[^：]{0,12}[:：]"
    r"|(Lyrics|Composed|Written|Produce|Produced|Arranged|Vocal|Guitar|Bass|Drum|Drums|Mix(?:ed|ing)?|Master(?:ed|ing)?|Keyboard|Strings|Programming|Program|Recorded|Recording|Chorus|Remix|Edit(?:ed|ing)?|Engineer)[A-Za-z ]*[:：]"
    r"|^(OP|ED)\b",
    re.I,
)

# ---------------------------------------------------------------------------
# 输入格式入口: 识别并归一化各种 QRC 输入
# ---------------------------------------------------------------------------

# 原始 API 响应里的加密 CDATA (content/contentts/contentroma)
_CDATA_LYRIC_RE = re.compile(
    r'<content[^>]*timetag="[^"]*"[^>]*>\s*<!\[CDATA\[([0-9A-Fa-f]+)\]\]>', re.S
)
_CDATA_TRANS_RE = re.compile(r'<contentts[^>]*>\s*<!\[CDATA\[([0-9A-Fa-f]+)\]\]>', re.S)
_CDATA_ROMA_RE = re.compile(r'<contentroma[^>]*>\s*<!\[CDATA\[([0-9A-Fa-f]+)\]\]>', re.S)
_SECTION_HEAD_RE = re.compile(r"^\[(lyric|trans|roma)\]\s*$", re.M)


def split_qrc_sections(text):
    """拆分 [lyric]/[trans]/[roma] 分段文本 (PHP type=0 导出格式)"""
    heads = list(_SECTION_HEAD_RE.finditer(text))
    if not heads:
        return text.strip(), "", ""
    parts = {"lyric": "", "trans": "", "roma": ""}
    for i, m in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
        parts[m.group(1)] = text[m.end():end].strip()
    if not parts["lyric"]:
        return "", "", ""
    return parts["lyric"], parts["trans"], parts["roma"]


def convert_qrc_input(content, include_credits=False, decrypt_func=None):
    """识别输入格式 → 归一化三轨 → 转 Ruby TTML

    支持:
      1. 加密 CDATA hex (content/contentts/contentroma, 需要 decrypt_func)
      2. 解密后的 QrcInfos XML (LyricContent= 属性)
      3. [lyric]/[trans]/[roma] 分段文本
      4. 纯 QRC 文本 ([ti:] 头 + [start,dur] 逐字行)
    返回 (ttml, stats, fmt)
    """
    content = content.lstrip("\ufeff").strip()
    if not content:
        return "", {"lineCount": 0, "error": "empty"}, "empty"

    lyric = trans = roma = ""
    fmt = ""

    m = _CDATA_LYRIC_RE.search(content)
    if m or _CDATA_TRANS_RE.search(content) or _CDATA_ROMA_RE.search(content):
        fmt = "encrypted-cdata"
        if not decrypt_func:
            return "", {"lineCount": 0, "error": "需要解密支持"}, fmt

        def dec(mm):
            if not mm:
                return ""
            try:
                return decrypt_func(mm.group(1)).decode("utf-8", errors="replace")
            except Exception:
                return ""

        lyric = dec(m)
        trans = dec(_CDATA_TRANS_RE.search(content))
        roma = dec(_CDATA_ROMA_RE.search(content))
    elif "LyricContent=" in content:
        fmt = "qrc-xml"
        lyric = extract_lyric_content(content)
    else:
        lyric, trans, roma = split_qrc_sections(content)
        fmt = "sections" if lyric != content.strip() or trans or roma else "qrc-text"

    if not lyric.strip():
        return "", {"lineCount": 0, "error": "未识别出歌词内容"}, fmt or "unknown"

    ttml, stats = qrc_to_ttml_ruby(
        lyric, trans, roma, include_credits=include_credits
    )
    stats["format"] = fmt
    return ttml, stats, fmt


# ---------------------------------------------------------------------------
# AI 聊天代理 (OpenAI 兼容 /chat/completions)
# ---------------------------------------------------------------------------

def _collect_sse_stream(resp) -> dict:
    """读取 OpenAI 兼容 SSE 流, 聚合为非流式的 choices[0].message 结构。

    某些上游端点 (如基于 Cloudflare Worker 的免费代理) 只接受 stream=true,
    非流式请求会被其自身校验拒绝 (500: Stream response Content-Type invalid)。
    这里把增量 delta 的 content / tool_calls 重新拼成完整消息, 前端无感知。
    """
    content_parts: list[str] = []
    tool_by_index: dict[int, dict] = {}
    finish_reason = None
    model_name = None
    for raw_line in resp:
        line = raw_line.decode("utf-8", errors="replace").strip()
        if not line or not line.startswith("data:"):
            continue
        payload_str = line[5:].strip()
        if payload_str == "[DONE]":
            break
        try:
            chunk = json.loads(payload_str)
        except Exception:
            continue
        if chunk.get("model"):
            model_name = chunk["model"]
        choices = chunk.get("choices") or []
        if not choices:
            continue
        choice = choices[0]
        if choice.get("finish_reason"):
            finish_reason = choice["finish_reason"]
        delta = choice.get("delta") or {}
        if delta.get("content"):
            content_parts.append(delta["content"])
        for tc in (delta.get("tool_calls") or []):
            idx = tc.get("index", 0)
            slot = tool_by_index.setdefault(
                idx,
                {"id": "", "type": "function", "function": {"name": "", "arguments": ""}},
            )
            if tc.get("id"):
                slot["id"] = tc["id"]
            fn = tc.get("function") or {}
            if fn.get("name"):
                slot["function"]["name"] += fn["name"]
            if fn.get("arguments"):
                slot["function"]["arguments"] += fn["arguments"]
    message: dict = {"role": "assistant"}
    content = "".join(content_parts)
    if content:
        message["content"] = content
    if tool_by_index:
        message["tool_calls"] = [tool_by_index[i] for i in sorted(tool_by_index)]
    result: dict = {
        "choices": [{"message": message, "finish_reason": finish_reason or "stop"}],
    }
    if model_name:
        result["model"] = model_name
    return result


def do_ai_chat(payload: dict, timeout: int = CHAT_TIMEOUT) -> dict:
    base_url = str(payload.get("baseURL", "")).strip().rstrip("/")
    api_key = str(payload.get("apiKey", "")).strip()
    model = str(payload.get("model", "")).strip()
    if not base_url:
        raise JSONError(400, "未配置 API Base URL")
    if not model:
        raise JSONError(400, "未配置模型名称")
    if not base_url.startswith(("http://", "https://")):
        raise JSONError(400, "API Base URL 必须以 http(s):// 开头")
    if not api_key and "localhost" not in base_url and "127.0.0.1" not in base_url:
        raise JSONError(400, "未配置 API Key")

    # 兼容用户直接填域名 (不带 /v1) 与完整 endpoint 两种写法
    if base_url.endswith("/chat/completions"):
        endpoint = base_url
    else:
        endpoint = base_url + "/chat/completions"

    body = {
        "model": model,
        "messages": payload.get("messages", []),
        "stream": False,
    }
    if payload.get("temperature") is not None:
        body["temperature"] = float(payload["temperature"])
    if payload.get("maxTokens"):
        body["max_tokens"] = int(payload["maxTokens"])
    if payload.get("tools"):
        body["tools"] = payload["tools"]
        body["tool_choice"] = payload.get("toolChoice", "auto")

    headers = {"Content-Type": "application/json", "User-Agent": "amll-ttml-tool/1.0"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    req = Request(endpoint, data=json.dumps(body).encode(), headers=headers)
    first_err_detail = ""
    try:
        with _urlopen_tls(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception as e:
        if hasattr(e, "read"):
            try:
                first_err_detail = e.read().decode("utf-8", errors="replace")[:500]
            except Exception:
                first_err_detail = ""

    # 非流式失败 → 回退流式 (部分端点仅支持 SSE, 见 _collect_sse_stream 说明)
    stream_body = dict(body)
    stream_body["stream"] = True
    stream_headers = dict(headers)
    stream_headers["Accept"] = "text/event-stream"
    stream_req = Request(
        endpoint, data=json.dumps(stream_body).encode(), headers=stream_headers
    )
    try:
        with _urlopen_tls(stream_req, timeout=timeout) as resp:
            ctype = resp.headers.get("Content-Type", "")
            if "text/event-stream" in ctype or "stream" in ctype:
                return _collect_sse_stream(resp)
            # 上游其实给了非流式 JSON
            return json.loads(resp.read().decode("utf-8", errors="replace"))
    except Exception as e2:
        detail2 = ""
        if hasattr(e2, "read"):
            try:
                detail2 = e2.read().decode("utf-8", errors="replace")[:500]
            except Exception:
                detail2 = ""
        combined = f"{e2}"
        if detail2:
            combined += f" | 上游响应(流式): {detail2}"
        if first_err_detail:
            combined += f" | 上游响应(非流式): {first_err_detail}"
        raise JSONError(502, f"AI 接口请求失败（目标 {endpoint}）: {combined}")


def _prepare_chat_upstream(payload: dict, stream: bool):
    """校验并构造上游 chat/completions 请求要素 (端点/头/体)。
    stream=True 时带上 Accept: text/event-stream。供流式代理端点复用。"""
    base_url = str(payload.get("baseURL", "")).strip().rstrip("/")
    api_key = str(payload.get("apiKey", "")).strip()
    model = str(payload.get("model", "")).strip()
    if not base_url:
        raise JSONError(400, "未配置 API Base URL")
    if not model:
        raise JSONError(400, "未配置模型名称")
    if not base_url.startswith(("http://", "https://")):
        raise JSONError(400, "API Base URL 必须以 http(s):// 开头")
    if not api_key and "localhost" not in base_url and "127.0.0.1" not in base_url:
        raise JSONError(400, "未配置 API Key")
    endpoint = (
        base_url if base_url.endswith("/chat/completions")
        else base_url + "/chat/completions"
    )
    body = {
        "model": model,
        "messages": payload.get("messages", []),
        "stream": stream,
    }
    if payload.get("temperature") is not None:
        body["temperature"] = float(payload["temperature"])
    if payload.get("maxTokens"):
        body["max_tokens"] = int(payload["maxTokens"])
    if payload.get("tools"):
        body["tools"] = payload["tools"]
        body["tool_choice"] = payload.get("toolChoice", "auto")
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "amll-ttml-tool/1.0",
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if stream:
        headers["Accept"] = "text/event-stream"
    return endpoint, headers, body


def do_test_ai(payload: dict) -> dict:
    result = do_ai_chat({
        "baseURL": payload.get("baseURL", ""),
        "apiKey": payload.get("apiKey", ""),
        "model": payload.get("model", ""),
        "messages": [{"role": "user", "content": "Hi"}],
        "maxTokens": 8,
        "temperature": 0,
    }, timeout=30)
    return {"ok": True, "reply": (result.get("choices") or [{}])[0].get("message", {}).get("content", "")}


# ---------------------------------------------------------------------------
# HTTP Handler
# ---------------------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ---- API 路由 ----
    def _send_json(self, status: int, obj):
        data = json.dumps(obj, ensure_ascii=False).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            # 浏览器中断了请求 (停止生成/刷新页面/关闭页签), 属正常现象
            pass
        except Exception:
            pass

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 8 * 1024 * 1024:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            raise JSONError(400, "请求体不是有效的 JSON")

    def _handle_api(self, method: str) -> bool:
        if not self.path.startswith("/api/"):
            return False
        path = self.path.split("?")[0]
        try:
            if method != "POST":
                raise JSONError(405, "API 仅支持 POST")
            body = self._read_json_body()
            if path == "/api/ai/chat/stream":
                # 流式代理: 逐块下发上游 SSE, 前端逐字显示“思考”过程
                self._handle_ai_chat_stream(body)
                return True
            if path == "/api/ai/chat":
                result = do_ai_chat(body)
                self._send_json(200, result)
            elif path == "/api/test-ai":
                self._send_json(200, do_test_ai(body))
            elif path == "/api/web-search":
                query = str(body.get("query", "")).strip()
                if not query:
                    raise JSONError(400, "缺少搜索关键词 query")
                max_results = min(int(body.get("maxResults", 8) or 8), 15)
                result = do_web_search(query, max_results)
                self._send_json(200, {"success": len(result["results"]) > 0, **result})
            elif path == "/api/qq-music-search":
                query = str(body.get("query", "")).strip()
                if not query:
                    raise JSONError(400, "缺少搜索关键词 query")
                max_results = min(int(body.get("maxResults", 20) or 20), 50)
                page = max(int(body.get("page", 1) or 1), 1)
                result = do_qq_music_search(query, max_results, page)
                status = 200 if result.get("success") else 502
                self._send_json(status, result)
            elif path == "/api/qq-music-lyric":
                song_mid = str(body.get("songMid", "")).strip()
                if not song_mid:
                    raise JSONError(400, "缺少 songMid 参数")
                me = body.get("metaExtra") or {}
                meta_extra = {
                    "ti": str(me.get("name") or "").strip(),
                    "ar": str(me.get("singers") or "").strip(),
                    "al": str(me.get("album") or "").strip(),
                    "qqMusicId": str(me.get("songId") or "").strip(),
                }
                result = do_qq_music_lyric(
                    song_mid,
                    bool(body.get("withTranslation", True)),
                    bool(body.get("includeCredits", False)),
                    meta_extra,
                )
                self._send_json(200, result)
            elif path == "/api/qrc-to-ttml":
                content = str(body.get("content", ""))
                if not content.strip():
                    raise JSONError(400, "缺少歌词内容 content")
                if len(content) > 8 * 1024 * 1024:
                    raise JSONError(413, "文件内容过大")
                ttml, stats, fmt = convert_qrc_input(
                    content,
                    include_credits=bool(body.get("includeCredits", False)),
                    decrypt_func=qrc_decrypt,
                )
                if not stats.get("lineCount"):
                    raise JSONError(
                        422,
                        "无法识别该文件的 QRC 内容（支持: QRC XML / [lyric] 分段文本 / 加密内容）: %s"
                        % stats.get("error", ""),
                    )
                self._send_json(200, {"success": True, "ttml": ttml, **stats})
            elif path == "/api/fetch-page":
                url = str(body.get("url", "")).strip()
                if not url:
                    raise JSONError(400, "缺少 url 参数")
                page = do_fetch_page(url)
                self._send_json(200, {"success": True, **page})
            else:
                raise JSONError(404, f"未知接口: {path}")
        except JSONError as e:
            self._send_json(e.status, {"error": e.message})
        except Exception as e:
            self._send_json(500, {"error": f"服务器内部错误: {e}"})
        return True

    def do_POST(self):
        if self._handle_api("POST"):
            return
        self._send_json(404, {"error": "Not Found"})

    # ---- SSE 流式转发 ----
    def _send_sse_head(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            self.wfile.flush()
        except Exception:
            pass

    def _send_sse_raw(self, text: str):
        self.wfile.write(text.encode("utf-8"))
        self.wfile.flush()

    def _send_sse_event(self, obj):
        self._send_sse_raw("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n")

    def _send_sse_done(self):
        self._send_sse_raw("data: [DONE]\n\n")

    def _emit_result_as_sse(self, data: dict):
        """把一段非流式 chat 结果合成为标准 delta 事件下发, 保持前端解析统一。"""
        msg = ((data.get("choices") or [{}])[0]).get("message", {}) or {}
        delta: dict = {"role": "assistant"}
        if msg.get("content"):
            delta["content"] = msg["content"]
        tcs = msg.get("tool_calls")
        if tcs:
            delta["tool_calls"] = [
                {
                    "index": i,
                    "id": tc.get("id") or f"call_{i}",
                    "type": "function",
                    "function": {
                        "name": (tc.get("function") or {}).get("name", ""),
                        "arguments": (tc.get("function") or {}).get("arguments", ""),
                    },
                }
                for i, tc in enumerate(tcs)
            ]
        self._send_sse_head()
        self._send_sse_event({"choices": [{"delta": delta, "finish_reason": "stop"}]})
        self._send_sse_done()

    def _handle_ai_chat_stream(self, body: dict):
        """把上游 OpenAI 兼容流式响应原样中继给浏览器 (标准 SSE delta 分片)。
        上游若不支持流式(返回整段 JSON), 则合成单个 delta 事件下发, 保持前端解析统一。"""
        try:
            endpoint, headers, req_body = _prepare_chat_upstream(body, stream=True)
        except JSONError as e:
            self._send_json(e.status, {"error": e.message})
            return
        try:
            resp = _urlopen_tls(
                Request(endpoint, data=json.dumps(req_body).encode(), headers=headers),
                timeout=CHAT_TIMEOUT,
                retries=2,
            )
        except Exception as e:
            detail = ""
            if hasattr(e, "read"):
                try:
                    detail = e.read().decode("utf-8", errors="replace")[:300]
                except Exception:
                    detail = ""
            # 流式通道连不上上游: 回退非流式 do_ai_chat (自带"非流式→流式"双重容错
            # 与清晰错误文案)。仍失败则转发其错误; 成功则把结果合成为 SSE delta 下发,
            # 保证前端拿到的始终是可统一解析的流式响应, 不泄露原始连接错误。
            try:
                result = do_ai_chat(body)
            except JSONError as e2:
                self._send_json(e2.status, {"error": e2.message})
                return
            except Exception as e2:
                combined = f"{e2}"
                if detail:
                    combined += f" | 流式: {detail}"
                self._send_json(
                    502,
                    {"error": f"AI 接口请求失败（目标 {endpoint}）: {combined}"},
                )
                return
            self._emit_result_as_sse(result)
            return
        try:
            with resp:
                ctype = resp.headers.get("Content-Type", "")
                if "text/event-stream" not in ctype and "stream" not in ctype:
                    # 上游给了非流式 JSON → 合成为标准 delta 事件
                    self._emit_result_as_sse(
                        json.loads(resp.read().decode("utf-8", errors="replace"))
                    )
                    return
                self._send_sse_head()
                for raw_line in resp:
                    line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
                    if not line.startswith("data:"):
                        continue
                    self._send_sse_raw(line + "\n\n")
                    if line.strip() == "data: [DONE]":
                        break
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass
        except Exception as e:
            # 响应头已发出, 只能用 SSE 错误事件收尾
            try:
                self._send_sse_event({"error": f"流式转发中断: {e}"})
                self._send_sse_done()
            except Exception:
                pass

    def do_OPTIONS(self):
        # CORS 预检：当前端把「后端代理地址」填成绝对 URL 时，会跨源直连本服务
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self._handle_api("GET"):
            return
        super().do_GET()

    def end_headers(self):
        # 允许前端跨源访问 API（设置面板填写 http://host:port 时）
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers", "Content-Type, Authorization"
        )
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        # index.html / sw.js 不缓存, 保证版本更新即时生效; 其余资源带哈希可长缓存
        if (
            self.path.endswith("index.html")
            or self.path == "/"
            or self.path.startswith("/sw.js")
            or self.path.startswith("/workbox-")
            or self.path.startswith("/manifest")
        ):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in EXTRA_MIME:
            return EXTRA_MIME[ext]
        return super().guess_type(path)

    def translate_path(self, path):
        # SPA: 未知路径回退 index.html
        p = super().translate_path(path)
        if not os.path.exists(p) and not path.startswith(("/assets/", "/sw.js")):
            return os.path.join(ROOT, "index.html")
        return p

    def log_message(self, fmt, *args):
        pass


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    os.chdir(ROOT)
    with Server(("127.0.0.1", PORT), Handler) as httpd:
        url = f"http://127.0.0.1:{PORT}/"
        print(f"TTML Tool 已启动: {url}  (Ctrl+C 退出)")
        print(f"AI 助手后端已就绪: {url}api/ai/chat")
        try:
            webbrowser.open(url)
        except Exception:
            pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已退出")


if __name__ == "__main__":
    main()
