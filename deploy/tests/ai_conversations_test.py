#!/usr/bin/env python3
"""Saved AI conversations: auto-save, continue, rename, access checks, delete.

Talks to /workbench/tex-gpt the way the editor does (chat id + project id in the
body) and to the /workbench/conversations endpoints. Deletes its project after."""
import json, os, sys, uuid

E2E = os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e_platform.py")
sys.argv = [sys.argv[0]]
ns = {"__file__": E2E}
exec(open(E2E).read().split('{"run"')[0], ns)
B, login, zip_of = ns["BASE"], ns["login"], ns["zip_of"]

s = login()
pid = s.post(B + "/project/new/upload", files={"qqfile": ("convtest.zip", zip_of({"main.tex": "\\documentclass{article}\\begin{document}Hi\\end{document}"}), "application/zip")}, data={"name": "convtest.zip"}).json()["project_id"]
cid = str(uuid.uuid4())
results = {}


def check(name, ok, detail=""):
    results[name] = bool(ok)
    print(f"{'PASS' if ok else 'FAIL'} {name} {detail}")


def chat(messages):
    r = s.post(B + "/workbench/tex-gpt", stream=True, timeout=300, json={"id": cid, "messages": messages, "enabledTools": [], "projectId": pid})
    text, error = "", None
    for raw in r.iter_lines():
        if raw.startswith(b"data:") and raw[5:].strip() != b"[DONE]":
            e = json.loads(raw[5:])
            if e["type"] == "text-delta":
                text += e["delta"]
            elif e["type"] == "error":
                error = e["errorText"]
    return text, error


def listed():
    r = s.get(f"{B}/workbench/conversations", params={"project_id": pid})
    return r.status_code, {c["id"]: c for c in r.json().get("conversations", [])} if r.ok else {}


first = {"id": "u1", "role": "user", "parts": [{"type": "text", "text": "Reply with one short sentence about LaTeX. Do not use tools."}]}
text, error = chat([first])
check("chat reply", text and not error, repr((error or text)[:60]))
status, convs = listed()
c = convs.get(cid)
check("auto-saved after the reply", status == 200 and c and c["messageCount"] == 2, f"status={status} entry={c and {k: c[k] for k in ('title', 'messageCount')}}")
check("title from first message", c and c["title"].startswith("Reply with one short sentence"), repr(c and c["title"]))

got = s.get(f"{B}/workbench/conversations/{cid}")
saved = got.json() if got.ok else {}
check("open saved conversation", got.status_code == 200 and len(saved.get("messages", [])) == 2 and saved["messages"][1]["role"] == "assistant")

follow = {"id": "u2", "role": "user", "parts": [{"type": "text", "text": "And one more sentence, please."}]}
text, error = chat(saved["messages"] + [follow])
status, convs = listed()
check("continued conversation saved", convs.get(cid, {}).get("messageCount") == 4, f"messages={convs.get(cid, {}).get('messageCount')}")

r = s.post(f"{B}/workbench/conversations/{cid}/rename", json={"title": "  My   LaTeX notes  "})
status, convs = listed()
check("rename", r.status_code == 204 and convs.get(cid, {}).get("title") == "My LaTeX notes", repr(convs.get(cid, {}).get("title")))

check("unknown id -> 404", s.get(f"{B}/workbench/conversations/{uuid.uuid4()}").status_code == 404)
check("bad project id -> 400", s.get(f"{B}/workbench/conversations", params={"project_id": "nope"}).status_code == 400)
check("rename unknown -> 404", s.post(f"{B}/workbench/conversations/{uuid.uuid4()}/rename", json={"title": "x"}).status_code == 404)

r = s.delete(f"{B}/workbench/conversations/{cid}")
status, convs = listed()
check("delete", r.status_code == 204 and cid not in convs and s.get(f"{B}/workbench/conversations/{cid}").status_code == 404)

s.delete(f"{B}/project/{pid}")
print("\nSUMMARY", json.dumps(results))
sys.exit(0 if all(results.values()) else 1)
