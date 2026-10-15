// Registers LambdaTeX's frontend module entries in the image's
// config/settings.defaults.js, which webpack reads (overleafModuleImports)
// when it builds the editor. Run by build.sh inside the throwaway build
// container only; the running app is not affected. Fails loudly if upstream
// renames a slot, so a build never silently drops a feature.
const fs = require('fs')

const file = process.argv[2]
const entries = {
  // AI autocomplete (ghost text) in the source editor
  sourceEditorExtensions: '../modules/workbench/frontend/js/codemirror/ai-autocomplete',
  // its switch in Settings → Editor
  settingsModalEditorTabSections: '../modules/workbench/frontend/js/components/ai-autocomplete-setting',
}

let source = fs.readFileSync(file, 'utf8')
for (const [slot, path] of Object.entries(entries)) {
  const anchor = `    ${slot}: [`
  if (source.split(anchor).length !== 2) {
    console.error(`register-modules: slot "${slot}" not found once in ${file}`)
    process.exit(1)
  }
  source = source.replace(anchor, `${anchor}\n      Path.resolve(__dirname, '${path}'),`)
  console.log(`register-modules: ${slot} += ${path}`)
}
fs.writeFileSync(file, source)
