"""Browser test for the AI assistant's Manual / Auto edit mode (lambdatex.js) and the
reasoning-history patch (deploy/patches/). Runs in the Playwright image; see deploy/tests/browser/README.md.
Creates a project named "aimode", checks Manual (nothing changes until Apply) and Auto (applied
with no click, Undo shown), then deletes the "aimode*" projects."""
import io, os, re, time, zipfile, requests
from playwright.sync_api import sync_playwright
B = os.environ.get("OL_URL", "http://127.0.0.1:8001"); EMAIL, PW = os.environ["OL_EMAIL"], os.environ["OL_PW"]
OUT = os.environ.get("LT_TEST_DIR", "/tmp/lambdatex-tests"); os.makedirs(OUT, exist_ok=True)
DOC = "\\documentclass{article}\n\\begin{document}\nHello.\n\n\\begin{itemiz}\n\\item one\n\\end{itemiz}\n\\end{document}\n"

# --- create the test project over HTTP
s = requests.Session()
tok = lambda path: re.search(r'name="ol-csrfToken" content="([^"]+)"', s.get(B + path).text).group(1)
s.post(B + "/login", json={"email": EMAIL, "password": PW}, headers={"X-Csrf-Token": tok("/login")})
s.headers["X-Csrf-Token"] = tok("/project")
buf = io.BytesIO(); zipfile.ZipFile(buf, "w").writestr("main.tex", DOC)
pid = s.post(B + "/project/new/upload", files={"qqfile": ("aimode.zip", buf.getvalue(), "application/zip")}, data={"name": "aimode.zip"}).json()["project_id"]
print("test project", pid)


PENDING_JS = """() => [...document.querySelectorAll('.workbench-panel .workbench-code-suggestion')].filter(card => {
  const groups = card.querySelectorAll('.workbench-code-diff-actions > div'); const g = groups[groups.length - 1];
  if (!g) return false; const b = g.querySelectorAll('button'); if (b.length !== 2) return false;
  const i = b[1].querySelector('.material-symbols'); return !!i && i.textContent.trim() === 'arrow_right_alt'; }).length"""
UNDO_JS = """() => [...document.querySelectorAll('.workbench-panel .workbench-code-suggestion .workbench-code-diff-actions button')].filter(b => { const i = b.querySelector('.material-symbols'); return i && i.textContent.trim() === 'undo'; }).length"""
def wait_for(pg, js, timeout):
    end = time.time() + timeout
    while time.time() < end:
        if pg.evaluate(js): return True
        time.sleep(0.5)
    return False
def dump(pg, name):
    pg.locator(".workbench-panel").screenshot(path=os.path.join(OUT, name + ".png"))
    print(name, "panel text:", pg.locator(".workbench-panel").inner_text()[-500:].replace("\n", " | "))

def doc_text(pg):
    return pg.evaluate("() => [...document.querySelectorAll('.cm-content .cm-line')].map(l => l.textContent).join('\\n')")

def ask(pg, text):
    box = pg.locator(".workbench-panel .workbench-prompt-input-textarea")
    box.click(); box.fill(text); box.press("Enter")

with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1600, "height": 1000})
    pg.goto(B + "/login"); pg.fill('input[name="email"]', EMAIL); pg.fill('input[name="password"]', PW)
    pg.click('button[type="submit"]'); pg.wait_for_url("**/project")
    pg.goto(f"{B}/project/{pid}")
    try:
        pg.wait_for_selector(".cm-content", timeout=90000)
    except Exception:
        pg.screenshot(path=os.path.join(OUT, "fail-editor.png")); print("EDITOR NOT LOADED; url:", pg.url, "| title:", pg.title()); raise
    time.sleep(3)
    pg.locator('button.ide-rail-tab-link', has_text="AI assistant").first.click()
    time.sleep(2)
    consent = pg.locator(".workbench-consent-prompt button")
    if consent.count():
        consent.last.click(); print("accepted AI consent"); time.sleep(2)
    pg.wait_for_selector(".workbench-panel .lt-ai-mode", timeout=30000)
    state = lambda: pg.evaluate("() => [...document.querySelectorAll('.lt-ai-mode-option')].map(b => b.dataset.mode + '=' + b.getAttribute('aria-checked')).join(' ')")
    print("switch present; state:", state())
    pg.locator(".workbench-panel .workbench-prompt-input").screenshot(path=os.path.join(OUT, "prompt-manual.png"))

    # ---------- MANUAL: nothing changes until Apply is clicked
    ask(pg, "Fix the LaTeX error in main.tex: the environment is misspelled 'itemiz' on lines 5 and 7. Use one replace_lines call for lines 5-7. Do not compile.")
    if not wait_for(pg, PENDING_JS, 150):
        dump(pg, "fail-manual"); raise SystemExit("no pending suggestion appeared")
    time.sleep(5)
    t = doc_text(pg); print("MANUAL pending -> doc unchanged:", "itemiz}" in t and "itemize}" not in t)
    pg.locator(".workbench-panel").screenshot(path=os.path.join(OUT, "manual-pending.png"))
    pg.evaluate("""() => { const cards = [...document.querySelectorAll('.workbench-panel .workbench-code-suggestion')];
      for (const card of cards.reverse()) { const groups = card.querySelectorAll('.workbench-code-diff-actions > div'); const g = groups[groups.length - 1];
        const b = g ? g.querySelectorAll('button') : []; if (b.length === 2) { b[1].click(); return true; } } return false; }""")
    for _ in range(40):
        if "itemize}" in doc_text(pg): break
        time.sleep(0.5)
    t = doc_text(pg); print("MANUAL after Apply -> fixed:", "itemize}" in t and "itemiz}" not in t.replace("itemize}", ""))
    pg.wait_for_function("() => !document.querySelector('.workbench-panel .workbench-submit-active') ", timeout=120000) if False else time.sleep(8)

    # ---------- AUTO: applied without any click
    pg.locator('.lt-ai-mode-option[data-mode="auto"]').click(); time.sleep(0.5)
    print("switched; state:", state(), "| stored:", pg.evaluate("() => localStorage.getItem('lambdatex.aiEditMode')"))
    pg.locator(".workbench-panel .workbench-prompt-input").screenshot(path=os.path.join(OUT, "prompt-auto.png"))
    ask(pg, "Now replace line 3 'Hello.' with 'Hello LambdaTeX.' using one replace_lines call. Do not compile.")
    ok = False
    for _ in range(240):
        if "Hello LambdaTeX." in doc_text(pg): ok = True; break
        time.sleep(0.5)
    print("AUTO -> applied with no click:", ok)
    if not ok: dump(pg, "fail-auto")
    time.sleep(3)
    undo = pg.evaluate(UNDO_JS); pending = pg.evaluate(PENDING_JS)
    print("AUTO -> Undo buttons:", undo, "| pending Apply buttons:", pending)
    pg.locator(".workbench-panel").screenshot(path=os.path.join(OUT, "auto-applied.png"))
    b.close()

for proj in s.get(B + "/user/projects").json()["projects"]:
    if re.match(r'^aimode( \(\d+\))?$', proj["name"]):
        print("cleanup", proj["name"], "->", s.delete(f"{B}/project/{proj['_id']}").status_code)
