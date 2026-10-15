#!/usr/bin/env python3
"""save_attached_image must never replace a project file (it runs without the
user's approval). A project already has images/photo.png; the assistant is asked
to save a different attached image under that same name. The original must stay
byte-for-byte unchanged and the new image must get a free name; saving the same
image again must write nothing. Deletes its project afterwards."""
import base64, hashlib, io, json, os, struct, subprocess, sys, zipfile, zlib

E2E = os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e_platform.py")
sys.argv = [sys.argv[0]]
ns = {"__file__": E2E}
exec(open(E2E).read().split('{"run"')[0], ns)
B, login, zip_of = ns["BASE"], ns["login"], ns["zip_of"]
results = {}


def check(name, ok, detail=""):
    results[name] = bool(ok)
    print(f"{'PASS' if ok else 'FAIL'} {name} {detail}", flush=True)


def png(w, h, shade):
    rows = b"".join(b"\x00" + b"".join(bytes((shade, x % 256, y % 256)) for x in range(w)) for y in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


ORIGINAL, NEW = png(40, 30, 200), png(160, 100, 30)
DOC = "\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\nHello.\n\\end{document}\n"
s = login()
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w") as z:
    z.writestr("main.tex", DOC); z.writestr("images/photo.png", ORIGINAL)
pid = s.post(B + "/project/new/upload", files={"qqfile": ("imgsafe.zip", buf.getvalue(), "application/zip")}, data={"name": "imgsafe.zip"}).json()["project_id"]
referer = {"Referer": f"{B}/project/{pid}"}


def files():
    z = zipfile.ZipFile(io.BytesIO(s.get(f"{B}/Project/{pid}/download/zip").content))
    return {n: z.read(n) for n in z.namelist()}


def blob_sha1(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


stored = subprocess.check_output(["docker", "exec", "mongo", "mongosh", "sharelatex", "--quiet", "--eval",
    f'const f = db.projects.findOne({{_id: ObjectId("{pid}")}}).rootFolder[0].folders.find(f => f.name === "images"); print(f.fileRefs.find(r => r.name === "photo.png").hash)']).decode().strip()
check("Overleaf stores files under their git blob hash (what the tool compares)", stored == blob_sha1(ORIGINAL), stored)


def save_image(image, path):
    """One chat turn asking for save_attached_image; returns the tool outputs."""
    msgs = [{"id": "u1", "role": "user", "parts": [
        {"type": "text", "text": f"Save the attached image into the project with save_attached_image, index 1 and path {path}. Do not edit the document and do not call any other tool. Then reply with the path it returned."},
        {"type": "file", "mediaType": "image/png", "filename": "new.png", "url": "data:image/png;base64," + base64.b64encode(image).decode()}]}]
    outputs, dynamic = [], {}
    r = s.post(B + "/workbench/tex-gpt", stream=True, timeout=600, headers=referer, json={"messages": msgs, "enabledTools": []})
    for raw in r.iter_lines():
        if not raw.startswith(b"data:") or raw[5:].strip() == b"[DONE]":
            continue
        e = json.loads(raw[5:])
        if e["type"] == "tool-input-available" and e.get("dynamic"):
            dynamic[e["toolCallId"]] = e
        elif e["type"] == "tool-output-available" and e["toolCallId"] in dynamic:
            outputs.append(e["output"])
    print("  tool outputs:", json.dumps(outputs))
    return outputs


out = save_image(NEW, "images/photo.png")
after = files()
check("asked to save over images/photo.png: the original is unchanged", after.get("images/photo.png") == ORIGINAL)
check("the new image is saved under a free name", any(o.get("saved") and o.get("path") == "images/photo-2.png" for o in out) and after.get("images/photo-2.png") == NEW,
      str([o.get("path") for o in out]))
check("the assistant is told why the name changed", any("left unchanged" in (o.get("note") or "") for o in out))

out = save_image(NEW, "images/photo-2.png")
after = files()
check("saving the same image again writes nothing", any(o.get("saved") and o.get("path") == "images/photo-2.png" and "nothing was written" in (o.get("note") or "") for o in out)
      and "images/photo-3.png" not in after and after.get("images/photo.png") == ORIGINAL)

s.delete(f"{B}/project/{pid}")
print("\nSUMMARY", json.dumps(results))
sys.exit(0 if all(results.values()) else 1)
