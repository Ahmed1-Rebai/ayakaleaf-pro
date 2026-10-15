// Unit tests for deploy/patches/workbench/AutocompleteText.mjs (no server needed).
// Run with Node 18+, e.g. in the web image:
//   docker run --rm -v ~/lambdatex/deploy:/d:ro --entrypoint node <web image> /d/tests/autocomplete_text_test.mjs
import { cleanCompletion } from '../patches/workbench/AutocompleteText.mjs'

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
  ['code fences are removed', '```latex\nnew method\n```', 'we propose a ', '', 'new method'],
]
for (const [name, reply, prefix, suffix, expected] of cases) {
  const got = cleanCompletion(reply, prefix, suffix)
  check(name, got === expected, `-> ${JSON.stringify(got)}`)
}

const long = cleanCompletion('word '.repeat(60).trim(), 'Here is a ', '')
check('long suggestions are cut at a word boundary', long.length <= 160 && !long.endsWith(' ') && long.startsWith('word'), `${long.length} chars`)

const failed = Object.entries(results).filter(([, ok]) => !ok).map(([name]) => name)
console.log(`\nSUMMARY ${Object.keys(results).length - failed.length}/${Object.keys(results).length} passed${failed.length ? `; failed: ${failed.join(', ')}` : ''}`)
process.exit(failed.length ? 1 : 0)
