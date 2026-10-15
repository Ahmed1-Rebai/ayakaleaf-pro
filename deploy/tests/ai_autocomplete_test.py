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


# Suggestions are made at word boundaries; spacing follows fixed rules.
for prefix in ("Large language models are ", "Deep learning has transformed NLP. In this paper, we ", "Dans ce travail, nous proposons une méthode "):
    code, text, t = complete(HEAD + prefix)
    check(f"after a space ({prefix.split()[-1]!r}): a suggestion, no extra space", code == 200 and bool(text) and not text[0].isspace(), f"{t:.2f}s {text!r}")
for prefix in ("Transformers, which rely on attention,", "Transformers are now the state of the art in machine translation."):
    code, text, t = complete(HEAD + prefix)
    check(f"after {prefix[-1]!r}: one space, no ', ...' continuation", code == 200 and (not text or (text.startswith(" ") and not text.startswith("  ") and text.strip()[0] not in ",;:.")), f"{t:.2f}s {text!r}")
code, text, t = complete(HEAD + "Einstein showed that $E = ", "$." + TAIL)
check("inside math: auto-closed $ after the cursor is not repeated", code == 200 and bool(text) and not text.rstrip().endswith("$") and not text[0].isspace(), f"{t:.2f}s {text!r}")
code, text, t = complete(HEAD.replace("\\section{Introduction}\n", "") + "\\section{", "}" + TAIL)
check("inside \\section{}: no space, no repeated }", code == 200 and bool(text) and not text[0].isspace() and not text.endswith("}"), f"{t:.2f}s {text!r}")
for prefix in ("In this paper, we", "Deep learning has transfor", "Large language models are"):
    code, text, t = complete(HEAD + prefix)
    check(f"inside or right after a word ({prefix.split()[-1]!r}): no suggestion", code == 200 and text == "", f"{text!r}")
# ---------- corrections (on by default) and the completion-only mode
def correct(prefix, corrections=True):
    r = s.post(B + "/workbench/autocomplete", json={"projectId": pid, "path": "main.tex", "prefix": prefix, "suffix": TAIL, "corrections": corrections}, timeout=30)
    return r.status_code, r.json() if r.ok else {}
def applied(prefix, fixes):
    out = prefix
    for f in sorted(fixes, key=lambda f: -f["from"]):
        out = out[:len(prefix) + f["from"]] + f["text"] + out[len(prefix) + f["to"]:]
    return out
for typed, expected in (("In this papr, we ", "In this paper, we "),
                        ("The resutls of our experimetns show that ", "The results of our experiments show that "),
                        ("Their are many approaches to ", "There are many approaches to ")):
    code, data = correct(HEAD + typed)
    fixed = applied(HEAD + typed, data.get("fixes", []))[len(HEAD):]
    check(f"correction: {typed.strip()!r}", code == 200 and fixed == expected and all(HEAD + typed == HEAD + typed for _ in [0]), f"-> {fixed!r} + {data.get('completion')!r}")
for typed in ("In this paper, we ", "We fine-tune BERT and RoBERTa with PyTorch on 8 GPUs. ", "As shown by~\\cite{vaswani2017attention}, attention "):
    code, data = correct(HEAD + typed)
    check(f"no correction for correct text: {typed.strip()[:30]!r}", code == 200 and data.get("fixes") == [] and bool(data.get("completion")), f"fixes={data.get('fixes')} completion={data.get('completion')!r}")
code, data = correct(HEAD + "In this papr, we ", corrections=False)
check("corrections off: completion only", code == 200 and data.get("fixes") == [] and bool(data.get("completion")), str(data))

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
