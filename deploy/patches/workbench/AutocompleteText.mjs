// LambdaTeX addition: turns an autocomplete reply from the model into text that
// can be inserted at the cursor. Pure functions (no Overleaf imports), used by
// AutocompleteController.mjs and unit-tested by deploy/tests/autocomplete_text_test.mjs.

const MAX_LENGTH = 160

// The cursor is inside a word: suggestions are not made there (the editor only
// asks at word boundaries) because a chat model can't be trusted to say
// whether its text continues the word or starts a new one.
export const MID_WORD = /[\p{L}\p{N}]$/u
// No space between these and the suggestion (whitespace, openers, $, ~, joiners).
const NO_SPACE_AFTER = /[\s([{$~\-/_'`]$/
// After these, a suggestion that starts with a word gets one space.
const WORD_START = /^[\p{L}\p{N}\\]/u

// Removes the part of the suggestion that the text after the cursor already has,
// e.g. a "}" the editor closed automatically.
function trimSuffixOverlap(text, suffix) {
  const line = suffix.split('\n')[0]
  for (let k = Math.min(text.length, line.length, 40); k >= 1; k--) {
    const overlap = line.slice(0, k)
    if (text.endsWith(overlap) && (k >= 4 || /^[\]})$]+$/.test(overlap))) {
      return text.slice(0, -k)
    }
  }
  return text
}

/** Turns the model's reply into text that can be inserted at the cursor, or ''. */
export function cleanCompletion(raw, prefix, suffix) {
  if (MID_WORD.test(prefix)) return ''
  let text = String(raw || '')
    .replace(/\r/g, '')
    .replace(/‸/g, '')
    .replace(/^\s*```[a-z]*\n?/i, '')
    .replace(/\n?```\s*$/, '')
  if (/^[ \t]*\n/.test(text)) return '' // shown inline: the suggestion must start on this line
  text = text.split('\n')[0].replace(/^[ \t]+/, '')
  if (!text.trim()) return ''
  // Models sometimes start by repeating the word just typed ("approaches to " +
  // "to the..."); only when nothing but spaces follows that word.
  const lastWord = /([\p{L}\p{N}']+)\s*$/u.exec(prefix)?.[1]
  const firstWord = /^([\p{L}\p{N}']+)/u.exec(text)
  if (lastWord && firstWord && firstWord[1].toLowerCase() === lastWord.toLowerCase()) {
    text = text.slice(firstWord[0].length).replace(/^[ \t]+/, '')
    if (!text.trim()) return ''
  }
  if (/[.!?]$/.test(prefix) && /^[,;:.]/.test(text)) return '' // never continue a finished sentence
  if (!NO_SPACE_AFTER.test(prefix) && prefix !== '' && WORD_START.test(text)) text = ' ' + text
  const core = text.trim()
  if (core.length >= 12 && prefix.slice(-400).includes(core)) return '' // repeats earlier text
  text = trimSuffixOverlap(text, suffix)
  if (text.length > MAX_LENGTH) {
    const cut = text.lastIndexOf(' ', MAX_LENGTH)
    text = text.slice(0, cut > 40 ? cut : MAX_LENGTH)
  }
  return text.trimEnd()
}

// ------------------------------------------------------------ corrections

const MAX_FIXES = 3
const FIX_WINDOW = 400 // characters before the cursor where corrections may be made
// Corrections never touch LaTeX commands, math, comments, or span lines.
const FIX_FORBIDDEN = /[\\$%\n]/
// ...nor keys, labels, URLs or file names in these commands' arguments.
const INSIDE_KEY_ARGUMENT =
  /\\(?:[A-Za-z]*cite[A-Za-z]*|[A-Za-z]*ref|label|url|href|input|include|includegraphics|bibliography|usepackage)\*?(?:\[[^\]\n]*\])*\{[^}\n]*$/

/** Reads { fixes, text } from the reply of the autocorrect prompt (JSON), or null. */
export function parseCorrectionReply(raw) {
  const reply = String(raw || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
  try {
    const data = JSON.parse(reply.match(/\{[\s\S]*\}/)?.[0] ?? '')
    if (data && typeof data === 'object') {
      return {
        fixes: Array.isArray(data.fixes) ? data.fixes : [],
        text: typeof data.text === 'string' ? data.text : '',
      }
    }
  } catch {}
  return null
}

const isWordChar = c => c !== undefined && /[\p{L}\p{N}_]/u.test(c)

function onWordBoundaries(area, at, wrong) {
  const startOk = !(isWordChar(area[at - 1]) && isWordChar(wrong[0]))
  const endOk = !(isWordChar(area[at + wrong.length]) && isWordChar(wrong[wrong.length - 1]))
  return startOk && endOk
}

/**
 * Places the model's corrections on the text just typed: the last occurrence of
 * `wrong` (as whole words) in the current paragraph, within FIX_WINDOW
 * characters before the cursor. Anything doubtful is dropped: LaTeX markup,
 * keys and labels, large rewrites, overlaps. Returns
 * [{ from, to, text, wrong }] with offsets relative to the cursor (<= 0).
 */
export function placeFixes(fixes, prefix) {
  const paragraph = prefix.lastIndexOf('\n\n')
  const start = Math.max(prefix.length - FIX_WINDOW, paragraph < 0 ? 0 : paragraph + 2)
  const area = prefix.slice(start)
  const placed = []
  for (const fix of (fixes || []).slice(0, MAX_FIXES)) {
    const wrong = typeof fix?.wrong === 'string' ? fix.wrong : ''
    const right = typeof fix?.right === 'string' ? fix.right : ''
    if (!wrong.trim() || !right.trim() || wrong === right) continue
    if (wrong.length > 80 || right.length > wrong.length * 2 + 20) continue
    if (FIX_FORBIDDEN.test(wrong) || FIX_FORBIDDEN.test(right)) continue
    let at = area.lastIndexOf(wrong)
    while (at >= 0 && !onWordBoundaries(area, at, wrong)) {
      at = at === 0 ? -1 : area.lastIndexOf(wrong, at - 1)
    }
    if (at < 0) continue
    if (INSIDE_KEY_ARGUMENT.test(area.slice(Math.max(0, at - 120), at))) continue
    const from = start + at - prefix.length
    const to = from + wrong.length
    if (placed.some(other => from < other.to && to > other.from)) continue
    placed.push({ from, to, text: right, wrong })
  }
  return placed.sort((a, b) => a.from - b.from)
}
