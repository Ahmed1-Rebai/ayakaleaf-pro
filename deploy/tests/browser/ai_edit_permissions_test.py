"""Browser test: does the AI assistant ever change the document without the
user's permission? Runs in the Playwright image; see README.md here.

Manual (the default) must leave the document alone until Apply, and Reject must
keep it unchanged. Auto must apply new edits by itself, with Undo. An edit left
pending must never be applied by itself: not when Auto is switched on, not after
a reload with Auto on, and not when its conversation is reopened. Creates a
project "aiperm" and deletes it (and its conversations) afterwards."""
import atexit, io, os, re, time, zipfile, requests
from playwright.sync_api import sync_playwright

B = os.environ.get("OL_URL", "http://127.0.0.1:8001")
EMAIL, PW = os.environ["OL_EMAIL"], os.environ["OL_PW"]
OUT = os.environ.get("LT_TEST_DIR", "/tmp/lambdatex-tests"); os.makedirs(OUT, exist_ok=True)
DOC = "\\documentclass{article}\n\\begin{document}\nAlpha line.\n\nBeta line.\n\nGamma line.\n\\end{document}\n"
ONLY = " using one replace_lines call. Do not compile and do not do anything else."
results = {}


def check(name, ok, detail=""):
    results[name] = bool(ok); print(f"{'PASS' if ok else 'FAIL'} {name} {detail}", flush=True)


s = requests.Session()
tok = lambda path: re.search(r'name="ol-csrfToken" content="([^"]+)"', s.get(B + path).text).group(1)
s.post(B + "/login", json={"email": EMAIL, "password": PW}, headers={"X-Csrf-Token": tok("/login")})
s.headers["X-Csrf-Token"] = tok("/project")
buf = io.BytesIO(); zipfile.ZipFile(buf, "w").writestr("main.tex", DOC)
pid = s.post(B + "/project/new/upload", files={"qqfile": ("aiperm.zip", buf.getvalue(), "application/zip")}, data={"name": "aiperm.zip"}).json()["project_id"]


def cleanup():
    convs = s.get(f"{B}/workbench/conversations", params={"project_id": pid}).json().get("conversations", [])
    for c in convs:
        s.delete(f"{B}/workbench/conversations/{c['id']}")
    print("cleanup: conversations", len(convs), "| project ->", s.delete(f"{B}/project/{pid}").status_code)
atexit.register(cleanup)

# Cards still waiting for a decision show Reject + Apply (arrow icon).
PENDING_JS = """() => [...document.querySelectorAll('.workbench-panel .workbench-code-suggestion')].filter(card => {
  const groups = card.querySelectorAll('.workbench-code-diff-actions > div'); const g = groups[groups.length - 1];
  if (!g) return false; const b = g.querySelectorAll('button'); if (b.length !== 2) return false;
  const i = b[1].querySelector('.material-symbols'); return !!i && i.textContent.trim() === 'arrow_right_alt'; }).length"""
CLICK_PENDING_JS = """(which) => { const cards = [...document.querySelectorAll('.workbench-panel .workbench-code-suggestion')].reverse();
  for (const card of cards) { const groups = card.querySelectorAll('.workbench-code-diff-actions > div'); const g = groups[groups.length - 1];
    const b = g ? g.querySelectorAll('button') : []; if (b.length === 2) { b[which].click(); return true } } return false }"""
CLICK_UNDO_JS = """() => { const b = [...document.querySelectorAll('.workbench-panel .workbench-code-suggestion button')]
  .filter(b => { const i = b.querySelector('.material-symbols'); return i && i.textContent.trim() === 'undo' }); if (!b.length) return false; b[b.length - 1].click(); return true }"""
CLICK_ICON_JS = """(icon) => { const b = [...document.querySelectorAll('.workbench-panel button')].find(b =>
  [...b.querySelectorAll('.material-symbols')].some(i => i.textContent.trim() === icon)); if (!b) return false; b.click(); return true }"""


def doc_text(pg):
    return pg.evaluate("() => [...document.querySelectorAll('.cm-content .cm-line')].map(l => l.textContent).join('\\n')")


def wait_for(fn, timeout, step=0.5):
    end = time.time() + timeout
    while time.time() < end:
        if fn(): return True
        time.sleep(step)
    return False


def ask(pg, text):
    box = pg.locator(".workbench-panel .workbench-prompt-input-textarea")
    box.click(); box.fill(text); box.press("Enter")


def saved_parts():
    convs = s.get(f"{B}/workbench/conversations", params={"project_id": pid}).json()["conversations"]
    if not convs: return []
    msgs = s.get(f"{B}/workbench/conversations/{convs[0]['id']}").json()["messages"]
    return [p for m in msgs if m["role"] == "assistant" for p in m["parts"]]


def turn_finished():
    parts = saved_parts()
    return bool(parts) and parts[-1]["type"] == "text" and not any(p.get("state") == "input-available" for p in parts if p["type"].startswith("tool-"))


def open_editor(pg):
    pg.goto(f"{B}/project/{pid}"); pg.wait_for_selector(".cm-content", timeout=120000); time.sleep(3)
    if not pg.locator(".workbench-panel .workbench-prompt-input-textarea").is_visible():
        pg.locator("button.ide-rail-tab-link", has_text="AI assistant").first.click(); time.sleep(2)
    consent = pg.locator(".workbench-consent-prompt button")
    if consent.count(): consent.last.click(); time.sleep(2)
    pg.wait_for_selector(".workbench-panel .lt-ai-mode", timeout=30000); time.sleep(2)


def mode(pg):
    return pg.evaluate("() => (document.querySelector('.lt-ai-mode-option[aria-checked=\"true\"]') || {}).dataset?.mode")


with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={"width": 1600, "height": 1000}); pg = ctx.new_page()
    pg.goto(B + "/login"); pg.fill('input[name="email"]', EMAIL); pg.fill('input[name="password"]', PW)
    pg.click('button[type="submit"]'); pg.wait_for_url("**/project")
    open_editor(pg)
    check("Manual is the default", mode(pg) == "manual" and pg.evaluate("() => localStorage.getItem('lambdatex.aiEditMode')") is None, str(mode(pg)))

    # ---------- Manual + Reject
    ask(pg, "Replace line 3 'Alpha line.' with 'Alpha REJECTED.'" + ONLY)
    got = wait_for(lambda: pg.evaluate(PENDING_JS) > 0, 180)
    time.sleep(8)
    check("Manual: edit proposed, document unchanged while waiting", got and "REJECTED" not in doc_text(pg))
    pg.evaluate(CLICK_PENDING_JS, 0)  # Reject
    for _ in range(2):  # the model may propose again after a rejection; reject that too
        wait_for(lambda: turn_finished() or pg.evaluate(PENDING_JS) > 0, 120, 2)
        if pg.evaluate(PENDING_JS) > 0: pg.evaluate(CLICK_PENDING_JS, 0)
    wait_for(turn_finished, 120, 2); time.sleep(2)
    check("Manual: Reject keeps the document unchanged", "REJECTED" not in doc_text(pg) and "Alpha line." in doc_text(pg))

    # ---------- Manual + Apply
    ask(pg, "Replace line 5 'Beta line.' with 'Beta APPLIED.'" + ONLY)
    got = wait_for(lambda: pg.evaluate(PENDING_JS) > 0, 180)
    time.sleep(6)
    unchanged = "APPLIED" not in doc_text(pg)
    pg.evaluate(CLICK_PENDING_JS, 1)  # Apply
    check("Manual: nothing changes before Apply, Apply changes it", got and unchanged and wait_for(lambda: "Beta APPLIED." in doc_text(pg), 20))
    wait_for(turn_finished, 120, 2)

    # ---------- an edit left pending
    ask(pg, "Replace line 7 'Gamma line.' with 'Gamma STALE.'" + ONLY)
    got = wait_for(lambda: pg.evaluate(PENDING_JS) > 0, 180)
    saved = wait_for(lambda: any(p["type"] == "tool-replace_lines" and p.get("state") == "input-available" for p in saved_parts()), 60, 2)
    print("pending edit shown:", got, "| saved as pending:", saved)

    pg.locator('.lt-ai-mode-option[data-mode="auto"]').click(); time.sleep(10)
    check("Switching to Auto does not apply an edit already waiting", "STALE" not in doc_text(pg))

    pg.reload(); open_editor(pg); time.sleep(12)
    restored = pg.evaluate(PENDING_JS)
    check("After a reload in Auto, the restored pending edit is not applied", "STALE" not in doc_text(pg) and mode(pg) == "auto",
          f"restored pending cards: {restored}, mode: {mode(pg)}")
    pg.screenshot(path=os.path.join(OUT, "perm-after-reload.png"))

    # ---------- Auto with a new request
    pg.evaluate(CLICK_ICON_JS, "edit_square"); time.sleep(2)  # New conversation
    ask(pg, "Replace line 3 'Alpha line.' with 'Alpha AUTO.'" + ONLY)
    applied = wait_for(lambda: "Alpha AUTO." in doc_text(pg), 180)
    check("Auto: a new edit is applied without a click", applied)
    time.sleep(3)
    undo = pg.evaluate(CLICK_UNDO_JS)
    check("Auto: Undo restores the previous text", undo and wait_for(lambda: "Alpha line." in doc_text(pg) and "Alpha AUTO." not in doc_text(pg), 20))
    wait_for(turn_finished, 120, 2)

    # ---------- reopening the conversation with the pending edit, in Auto
    pg.evaluate(CLICK_ICON_JS, "history"); pg.wait_for_selector(".workbench-conversations", timeout=15000); time.sleep(2)
    pg.locator(".workbench-conversation-open", has_text="REJECTED").first.click(); time.sleep(12)
    check("Reopening a conversation in Auto does not apply its pending edit", "STALE" not in doc_text(pg),
          f"pending cards shown: {pg.evaluate(PENDING_JS)}")
    pg.screenshot(path=os.path.join(OUT, "perm-reopened.png"))
    print("final document:", doc_text(pg).replace("\n", " | "))
    b.close()

print("SUMMARY", results, "| all passed:", all(results.values()))
