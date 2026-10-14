#!/usr/bin/env python3
"""Agentic editing through /workbench/tex-gpt. This script plays the browser's
role: it executes the client tools (read-only ones directly, replace_lines only
after checking existingContent, i.e. "approving the diff"), sends results back
as AI SDK v6 UI-message tool parts, then compiles."""
import json, os, sys, uuid
sys.argv = [sys.argv[0]]
_E2E = os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e_platform.py")
ns = {"__file__": _E2E}; exec(open(_E2E).read().split('{"run"')[0], ns)
B, login, zip_of, upload, export_zip, compile_pdf = (ns[k] for k in ("BASE", "login", "zip_of", "upload", "export_zip", "compile_pdf"))
DOC = "\\documentclass{article}\n\\begin{document}\nHello.\n\n\\begin{itemiz}\n\\item one\n\\end{itemiz}\n\\end{document}\n"

s = login()
pid = s.post(B + "/project/new/upload", files={"qqfile": ("a.zip", zip_of({"main.tex": DOC}), "application/zip")}, data={"name": "a.zip"}).json()["project_id"]
cur = lambda: export_zip(s, pid)["main.tex"]
lines_of = lambda t: [{"line": i + 1, "content": c} for i, c in enumerate(t.split("\n"))]
ctx = "\n\n--- START CONTEXT\nCurrent file: main.tex\n--- END CONTEXT"
msgs = [{"id": "u1", "role": "user", "parts": [{"type": "text", "text":
    "The document fails to compile (Environment itemiz undefined). Read the current file and fix ALL errors with replace_lines." + ctx}]}]
calls, edits = [], 0
for turn in range(8):
    r = s.post(B + "/workbench/tex-gpt", stream=True, timeout=300, json={"messages": msgs, "enabledTools": []})
    assert r.status_code == 200, (r.status_code, r.text[:200])
    pending, text, err = [], "", None
    for raw in r.iter_lines():
        if not raw.startswith(b"data:") or raw[5:].strip() == b"[DONE]": continue
        e = json.loads(raw[5:])
        if e["type"] == "tool-input-available": pending.append(e)
        elif e["type"] == "text-delta": text += e["delta"]
        elif e["type"] == "error": err = e["errorText"]
    if err: sys.exit(f"FAIL stream error on turn {turn}: {err}")
    if not pending:
        print(f"turn {turn}: final answer: {text.strip()[:200]!r}"); break
    parts = [{"type": "step-start"}]
    for c in pending:
        name, inp = c["toolName"], c["input"]; calls.append(name)
        if name in ("read_current_file", "open_file"): out = lines_of(cur())
        elif name == "read_lines": out = [l for l in lines_of(cur()) if inp["fromLine"] <= l["line"] <= inp["toLine"]]
        elif name == "list_files": out = ["main.tex"]
        elif name == "replace_lines":
            src = cur().split("\n"); existing = "\n".join(src[inp["fromLine"] - 1:inp["toLine"]])
            if existing != inp["existingContent"]:
                out = {"applied": False, "error": "existingContent does not match the document"}
            else:  # the user approves the diff
                src[inp["fromLine"] - 1:inp["toLine"]] = inp["newContent"].split("\n")
                upload(s, pid, "main.tex", "\n".join(src).encode()); edits += 1
                out = {"applied": True}
        elif name in ("get_diagnostics", "compile"):
            st, _ = compile_pdf(s, pid, f"agent-{turn}")
            out = {"logsReady": True, "compiling": False, "hasUncompiledChanges": False,
                   "errors": [l.strip() for l in open(os.path.join(ns["OUT"], f"agent-{turn}.log")) if l.startswith("!")]}
        else: out = {"error": f"tool {name} not available in this test"}
        print(f"turn {turn}: {name}({json.dumps(inp)[:140]}) -> {json.dumps(out)[:120]}")
        parts.append({"type": f"tool-{name}", "toolCallId": c["toolCallId"], "state": "output-available", "input": inp, "output": out})
    msgs.append({"id": str(uuid.uuid4()), "role": "assistant", "parts": parts})
st, pdf = compile_pdf(s, pid, "agent-final")
errs = [l for l in open(os.path.join(ns["OUT"], "agent-final.log")) if l.startswith("!")]
ok = edits > 0 and "itemiz}" not in cur().replace("itemize}", "") and not errs
print(f"tool calls: {calls}; approved edits applied: {edits}; LaTeX errors after: {len(errs)}")
print(("PASS" if ok else "FAIL"), "agentic editing (read -> replace_lines -> compile)")
