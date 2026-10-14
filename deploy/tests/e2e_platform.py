#!/usr/bin/env python3
"""End-to-end platform test: login, create, save (replace file), compile,
download PDF, export zip. Usage: e2e_platform.py run | verify-persist"""
import io, json, os, re, subprocess, sys, time, zipfile
import requests

BASE = os.environ.get("OL_URL", "http://127.0.0.1:8001")
def _dotenv(path=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".env")):
    out = {}
    for line in open(path):
        m = re.match(r'^([A-Z0-9_]+)=(.*)$', line.strip())
        if m: out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return out
_ENV = _dotenv()
# Admin account from .env (SEED_ADMIN_*), overridable with OL_EMAIL / OL_PW
EMAIL = os.environ.get("OL_EMAIL") or _ENV["SEED_ADMIN_EMAIL"]
PW = os.environ.get("OL_PW") or _ENV["SEED_ADMIN_PASSWORD"]
STATE = os.path.expanduser("~/ayakaleaf-tests/state.json")
OUT = os.path.expanduser("~/ayakaleaf-tests/out")
os.makedirs(OUT, exist_ok=True)

def csrf(s, path):
    return re.search(r'name="ol-csrfToken" content="([^"]+)"', s.get(BASE + path).text).group(1)

def login():
    s = requests.Session()
    tok = csrf(s, "/login")
    r = s.post(BASE + "/login", json={"email": EMAIL, "password": PW}, headers={"X-Csrf-Token": tok})
    assert r.status_code == 200 and ("redir" in r.text or "Your projects" in r.text), f"login failed {r.status_code} {r.text[:200]}"
    s.headers["X-Csrf-Token"] = csrf(s, "/project")
    return s

def zip_of(files):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        for n, c in files.items(): z.writestr(n, c)
    return b.getvalue()

def root_folder(pid):
    out = subprocess.check_output(["docker", "exec", "mongo", "mongosh", "sharelatex", "--quiet", "--eval",
        f'print(db.projects.findOne({{_id: ObjectId("{pid}")}}, {{rootFolder:1}}).rootFolder[0]._id.toString())'])
    return out.decode().strip()

def upload(s, pid, name, content):
    r = s.post(f"{BASE}/Project/{pid}/upload", params={"folder_id": root_folder(pid)},
               data={"name": name}, files={"qqfile": (name, content)})
    assert r.status_code == 200 and r.json().get("success"), f"upload failed {r.status_code} {r.text[:200]}"

def compile_pdf(s, pid, tag):
    t = time.time()
    r = s.post(f"{BASE}/project/{pid}/compile", json={"rootDoc_id": None, "draft": False,
               "check": "silent", "incrementalCompilesEnabled": True, "stopOnFirstError": False}, timeout=300)
    j = r.json()
    print(f"  compile[{tag}]: HTTP {r.status_code} status={j.get('status')} in {time.time()-t:.1f}s")
    files = {f["path"]: f for f in j.get("outputFiles", [])}
    pdf = None
    if "output.pdf" in files:
        pr = s.get(BASE + files["output.pdf"]["url"])
        pdf = pr.content
        open(f"{OUT}/{tag}.pdf", "wb").write(pdf)
        print(f"  pdf[{tag}]: {len(pdf)} bytes, magic={pdf[:5]!r}")
    if "output.log" in files:
        open(f"{OUT}/{tag}.log", "w").write(s.get(BASE + files["output.log"]["url"]).text)
    return j.get("status"), pdf

def export_zip(s, pid):
    r = s.get(f"{BASE}/Project/{pid}/download/zip")
    assert r.status_code == 200, r.status_code
    z = zipfile.ZipFile(io.BytesIO(r.content))
    return {n: z.read(n).decode(errors="replace") for n in z.namelist()}

V1 = r"""\documentclass{article}
\usepackage{amsmath}
\title{Ayakaleaf E2E}
\begin{document}
\maketitle
Version one. $E=mc^2$.
\end{document}
"""
V2 = V1.replace("Version one.", "Version two MARKER-SAVED-42.")

def run():
    s = login(); print("PASS login")
    r = s.post(BASE + "/project/new/upload", files={"qqfile": ("e2e.zip", zip_of({"main.tex": V1}), "application/zip")},
               data={"name": "e2e.zip"})
    pid = r.json()["project_id"]; print(f"PASS create project via upload: {pid}")
    st, pdf = compile_pdf(s, pid, "v1"); assert st == "success" and pdf[:4] == b"%PDF"; print("PASS compile v1 -> PDF")
    upload(s, pid, "main.tex", V2.encode()); print("PASS save (replace main.tex)")
    st, pdf = compile_pdf(s, pid, "v2"); assert st == "success" and pdf[:4] == b"%PDF"; print("PASS compile v2 -> PDF")
    files = export_zip(s, pid); assert "MARKER-SAVED-42" in files["main.tex"]; print(f"PASS export zip: {sorted(files)}")
    json.dump({"project_id": pid}, open(STATE, "w"))

def verify_persist():
    pid = json.load(open(STATE))["project_id"]
    s = login(); print("PASS login after restart")
    files = export_zip(s, pid); assert "MARKER-SAVED-42" in files["main.tex"]; print(f"PASS project {pid} content persisted")
    st, pdf = compile_pdf(s, pid, "after-restart"); assert st == "success" and pdf[:4] == b"%PDF"; print("PASS compile after restart")

{"run": run, "verify-persist": verify_persist}[sys.argv[1]]()
