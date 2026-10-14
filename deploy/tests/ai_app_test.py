#!/usr/bin/env python3
"""App-level AI tests through Ayakaleaf (session auth): Error Assistant
suggest-fix on a real compile error, and workbench chat (LaTeX generation).
Prints the raw stream events so failures are visible."""
import json, os, sys, time
sys.argv = [sys.argv[0], "noop"]
_E2E = os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e_platform.py")
ns = {"__file__": _E2E}; exec(open(_E2E).read().split('{"run"')[0], ns)
BASE, login, compile_pdf, zip_of = ns["BASE"], ns["login"], ns["compile_pdf"], ns["zip_of"]
BROKEN = "\\documentclass{article}\n\\begin{document}\nHello.\n\n\\begin{itemiz}\n\\item one\n\\end{itemiz}\n\\end{document}\n"

s = login(); print("PASS login")
r = s.post(BASE + "/project/new/upload", files={"qqfile": ("err.zip", zip_of({"main.tex": BROKEN}), "application/zip")}, data={"name": "err.zip"})
pid = r.json()["project_id"]; print("project", pid)
st, _ = compile_pdf(s, pid, "broken"); print(f"compile status for broken doc: {st} (expected failure/error)")
log = open(os.path.expanduser("~/ayakaleaf-tests/out/broken.log")).read()
err_line = next((l for l in log.splitlines() if l.startswith("!")), "")
print("first LaTeX error:", err_line)

# 1. Error Assistant
t = time.time()
r = s.post(f"{BASE}/project/{pid}/suggest-fix", stream=True, timeout=300, json={"logEntry": {
    "file": "main.tex", "line": 5, "level": "error", "message": err_line.lstrip("! "),
    "content": "", "raw": err_line}})
print(f"\n== suggest-fix: HTTP {r.status_code} ct={r.headers.get('content-type')}")
events = []
for raw in r.iter_lines():
    if raw.startswith(b"data:"):
        events.append(raw[5:].strip().decode()); print("  ", events[-1][:300])
ok_fix = any("itemize" in e for e in events) and not any('"error"' in e for e in events)
print(f"{'PASS' if ok_fix else 'FAIL'} error-assistant ({time.time()-t:.1f}s)")

# 2. Workbench chat: LaTeX generation (no client tools executed here)
t = time.time()
r = s.post(f"{BASE}/workbench/tex-gpt", stream=True, timeout=300, json={"messages": [{"id": "u1", "role": "user",
    "parts": [{"type": "text", "text": "Write a minimal LaTeX table with 2 columns (Name, Score) and 2 rows. Reply with only a fenced latex code block; do not call tools."}]}]})
print(f"\n== tex-gpt: HTTP {r.status_code} ct={r.headers.get('content-type')}")
text, kinds = "", {}
for raw in r.iter_lines():
    if not raw.startswith(b"data:"): continue
    d = raw[5:].strip()
    if d == b"[DONE]": break
    j = json.loads(d); kinds[j.get("type")] = kinds.get(j.get("type"), 0) + 1
    if j.get("type") == "text-delta": text += j.get("delta", "")
    if j.get("type") in ("error", "tool-input-available"): print("  ", d.decode()[:300])
print("   event types:", kinds); print("   text:", text[:400].replace("\n", "\\n"))
ok_chat = "\\begin{tabular}" in text
print(f"{'PASS' if ok_chat else 'FAIL'} chat latex-generation ({time.time()-t:.1f}s)")
json.dump({"error_project_id": pid}, open(os.path.expanduser("~/ayakaleaf-tests/ai_state.json"), "w"))
