"""Browser test for saved AI conversations (Conversations list, New conversation,
open, resume after reload, rename, delete). Runs in the Playwright image; see
README.md here. Creates a project "convui" and deletes it afterwards."""
import atexit, io, os, re, time, zipfile, requests
from playwright.sync_api import sync_playwright

B = os.environ.get("OL_URL", "http://127.0.0.1:8001")
EMAIL, PW = os.environ["OL_EMAIL"], os.environ["OL_PW"]
OUT = os.environ.get("LT_TEST_DIR", "/tmp/lambdatex-tests"); os.makedirs(OUT, exist_ok=True)
results = {}

def check(name, ok, detail=""):
    results[name] = bool(ok); print(f"{'PASS' if ok else 'FAIL'} {name} {detail}", flush=True)

# --- project over HTTP
s = requests.Session()
tok = lambda path: re.search(r'name="ol-csrfToken" content="([^"]+)"', s.get(B + path).text).group(1)
s.post(B + "/login", json={"email": EMAIL, "password": PW}, headers={"X-Csrf-Token": tok("/login")})
s.headers["X-Csrf-Token"] = tok("/project")
buf = io.BytesIO(); zipfile.ZipFile(buf, "w").writestr("main.tex", "\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n")
pid = s.post(B + "/project/new/upload", files={"qqfile": ("convui.zip", buf.getvalue(), "application/zip")}, data={"name": "convui.zip"}).json()["project_id"]
atexit.register(lambda: print("cleanup project ->", s.delete(f"{B}/project/{pid}").status_code))  # also after a failure

CLICK_ICON = """([scope, icon]) => { const root = document.querySelector(scope); if (!root) return false;
  const b = [...root.querySelectorAll('button')].find(b => [...b.querySelectorAll('.material-symbols')].some(i => i.textContent.trim() === icon));
  if (!b) return false; b.click(); return true; }"""

def click_icon(pg, scope, icon):
    return pg.evaluate(CLICK_ICON, [scope, icon])

ROW_ICON = """([name, icon]) => { const li = [...document.querySelectorAll('.workbench-conversation')]
  .find(li => ((li.querySelector('.workbench-conversation-name') || {}).textContent || '').toLowerCase().includes(name));
  if (!li) return false; const b = [...li.querySelectorAll('button')].find(b => [...b.querySelectorAll('.material-symbols')].some(i => i.textContent.trim() === icon));
  if (!b) return false; b.click(); return true; }"""

def click_row_icon(pg, name, icon):
    return pg.evaluate(ROW_ICON, [name, icon])

def panel_text(pg):
    return pg.evaluate("() => (document.querySelector('.workbench-panel .workbench-tab-content') || {}).innerText || ''")

def ask_and_wait(pg, prompt, expect, timeout=180):
    box = pg.locator(".workbench-panel .workbench-prompt-input-textarea")
    box.click(); box.fill(prompt); box.press("Enter")
    end = time.time() + timeout
    while time.time() < end:
        if expect.lower() in panel_text(pg).lower().replace(prompt.lower(), ""): return True
        time.sleep(1)
    return False

def open_panel(pg):
    pg.goto(f"{B}/project/{pid}"); pg.wait_for_selector(".cm-content", timeout=90000); time.sleep(2)
    if not pg.locator(".workbench-panel .workbench-prompt-input-textarea").is_visible():
        pg.locator("button.ide-rail-tab-link", has_text="AI assistant").first.click()
    pg.wait_for_selector(".workbench-panel .workbench-prompt-input-textarea", timeout=30000); time.sleep(2)

def list_items(pg):
    return pg.evaluate("() => [...document.querySelectorAll('.workbench-conversation')].map(li => ({ title: (li.querySelector('.workbench-conversation-name') || {}).textContent || '', active: li.classList.contains('active') }))")

with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1600, "height": 1000})
    pg.goto(B + "/login"); pg.fill('input[name="email"]', EMAIL); pg.fill('input[name="password"]', PW)
    pg.click('button[type="submit"]'); pg.wait_for_url("**/project")
    open_panel(pg)
    check("Conversations button in header", pg.evaluate("() => [...document.querySelectorAll('.workbench-panel button .material-symbols')].some(i => i.textContent.trim() === 'history')"))

    check("first conversation replies", ask_and_wait(pg, "Reply with exactly these words: alpha conversation", "alpha conversation"))
    time.sleep(3)
    click_icon(pg, ".workbench-panel", "edit_square"); time.sleep(2)
    check("New conversation starts empty", "alpha conversation" not in panel_text(pg).lower())
    check("second conversation replies", ask_and_wait(pg, "Reply with exactly these words: beta conversation", "beta conversation"))
    time.sleep(3)

    click_icon(pg, ".workbench-panel", "history"); pg.wait_for_selector(".workbench-conversations", timeout=15000); time.sleep(2)
    items = list_items(pg)
    check("list shows both, newest first, active marked", len(items) == 2 and "beta" in items[0]["title"].lower() and items[0]["active"] and "alpha" in items[1]["title"].lower(), str(items))
    pg.locator(".workbench-panel").screenshot(path=os.path.join(OUT, "conversations-list.png"))

    pg.locator(".workbench-conversation-open", has_text="alpha").first.click(); time.sleep(3)
    t = panel_text(pg).lower()
    check("open restores the first conversation", "alpha conversation" in t and "beta conversation" not in t)

    open_panel(pg)  # full page reload
    time.sleep(3)
    check("reload resumes the last conversation", "alpha conversation" in panel_text(pg).lower())

    click_icon(pg, ".workbench-panel", "history"); pg.wait_for_selector(".workbench-conversations", timeout=15000); time.sleep(2)
    click_row_icon(pg, "alpha", "edit"); time.sleep(0.5)
    pg.locator(".workbench-conversation-rename").fill("Project kickoff notes"); pg.keyboard.press("Enter"); time.sleep(2)
    names = [i["title"] for i in list_items(pg)]
    check("rename", "Project kickoff notes" in names, str(names))
    server = s.get(f"{B}/workbench/conversations", params={"project_id": pid}).json()["conversations"]
    check("rename persisted on the server", any(c["title"] == "Project kickoff notes" for c in server))

    click_row_icon(pg, "beta", "delete"); time.sleep(0.5)
    pg.locator(".workbench-conversation-confirm button", has_text="Delete").click(); time.sleep(2)
    check("delete another conversation", len(list_items(pg)) == 1)
    pg.locator(".workbench-panel").screenshot(path=os.path.join(OUT, "conversations-after-delete.png"))

    click_icon(pg, ".workbench-conversation", "delete"); time.sleep(0.5)
    pg.locator(".workbench-conversation-confirm button", has_text="Delete").click(); time.sleep(2)
    check("delete the active one resets to an empty chat", pg.locator(".workbench-conversations").count() == 0 and "alpha conversation" not in panel_text(pg).lower())
    server = s.get(f"{B}/workbench/conversations", params={"project_id": pid}).json()["conversations"]
    check("server list empty afterwards", server == [], str(server))
    b.close()

print("SUMMARY", results, "| all passed:", all(results.values()))
