"""Captures the two real product screenshots used on the welcome page
(../lambdatex/welcome-editor.webp, ../lambdatex/welcome-assistant.webp).

Creates a demo project with textbook content, opens it in the editor, asks the AI
assistant (Auto mode) for a small edit and a compile, then screenshots the editor
and the assistant panel at 2x and converts them to WebP in the browser. The demo
project and its conversation are deleted afterwards.

Run in the Playwright image (see ../../tests/browser/README.md), with OUT=/out
pointing at a mounted folder; review the images before copying them into
../lambdatex/."""
import atexit, base64, io, os, re, time, zipfile, requests
from playwright.sync_api import sync_playwright

B = os.environ.get("OL_URL", "http://127.0.0.1:8001")
EMAIL, PW = os.environ["OL_EMAIL"], os.environ["OL_PW"]
OUT = os.environ.get("OUT", "/out"); os.makedirs(OUT, exist_ok=True)

DOC = r"""\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{booktabs}
\usepackage[hidelinks]{hyperref}

\title{Notes on Linear Regression}
\author{Example document}
\date{}

\begin{document}
\maketitle

\section{Introduction}
Linear regression models a response $y \in \mathbb{R}^n$ as a linear
function of the columns of a design matrix $X \in \mathbb{R}^{n \times p}$,
plus noise:
\begin{equation}
  y = X\beta + \varepsilon, \qquad \varepsilon \sim \mathcal{N}(0, \sigma^2 I).
\end{equation}

\section{Least squares}
The ordinary least squares estimate minimises the residual sum of squares.
When $X^\top X$ is invertible it has the closed form
\begin{equation}
  \hat{\beta} = (X^\top X)^{-1} X^\top y.
\end{equation}

\section{Regularisation}
Ridge regression adds a penalty on the size of the coefficients:
\begin{equation}
  \hat{\beta}_{\text{ridge}}
  = \operatorname*{arg\,min}_{\beta} \lVert y - X\beta \rVert_2^2 + \lambda \lVert \beta \rVert_2^2
  = (X^\top X + \lambda I)^{-1} X^\top y.
\end{equation}

\section{Loss functions}
\begin{table}[h]
  \centering
  \begin{tabular}{lll}
    \toprule
    Loss & Definition & Sensitivity to outliers \\
    \midrule
    Squared error & $(y - \hat{y})^2$ & High \\
    Absolute error & $\lvert y - \hat{y} \rvert$ & Low \\
    Huber & quadratic for $\lvert r \rvert \le \delta$, linear beyond & Moderate \\
    \bottomrule
  \end{tabular}
  \caption{Common regression losses, with residual $r = y - \hat{y}$.}
\end{table}

\end{document}
"""
PROMPT = "Below the ridge regression equation, add one short sentence on what λ controls, then compile. Reply in one sentence."

s = requests.Session()
tok = lambda path: re.search(r'name="ol-csrfToken" content="([^"]+)"', s.get(B + path).text).group(1)
s.post(B + "/login", json={"email": EMAIL, "password": PW}, headers={"X-Csrf-Token": tok("/login")})
s.headers["X-Csrf-Token"] = tok("/project")
buf = io.BytesIO(); zipfile.ZipFile(buf, "w").writestr("main.tex", DOC)
pid = s.post(B + "/project/new/upload", files={"qqfile": ("Linear regression notes.zip", buf.getvalue(), "application/zip")},
             data={"name": "Linear regression notes.zip"}).json()["project_id"]
s.post(f"{B}/project/{pid}/settings", json={"compiler": "pdflatex"})


def cleanup():
    convs = s.get(f"{B}/workbench/conversations", params={"project_id": pid}).json().get("conversations", [])
    for c in convs:
        s.delete(f"{B}/workbench/conversations/{c['id']}")
    print("cleanup: conversations", len(convs), "| project ->", s.delete(f"{B}/project/{pid}").status_code)
atexit.register(cleanup)


def finished():
    convs = s.get(f"{B}/workbench/conversations", params={"project_id": pid}).json()["conversations"]
    if not convs: return False
    msgs = s.get(f"{B}/workbench/conversations/{convs[0]['id']}").json()["messages"]
    parts = [p for m in msgs if m["role"] == "assistant" for p in m["parts"]]
    tools = [p for p in parts if p["type"].startswith("tool-")]
    return msgs[-1]["role"] == "assistant" and parts and parts[-1]["type"] == "text" and \
        any(p["type"] == "tool-compile" for p in tools) and all(p.get("state") == "output-available" for p in tools)


def to_webp(page, png, quality):
    src = "data:image/png;base64," + base64.b64encode(png).decode()
    url = page.evaluate("""async ([src, q]) => { const img = new Image(); img.src = src; await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0); return c.toDataURL('image/webp', q); }""", [src, quality])
    return base64.b64decode(url.split(",", 1)[1])


with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1440, "height": 1000}, device_scale_factor=2)
    pg = ctx.new_page()
    pg.goto(B + "/login"); pg.fill('input[name="email"]', EMAIL); pg.fill('input[name="password"]', PW)
    pg.click('button[type="submit"]'); pg.wait_for_url("**/project")
    pg.goto(f"{B}/project/{pid}")
    try:
        pg.wait_for_selector(".cm-content", timeout=120000)
    except Exception:
        pg.screenshot(path=os.path.join(OUT, "debug-editor.png")); print("editor not loaded:", pg.url, pg.title()); raise
    pg.wait_for_selector(".pdfjs-viewer-inner canvas, .pdfViewer .page canvas", timeout=90000); time.sleep(2)
    if not pg.locator(".workbench-panel .workbench-prompt-input-textarea").is_visible():
        pg.locator("button.ide-rail-tab-link", has_text="AI assistant").first.click(); time.sleep(2)
    consent = pg.locator(".workbench-consent-prompt button")
    if consent.count(): consent.last.click(); time.sleep(2)
    pg.locator('.lt-ai-mode-option[data-mode="auto"]').click(); time.sleep(0.5)
    box = pg.locator(".workbench-panel .workbench-prompt-input-textarea")
    box.click(); box.fill(PROMPT); box.press("Enter")
    end = time.time() + 300
    while time.time() < end and not finished():
        time.sleep(3)
    time.sleep(6)  # PDF re-render and settled layout
    pg.mouse.move(720, 980)  # no hover tooltips
    # Show the conversation from the user's request onwards
    pg.evaluate("""() => { for (const el of document.querySelectorAll('.workbench-panel *')) {
      const o = getComputedStyle(el).overflowY;
      if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight) el.scrollTop = 0 } }""")
    time.sleep(1)
    print("conversation fits:", pg.evaluate("""() => [...document.querySelectorAll('.workbench-panel *')].every(el => {
      const o = getComputedStyle(el).overflowY; return !(o === 'auto' || o === 'scroll') || el.scrollHeight <= el.clientHeight + 2 })"""))
    editor = pg.screenshot()
    # Assistant close-up: from the panel's top to just below the "Compile" step
    box = pg.locator(".workbench-panel").bounding_box()
    step = pg.evaluate("""() => { const hits = [...document.querySelectorAll('.workbench-panel *')]
      .filter(e => e.children.length === 0 && e.textContent.trim() === 'Compile');
      const r = hits.length ? hits[hits.length - 1].getBoundingClientRect() : null; return r && { y: r.y, height: r.height } }""")
    panel_bottom = box["y"] + box["height"]
    bottom = min(step["y"] + step["height"] + 8, panel_bottom) if step and step["y"] > box["y"] else panel_bottom
    panel = pg.screenshot(clip={"x": box["x"], "y": box["y"], "width": box["width"], "height": bottom - box["y"]})
    out = b.new_page()
    for name, png, q in [("welcome-editor", editor, 0.86), ("welcome-assistant", panel, 0.9)]:
        open(os.path.join(OUT, name + ".png"), "wb").write(png)
        webp = to_webp(out, png, q)
        open(os.path.join(OUT, name + ".webp"), "wb").write(webp)
        print(name, f"png {len(png) // 1024} KB -> webp {len(webp) // 1024} KB")
    b.close()
