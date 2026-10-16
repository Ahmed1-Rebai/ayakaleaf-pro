"""Browser test: the AI assistant names each kind of failure and offers the right
action. Runs in the Playwright image; see README.md here.

Failures are produced by intercepting /workbench/tex-gpt in the browser and
answering the way the server or the network fails: a reply stream that ends
with a cause code, an HTTP error with a JSON code, a 403 without JSON (expired
session), a dropped connection. "Try again" must send the message again (here it
then goes to the real server and gets a reply). Creates a project "aierr" and
deletes it and its conversations afterwards."""
import atexit, io, json, os, re, time, zipfile, requests
from playwright.sync_api import sync_playwright

B = os.environ.get("OL_URL", "http://127.0.0.1:8001")
EMAIL, PW = os.environ["OL_EMAIL"], os.environ["OL_PW"]
OUT = os.environ.get("LT_TEST_DIR", "/tmp/lambdatex-tests"); os.makedirs(OUT, exist_ok=True)
results = {}


def check(name, ok, detail=""):
    results[name] = bool(ok); print(f"{'PASS' if ok else 'FAIL'} {name} {detail}", flush=True)


s = requests.Session()
tok = lambda path: re.search(r'name="ol-csrfToken" content="([^"]+)"', s.get(B + path).text).group(1)
s.post(B + "/login", json={"email": EMAIL, "password": PW}, headers={"X-Csrf-Token": tok("/login")})
s.headers["X-Csrf-Token"] = tok("/project")
buf = io.BytesIO(); zipfile.ZipFile(buf, "w").writestr("main.tex", "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n")
pid = s.post(B + "/project/new/upload", files={"qqfile": ("aierr.zip", buf.getvalue(), "application/zip")}, data={"name": "aierr.zip"}).json()["project_id"]


def cleanup():
    convs = s.get(f"{B}/workbench/conversations", params={"project_id": pid}).json().get("conversations", [])
    for c in convs:
        s.delete(f"{B}/workbench/conversations/{c['id']}")
    print("cleanup: conversations", len(convs), "| project ->", s.delete(f"{B}/project/{pid}").status_code)
atexit.register(cleanup)


def stream_error(code):
    body = "".join(f"data: {json.dumps(e)}\n\n" for e in (
        {"type": "start"}, {"type": "error", "errorText": f"[{code}] The AI reply could not be completed."})) + "data: [DONE]\n\n"
    return dict(status=200, headers={"content-type": "text/event-stream", "x-vercel-ai-ui-message-stream": "v1", "cache-control": "no-cache"}, body=body)


def http_error(status, code=None, text="Forbidden"):
    if code:
        return dict(status=status, headers={"content-type": "application/json"}, body=json.dumps({"error": code}))
    return dict(status=status, headers={"content-type": "text/plain"}, body=text)


SCENARIOS = [
    # name, how the failure arrives, expected title, "Try again" expected
    ("model server error (stream)", stream_error("gateway_error"), "The AI service had a problem", True),
    ("gateway down (HTTP 502)", http_error(502, "gateway_unreachable"), "The AI service isn't responding", True),
    ("provider rate limit (stream)", stream_error("gateway_busy"), "The AI service is busy", True),
    ("budget used up (stream)", stream_error("gateway_budget"), "The AI budget is used up", False),
    ("conversation too long (stream)", stream_error("context_too_long"), "This conversation is too long", False),
    ("model can't read images (stream)", stream_error("images_unsupported"), "The model can't read images", False),
    ("AI off for the account (HTTP 403)", http_error(403, "ai_access_denied"), "AI is turned off for your account", False),
    ("AI not set up (HTTP 403)", http_error(403, "ai_not_configured"), "The AI assistant isn't set up", False),
    ("expired session (403 without JSON)", http_error(403), "Your session has expired", False),
    ("bad attachment (HTTP 400)", http_error(400, "invalid_attachments"), "This attachment can't be sent", False),
    ("step limit (HTTP 409)", http_error(409, "ai_tool_call_limit_exceeded"), "Step limit reached", False),
    ("network down", "abort", "Can't reach LambdaTeX", True),
]

def handler_for(response):
    if response == "abort":
        return lambda route: route.abort("failed")
    return lambda route: route.fulfill(**response)


NOTE_JS = """() => { const n = document.querySelector('.workbench-panel .workbench-error-notification'); if (!n) return null;
  return { text: n.innerText, retry: [...n.querySelectorAll('button')].some(b => b.innerText.trim() === 'Try again') } }"""

with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1500, "height": 950})
    pg.goto(B + "/login"); pg.fill('input[name="email"]', EMAIL); pg.fill('input[name="password"]', PW)
    pg.click('button[type="submit"]'); pg.wait_for_url("**/project")
    pg.goto(f"{B}/project/{pid}"); pg.wait_for_selector(".cm-content", timeout=120000); time.sleep(3)
    if not pg.locator(".workbench-panel .workbench-prompt-input-textarea").is_visible():
        pg.locator("button.ide-rail-tab-link", has_text="AI assistant").first.click(); time.sleep(2)
    consent = pg.locator(".workbench-consent-prompt button")
    if consent.count(): consent.last.click(); time.sleep(2)
    box = pg.locator(".workbench-panel .workbench-prompt-input-textarea")

    def ask(text):
        box.click(); box.fill(text); box.press("Enter")

    def wait_note(timeout=20):
        end = time.time() + timeout
        while time.time() < end:
            note = pg.evaluate(NOTE_JS)
            if note: return note
            time.sleep(0.2)
        return None

    def dismiss():
        pg.evaluate("""() => { const n = document.querySelector('.workbench-panel .workbench-error-notification');
          const b = n && [...n.querySelectorAll('button')].find(b => b.innerText.trim() !== 'Try again'); if (b) b.click() }""")
        time.sleep(0.5)

    for name, response, title, retry in SCENARIOS:
        pg.route("**/workbench/tex-gpt", handler_for(response))
        ask(f"Test: {name}")
        note = wait_note()
        pg.unroute("**/workbench/tex-gpt")
        ok = bool(note) and title in note["text"] and note["retry"] == retry and "Something's gone wrong" not in note["text"]
        check(name, ok, json.dumps(note)[:160] if note else "no notification")
        if name == "model server error (stream)":
            pg.locator(".workbench-panel").screenshot(path=os.path.join(OUT, "error-gateway.png"))
        dismiss()
    check("dismissing hides the message for good", pg.evaluate(NOTE_JS) is None and (time.sleep(2) or pg.evaluate(NOTE_JS) is None))

    # "Try again": the first attempt fails, the retry reaches the real server and gets a reply.
    hits = {"n": 0}
    def flaky(route):
        hits["n"] += 1
        if hits["n"] == 1:
            route.fulfill(**http_error(502, "gateway_unreachable"))
        else:
            route.continue_()
    pg.route("**/workbench/tex-gpt", flaky)
    ask("Reply with exactly these words: retry worked")
    note = wait_note()
    pg.locator(".workbench-panel .workbench-error-notification button", has_text="Try again").click()
    replied = False
    end = time.time() + 120
    while time.time() < end:
        txt = pg.evaluate("() => (document.querySelector('.workbench-panel .workbench-tab-content') || {}).innerText || ''")
        if "retry worked" in txt.lower().replace("reply with exactly these words: retry worked", ""):
            replied = True; break
        time.sleep(1)
    pg.unroute("**/workbench/tex-gpt")
    check("Try again sends the message again and the reply arrives", bool(note) and hits["n"] == 2 and replied and pg.evaluate(NOTE_JS) is None, f"requests={hits['n']} replied={replied}")
    pg.locator(".workbench-panel").screenshot(path=os.path.join(OUT, "error-retried.png"))
    b.close()

print("SUMMARY", results, "| all passed:", all(results.values()))
