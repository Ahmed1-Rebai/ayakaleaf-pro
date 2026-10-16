#!/usr/bin/env python3
"""The chat endpoint reports failures with a cause code (and logs it).

Triggers real failures on the live server: a message far beyond the model's
context window (the gateway rejects it) and an invalid attachment; checks the
code the editor receives and the web log line. Deletes its project afterwards."""
import json, os, subprocess, sys, time

E2E = os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e_platform.py")
sys.argv = [sys.argv[0]]
ns = {"__file__": E2E}
exec(open(E2E).read().split('{"run"')[0], ns)
B, login, zip_of = ns["BASE"], ns["login"], ns["zip_of"]
results = {}


def check(name, ok, detail=""):
    results[name] = bool(ok)
    print(f"{'PASS' if ok else 'FAIL'} {name} {detail}", flush=True)


s = login()
pid = s.post(B + "/project/new/upload", files={"qqfile": ("aierrapi.zip", zip_of({"main.tex": "\\documentclass{article}\\begin{document}Hi\\end{document}"}), "application/zip")},
             data={"name": "aierrapi.zip"}).json()["project_id"]
referer = {"Referer": f"{B}/project/{pid}"}


def chat(parts):
    r = s.post(B + "/workbench/tex-gpt", stream=True, timeout=300, headers=referer,
               json={"messages": [{"id": "u1", "role": "user", "parts": parts}], "enabledTools": [], "projectId": pid})
    if r.status_code != 200:
        return r.status_code, (r.json().get("error") if r.headers.get("content-type", "").startswith("application/json") else r.text[:80])
    error = None
    for raw in r.iter_lines():
        if raw.startswith(b"data:") and raw[5:].strip() != b"[DONE]":
            event = json.loads(raw[5:])
            if event["type"] == "error":
                error = event["errorText"]
    return 200, error


started = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
huge = "lorem ipsum dolor sit amet " * 110_000  # ~3 MB, far beyond any context window
status, error = chat([{"type": "text", "text": huge}])
check("message beyond the context window -> [context_too_long]", status == 200 and str(error).startswith("[context_too_long]"), f"{status} {str(error)[:80]!r}")

status, code = chat([{"type": "text", "text": "hi"}, {"type": "file", "mediaType": "application/pdf", "url": "data:application/pdf;base64,AAAA"}])
check("non-image attachment -> HTTP 400 invalid_attachments", status == 400 and code == "invalid_attachments", f"{status} {code}")

time.sleep(1)
log = subprocess.run(["docker", "exec", "sharelatex", "sh", "-c", "grep 'workbench tex-gpt: AI error' /var/log/overleaf/web.log | tail -5"],
                     capture_output=True, text=True).stdout
entries = [json.loads(line) for line in log.splitlines() if line.startswith("{")]
recent = [e for e in entries if e.get("time", "") >= started]
check("the failure is logged with its cause", any(e.get("code") == "context_too_long" and e.get("status") and e.get("detail") for e in recent),
      json.dumps([{k: e.get(k) for k in ("code", "status")} for e in recent]))
check("the log line is short (no message content beyond 240 characters)", bool(recent) and all(len(e.get("detail", "")) <= 240 for e in recent))

s.delete(f"{B}/project/{pid}")
print("\nSUMMARY", json.dumps(results))
sys.exit(0 if all(results.values()) else 1)
