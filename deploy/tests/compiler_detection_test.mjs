// Unit tests for deploy/patches/compile/CompilerDetection.mjs (no server needed).
// Run with Node 18+, e.g. in the web container:
//   docker run --rm -v ~/lambdatex/deploy:/d:ro --entrypoint node <web image> /d/tests/compiler_detection_test.mjs
import { detectCompiler, engineFromLog, stripComments } from '../patches/compile/CompilerDetection.mjs'

const results = {}
function check(name, ok, detail = '') {
  results[name] = Boolean(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`)
}

async function detect(files, current = 'pdflatex', rootPath = 'main.tex') {
  return await detectCompiler({
    rootPath,
    current,
    has: path => path in files,
    read: async path => files[path] ?? null,
  })
}
const doc = (preamble, body = 'Hi') =>
  `\\documentclass{article}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}\n`

const cases = [
  ['plain document keeps pdflatex', { 'main.tex': doc('\\usepackage{amsmath}') }, 'pdflatex', null],
  ['fontspec -> xelatex', { 'main.tex': doc('\\usepackage{fontspec}') }, 'pdflatex', 'xelatex'],
  ['fontspec keeps lualatex', { 'main.tex': doc('\\usepackage{fontspec}') }, 'lualatex', 'lualatex'],
  ['unicode-math in a package list', { 'main.tex': doc('\\usepackage[T1]{fontenc}\n\\usepackage{amsmath, unicode-math}') }, 'pdflatex', 'xelatex'],
  ['polyglossia -> xelatex', { 'main.tex': doc('\\usepackage{polyglossia}\\setmainlanguage{arabic}') }, 'pdflatex', 'xelatex'],
  ['\\setmainfont alone -> xelatex', { 'main.tex': doc('\\setmainfont{Arial}') }, 'pdflatex', 'xelatex'],
  ['xeCJK forces xelatex over lualatex', { 'main.tex': doc('\\usepackage{xeCJK}') }, 'lualatex', 'xelatex'],
  ['ctexart class -> xelatex', { 'main.tex': '\\documentclass{ctexart}\n\\begin{document}你好\\end{document}' }, 'pdflatex', 'xelatex'],
  ['luacode -> lualatex', { 'main.tex': doc('\\usepackage{luacode}') }, 'xelatex', 'lualatex'],
  ['\\directlua -> lualatex', { 'main.tex': doc('', '\\directlua{tex.print("x")}') }, 'pdflatex', 'lualatex'],
  ['luatexja -> lualatex', { 'main.tex': doc('\\usepackage{luatexja}') }, 'pdflatex', 'lualatex'],
  ['pstricks -> xelatex', { 'main.tex': doc('\\usepackage{pstricks}') }, 'pdflatex', 'xelatex'],
  ['pstricks keeps latex', { 'main.tex': doc('\\usepackage{pst-node}') }, 'latex', 'latex'],
  ['pstricks with auto-pst-pdf keeps pdflatex', { 'main.tex': doc('\\usepackage{auto-pst-pdf}\\usepackage{pstricks}') }, 'pdflatex', null],
  ['\\RequireXeTeX -> xelatex', { 'main.tex': doc('\\usepackage{iftex}\\RequireXeTeX') }, 'lualatex', 'xelatex'],
  ['\\RequirePDFTeX -> pdflatex', { 'main.tex': doc('\\usepackage{iftex}\\RequirePDFTeX') }, 'xelatex', 'pdflatex'],
  ['commented-out fontspec ignored', { 'main.tex': doc('% \\usepackage{fontspec}\n\\usepackage{amsmath} % fontspec later') }, 'pdflatex', null],
  ['\\iffalse block ignored', { 'main.tex': doc('\\iffalse\n\\usepackage{fontspec}\n\\fi') }, 'pdflatex', null],
  ['escaped \\% is not a comment', { 'main.tex': doc('100\\% sure \\usepackage{fontspec}') }, 'pdflatex', 'xelatex'],
  ['engine-conditional template keeps pdflatex', { 'main.tex': doc('\\usepackage{iftex}\n\\ifPDFTeX\n\\usepackage[T1]{fontenc}\n\\else\n\\usepackage{fontspec}\n\\fi') }, 'pdflatex', null],
  ['\\ifxetex template keeps pdflatex', { 'main.tex': doc('\\ifxetex\\usepackage{fontspec}\\else\\usepackage[utf8]{inputenc}\\fi') }, 'pdflatex', null],
  ['fontspec in \\input file', { 'main.tex': doc('\\input{preamble}'), 'preamble.tex': '\\usepackage{fontspec}' }, 'pdflatex', 'xelatex'],
  ['fontspec in nested include in subfolder', { 'main.tex': doc('', '\\include{chapters/one}'), 'chapters/one.tex': '\\input{chapters/two}', 'chapters/two.tex': '\\directlua{x=1}' }, 'pdflatex', 'lualatex'],
  ['\\import{dir}{file}', { 'main.tex': doc('\\usepackage{import}', '\\import{parts/}{intro}'), 'parts/intro.tex': '\\setmainfont{Arial}' }, 'pdflatex', 'xelatex'],
  ['bare \\input file', { 'main.tex': doc('\\input settings'), 'settings.tex': '\\usepackage{fontspec}' }, 'pdflatex', 'xelatex'],
  ['local .cls with fontspec (CV template)', { 'main.tex': '\\documentclass{awesome-cv}\n\\begin{document}x\\end{document}', 'awesome-cv.cls': '\\RequirePackage{fontspec}' }, 'pdflatex', 'xelatex'],
  ['local .sty with luacode', { 'main.tex': doc('\\usepackage{mystyle}'), 'mystyle.sty': '\\RequirePackage{luacode}' }, 'pdflatex', 'lualatex'],
  ['beamer theme file', { 'main.tex': '\\documentclass{beamer}\\usetheme{lab}\\begin{document}\\end{document}', 'beamerthemelab.sty': '\\RequirePackage{fontspec}' }, 'pdflatex', 'xelatex'],
  ['unreferenced .tex file ignored', { 'main.tex': doc(''), 'old.tex': doc('\\usepackage{fontspec}') }, 'pdflatex', null],
  ['main file in a subfolder', { 'thesis/main.tex': doc('\\input{thesis/setup}'), 'thesis/setup.tex': '\\usepackage{xeCJK}' }, 'pdflatex', 'xelatex', 'thesis/main.tex'],
  ['magic comment wins', { 'main.tex': '% !TEX program = lualatex\n' + doc('\\usepackage{xeCJK}') }, 'pdflatex', 'lualatex'],
  ['TS-program magic comment', { 'main.tex': '%!TeX TS-program = xelatex\n' + doc('') }, 'pdflatex', 'xelatex'],
  ['magic comment pins pdflatex', { 'main.tex': '% !TEX program = pdflatex\n' + doc('\\usepackage{fontspec}') }, 'xelatex', 'pdflatex'],
  ['arara directive', { 'main.tex': '% arara: lualatex\n% arara: biber\n' + doc('') }, 'pdflatex', 'lualatex'],
  ['magic comment after \\documentclass ignored', { 'main.tex': doc('% !TEX program = xelatex') }, 'pdflatex', null],
  ['conflict (xeCJK + luacode) keeps setting', { 'main.tex': doc('\\usepackage{xeCJK}\\usepackage{luacode}') }, 'pdflatex', 'pdflatex'],
  ['include cycle terminates', { 'main.tex': doc('\\input{a}'), 'a.tex': '\\input{b}', 'b.tex': '\\input{a}\\usepackage{fontspec}' }, 'pdflatex', 'xelatex'],
]

for (const [name, files, current, expected, root] of cases) {
  const decision = await detect(files, current, root)
  const got = decision ? decision.compiler : null
  check(name, got === expected, `-> ${got}${decision?.reason ? ` (${decision.reason})` : ''}`)
}

check('stripComments keeps \\\\% and strips %', stripComments('a\\%b % c\n\\\\% d') === 'a\\%b \n\\\\')

const logs = [
  ['fontspec under pdflatex', '! Fatal Package fontspec Error: The fontspec package requires either XeTeX or\n(fontspec)                      LuaTeX.\n', 'pdflatex', 'xelatex'],
  ['unicode-math under pdflatex', '! Package unicode-math Error: Cannot be run with pdftex!\n(unicode-math)                Use XeLaTeX or LuaLaTeX instead.\n', 'pdflatex', 'xelatex'],
  ['xeCJK under lualatex', '! Critical Package xeCJK Error: The xeCJK package requires XeTeX to function.\n(xeCJK)\n(xeCJK)                         You must change your typesetting engine to\n(xeCJK)                         "xelatex" instead of plain "tex" or "pdflatex".\n', 'lualatex', 'xelatex'],
  ['luacode under xelatex', '! Package luacode Error: LuaTeX is required for this package. Aborting..\n', 'xelatex', 'lualatex'],
  ['luatexja under pdflatex', '! Package luatexja-core Error: This package requires Lua(HB)(La)TeX.\n', 'pdflatex', 'lualatex'],
  ['ctex fontset under pdflatex', "! Critical Class ctexart Error: CTeX fontset `fandol' is unavailable in\n(ctexart)                       current mode.\n", 'pdflatex', 'xelatex'],
  ['\\RequireXeTeX box', ' ********************************************\n * XeTeX is required to compile this document.\n * Sorry!\n ********************************************\n\n! Emergency stop.\n', 'pdflatex', 'xelatex'],
  ['pstricks under pdflatex', '! Undefined control sequence.\n\\c@lor@to@ps ->\\PSTricks \n                         _Not_Configured_For_This_Format\n', 'pdflatex', 'xelatex'],
  ['ordinary error -> no switch', '! Undefined control sequence.\nl.5 \\foo\n', 'pdflatex', null],
  ['missing file -> no switch', "! LaTeX Error: File `missing.sty' not found.\n", 'pdflatex', null],
  ['"only in preamble" -> no switch', '! LaTeX Error: Can be used only in preamble.\n', 'xelatex', null],
  ['already on the asked engine -> no switch', '! Package luacode Error: LuaTeX is required for this package.\n', 'lualatex', null],
]
for (const [name, log, current, expected] of logs) {
  const got = engineFromLog(log, current)?.compiler ?? null
  check(`log: ${name}`, got === expected, `-> ${got}`)
}

const failed = Object.entries(results).filter(([, ok]) => !ok).map(([name]) => name)
console.log(`\nSUMMARY ${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed${failed.length ? `; failed: ${failed.join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
