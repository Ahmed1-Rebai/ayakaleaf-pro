// LambdaTeX addition: works out which TeX engine a LaTeX project needs.
// Pure functions (no Overleaf imports) used by CompilerAutoSelect.mjs:
//   detectCompiler()  reads the main file and everything it loads from the
//                     project (\input, local .sty/.cls, beamer themes) and
//                     returns the engine its magic comment, packages and
//                     commands require;
//   engineFromLog()   reads a failed compile's log for "requires XeTeX"-style
//                     errors, as a fallback for packages not listed here.
import Path from 'node:path'

export const ENGINES = ['pdflatex', 'latex', 'xelatex', 'lualatex']

// When several engines would work, prefer XeLaTeX: it starts quickly, while
// LuaLaTeX builds its font cache on first use in every compile container.
const PREFERENCE = ['xelatex', 'lualatex', 'pdflatex', 'latex']

const UNICODE = ['xelatex', 'lualatex']
const XETEX = ['xelatex']
const LUATEX = ['lualatex']
const PDFTEX = ['pdflatex', 'latex']
const PSTRICKS = ['xelatex', 'latex'] // PDF output via xdvipdfmx or dvips

const PACKAGES = {
  fontspec: UNICODE,
  'unicode-math': UNICODE,
  polyglossia: UNICODE,
  realscripts: UNICODE,
  fontsetup: UNICODE,
  'libertinus-otf': UNICODE,
  academicons: UNICODE,
  ctex: UNICODE,
  xeCJK: XETEX,
  xeCJKfntef: XETEX,
  xltxtra: XETEX,
  xunicode: XETEX,
  mathspec: XETEX,
  xetexko: XETEX,
  xepersian: XETEX,
  bidi: XETEX,
  xgreek: XETEX,
  xecyr: XETEX,
  arabxetex: XETEX,
  xevlna: XETEX,
  zhspacing: XETEX,
  luacode: LUATEX,
  luatextra: LUATEX,
  luaotfload: LUATEX,
  luamplib: LUATEX,
  luacolor: LUATEX,
  'lua-ul': LUATEX,
  'lua-visual-debug': LUATEX,
  'lua-widow-control': LUATEX,
  'lualatex-math': LUATEX,
  luatexja: LUATEX,
  'luatexja-fontspec': LUATEX,
  'luatexja-preset': LUATEX,
  'luatexja-ruby': LUATEX,
  luatexko: LUATEX,
  luavlna: LUATEX,
  selnolig: LUATEX,
  emoji: LUATEX,
  pyluatex: LUATEX,
  chickenize: LUATEX,
  pstricks: PSTRICKS,
  'pstricks-add': PSTRICKS,
}
// Packages that let pdfLaTeX run PSTricks (through shell escape)
const PSTRICKS_UNDER_PDFTEX = ['auto-pst-pdf', 'pst-pdf', 'pdftricks', 'pdftricks2']

const CLASSES = {
  ctexart: UNICODE,
  ctexrep: UNICODE,
  ctexbook: UNICODE,
  ctexbeamer: UNICODE,
}

const COMMANDS = [
  [
    /\\(?:setmainfont|setsansfont|setmonofont|setmathfont|newfontfamily|newfontface|setfontfamily|setfontface|defaultfontfeatures|setCJKmainfont|setCJKsansfont|setCJKmonofont)\b/,
    UNICODE,
    'system fonts (\\setmainfont)',
  ],
  [
    /\\(?:directlua|luaexec|luadirect)\b|\\begin\s*\{(?:luacode\*?|luablock)\}/,
    LUATEX,
    'Lua code (\\directlua)',
  ],
  [
    /\\XeTeX(?:linebreaklocale|linebreakskip|inputencoding|defaultencoding|interchartokenstate|charclass|interchartoks)\b/,
    XETEX,
    'XeTeX primitives',
  ],
]

// \RequireXeTeX etc. (iftex) state the engine outright.
const REQUIRE = /\\Require(XeTeX|LuaTeX|TUTeX|PDFTeX)\b/g
const REQUIRED = { XeTeX: XETEX, LuaTeX: LUATEX, TUTeX: UNICODE, PDFTeX: PDFTEX }

// A file that tests the engine supports more than one; its package and
// command hints are ignored (\Require... still counts).
const ENGINE_CONDITIONAL =
  /\\if(?:xe|lua|pdf|tu)(?:la)?tex\b|\\(?:ifdefined|ifx|ifcsname|@ifundefined\s*\{|ifundef|ifcsundef\s*\{|ifdef)\s*\\?(?:XeTeXrevision|XeTeXversion|luatexversion|luatexrevision|pdftexversion|directlua)\b|\\sys_if_engine_/i

const MAGIC = /^[ \t]*%[ \t]*!\s*TeX\s+(?:TS-)?program\s*=\s*([A-Za-z]+)/im
const ARARA = /^[ \t]*%[ \t]*arara\s*:\s*([A-Za-z]+)/gim
const MAGIC_NAMES = {
  pdflatex: 'pdflatex',
  pdftex: 'pdflatex',
  latex: 'latex',
  xelatex: 'xelatex',
  xetex: 'xelatex',
  lualatex: 'lualatex',
  luatex: 'lualatex',
}

const OPTIONS = String.raw`\s*(?:\[[^\]]*\])?\s*`
const INPUT = new RegExp(
  String.raw`\\(?:input|include|subfile|InputIfFileExists|includestandalone)${OPTIONS}\{([^{}]+)\}`,
  'g'
)
const INPUT_BARE = /\\input\s+([A-Za-z0-9_./-]+)/g
const IMPORT =
  /\\(?:sub)?(?:import|inputfrom|includefrom)\*?\s*\{([^{}]*)\}\s*\{([^{}]+)\}/g
const PACKAGE = new RegExp(
  String.raw`\\(?:usepackage|RequirePackage|RequirePackageWithOptions)${OPTIONS}\{([^{}]+)\}`,
  'g'
)
const CLASS = new RegExp(
  String.raw`\\(?:documentclass|LoadClass|LoadClassWithOptions)${OPTIONS}\{([^{}]+)\}`,
  'g'
)
const THEME = new RegExp(
  String.raw`\\use(color|font|inner|outer)?theme${OPTIONS}\{([^{}]+)\}`,
  'g'
)

/** The engine named by a "% !TEX program = ..." or "% arara: ..." line before \documentclass. */
export function magicCompiler(text) {
  const head = text.split(/\\documentclass/)[0].split('\n').slice(0, 50).join('\n')
  const magic = MAGIC.exec(head)
  if (magic && MAGIC_NAMES[magic[1].toLowerCase()]) {
    return { compiler: MAGIC_NAMES[magic[1].toLowerCase()], line: magic[0].trim() }
  }
  for (const arara of head.matchAll(ARARA)) {
    const compiler = MAGIC_NAMES[arara[1].toLowerCase()]
    if (compiler) return { compiler, line: arara[0].trim() }
  }
  return null
}

/** Removes % comments (keeping \%) and simple \iffalse ... \fi blocks. */
export function stripComments(text) {
  const lines = text.split('\n').map(line => {
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\') i++
      else if (line[i] === '%') return line.slice(0, i)
    }
    return line
  })
  return lines.join('\n').replace(/\\iffalse\b(?:(?!\\if)[\s\S])*?\\fi\b/g, '')
}

function normalise(path) {
  return Path.posix.normalize(path.trim()).replace(/^(\.\/|\/)+/, '')
}

function names(list) {
  return list
    .split(',')
    .map(name => name.trim())
    .filter(name => /^[A-Za-z0-9_./-]+$/.test(name))
}

/**
 * @param {object} args
 * @param {string} args.rootPath   main file, project-relative
 * @param {string} args.current    engine the project is set to
 * @param {(path: string) => Promise<string|null>} args.read  text of a project doc, or null
 * @param {(path: string) => boolean} args.has  whether a project doc exists
 * @returns {Promise<null | { compiler: string, changed: boolean, reason: string, source: string, files: number }>}
 *   null when nothing in the project constrains the engine
 */
export async function detectCompiler({
  rootPath,
  current,
  read,
  has,
  maxFiles = 60,
  maxBytes = 4_000_000,
}) {
  current = ENGINES.includes(current) ? current : 'pdflatex'
  const root = normalise(rootPath)
  const rootText = await read(root)
  if (rootText == null) return null

  const magic = magicCompiler(rootText)
  if (magic) {
    return {
      compiler: magic.compiler,
      changed: magic.compiler !== current,
      reason: `${magic.line} in ${root}`,
      source: 'magic-comment',
      files: 1,
    }
  }

  const constraints = []
  const seen = new Set([root])
  const queue = [[root, rootText]]
  let bytes = 0

  const follow = (from, name, extensions) => {
    const dirs = new Set(['', Path.posix.dirname(root), Path.posix.dirname(from)])
    for (const dir of dirs) {
      for (const extension of extensions) {
        const path = normalise(Path.posix.join(dir === '.' ? '' : dir, name + extension))
        if (has(path)) {
          if (!seen.has(path)) {
            seen.add(path)
            queue.push([path, null])
          }
          return true
        }
      }
    }
    return false
  }

  while (queue.length && seen.size <= maxFiles) {
    let [path, text] = queue.shift()
    if (text == null) text = await read(path)
    if (text == null) continue
    bytes += text.length
    if (bytes > maxBytes) break
    text = stripComments(text)
    const hints = !ENGINE_CONDITIONAL.test(text)
    const add = (engines, why) => constraints.push({ engines, why: `${why} (${path})` })

    for (const match of text.matchAll(REQUIRE)) {
      add(REQUIRED[match[1]], `\\Require${match[1]}`)
    }
    const packages = []
    for (const match of text.matchAll(PACKAGE)) packages.push(...names(match[1]))
    for (const name of packages) {
      if (follow(path, name, ['.sty'])) continue
      const engines = PACKAGES[name] || (name.startsWith('pst-') ? PSTRICKS : null)
      if (!engines || !hints) continue
      if (engines === PSTRICKS && packages.some(p => PSTRICKS_UNDER_PDFTEX.includes(p))) continue
      add(engines, `package ${name}`)
    }
    for (const match of text.matchAll(CLASS)) {
      const name = match[1].trim()
      if (!follow(path, name, ['.cls']) && CLASSES[name] && hints) add(CLASSES[name], `class ${name}`)
    }
    for (const match of text.matchAll(THEME)) {
      for (const name of names(match[2])) follow(path, `beamer${match[1] || ''}theme${name}`, ['.sty'])
    }
    for (const match of text.matchAll(INPUT)) {
      for (const name of names(match[1])) follow(path, name, ['', '.tex'])
    }
    for (const match of text.matchAll(INPUT_BARE)) follow(path, match[1], ['', '.tex'])
    for (const match of text.matchAll(IMPORT)) {
      follow(path, Path.posix.join(match[1].trim(), match[2].trim()), ['', '.tex'])
    }
    if (hints) {
      for (const [pattern, engines, why] of COMMANDS) {
        if (pattern.test(text)) add(engines, why)
      }
    }
  }

  if (!constraints.length) return null
  const allowed = ENGINES.filter(engine => constraints.every(c => c.engines.includes(engine)))
  if (!allowed.length) {
    return {
      compiler: current,
      changed: false,
      reason: `conflicting requirements: ${constraints.map(c => c.why).join('; ')}`,
      source: 'conflict',
      files: seen.size,
    }
  }
  const compiler = allowed.includes(current)
    ? current
    : PREFERENCE.find(engine => allowed.includes(engine))
  const decisive = constraints.filter(c => !c.engines.includes(current))
  return {
    compiler,
    changed: compiler !== current,
    reason: (decisive.length ? decisive : constraints)
      .slice(0, 3)
      .map(c => c.why)
      .join('; '),
    source: 'packages',
    files: seen.size,
  }
}

const REQUIREMENT =
  /requir|must|only|cannot be run|can't be run|change your typesetting engine|instead|not supported/i

/**
 * Engine asked for by the errors of a failed compile, e.g. "The fontspec
 * package requires either XeTeX or LuaTeX". Null if the log names none.
 */
export function engineFromLog(log, current) {
  const lines = log.split('\n')
  const blocks = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('!')) {
      blocks.push(lines.slice(i, i + 6).join(' '))
    }
    // iftex's \RequireXeTeX prints a box before "! Emergency stop."
    const box = /^\s*\*\s*((?:Xe|Lua|pdf)TeX) is required to compile this document/.exec(lines[i])
    if (box) blocks.push(`! ${box[1]} is required to compile this document`)
  }
  for (const raw of blocks) {
    const block = raw.replace(/\([A-Za-z@-]+\)\s+/g, ' ').replace(/\s+/g, ' ')
    let candidates = []
    if (/CTeX fontset .{0,60}unavailable/i.test(block)) {
      candidates = UNICODE
    } else if (/PSTricks\s*_?Not_?Configured/i.test(block)) {
      candidates = PSTRICKS
    } else if (REQUIREMENT.test(block)) {
      if (/\bXe(?:La)?TeX\b/i.test(block)) candidates.push('xelatex')
      if (/\bLua(?:\(HB\))?(?:HB)?(?:\(La\))?(?:La)?TeX\b/i.test(block)) candidates.push('lualatex')
      if (/\bpdf(?:La)?TeX\b/i.test(block)) candidates.push('pdflatex')
    }
    candidates = candidates.filter(
      engine => engine !== current && !(current === 'latex' && engine === 'pdflatex')
    )
    if (candidates.length) {
      return {
        compiler: PREFERENCE.find(engine => candidates.includes(engine)),
        reason: block.trim().slice(0, 160),
      }
    }
  }
  return null
}
