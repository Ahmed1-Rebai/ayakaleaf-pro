// Unit tests for deploy/patches/workbench/AutocompleteText.mjs (no server needed).
// Run with Node 18+, e.g. in the web image:
//   docker run --rm -v ~/lambdatex/deploy:/d:ro --entrypoint node <web image> /d/tests/autocomplete_text_test.mjs
import { cleanCompletion, parseCorrectionReply, placeFixes } from '../patches/workbench/AutocompleteText.mjs'

const results = {}
function check(name, ok, detail = '') {
  results[name] = Boolean(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`)
}

const cases = [
  // [name, model reply, text before the cursor, text after, expected insertion]
  ['after a space: no space added', 'powerful tools for NLP', 'Large language models are ', '', 'powerful tools for NLP'],
  ['after a space: the model\'s own leading space is removed', ' powerful tools', 'models are ', '', 'powerful tools'],
  ['after a full stop: one space before the next sentence', 'They are used widely.', 'machine translation.', '', ' They are used widely.'],
  ['after a full stop even if the model added a space', ' They are used.', 'translation.', '', ' They are used.'],
  ['after a comma: one space', 'which rely on attention', 'Transformers,', '', ' which rely on attention'],
  ['after a closing brace: one space', 'is used here', '\\emph{attention}', '', ' is used here'],
  ['after an opening brace: none', 'Related Work', '\\section{', '}', 'Related Work'],
  ['after $: none', 'x^2 + y^2', 'we have $', '$', 'x^2 + y^2'],
  ['after a tie ~: none', '\\ref{fig:a}', 'Figure~', '', '\\ref{fig:a}'],
  ['after a hyphen: none', 'the-art methods', 'state-of-', '', 'the-art methods'],
  ['French elision l\': none', 'analyse des résultats', "pour l'", '', 'analyse des résultats'],
  ['start of a line: none', '\\item First point', '\\begin{itemize}\n  ', '', '\\item First point'],
  ['inside a word: never suggested', 'powerful', 'models are', '', ''],
  ['inside a word (French): never suggested', 'ons une approche', 'nous propos', '', ''],
  ['inside a word (digit): never suggested', '0 GPUs', 'trained on 1', '', ''],
  ['auto-closed brace after the cursor is not repeated', 'Introduction}', '\\section{', '}', 'Introduction'],
  ['auto-closed $ after the cursor is not repeated', 'mc^2$', 'Einstein showed $E = ', '$.', 'mc^2'],
  ['text already before the cursor is dropped', 'We train on 8 GPUs for three days.', 'We train on 8 GPUs for three days. ', '', ''],
  ['a comma after a finished sentence is dropped', ', surpassing earlier work.', 'translation.', '', ''],
  ['only the first line is kept', 'first line\nsecond line', 'This is the ', '', 'first line'],
  ['a suggestion starting on the next line is dropped', '\n\\item Next', '\\item First ', '', ''],
  ['empty reply gives nothing', '', 'Some text ', '', ''],
  ['a repeated last word is dropped', 'to the problem', 'many approaches to ', '', 'the problem'],
  ['only the repeated last word: nothing', 'to', 'many approaches to ', '', ''],
  ['a new sentence after a full stop is not a repeat', 'We use it', 'and so we. ', '', 'We use it'],
  ['code fences are removed', '```latex\nnew method\n```', 'we propose a ', '', 'new method'],
]
for (const [name, reply, prefix, suffix, expected] of cases) {
  const got = cleanCompletion(reply, prefix, suffix)
  check(name, got === expected, `-> ${JSON.stringify(got)}`)
}

const long = cleanCompletion('word '.repeat(60).trim(), 'Here is a ', '')
check('long suggestions are cut at a word boundary', long.length <= 160 && !long.endsWith(' ') && long.startsWith('word'), `${long.length} chars`)

// ---------------------------------------------------------- corrections
const apply = (prefix, fixes) => {
  let out = prefix
  for (const fix of [...fixes].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, prefix.length + fix.from) + fix.text + out.slice(prefix.length + fix.to)
  }
  return out
}
const fixCases = [
  // [name, fixes from the model, text before the cursor, expected text after applying]
  ['a typo is placed and fixed', [{ wrong: 'papr', right: 'paper' }], 'In this papr, we ', 'In this paper, we '],
  ['two typos', [{ wrong: 'resutls', right: 'results' }, { wrong: 'experimetns', right: 'experiments' }], 'The resutls of our experimetns show that ', 'The results of our experiments show that '],
  ['grammar with context words', [{ wrong: 'they was', right: 'they were' }], 'In our study, they was able to ', 'In our study, they were able to '],
  ['the last occurrence is the one fixed', [{ wrong: 'teh', right: 'the' }], 'Use teh old one. Then teh ', 'Use teh old one. Then the '],
  ['whole words only (not inside "theory")', [{ wrong: 'the', right: 'a' }], 'A theory of ', 'A theory of '],
  ['LaTeX commands are never edited', [{ wrong: '\\secton', right: '\\section' }], '\\secton{Intro} We ', '\\secton{Intro} We '],
  ['math is never edited', [{ wrong: '$x^2$', right: '$x^3$' }], 'We have $x^2$ and ', 'We have $x^2$ and '],
  ['citation keys are never edited', [{ wrong: 'vaswnai2017', right: 'vaswani2017' }], 'As in~\\cite{vaswnai2017', 'As in~\\cite{vaswnai2017'],
  ['text not in the current paragraph is ignored', [{ wrong: 'papr', right: 'paper' }], 'The papr is old.\n\nNew paragraph ', 'The papr is old.\n\nNew paragraph '],
  ['text the model made up is ignored', [{ wrong: 'missing', right: 'found' }], 'Nothing to fix here ', 'Nothing to fix here '],
  ['large rewrites are ignored', [{ wrong: 'ok', right: 'a much longer sentence that rewrites everything the author wrote' }], 'This is ok ', 'This is ok '],
  ['empty or identical fixes are ignored', [{ wrong: 'fine', right: 'fine' }, { wrong: 'x', right: '' }], 'All fine x ', 'All fine x '],
]
for (const [name, fixes, prefix, expected] of fixCases) {
  const placed = placeFixes(fixes, prefix)
  const got = apply(prefix, placed)
  check(`fix: ${name}`, got === expected && placed.every(f => f.to <= 0 && prefix.slice(prefix.length + f.from, prefix.length + f.to) === f.wrong), `-> ${JSON.stringify(got)}`)
}
check('at most 3 fixes are kept', placeFixes([1, 2, 3, 4].map(i => ({ wrong: `w${i}`, right: `r${i}` })), 'w1 w2 w3 w4 ').length === 3)
check('JSON reply with fixes and text is read', JSON.stringify(parseCorrectionReply('```json\n{"fixes":[{"wrong":"papr","right":"paper"}],"text":"propose"}\n```')) === '{"fixes":[{"wrong":"papr","right":"paper"}],"text":"propose"}')
check('a reply that is not JSON gives null', parseCorrectionReply('Sure, here you go') === null)

const failed = Object.entries(results).filter(([, ok]) => !ok).map(([name]) => name)
console.log(`\nSUMMARY ${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed${failed.length ? `; failed: ${failed.join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
