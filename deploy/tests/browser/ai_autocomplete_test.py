"""Browser test for AI autocomplete in the editor (ghost text). Runs in the
Playwright image; see README.md here. Creates a project "acui" and deletes it."""
import atexit, io, os, re, time, zipfile, requests
from playwright.sync_api import sync_playwright

B = os.environ.get("OL_URL", "http://127.0.0.1:8001")
EMAIL, PW = os.environ["OL_EMAIL"], os.environ["OL_PW"]
OUT = os.environ.get("LT_TEST_DIR", "/tmp/lambdatex-tests"); os.makedirs(OUT, exist_ok=True)
DOC = "\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\nDeep learning has transformed natural language processing.\n\n\\end{document}\n"
results = {}


def check(name, ok, detail=""):
    results[name] = bool(ok); print(f"{'PASS' if ok else 'FAIL'} {name} {detail}", flush=True)


s = requests.Session()
tok = lambda path: re.search(r'name="ol-csrfToken" content="([^"]+)"', s.get(B + path).text).group(1)
s.post(B + "/login", json={"email": EMAIL, "password": PW}, headers={"X-Csrf-Token": tok("/login")})
s.headers["X-Csrf-Token"] = tok("/project")
buf = io.BytesIO(); zipfile.ZipFile(buf, "w").writestr("main.tex", DOC)
pid = s.post(B + "/project/new/upload", files={"qqfile": ("acui.zip", buf.getvalue(), "application/zip")}, data={"name": "acui.zip"}).json()["project_id"]
atexit.register(lambda: print("cleanup project ->", s.delete(f"{B}/project/{pid}").status_code))

GHOST_JS = """() => { const g = document.querySelector('.cm-content .ol-cm-ai-ghost'); if (!g) return null;
  const hint = g.querySelector('.ol-cm-ai-ghost-hint'); return g.textContent.slice(0, g.textContent.length - (hint ? hint.textContent.length : 0)) }"""


def doc_text(pg):
    # the ghost text is a widget inside the line: leave it out, it is not in the document
    return pg.evaluate("""() => [...document.querySelectorAll('.cm-content .cm-line')].map(l => {
      const c = l.cloneNode(true); c.querySelectorAll('.ol-cm-ai-ghost, .ol-cm-ai-fix-new, .ol-cm-ai-ghost-hint').forEach(g => g.remove()); return c.textContent }).join('\\n')""")


def ghost(pg):
    return pg.evaluate(GHOST_JS)


def wait_ghost(pg, timeout=12):
    end = time.time() + timeout
    while time.time() < end:
        g = ghost(pg)
        if g: return g
        time.sleep(0.2)
    return None


def put_cursor_on_empty_line(pg):
    lines = pg.locator(".cm-content .cm-line")
    for i in range(lines.count()):
        if lines.nth(i).inner_text().strip() == "":
            lines.nth(i).click(); return True
    return False


with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1500, "height": 950})
    pg.goto(B + "/login"); pg.fill('input[name="email"]', EMAIL); pg.fill('input[name="password"]', PW)
    pg.click('button[type="submit"]'); pg.wait_for_url("**/project")
    # a second browser session (same account), used as a collaborator
    ctx2 = b.new_context(viewport={"width": 1200, "height": 800}); login2 = ctx2.new_page()
    login2.goto(B + "/login"); login2.fill('input[name="email"]', EMAIL); login2.fill('input[name="password"]', PW)
    login2.click('button[type="submit"]'); login2.wait_for_url("**/project"); login2.close()
    pg.goto(f"{B}/project/{pid}"); pg.wait_for_selector(".cm-content", timeout=120000); time.sleep(4)

    # ---------- suggestion appears, Tab accepts
    put_cursor_on_empty_line(pg)
    pg.keyboard.type("In this paper, we ", delay=40)
    t0 = time.time(); g = wait_ghost(pg); shown_after = time.time() - t0
    check("ghost text appears after a pause in typing", bool(g), f"{shown_after:.1f}s {g!r}")
    pg.screenshot(path=os.path.join(OUT, "autocomplete-ghost.png"))
    before = doc_text(pg)
    check("the document is unchanged while the suggestion is shown", g is not None and g not in before)
    pg.keyboard.press("Tab"); time.sleep(0.5)
    after = doc_text(pg)
    check("Tab inserts the suggestion", g is not None and ("In this paper, we " + g) in after and ghost(pg) is None)

    # ---------- corrections: shown struck out with the fix, Tab applies them with the completion
    FIX_JS = """() => ({ old: [...document.querySelectorAll('.cm-content .ol-cm-ai-fix-old')].map(e => e.textContent),
      fix: [...document.querySelectorAll('.cm-content .ol-cm-ai-fix-new')].map(e => e.textContent) })"""
    pg.keyboard.press("End"); pg.keyboard.press("Enter")
    pg.keyboard.type("In this papr, we ", delay=40)
    shown = None
    for _ in range(60):
        shown = pg.evaluate(FIX_JS)
        if shown["old"]: break
        time.sleep(0.2)
    check("a typo is shown struck out with its fix", shown["old"] == ["papr"] and shown["fix"] == ["paper"], str(shown))
    pg.screenshot(path=os.path.join(OUT, "autocomplete-correction.png"))
    completion = ghost(pg) or ""
    pg.keyboard.press("Tab"); time.sleep(0.5)
    line = ([l for l in doc_text(pg).split("\n") if l.startswith("In this pap")] or [""])[-1]  # the line just corrected
    check("Tab applies the fix and the completion", line == "In this paper, we " + completion and not pg.evaluate(FIX_JS)["old"], repr(line))

    # ---------- Esc dismisses, document unchanged
    pg.keyboard.press("End"); pg.keyboard.press("Enter"); pg.keyboard.press("Enter")
    pg.keyboard.type("Our experiments show that ", delay=40)
    g = wait_ghost(pg)
    before = doc_text(pg)
    pg.keyboard.press("Escape"); time.sleep(0.4)
    check("Esc dismisses the suggestion and changes nothing", bool(g) and ghost(pg) is None and doc_text(pg) == before, f"{g!r}")

    # ---------- typing the suggested characters keeps the rest
    pg.keyboard.type("the proposed ", delay=40)
    g = wait_ghost(pg)
    kept = None
    if g and len(g.lstrip()) > 3:
        first = g[0] if g[0] != " " else g[:2]
        pg.keyboard.type(first, delay=40); time.sleep(0.3)
        kept = ghost(pg)
    check("typing the suggested characters keeps the rest of it", bool(kept) and g.startswith(first) and kept == g[len(first):], f"{g!r} -> {kept!r}")
    pg.keyboard.press("Escape")

    # ---------- a collaborator's edit elsewhere keeps the suggestion
    pg.keyboard.press("End"); pg.keyboard.press("Enter")
    pg.keyboard.type("Large language models are ", delay=40)
    g = wait_ghost(pg)
    other = ctx2.new_page(); other.goto(f"{B}/project/{pid}"); other.wait_for_selector(".cm-content", timeout=120000); time.sleep(3)
    other.locator(".cm-content .cm-line").first.click(); other.keyboard.press("Home")
    other.keyboard.type("% note from a collaborator\n", delay=30); time.sleep(3)
    remote_seen = "note from a collaborator" in doc_text(pg)
    check("a collaborator's edit elsewhere keeps the suggestion", bool(g) and remote_seen and ghost(pg) == g, f"remote edit seen: {remote_seen}, ghost: {g!r} -> {ghost(pg)!r}")
    other.close()
    pg.keyboard.press("Escape")

    # ---------- no suggestion right after a word (only at word boundaries)
    pg.keyboard.press("End"); pg.keyboard.press("Enter")
    pg.keyboard.type("In this paper we", delay=40); time.sleep(3)
    check("no suggestion right after a word", ghost(pg) is None)
    pg.keyboard.press("End"); pg.keyboard.press("Enter")

    # ---------- no suggestion inside \\cite{...}
    pg.keyboard.press("End"); pg.keyboard.press("Enter")
    pg.keyboard.type("as shown in \\cite{", delay=40); time.sleep(3)
    check("no suggestion inside \\cite{...}", ghost(pg) is None)
    pg.keyboard.press("Escape")
    for _ in range(len("as shown in \\cite{}") + 2): pg.keyboard.press("Backspace")

    # ---------- Overleaf's own command completion still works, Tab included
    pg.keyboard.press("End"); pg.keyboard.press("Enter")
    pg.keyboard.type("\\subsec", delay=60); time.sleep(1.5)
    popup = pg.locator(".cm-tooltip-autocomplete").count() > 0
    pg.keyboard.press("Tab"); time.sleep(0.6)
    check("built-in command completion still works", popup and "\\subsection" in doc_text(pg), f"popup={popup}")
    pg.keyboard.press("Escape")

    # ---------- the corrections switch: completion still shown, no corrections
    OPEN_SETTINGS = """() => { const b = [...document.querySelectorAll('button')].find(b => [...b.querySelectorAll('.material-symbols')].some(i => i.textContent.trim() === 'settings')); if (b) b.click() }"""
    pg.evaluate(OPEN_SETTINGS); pg.wait_for_selector("#aiCorrections", timeout=15000); time.sleep(0.5)
    pg.locator("#aiCorrections").click(); time.sleep(0.3)
    pg.keyboard.press("Escape"); time.sleep(0.8)
    put_cursor_on_empty_line(pg)
    pg.keyboard.type("The resutls of our study show that ", delay=40)
    g = wait_ghost(pg)
    check("corrections switched off: completion only", bool(g) and not pg.evaluate(FIX_JS)["old"], f"{g!r} {pg.evaluate(FIX_JS)}")
    pg.keyboard.press("Escape")

    # ---------- the switch in Settings turns it off
    pg.evaluate(OPEN_SETTINGS)
    pg.wait_for_selector("#aiAutocomplete", timeout=15000); time.sleep(0.5)
    pg.screenshot(path=os.path.join(OUT, "autocomplete-setting.png"))
    pg.locator("#aiAutocomplete").click(); time.sleep(0.3)
    stored = pg.evaluate("() => localStorage.getItem('lambdatex.aiAutocomplete')")
    pg.keyboard.press("Escape"); time.sleep(0.8)
    put_cursor_on_empty_line(pg)
    pg.keyboard.type("Transformers are widely used because ", delay=40); time.sleep(3.5)
    check("switched off in Settings: no suggestions", stored == "off" and ghost(pg) is None, f"stored={stored}")

    # ---------- normal Tab when there is no suggestion
    before = doc_text(pg); pg.keyboard.press("Tab"); time.sleep(0.3)
    check("Tab still indents when there is no suggestion", doc_text(pg) != before)
    print("final document:", doc_text(pg).replace("\n", " | ")[:400])
    b.close()

print("SUMMARY", results, "| all passed:", all(results.values()))
