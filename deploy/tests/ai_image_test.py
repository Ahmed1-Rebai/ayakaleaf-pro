#!/usr/bin/env python3
"""Image attached in the AI chat -> inserted into the document.

Sends a PNG with "insert this photo at the bottom of the document" through
/workbench/tex-gpt (Referer = the project, as the editor sends it), runs the
client tools like the browser (dynamic, server-run tools are skipped), then
checks that the image is a project file, main.tex references that exact path,
and the project compiles. Deletes its project afterwards."""
import base64, json, os, re, struct, sys, uuid, zlib

E2E = os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e_platform.py")
sys.argv = [sys.argv[0]]
ns = {"__file__": E2E}
exec(open(E2E).read().split('{"run"')[0], ns)
B, login, zip_of, upload, export_zip, compile_pdf, OUT = (ns[k] for k in ("BASE", "login", "zip_of", "upload", "export_zip", "compile_pdf", "OUT"))


def png(w=160, h=100):
    rows = b"".join(b"\x00" + b"".join(bytes((30 + x, 90 + y // 2, 220 - x // 2)) for x in range(w)) for y in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


DOC = "\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\nHello from LambdaTeX.\n\n\\end{document}\n"
s = login()
pid = s.post(B + "/project/new/upload", files={"qqfile": ("imgtest.zip", zip_of({"main.tex": DOC}), "application/zip")}, data={"name": "imgtest.zip"}).json()["project_id"]
referer = {"Referer": f"{B}/project/{pid}"}
cur = lambda: export_zip(s, pid)
lines_of = lambda t: [{"line": i + 1, "content": c} for i, c in enumerate(t.split("\n"))]

image_url = "data:image/png;base64," + base64.b64encode(png()).decode()
msgs = [{"id": "u1", "role": "user", "parts": [
    {"type": "text", "text": "Insert this photo at the bottom of the document.\n\n--- START CONTEXT\nCurrent file: main.tex\n--- END CONTEXT"},
    {"type": "file", "mediaType": "image/png", "filename": "My Photo.png", "url": image_url}]}]

saved_path, calls, err = None, [], None
for turn in range(8):
    r = s.post(B + "/workbench/tex-gpt", stream=True, timeout=600, headers=referer, json={"messages": msgs, "enabledTools": []})
    client, dynamic_in, dynamic_out, reasoning, text = [], {}, {}, "", ""
    for raw in r.iter_lines():
        if not raw.startswith(b"data:") or raw[5:].strip() == b"[DONE]":
            continue
        e = json.loads(raw[5:])
        if e["type"] == "tool-input-available":
            (dynamic_in.__setitem__(e["toolCallId"], e) if e.get("dynamic") else client.append(e))
        elif e["type"] == "tool-output-available" and e["toolCallId"] in dynamic_in:
            dynamic_out[e["toolCallId"]] = e["output"]
        elif e["type"] == "reasoning-delta":
            reasoning += e["delta"]
        elif e["type"] == "text-delta":
            text += e["delta"]
        elif e["type"] == "error":
            err = e["errorText"]
    if err:
        break
    parts = [{"type": "step-start"}] + ([{"type": "reasoning", "text": reasoning, "state": "done"}] if reasoning else [])
    for cid, e in dynamic_in.items():
        out = dynamic_out.get(cid)
        calls.append(e["toolName"])
        print(f"turn {turn}: {e['toolName']} (server) {json.dumps(e['input'])} -> {json.dumps(out)}")
        if isinstance(out, dict) and out.get("saved"):
            saved_path = out["path"]
        parts.append({"type": "dynamic-tool", "toolName": e["toolName"], "toolCallId": cid, "state": "output-available", "input": e["input"], "output": out})
    if not client:
        print(f"turn {turn}: final answer: {text.strip()[:160]!r}")
        break
    for e in client:
        n, inp = e["toolName"], e["input"]
        calls.append(n)
        files = cur()
        main = files["main.tex"]
        if n in ("read_current_file", "open_file"):
            out = lines_of(main)
        elif n == "read_lines":
            out = [l for l in lines_of(main) if inp["fromLine"] <= l["line"] <= inp["toLine"]]
        elif n == "list_files":
            out = sorted(files)
        elif n == "replace_lines":
            src = main.split("\n")
            if "\n".join(src[inp["fromLine"] - 1:inp["toLine"]]) != inp["existingContent"]:
                out = {"applied": False, "error": "existingContent does not match"}
            else:
                src[inp["fromLine"] - 1:inp["toLine"]] = inp["newContent"].split("\n")
                upload(s, pid, "main.tex", "\n".join(src).encode())
                out = {"applied": True}
        elif n in ("compile", "get_diagnostics"):
            compile_pdf(s, pid, f"img-{turn}")
            out = {"logsReady": True, "compiling": False, "hasUncompiledChanges": False, "errors": []}
        else:
            out = {"error": f"{n} not available in this test"}
        print(f"turn {turn}: {n} {json.dumps(inp)[:140]}")
        parts.append({"type": f"tool-{n}", "toolCallId": e["toolCallId"], "state": "output-available", "input": inp, "output": out})
    msgs.append({"id": str(uuid.uuid4()), "role": "assistant", "parts": parts})

files = cur()
main = files["main.tex"]
stem = re.sub(r"\.(png|jpe?g)$", "", saved_path or "")
referenced = bool(saved_path) and re.search(r"\\includegraphics(\[[^\]]*\])?\{" + re.escape(stem) + r"(\.(png|jpe?g))?\}", main) is not None
st, pdf = compile_pdf(s, pid, "img-final")
log = open(os.path.join(OUT, "img-final.log")).read() if os.path.exists(os.path.join(OUT, "img-final.log")) else ""
missing = "not found" in log or "Unable to load picture" in log
ok = not err and saved_path in files and referenced and pdf is not None and not missing
print(f"error: {err} | saved: {saved_path} | in project: {saved_path in files} | referenced in main.tex: {referenced} | image missing in log: {missing}")
print(("PASS" if ok else "FAIL"), "image attached in chat -> saved into project -> included -> compiles")
s.delete(f"{B}/project/{pid}")
sys.exit(0 if ok else 1)
