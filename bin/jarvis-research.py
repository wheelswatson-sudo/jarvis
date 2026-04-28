#!/usr/bin/env python3
"""Web research agent — search, fetch, summarize.

Two public functions:

    web_search(query, max_results=5) -> dict
        Single search query. Returns
        {query, sources: [{title, url, snippet}], summary, confidence}.

    research_topic(topic, depth="quick"|"thorough") -> dict
        Multi-query deep research. Uses Haiku to expand the topic into
        sub-queries, fetches the top results from each, and Sonnet-
        synthesizes a structured findings block with sources.

Search backends, picked at call time in this priority order:
    1. SERPAPI_KEY       → SerpAPI (structured JSON)
    2. BRAVE_SEARCH_KEY  → Brave Search API
    3. fallback          → DuckDuckGo HTML scrape (no key)

Page fetch is plain urllib + a tiny stdlib HTML→text parser, so this
module has zero non-stdlib dependencies. Each fetch:
  - respects robots.txt (urllib.robotparser, stdlib),
  - 5-second connect/read timeout,
  - sends a UA the user can change via JARVIS_RESEARCH_UA.

Gate: JARVIS_RESEARCH=1 (default 1).

CLI:
    bin/jarvis-research.py search "what is langgraph"
    bin/jarvis-research.py topic "Acme Corp leadership 2026" --depth thorough
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from html.parser import HTMLParser
from pathlib import Path

ASSISTANT_DIR = Path(os.environ.get("ASSISTANT_DIR", str(Path.home() / ".jarvis")))
LOG_DIR = ASSISTANT_DIR / "logs"
RESEARCH_LOG = LOG_DIR / "research.log"
CACHE_DIR = ASSISTANT_DIR / "cache" / "research"

DEFAULT_UA = os.environ.get(
    "JARVIS_RESEARCH_UA",
    "Mozilla/5.0 (Macintosh; Jarvis Research/1.0) AppleWebKit/537.36",
)
FETCH_TIMEOUT_S = float(os.environ.get("JARVIS_RESEARCH_FETCH_TIMEOUT_S", "5"))
SEARCH_TIMEOUT_S = float(os.environ.get("JARVIS_RESEARCH_SEARCH_TIMEOUT_S", "8"))
PAGE_TEXT_MAX_CHARS = int(os.environ.get("JARVIS_RESEARCH_PAGE_TEXT_MAX", "8000"))
RATE_LIMIT_S = float(os.environ.get("JARVIS_RESEARCH_RATE_LIMIT_S", "1.0"))

SUMMARIZER_MODEL = os.environ.get("JARVIS_RESEARCH_SUMMARIZER", "claude-haiku-4-5-20251001")
SYNTHESIZER_MODEL = os.environ.get("JARVIS_RESEARCH_SYNTHESIZER", "claude-sonnet-4-6")


def _gate_check() -> dict | None:
    if os.environ.get("JARVIS_RESEARCH", "1") != "1":
        return {"error": "research disabled (JARVIS_RESEARCH=0)"}
    return None


def _log(msg: str) -> None:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        ts = time.strftime("%Y-%m-%dT%H:%M:%S")
        with RESEARCH_LOG.open("a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


# ── Anthropic call (single-shot) ────────────────────────────────────
def _anthropic_call(api_key: str, model: str, system: str,
                    user_text: str, max_tokens: int = 800,
                    timeout: float = 30.0) -> str:
    payload = json.dumps({
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user_text}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    last_err: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = json.loads(r.read())
            blocks = data.get("content") or []
            return "\n".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(1 + attempt * 1.5)
                continue
            raise RuntimeError(f"API error {e.code}: {e}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            if attempt < 2:
                time.sleep(1 + attempt * 1.5)
                continue
            raise RuntimeError(f"network error: {e}") from e
    raise RuntimeError(f"unexpected: {last_err}")


# ── Search backends ─────────────────────────────────────────────────
def _search_serpapi(query: str, max_results: int) -> list[dict]:
    key = os.environ.get("SERPAPI_KEY", "")
    if not key:
        return []
    params = {
        "engine": "google",
        "q": query,
        "api_key": key,
        "num": str(max_results),
    }
    url = "https://serpapi.com/search.json?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=SEARCH_TIMEOUT_S) as r:
            data = json.loads(r.read())
    except Exception as e:
        _log(f"serpapi search failed: {e}")
        return []
    out = []
    for item in (data.get("organic_results") or [])[:max_results]:
        out.append({
            "title": item.get("title", "").strip(),
            "url": item.get("link", "").strip(),
            "snippet": item.get("snippet", "").strip(),
        })
    return out


def _search_brave(query: str, max_results: int) -> list[dict]:
    key = os.environ.get("BRAVE_SEARCH_KEY", "")
    if not key:
        return []
    url = "https://api.search.brave.com/res/v1/web/search?" + urllib.parse.urlencode({
        "q": query,
        "count": str(max_results),
    })
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "X-Subscription-Token": key,
        "User-Agent": DEFAULT_UA,
    })
    try:
        with urllib.request.urlopen(req, timeout=SEARCH_TIMEOUT_S) as r:
            data = json.loads(r.read())
    except Exception as e:
        _log(f"brave search failed: {e}")
        return []
    out = []
    web = data.get("web") or {}
    for item in (web.get("results") or [])[:max_results]:
        out.append({
            "title": (item.get("title") or "").strip(),
            "url": (item.get("url") or "").strip(),
            "snippet": (item.get("description") or "").strip(),
        })
    return out


# Stdlib HTML parser — pulls href + visible text out of DDG result blocks.
class _DDGResultParser(HTMLParser):
    """Extracts result blocks from the html.duckduckgo.com no-JS page.
    DDG renders each result as <a class="result__a" href="/l/?uddg=ENCODED_URL">title</a>
    followed by <a class="result__snippet">snippet text</a>."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.results: list[dict] = []
        self._in_a_title = False
        self._in_snippet = False
        self._cur_url = ""
        self._cur_title_buf: list[str] = []
        self._cur_snippet_buf: list[str] = []
        self._pending_title: str = ""
        self._pending_url: str = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = dict(attrs)
        cls = (a.get("class") or "").split()
        if tag == "a" and "result__a" in cls:
            self._in_a_title = True
            href = a.get("href") or ""
            self._cur_url = self._unwrap_ddg_redirect(href)
            self._cur_title_buf = []
        elif tag == "a" and "result__snippet" in cls:
            self._in_snippet = True
            self._cur_snippet_buf = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self._in_a_title:
            self._in_a_title = False
            title = "".join(self._cur_title_buf).strip()
            self._pending_title = title
            self._pending_url = self._cur_url
        elif tag == "a" and self._in_snippet:
            self._in_snippet = False
            snippet = "".join(self._cur_snippet_buf).strip()
            if self._pending_title and self._pending_url:
                self.results.append({
                    "title": self._pending_title,
                    "url": self._pending_url,
                    "snippet": snippet,
                })
                self._pending_title = ""
                self._pending_url = ""

    def handle_data(self, data: str) -> None:
        if self._in_a_title:
            self._cur_title_buf.append(data)
        elif self._in_snippet:
            self._cur_snippet_buf.append(data)

    @staticmethod
    def _unwrap_ddg_redirect(href: str) -> str:
        """DDG wraps results as /l/?uddg=ENCODED_URL[&rut=...]. Pull the real URL."""
        if not href:
            return ""
        if href.startswith("//"):
            href = "https:" + href
        try:
            parsed = urllib.parse.urlparse(href)
            if parsed.netloc.endswith("duckduckgo.com") and parsed.path == "/l/":
                qs = urllib.parse.parse_qs(parsed.query)
                target = qs.get("uddg", [""])[0]
                if target:
                    return urllib.parse.unquote(target)
        except Exception:
            pass
        return href


def _search_duckduckgo(query: str, max_results: int) -> list[dict]:
    url = "https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query})
    req = urllib.request.Request(url, headers={
        "User-Agent": DEFAULT_UA,
        "Accept": "text/html",
    })
    try:
        with urllib.request.urlopen(req, timeout=SEARCH_TIMEOUT_S) as r:
            body = r.read().decode("utf-8", errors="replace")
    except Exception as e:
        _log(f"duckduckgo search failed: {e}")
        return []
    parser = _DDGResultParser()
    try:
        parser.feed(body)
    except Exception as e:
        _log(f"ddg parser error: {e}")
        return []
    return parser.results[:max_results]


def _search(query: str, max_results: int = 5) -> tuple[list[dict], str]:
    """Run the highest-priority available backend. Returns (results, backend_label)."""
    if os.environ.get("SERPAPI_KEY"):
        results = _search_serpapi(query, max_results)
        if results:
            return results, "serpapi"
    if os.environ.get("BRAVE_SEARCH_KEY"):
        # Brave free tier: 1 query/sec — caller's loops should respect that
        results = _search_brave(query, max_results)
        if results:
            return results, "brave"
    return _search_duckduckgo(query, max_results), "duckduckgo"


# ── Page fetch + text extraction ────────────────────────────────────
class _PageTextParser(HTMLParser):
    """Strips scripts/styles/nav and emits plain text. Not perfect, but
    gets us 80% of the readable content for cheap. Drop tags whose
    content isn't useful for summarization."""

    SKIP_TAGS = {"script", "style", "noscript", "svg", "header", "nav",
                 "footer", "aside", "form", "iframe"}
    BLOCK_TAGS = {"p", "div", "li", "br", "h1", "h2", "h3", "h4", "h5", "h6",
                  "tr", "section", "article", "blockquote", "pre"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._skip_depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self.SKIP_TAGS:
            self._skip_depth += 1
        elif tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP_TAGS and self._skip_depth > 0:
            self._skip_depth -= 1
        elif tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0:
            self.parts.append(data)


def _robots_allows(url: str) -> bool:
    """Best-effort robots.txt check. Failure to fetch robots is treated as
    allow — most sites don't publish, and a missing file isn't a denial."""
    try:
        parsed = urllib.parse.urlparse(url)
        robots_url = f"{parsed.scheme}://{parsed.netloc}/robots.txt"
        rp = urllib.robotparser.RobotFileParser()
        rp.set_url(robots_url)
        rp.read()
        return rp.can_fetch(DEFAULT_UA, url)
    except Exception:
        return True


def fetch_page(url: str) -> dict:
    """Fetch and extract plain text from a URL. Returns {url, text} or {error}."""
    if not url or not url.startswith(("http://", "https://")):
        return {"error": "invalid url"}
    if not _robots_allows(url):
        return {"error": "robots.txt disallows", "url": url}

    req = urllib.request.Request(url, headers={
        "User-Agent": DEFAULT_UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
    })
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT_S) as r:
            ctype = r.headers.get("Content-Type", "")
            if "text" not in ctype and "html" not in ctype:
                return {"error": f"unsupported content-type: {ctype}", "url": url}
            charset = "utf-8"
            cs = re.search(r"charset=([\w-]+)", ctype, re.I)
            if cs:
                charset = cs.group(1)
            body = r.read(2_000_000)  # 2MB cap — bigger pages get truncated
    except urllib.error.HTTPError as e:
        return {"error": f"http {e.code}", "url": url}
    except Exception as e:
        return {"error": f"fetch failed: {e}", "url": url}

    try:
        html = body.decode(charset, errors="replace")
    except LookupError:
        html = body.decode("utf-8", errors="replace")

    parser = _PageTextParser()
    try:
        parser.feed(html)
    except Exception as e:
        return {"error": f"parse failed: {e}", "url": url}

    text = "".join(parser.parts)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{2,}", "\n\n", text).strip()
    if len(text) > PAGE_TEXT_MAX_CHARS:
        text = text[:PAGE_TEXT_MAX_CHARS] + "\n\n... (truncated)"
    return {"url": url, "text": text, "chars": len(text)}


# ── Public: web_search ──────────────────────────────────────────────
def _summarize_search(query: str, sources: list[dict], api_key: str) -> tuple[str, str]:
    """Have Haiku roll the search snippets into a 2-3 sentence answer.
    Returns (summary, confidence). Confidence is rough — reflects whether
    the model could compress with conviction or hedged."""
    if not sources:
        return ("No results found.", "low")
    src_text = "\n\n".join(
        f"[{i+1}] {s['title']}\nURL: {s['url']}\n{s.get('snippet', '')}"
        for i, s in enumerate(sources[:5])
    )
    prompt = (
        f"User query: {query!r}\n\n"
        f"Search results:\n{src_text}\n\n"
        "Write a tight 2-3 sentence answer to the query, using only what's "
        "in the snippets. Cite source numbers in brackets like [1]. End with "
        "a one-word confidence tag on its own line: high, medium, or low."
    )
    try:
        text = _anthropic_call(api_key, SUMMARIZER_MODEL, "", prompt,
                                max_tokens=400, timeout=20)
    except Exception as e:
        return (f"Summary failed: {e}", "low")
    lines = [l for l in text.strip().splitlines() if l.strip()]
    confidence = "medium"
    body = text.strip()
    if lines:
        last = lines[-1].lower().strip(".:- ")
        if last in ("high", "medium", "low"):
            confidence = last
            body = "\n".join(lines[:-1]).strip()
    return (body, confidence)


def web_search(query: str, max_results: int = 5) -> dict:
    """Single-query search + summarize. Returns
    {query, sources, summary, confidence, backend} or {error}."""
    gate = _gate_check()
    if gate:
        return gate
    query = (query or "").strip()
    if not query:
        return {"error": "query is required"}
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {"error": "ANTHROPIC_API_KEY not set"}

    _log(f"search: {query!r}")
    sources, backend = _search(query, max_results=max_results)
    summary, confidence = _summarize_search(query, sources, api_key)
    return {
        "query": query,
        "backend": backend,
        "sources": sources,
        "summary": summary,
        "confidence": confidence,
    }


# ── Public: research_topic ──────────────────────────────────────────
EXPAND_SYSTEM = """Expand a research topic into 3-5 distinct search queries
that, between them, cover the topic from complementary angles. Return ONLY
a JSON array of strings — no prose, no fences. Example:
["Acme Corp leadership 2026", "Acme Corp recent news", "Acme Corp financials"]"""


def _expand_queries(topic: str, depth: str, api_key: str) -> list[str]:
    n = 3 if depth == "quick" else 5
    prompt = f"Topic: {topic}\nReturn {n} distinct search queries as a JSON array of strings."
    try:
        raw = _anthropic_call(
            api_key, SUMMARIZER_MODEL, EXPAND_SYSTEM, prompt,
            max_tokens=200, timeout=15,
        )
    except Exception as e:
        _log(f"expand_queries failed: {e}")
        return [topic]
    # Find first JSON array in the response
    m = re.search(r"\[[^\[\]]*\]", raw, re.DOTALL)
    if not m:
        return [topic]
    try:
        arr = json.loads(m.group(0))
    except json.JSONDecodeError:
        return [topic]
    queries = [q for q in arr if isinstance(q, str) and q.strip()][:n]
    return queries or [topic]


SYNTHESIZE_SYSTEM = """You synthesize web research findings for JARVIS to
deliver to Watson.

Output:
1. A tight prose summary (under 180 words, voice-ready, British-butler
   register — no bullet lists in the prose).
2. After the prose, a "Sources:" line listing the most-cited URLs as
   "[1] url1 [2] url2 ...".

Rules:
- Use only what's in the provided source excerpts. No fabrication.
- If sources disagree, say so explicitly.
- If the topic isn't well-covered, say "I could not find solid information on
  X" rather than padding with unrelated material.
- End with a one-line confidence tag: "Confidence: high|medium|low".
"""


def research_topic(topic: str, depth: str = "quick") -> dict:
    """Multi-query deep research. depth='quick' fans out 3 sub-queries +
    fetches top 1 page each. depth='thorough' fans out 5 sub-queries and
    fetches top 2 pages each. Then Sonnet synthesizes one structured
    findings block. Returns
    {topic, depth, queries, sources, summary, confidence}."""
    gate = _gate_check()
    if gate:
        return gate
    topic = (topic or "").strip()
    if not topic:
        return {"error": "topic is required"}
    if depth not in ("quick", "thorough"):
        depth = "quick"
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {"error": "ANTHROPIC_API_KEY not set"}

    _log(f"research_topic: {topic!r} depth={depth}")

    queries = _expand_queries(topic, depth, api_key)
    fetch_n = 2 if depth == "thorough" else 1

    seen_urls: set[str] = set()
    all_sources: list[dict] = []
    excerpts: list[dict] = []  # {url, title, text}

    for q in queries:
        sources, _backend = _search(q, max_results=5)
        for s in sources:
            if not s.get("url") or s["url"] in seen_urls:
                continue
            seen_urls.add(s["url"])
            all_sources.append({**s, "query": q})
        # Fetch top N for this sub-query (skip URLs we've already fetched)
        fetched = 0
        for s in sources:
            if fetched >= fetch_n:
                break
            url = s.get("url", "")
            if not url:
                continue
            if any(e["url"] == url for e in excerpts):
                continue
            page = fetch_page(url)
            time.sleep(RATE_LIMIT_S)  # gentle on hosts
            if page.get("error"):
                continue
            excerpts.append({
                "url": url,
                "title": s.get("title", ""),
                "text": page.get("text", ""),
            })
            fetched += 1

    if not excerpts:
        return {
            "topic": topic, "depth": depth, "queries": queries,
            "sources": all_sources, "summary": "I could not retrieve any pages on that topic.",
            "confidence": "low",
        }

    # Build the synth prompt — number sources so the model can cite [N].
    src_blocks = []
    for i, ex in enumerate(excerpts, start=1):
        snippet = ex["text"][:1500] + ("..." if len(ex["text"]) > 1500 else "")
        src_blocks.append(f"[{i}] {ex['title']}\nURL: {ex['url']}\n{snippet}")
    synth_prompt = (
        f"Topic: {topic}\nDepth: {depth}\n\nSources:\n\n"
        + "\n\n---\n\n".join(src_blocks)
    )

    try:
        raw = _anthropic_call(
            api_key, SYNTHESIZER_MODEL, SYNTHESIZE_SYSTEM, synth_prompt,
            max_tokens=900, timeout=30,
        )
    except Exception as e:
        return {
            "topic": topic, "depth": depth, "queries": queries,
            "sources": all_sources,
            "summary": f"Research synth failed: {e}",
            "confidence": "low",
        }

    # Pull confidence tag if present
    confidence = "medium"
    body = raw.strip()
    m = re.search(r"(?im)^\s*confidence:\s*(high|medium|low)\s*$", body)
    if m:
        confidence = m.group(1).lower()
        body = re.sub(r"(?im)^\s*confidence:\s*(high|medium|low)\s*$", "", body).strip()

    return {
        "topic": topic,
        "depth": depth,
        "queries": queries,
        "sources": [{"title": ex["title"], "url": ex["url"]} for ex in excerpts],
        "all_results": all_sources,
        "summary": body,
        "confidence": confidence,
    }


# ── CLI ─────────────────────────────────────────────────────────────
def _cli() -> int:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        sys.stdout.write(__doc__ or "")
        return 0
    if args[0] == "search":
        if len(args) < 2:
            print("usage: jarvis-research.py search <query>", file=sys.stderr)
            return 2
        q = " ".join(args[1:])
        print(json.dumps(web_search(q), indent=2, ensure_ascii=False))
        return 0
    if args[0] == "topic":
        if len(args) < 2:
            print("usage: jarvis-research.py topic <topic> [--depth quick|thorough]", file=sys.stderr)
            return 2
        depth = "quick"
        rest = list(args[1:])
        if "--depth" in rest:
            i = rest.index("--depth")
            if i + 1 < len(rest):
                depth = rest[i + 1]
                del rest[i:i + 2]
        topic = " ".join(rest)
        print(json.dumps(research_topic(topic, depth=depth), indent=2, ensure_ascii=False))
        return 0
    if args[0] == "fetch":
        if len(args) < 2:
            print("usage: jarvis-research.py fetch <url>", file=sys.stderr)
            return 2
        rec = fetch_page(args[1])
        # Truncate text in CLI output for readability
        if isinstance(rec.get("text"), str) and len(rec["text"]) > 1000:
            rec = {**rec, "text": rec["text"][:1000] + "...", "_truncated_for_cli": True}
        print(json.dumps(rec, indent=2, ensure_ascii=False))
        return 0
    print(f"unknown command: {args[0]}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(_cli())
