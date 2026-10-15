#!/usr/bin/env python3
"""Automatic TeX engine choice, end to end.

Each case uploads a project, sets its compiler to a wrong (or deliberate) engine,
compiles through /project/:id/compile like the editor does, and checks that a PDF
was produced, which engine actually ran (first line of output.log) and what the
project's saved compiler is afterwards. Projects are deleted at the end."""
import os, subprocess, sys, time

E2E = os.path.join(os.path.dirname(os.path.abspath(__file__)), "e2e_platform.py")
sys.argv = [sys.argv[0]]
ns = {"__file__": E2E}
exec(open(E2E).read().split('{"run"')[0], ns)
B, login, zip_of, upload = ns["BASE"], ns["login"], ns["zip_of"], ns["upload"]

s = login()
results, projects = {}, []


def check(name, ok, detail=""):
    results[name] = bool(ok)
    print(f"{'PASS' if ok else 'FAIL'} {name} {detail}", flush=True)


def doc(preamble, body="Hello"):
    return f"\\documentclass{{article}}\n{preamble}\n\\begin{{document}}\n{body}\n\\end{{document}}\n"


def new_project(name, files, compiler):
    r = s.post(B + "/project/new/upload", files={"qqfile": (f"{name}.zip", zip_of(files), "application/zip")}, data={"name": f"{name}.zip"})
    pid = r.json()["project_id"]
    projects.append(pid)
    assert s.post(f"{B}/project/{pid}/settings", json={"compiler": compiler}).status_code == 204
    return pid


def saved_compiler(pid):
    return subprocess.check_output(["docker", "exec", "mongo", "mongosh", "sharelatex", "--quiet", "--eval",
        f'print(db.projects.findOne({{_id: ObjectId("{pid}")}}, {{compiler: 1}}).compiler)']).decode().strip()


ENGINE_OF_LOG = {"XeTeX": "xelatex", "LuaHBTeX": "lualatex", "LuaTeX": "lualatex", "pdfTeX": "pdflatex"}


def compile_project(pid):
    t = time.time()
    j = s.post(f"{B}/project/{pid}/compile", json={"rootDoc_id": None, "draft": False, "check": "silent",
               "incrementalCompilesEnabled": True, "stopOnFirstError": False}, timeout=400).json()
    files = {f["path"]: f for f in j.get("outputFiles", [])}
    pdf = s.get(B + files["output.pdf"]["url"]).content if "output.pdf" in files else b""
    log = s.get(B + files["output.log"]["url"]).text if "output.log" in files else ""
    first = log.split("\n", 1)[0]
    engine = next((e for k, e in ENGINE_OF_LOG.items() if first.startswith(f"This is {k},")), None)
    return {"status": j.get("status"), "pdf": pdf[:4] == b"%PDF", "engine": engine, "seconds": round(time.time() - t, 1)}


def case(name, files, start, expect):
    pid = new_project(name, files, start)
    r = compile_project(pid)
    saved = saved_compiler(pid)
    ok = r["status"] == "success" and r["pdf"] and r["engine"] == expect and saved == expect
    check(name, ok, f"set {start} -> ran {r['engine']}, saved {saved}, {r['status']}, pdf={r['pdf']}, {r['seconds']}s")
    return pid


case("fontspec document set to pdfLaTeX", {"main.tex": doc("\\usepackage{fontspec}\n\\setmainfont{TeX Gyre Termes}")}, "pdflatex", "xelatex")
case("Lua code set to pdfLaTeX", {"main.tex": doc("", "\\directlua{tex.print('Lua says hi')}")}, "pdflatex", "lualatex")
case("Chinese ctexart set to pdfLaTeX", {"main.tex": "\\documentclass{ctexart}\n\\begin{document}\n你好，世界\n\\end{document}\n"}, "pdflatex", "xelatex")
case("CV template with its own .cls (fontspec inside)", {
    "main.tex": "\\documentclass{mycv}\n\\begin{document}\n\\name{Ada}\n\\end{document}\n",
    "mycv.cls": "\\NeedsTeXFormat{LaTeX2e}\\ProvidesClass{mycv}\\LoadClass{article}\n\\RequirePackage{fontspec}\n\\setmainfont{TeX Gyre Heros}\n\\newcommand\\name[1]{\\section*{#1}}\n",
}, "pdflatex", "xelatex")
case("fontspec loaded from an \\input preamble", {"main.tex": doc("\\input{preamble}"), "preamble.tex": "\\usepackage{fontspec}\n"}, "pdflatex", "xelatex")
case("magic comment % !TEX program = lualatex", {"main.tex": "% !TEX program = lualatex\n" + doc("")}, "xelatex", "lualatex")
case("plain document keeps the chosen XeLaTeX", {"main.tex": doc("\\usepackage{amsmath}", "$a^2+b^2=c^2$")}, "xelatex", "xelatex")
case("engine-conditional template stays on pdfLaTeX", {"main.tex": doc(
    "\\usepackage{iftex}\n\\ifPDFTeX\n  \\usepackage[T1]{fontenc}\n\\else\n  \\usepackage{fontspec}\n\\fi")}, "pdflatex", "pdflatex")
case("hidden package name: fixed from the compile log", {"main.tex": doc("\\def\\enginepkg{fontspec}\n\\usepackage{\\enginepkg}")}, "pdflatex", "xelatex")

# Editing an existing project: compiles with pdfLaTeX, then fontspec is added
pid = case("edit flow: plain document first", {"main.tex": doc("")}, "pdflatex", "pdflatex")
upload(s, pid, "main.tex", doc("\\usepackage{fontspec}\n\\setmainfont{TeX Gyre Pagella}", "Edited").encode())
time.sleep(1)
r = compile_project(pid)
check("edit flow: add fontspec, recompile", r["status"] == "success" and r["pdf"] and r["engine"] == "xelatex" and saved_compiler(pid) == "xelatex",
      f"ran {r['engine']}, {r['status']}, {r['seconds']}s")

for pid in projects:
    s.delete(f"{B}/project/{pid}")
print(f"\nSUMMARY {sum(results.values())}/{len(results)} passed", "| all passed:", all(results.values()))
sys.exit(0 if all(results.values()) else 1)
