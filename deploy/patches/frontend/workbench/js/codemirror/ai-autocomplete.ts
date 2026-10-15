/**
 * LambdaTeX: AI autocomplete in the source editor.
 *
 * After a short pause in typing, the text around the cursor is sent to
 * /workbench/autocomplete and the suggestion is shown as grey "ghost" text at
 * the cursor. Tab accepts it, Esc dismisses it, and typing the same characters
 * keeps the rest of it. It stays out of the way of Overleaf's own completion
 * list, of \cite/\ref/\label and file arguments (the model can't know the keys),
 * of command names, and of the Visual editor. Registered as a
 * sourceEditorExtensions module entry (deploy/frontend/register-modules.cjs);
 * the switch is in Settings → Editor (../components/ai-autocomplete-setting.tsx).
 */
import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type ViewUpdate,
} from '@codemirror/view'
import { completionStatus, hasNextSnippetField } from '@codemirror/autocomplete'
import { postJSON } from '@/infrastructure/fetch-json'
import getMeta from '@/utils/meta'
import { isVisual } from '@/features/source-editor/extensions/visual/visual'

const STORAGE_KEY = 'lambdatex.aiAutocomplete'
const TOGGLE_EVENT = 'lambdatex:ai-autocomplete'
const DELAY_MS = 450
const PREFIX_CHARS = 3000
const SUFFIX_CHARS = 1000
const LATEX_FILE = /\.(tex|ltx|sty|cls|dtx)$/i
// Arguments the model can't know (keys, labels, files) and command names, which
// Overleaf's own completion handles.
const SKIP_BEFORE =
  /(\\[A-Za-z@]*|\\(?:[A-Za-z]*cite[A-Za-z]*|[A-Za-z]*ref|label|input|include|includegraphics|includepdf|includeonly|bibliography|bibliographystyle|addbibresource|usepackage|RequirePackage|documentclass|begin|end|url|href|usetikzlibrary)\*?(?:\[[^\]\n]*\])*\{[^}\n]*)$/
// Only suggest at the end of a line, or before closing characters.
const REST_OF_LINE_OK = /^[\s)\]}$]*$/

export function isAiAutocompleteEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

export function setAiAutocompleteEnabled(enabled: boolean) {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off')
  } catch {}
  window.dispatchEvent(new CustomEvent(TOGGLE_EVENT, { detail: enabled }))
}

type Suggestion = { pos: number; text: string } | null

const setSuggestion = StateEffect.define<Suggestion>()

class GhostText extends WidgetType {
  constructor(readonly text: string) {
    super()
  }

  eq(other: GhostText) {
    return other.text === this.text
  }

  toDOM() {
    const ghost = document.createElement('span')
    ghost.className = 'ol-cm-ai-ghost'
    ghost.setAttribute('aria-hidden', 'true')
    ghost.textContent = this.text
    const hint = document.createElement('span')
    hint.className = 'ol-cm-ai-ghost-hint'
    hint.textContent = 'Tab'
    ghost.appendChild(hint)
    return ghost
  }

  ignoreEvent() {
    return false
  }
}

const suggestionField = StateField.define<Suggestion>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSuggestion)) return effect.value
    }
    if (!value) return value
    if (tr.docChanged) {
      // Typing the next characters of the suggestion keeps the rest of it.
      let typed: string | null = null
      let simple = true
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        if (typed === null && fromA === value.pos && toA === fromA) {
          typed = inserted.toString()
        } else {
          simple = false
        }
      })
      const text: string = typed ?? ''
      if (simple && text && text.length < value.text.length && value.text.startsWith(text)) {
        return { pos: value.pos + text.length, text: value.text.slice(text.length) }
      }
      return null
    }
    if (tr.selection) {
      const { main } = tr.state.selection
      if (!main.empty || main.head !== value.pos) return null
    }
    return value
  },
  provide: field =>
    EditorView.decorations.from(field, value =>
      value
        ? Decoration.set([
            Decoration.widget({ widget: new GhostText(value.text), side: 1 }).range(value.pos),
          ])
        : Decoration.none
    ),
})

function accept(view: EditorView) {
  const value = view.state.field(suggestionField, false)
  if (!value || completionStatus(view.state) === 'active') return false
  const { main } = view.state.selection
  if (!main.empty || main.head !== value.pos) return false
  view.dispatch({
    changes: { from: value.pos, insert: value.text },
    selection: { anchor: value.pos + value.text.length },
    effects: setSuggestion.of(null),
    userEvent: 'input.complete',
    scrollIntoView: true,
  })
  return true
}

function dismiss(view: EditorView) {
  if (!view.state.field(suggestionField, false)) return false
  view.dispatch({ effects: setSuggestion.of(null) })
  return true
}

function fetcher(path: string) {
  return ViewPlugin.fromClass(
    class {
      timer: number | undefined
      controller: AbortController | null = null
      blocked = false // the server said no (no consent, no access): stop for this session

      constructor(readonly view: EditorView) {
        this.onToggle = this.onToggle.bind(this)
        window.addEventListener(TOGGLE_EVENT, this.onToggle)
      }

      onToggle() {
        this.cancel()
        if (!isAiAutocompleteEnabled()) {
          window.setTimeout(() => dismiss(this.view))
        }
      }

      cancel() {
        window.clearTimeout(this.timer)
        this.timer = undefined
        this.controller?.abort()
        this.controller = null
      }

      update(update: ViewUpdate) {
        if (!update.docChanged && !update.selectionSet && !update.focusChanged) return
        this.cancel()
        if (update.focusChanged && !update.view.hasFocus) {
          window.setTimeout(() => dismiss(this.view))
          return
        }
        const typing = update.transactions.some(tr => tr.isUserEvent('input.type'))
        if (!typing || update.state.field(suggestionField, false)) return
        this.timer = window.setTimeout(() => this.request(), DELAY_MS)
      }

      request() {
        const { view } = this
        const { state } = view
        const { main } = state.selection
        if (
          this.blocked ||
          !isAiAutocompleteEnabled() ||
          !view.hasFocus ||
          state.selection.ranges.length > 1 ||
          !main.empty ||
          isVisual(view) ||
          completionStatus(state) !== null ||
          hasNextSnippetField(state) // Tab moves between snippet fields there
        ) {
          return
        }
        const pos = main.head
        const line = state.doc.lineAt(pos)
        if (!REST_OF_LINE_OK.test(state.sliceDoc(pos, line.to))) return
        const beforeOnLine = state.sliceDoc(line.from, pos)
        if (SKIP_BEFORE.test(beforeOnLine)) return
        const prefix = state.sliceDoc(Math.max(0, pos - PREFIX_CHARS), pos)
        if (prefix.trim().length < 10) return

        const doc = state.doc
        const controller = new AbortController()
        this.controller = controller
        postJSON('/workbench/autocomplete', {
          body: {
            projectId: getMeta('ol-project_id'),
            path,
            prefix,
            suffix: state.sliceDoc(pos, Math.min(doc.length, pos + SUFFIX_CHARS)),
          },
          signal: controller.signal,
        })
          .then((data: { completion?: string }) => {
            if (this.controller !== controller) return
            this.controller = null
            const current = view.state
            const text = data?.completion
            if (
              !text ||
              current.doc !== doc ||
              !current.selection.main.empty ||
              current.selection.main.head !== pos ||
              !view.hasFocus ||
              completionStatus(current) !== null
            ) {
              return
            }
            view.dispatch({ effects: setSuggestion.of({ pos, text }) })
          })
          .catch((error: any) => {
            if (this.controller === controller) this.controller = null
            const status = error?.response?.status
            if (status === 403 || status === 404) this.blocked = true
          })
      }

      destroy() {
        this.cancel()
        window.removeEventListener(TOGGLE_EVENT, this.onToggle)
      }
    }
  )
}

const ghostTheme = EditorView.baseTheme({
  '.ol-cm-ai-ghost': {
    color: '#8a94a6',
    opacity: '0.85',
    whiteSpace: 'pre',
  },
  '&dark .ol-cm-ai-ghost': {
    color: '#7c8799',
  },
  '.ol-cm-ai-ghost-hint': {
    display: 'inline-block',
    marginLeft: '8px',
    padding: '0 5px',
    border: '1px solid currentColor',
    borderRadius: '4px',
    fontFamily: 'var(--font-sans, sans-serif)',
    fontSize: '0.7em',
    lineHeight: '1.5',
    verticalAlign: '1px',
    opacity: '0.7',
  },
})

// overleafModuleImports.sourceEditorExtensions expects `extension(options)`.
export const extension = (options: Record<string, any>): Extension => {
  const docName: string = options?.docName || ''
  if (!LATEX_FILE.test(docName)) return []
  const folder: string = (options?.currentDocFolder || '').replace(/^\/+|\/+$/g, '')
  const path = folder ? `${folder}/${docName}` : docName
  return [
    suggestionField,
    fetcher(path),
    Prec.highest(
      keymap.of([
        { key: 'Tab', run: accept },
        { key: 'Escape', run: dismiss },
      ])
    ),
    ghostTheme,
  ]
}
