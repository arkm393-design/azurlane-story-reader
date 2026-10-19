"""End-to-end check of the site in headless Chromium.

Serves site/ at http://reader.test/, points sync at a local copy of the Worker
(node worker/test/dev-server.mjs, started here), and walks two devices through
the library, a story, the reader, sync and EPUB export.

usage: python3 -I tests/e2e.py <jszip.min.js> <out dir>
"""
import base64
import json
import mimetypes
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
JSZIP, OUT = sys.argv[1:3]
os.makedirs(OUT, exist_ok=True)
SYNC = "http://sync.test"          # forwarded to the local Worker below
LOCAL = "http://127.0.0.1:8799"
missing, errors = [], []
fails = []


def check(cond, what):
    print(("ok   " if cond else "FAIL ") + what)
    if not cond:
        fails.append(what)


def handler(route):
    url = route.request.url
    if url.startswith("http://reader.test/"):
        rel = url[len("http://reader.test/"):].split("?")[0].split("#")[0] or "index.html"
        if rel == "config.json":
            cfg = json.load(open(os.path.join(SITE, rel)))
            cfg.update(syncApi=SYNC, repoUrl="https://github.com/example/azurlane-story-reader")
            return route.fulfill(body=json.dumps(cfg), content_type="application/json")
        path = os.path.join(SITE, rel)
        if os.path.isfile(path):
            return route.fulfill(path=path, content_type=mimetypes.guess_type(path)[0] or "application/octet-stream")
        missing.append(rel)
        return route.fulfill(status=404, body="")
    if "fonts.googleapis.com" in url:
        return route.fulfill(body="", content_type="text/css")
    if "jszip" in url:
        return route.fulfill(path=JSZIP, content_type="text/javascript")
    if url.startswith(SYNC):
        return forward(route)
    return route.abort()


def forward(route):
    """Pass a sync call to the local Worker (Chromium won't let a public page call 127.0.0.1)."""
    req = route.request
    r = urllib.request.Request(LOCAL + req.url[len(SYNC):], data=req.post_data_buffer, method=req.method,
                               headers={k: v for k, v in req.headers.items() if k.lower() in ("origin", "content-type")})
    try:
        res = urllib.request.urlopen(r, timeout=10)
    except urllib.error.HTTPError as e:
        res = e
    route.fulfill(status=res.status, headers=dict(res.headers), body=res.read())


def device(browser, name, **kw):
    ctx = browser.new_context(**kw)
    ctx.route("**/*", handler)
    page = ctx.new_page()
    # a 429 is the sync service asking a device to slow down; the reader handles it
    page.on("console", lambda m: m.type == "error" and "status of 429" not in m.text and errors.append(f"{name}: {m.text}"))
    page.on("pageerror", lambda e: errors.append(f"{name}: {e}"))
    return ctx, page


def advance(page, n):
    for _ in range(n):
        page.keyboard.press("Space")
        page.wait_for_timeout(60)


def main():
    env = dict(os.environ, PORT="8799")
    srv = subprocess.Popen(["node", os.path.join(ROOT, "worker/test/dev-server.mjs")], env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(50):
        try:
            urllib.request.urlopen(LOCAL + "/v1/health", timeout=1)
            break
        except Exception:
            time.sleep(0.1)
    try:
        run()
    finally:
        srv.terminate()


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        a_ctx, a = device(browser, "A", viewport={"width": 1280, "height": 800})
        a.goto("http://reader.test/")
        a.wait_for_selector(".ev-card")
        cards = a.locator(".ev-card")
        catalog = json.load(open(os.path.join(SITE, "data/catalog.json")))["events"]
        check(cards.count() == len(catalog), f"library lists all {len(catalog)} stories")
        for sec in ("#grid", "#pendingGrid"):
            ids = [int(x) for x in a.locator(f"{sec} .ev-card").evaluate_all("els => els.map(e => e.dataset.id)")]
            check(ids == sorted(ids), f"{sec}: stories are listed oldest first")
        check(a.locator(".made").is_visible() and "Claude" in a.locator(".made").inner_text(), "AI disclosure is visible on the library")
        chips = len({e["kind"] for e in catalog if e.get("reviewed")}) + any(not e.get("reviewed") for e in catalog)
        check(a.locator("#filters").is_hidden() == (chips < 2), "filter row shows only when there is more than one category")
        waiting = [e for e in catalog if not e.get("reviewed")]
        check(a.locator("#pending").is_visible() == bool(waiting)
              and a.locator("#pendingGrid .ev-card").count() == len(waiting), "unreviewed stories wait in their own section")
        a.wait_for_timeout(500)
        a.screenshot(path=f"{OUT}/1-library.png")
        a.click("#aboutBtn")
        check("Claude" in a.locator("#aboutDlg").inner_text(), "How this was made dialog names Claude")
        a.keyboard.press("Escape")
        check(a.locator("#aboutDlg").is_hidden(), "Escape closes the dialog")

        a.click(".ev-card[data-id='148']")
        a.wait_for_selector("#chList li")
        check(a.url.endswith("#/e/148"), "story home has its own address")
        check(a.locator("#chList li").count() == 22, "Crimson Echoes home lists 22 chapters")
        ce = next(e for e in catalog if e["id"] == 148)
        check(a.locator("#reviewNote").is_visible() != bool(ce.get("reviewed")), "story page says whether it was reviewed")
        a.wait_for_timeout(600)
        a.screenshot(path=f"{OUT}/2-home.png")

        a.click("#startBtn")
        a.wait_for_selector("#reader:not([hidden])")
        check(a.url.endswith("#/e/148/1"), "reader address includes the chapter")
        advance(a, 14)
        a.wait_for_timeout(700)
        a.screenshot(path=f"{OUT}/3-reader.png")
        pos = a.locator("#pos").inner_text()
        a.go_back()
        a.wait_for_selector("#home:not([hidden])")
        check(a.locator("#reader").is_hidden(), "browser Back leaves the reader for the story home")
        badge = a.locator("#chList li").first.locator(".st").inner_text()
        check(badge.endswith("%"), f"chapter 1 shows progress ({badge}, reader was at {pos})")
        check(a.locator("#startLbl").inner_text() == "Continue", "start button offers Continue")
        a.go_back()
        a.wait_for_selector("#library:not([hidden])")
        stat = a.locator(".ev-card[data-id='148'] .stat").text_content()
        check(stat == "In progress", f"library card shows progress ({stat})")

        # reload straight into a chapter address
        a.goto("http://reader.test/#/e/148/1")
        a.wait_for_selector("#reader:not([hidden])")
        check(a.locator("#txt").inner_text().strip() != "", "opening a chapter address resumes reading")
        a.keyboard.press("Escape")
        a.wait_for_selector("#home:not([hidden])")

        # turn on sync on device A
        a.click("#toLibrary")
        a.wait_for_selector("#library:not([hidden])")
        a.click("#syncBtn")
        a.click("#syncOnBtn")
        a.wait_for_selector("#syncBody .keybox")
        key = a.locator("#syncBody .keybox").inner_text().strip()
        check(len(key.replace("-", "")) == 24, f"sync key issued ({key})")
        a.screenshot(path=f"{OUT}/4-sync.png")
        a.keyboard.press("Escape")
        check("on" in a.locator("#syncDot").get_attribute("class"), "sync indicator turns on")

        # device B: a phone, linked by the sync link
        b_ctx, b = device(browser, "B", viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        b.goto(f"http://reader.test/#/sync/{key}")
        b.wait_for_selector("#offerYes")
        b.screenshot(path=f"{OUT}/5-phone-link.png")
        b.click("#offerYes")
        b.wait_for_function("document.querySelector('#syncDot').className.includes('on')")
        b.keyboard.press("Escape")
        b.wait_for_timeout(300)
        stat_b = b.locator(".ev-card[data-id='148'] .stat").text_content()
        check(stat_b == "In progress", f"phone sees progress from the computer ({stat_b})")
        b.screenshot(path=f"{OUT}/6-phone-library.png")

        # finish chapter 1 on the phone
        b.click(".ev-card[data-id='148']")
        b.wait_for_selector("#chList li")
        b.wait_for_timeout(400)
        b.screenshot(path=f"{OUT}/7-phone-home.png")
        b.click("#startBtn")
        b.wait_for_selector("#reader:not([hidden])")
        b.wait_for_timeout(600)
        b.screenshot(path=f"{OUT}/8-phone-reader.png")
        for _ in range(400):
            if b.locator("#end").is_visible():
                break
            if b.locator("#choices button").count() and b.locator("#choices").is_visible():
                b.locator("#choices button").first.click()
            else:
                b.locator("#stage").click(position={"x": 200, "y": 300})
            b.wait_for_timeout(15)
        check(b.locator("#end").is_visible(), "phone reaches the end of chapter 1")
        b.wait_for_timeout(1700)   # finishing a chapter syncs soon after

        time.sleep(1.2)
        a.evaluate("window.__alsr.syncNow()")
        a.wait_for_timeout(500)
        stat_a = a.locator(".ev-card[data-id='148'] .stat").text_content()
        check(stat_a == "Read 1 of 22 chapters", f"computer sees the chapter the phone finished ({stat_a})")

        # script style and the backlog
        a.click(".ev-card[data-id='312']")
        a.wait_for_selector("#chList li")
        a.click("#startBtn")
        a.wait_for_selector("#reader:not([hidden])")
        advance(a, 8)
        a.click("#logBtn")
        check(a.locator("#logList .row").count() > 0, "backlog lists lines read")
        a.wait_for_timeout(300)
        a.screenshot(path=f"{OUT}/9-log.png")
        a.click("#logClose")
        a.click("#menuBtn")
        check("Claude" in a.locator("#menu").inner_text(), "reader menu carries the AI note")
        a.click("#styleSeg [data-v='script']")
        a.wait_for_selector("#script:not([hidden])")
        a.wait_for_timeout(400)
        a.screenshot(path=f"{OUT}/10-script.png")
        a.click("#menuBtn")
        a.click("#styleSeg [data-v='story']")

        # EPUB
        data = a.evaluate("""async () => {
            const blob = await window.__alsr.buildEpub();
            const buf = new Uint8Array(await blob.arrayBuffer());
            let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            return btoa(s);
        }""")
        epub = os.path.join(OUT, "312.epub")
        open(epub, "wb").write(base64.b64decode(data))
        r = subprocess.run([sys.executable, "-m", "epubcheck", epub], capture_output=True, text=True)
        tail = (r.stdout + r.stderr).strip().splitlines()[-3:]
        check(r.returncode == 0, "EPUB passes epubcheck: " + " | ".join(tail))
        import zipfile
        about = zipfile.ZipFile(epub).read("OEBPS/about.xhtml").decode()
        check("Claude" in about, "EPUB colophon discloses Claude")

        check(not missing, f"no missing files ({sorted(set(missing))[:8]})")
        check(not errors, f"no script errors ({errors[:5]})")
        browser.close()
    print("\n%d failed" % len(fails) if fails else "\nall passed")
    sys.exit(1 if fails else 0)


main()
