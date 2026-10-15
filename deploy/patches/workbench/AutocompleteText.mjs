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
