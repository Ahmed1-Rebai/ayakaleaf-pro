#!/usr/bin/env python3
"""AI autocomplete endpoint (/workbench/autocomplete): real suggestions from the
gateway for typical cursor positions, their latency, and the access rules.
Deletes its project afterwards."""
import json, os, statistics, sys, time, requests

E2E = os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e_platform.py")
sys.argv = [sys.argv[0]]
ns = {"__file__": E2E}
exec(open(E2E).read().split('{"run"')[0], ns)
B, login, zip_of = ns["BASE"], ns["login"], ns["zip_of"]
results, times = {}, []


def check(name, ok, detail=""):
    results[name] = bool(ok)
    print(f"{'PASS' if ok else 'FAIL'} {name} {detail}", flush=True)


s = login()
pid = s.post(B + "/project/new/upload", files={"qqfile": ("actest.zip", zip_of({"main.tex": "\\documentclass{article}\\begin{document}Hi\\end{document}"}), "application/zip")},
             data={"name": "actest.zip"}).json()["project_id"]
HEAD = "\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n\\section{Introduction}\n"
TAIL = "\n\n\\end{document}\n"


def complete(prefix, suffix=TAIL, session=s, project=pid):
    t = time.time()
    r = session.post(B + "/workbench/autocomplete", json={"projectId": project, "path": "main.tex", "prefix": prefix, "suffix": suffix}, timeout=30)
    elapsed = time.time() - t
    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code == 200:
        times.append(elapsed)
    return r.status_code, body.get("completion"), elapsed


code, text, t = complete(HEAD + "Deep learning has transformed natural language processing. In this paper, we")
check("end of a word: suggestion starts with a space", code == 200 and bool(text) and text.startswith(" ") and not text.startswith("  "), f"{t:.2f}s {text!r}")
code, text, t = complete(HEAD + "Deep learning has transformed natural language processing. In this paper, we ")
check("after a space: no double space", code == 200 and bool(text) and not text[0].isspace(), f"{t:.2f}s {text!r}")
code, text, t = complete(HEAD + "Deep learning has transfor")
check("inside a word: continues the word", code == 200 and bool(text) and text[0].isalpha(), f"{t:.2f}s {text!r}")
code, text, t = complete(HEAD + "Einstein showed that $E = m", "$." + TAIL)
check("auto-closed $ after the cursor is not repeated", code == 200 and bool(text) and not text.rstrip().endswith("$"), f"{t:.2f}s {text!r}")
code, text, t = complete(HEAD + "Transformers are now the state of the art in machine translation.")
check("after a full stop: a new sentence, not ', ...'", code == 200 and (not text or (text.startswith(" ") and text.strip()[0].isupper())), f"{t:.2f}s {text!r}")
code, text, t = complete(HEAD + "Dans ce travail, nous proposons une méthode")
check("follows the document's language", code == 200 and bool(text), f"{t:.2f}s {text!r}")
check("median latency under 1 s", times and statistics.median(times) < 1.0, f"median {statistics.median(times):.2f}s over {len(times)} requests" if times else "")

check("invalid project id -> 400", complete(HEAD + "x", project="nope")[0] == 400)
check("unknown project -> 404 (JSON)", complete(HEAD + "x", project="0" * 24)[0] == 404)
no_csrf = requests.Session(); no_csrf.cookies.update(s.cookies)
check("missing CSRF token -> rejected", complete(HEAD + "x", session=no_csrf)[0] in (403, 400))
anon = requests.Session()
code = anon.post(B + "/workbench/autocomplete", json={"projectId": pid, "prefix": "x"}, allow_redirects=False).status_code
check("not logged in -> rejected", code in (302, 401, 403), str(code))

s.delete(f"{B}/project/{pid}")
print("\nSUMMARY", json.dumps(results))
sys.exit(0 if all(results.values()) else 1)
