"""Browser test for the automatic TeX engine choice, through the AI assistant and the
Recompile button. Runs in the Playwright image; see README.md here.

A project set to pdfLaTeX is opened, the assistant (Auto mode) is asked to set Arial as
the main font with fontspec (pdfLaTeX has no Arial); it must edit and compile once, the compile must
switch to XeLaTeX by itself (no set_compiler call) and produce a PDF. Then the
compiler is forced back to pdfLaTeX and the Recompile button must still produce a
PDF. Creates a project "aiengine" and deletes it afterwards."""
import atexit, io, json, os, re, time, zipfile, requests
from playwright.sync_api import sync_playwright

B = os.environ.get("OL_URL", "http://127.0.0.1:8001")
EMAIL, PW = os.environ["OL_EMAIL"], os.environ["OL_PW"]
OUT = os.environ.get("LT_TEST_DIR", "/tmp/lambdatex-tests"); os.makedirs(OUT, exist_ok=True)
DOC = "\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n\\section{Engines}\nThe quick brown fox jumps over the lazy dog.\n\\end{document}\n"
results = {}


def check(name, ok, detail=""):
    results[name] = bool(ok); print(f"{'PASS' if ok else 'FAIL'} {name} {detail}", flush=True)


s = requests.Session()
tok = lambda path: re.search(r'name="ol-csrfToken" content="([^"]+)"', s.get(B + path).text).group(1)
s.post(B + "/login", json={"email": EMAIL, "password": PW}, headers={"X-Csrf-Token": tok("/login")})
s.headers["X-Csrf-Token"] = tok("/project")
buf = io.BytesIO(); zipfile.ZipFile(buf, "w").writestr("main.tex", DOC)
pid = s.post(B + "/project/new/upload", files={"qqfile": ("aiengine.zip", buf.getvalue(), "application/zip")}, data={"name": "aiengine.zip"}).json()["project_id"]
atexit.register(lambda: print("cleanup project ->", s.delete(f"{B}/project/{pid}").status_code))  # also after a failure
assert s.post(f"{B}/project/{pid}/settings", json={"compiler": "pdflatex"}).status_code == 204


def doc_text(pg):
    return pg.evaluate("() => [...document.querySelectorAll('.cm-content .cm-line')].map(l => l.textContent).join('\\n')")


def no_pdf_error(pg):
    return pg.evaluate("() => /produce a PDF/.test(document.body.innerText)")


def latest_conversation():
    convs = s.get(f"{B}/workbench/conversations", params={"project_id": pid}).json()["conversations"]
    return s.get(f"{B}/workbench/conversations/{convs[0]['id']}").json() if convs else None


def tool_parts(conversation):
    return [p for m in conversation["messages"] if m["role"] == "assistant" for p in m["parts"] if p["type"].startswith("tool-")]


def finished(conversation):
    if not conversation: return False
    last = conversation["messages"][-1]
    return last["role"] == "assistant" and last["parts"] and last["parts"][-1]["type"] == "text" and \
        all(p.get("state") in ("output-available", "output-error") for p in tool_parts(conversation))


with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1600, "height": 1000})
    pg.goto(B + "/login"); pg.fill('input[name="email"]', EMAIL); pg.fill('input[name="password"]', PW)
    pg.click('button[type="submit"]'); pg.wait_for_url("**/project")
    pg.goto(f"{B}/project/{pid}"); pg.wait_for_selector(".cm-content", timeout=90000); time.sleep(3)
    if not pg.locator(".workbench-panel .workbench-prompt-input-textarea").is_visible():
        pg.locator("button.ide-rail-tab-link", has_text="AI assistant").first.click(); time.sleep(2)
    consent = pg.locator(".workbench-consent-prompt button")
    if consent.count(): consent.last.click(); time.sleep(2)
    pg.wait_for_selector(".workbench-panel .lt-ai-mode", timeout=30000)
    pg.locator('.lt-ai-mode-option[data-mode="auto"]').click(); time.sleep(0.5)

    # ---------- the assistant: switch to a system font, compile once
    box = pg.locator(".workbench-panel .workbench-prompt-input-textarea")
    box.click(); box.fill("Set Arial as the main font of this document with fontspec, then compile once to check it builds."); box.press("Enter")
    t0, conv = time.time(), None
    while time.time() - t0 < 300:
        conv = latest_conversation()
        if finished(conv) and any(p["type"] == "tool-compile" for p in tool_parts(conv)): break
        time.sleep(3)
    time.sleep(4); conv = latest_conversation()
    parts = tool_parts(conv) if conv else []
    names = [p["type"][5:] for p in parts]
    compiles = [p.get("output") or {} for p in parts if p["type"] == "tool-compile"]
    text = doc_text(pg)
    print("tool calls:", names, f"({time.time() - t0:.0f}s)")
    print("compile results:", [{k: c.get(k) for k in ("compiler", "error")} | {"errors": sum(d.get("severity") == "error" for d in c.get("diagnostics", []))} for c in compiles])
    pg.locator(".workbench-panel").screenshot(path=os.path.join(OUT, "engine-assistant.png"))
    pg.screenshot(path=os.path.join(OUT, "engine-editor.png"))
    check("assistant added fontspec + Arial", "fontspec" in text and "Arial" in text)
    check("assistant compiled", bool(compiles), f"{len(compiles)} compile(s)")
    check("compile switched to XeLaTeX by itself", compiles and compiles[-1].get("compiler") == "xelatex" and not compiles[-1].get("error"),
          json.dumps({k: compiles[-1].get(k) for k in ("compiler", "error")}) if compiles else "")
    check("no set_compiler call needed", "set_compiler" not in names)
    check("no 'didn't produce a PDF' in the editor", not no_pdf_error(pg))
    final = conv["messages"][-1]["parts"][-1]["text"] if conv else ""
    print("assistant said:", final[:300].replace("\n", " "))

    # ---------- Recompile button with the compiler forced back to pdfLaTeX
    assert s.post(f"{B}/project/{pid}/settings", json={"compiler": "pdflatex"}).status_code == 204
    time.sleep(2)
    pg.get_by_role("button", name=re.compile("^Recompile")).first.click()
    time.sleep(2)
    for _ in range(90):
        if pg.evaluate("() => !/Compiling/.test(document.querySelector('.pdf-preview, .ide-redesign-pdf-preview, body').innerText)"): break
        time.sleep(1)
    time.sleep(3)
    pg.screenshot(path=os.path.join(OUT, "engine-recompile.png"))
    check("Recompile button: PDF, no error", not no_pdf_error(pg) and pg.locator(".pdfjs-viewer-inner canvas, .pdf-viewer canvas, .pdfViewer .page").count() > 0)
    b.close()

j = s.post(f"{B}/project/{pid}/compile", json={"rootDoc_id": None, "draft": False, "check": "silent", "incrementalCompilesEnabled": True}).json()
log = next((s.get(B + f["url"]).text for f in j.get("outputFiles", []) if f["path"] == "output.log"), "")
check("project now builds with XeLaTeX", j.get("status") == "success" and log.startswith("This is XeTeX"), f"{j.get('status')} | {log[:40]!r}")
print("SUMMARY", results, "| all passed:", all(results.values()))
