/**
 * LambdaTeX: AI autocomplete in the source editor.
 *
 * After a short pause in typing at a word boundary (after a space, punctuation,
 * a bracket or $, or at the start of a line), the text around the cursor is sent to
 * /workbench/autocomplete and the suggestion is shown as grey "ghost" text at
 * the cursor. The same request checks the sentence just typed: corrections show
 * inline as struck-out text followed by the fix. Tab applies everything shown in
 * one step (one undo), Esc dismisses it, and typing the same characters keeps the
 * rest of the suggestion. It stays out of the way of Overleaf's own completion
 * list, of \cite/\ref/\label and file arguments (the model can't know the keys),
 * of command names, and of the Visual editor. Registered as a
 * sourceEditorExtensions module entry (deploy/frontend/register-modules.cjs);
 * the switches are in Settings → Editor (../components/ai-autocomplete-setting.tsx).
 */
import {
  Prec,
  StateEffect,
  StateField,
  type Extension,
  type Text,
  type Transaction,
} from '@codemirror/state'
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
const CORRECTIONS_KEY = 'lambdatex.aiCorrections'
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
// ...and at a word boundary (after a space, punctuation, a bracket or $, or at
// the start of a line): mid-word, a chat model can't be trusted to say whether
// its text continues the word or starts a new one ("are" + "powerful").
const MID_WORD = /[\p{L}\p{N}]$/u

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

export function isAiCorrectionsEnabled(): boolean {
  try {
    return window.localStorage.getItem(CORRECTIONS_KEY) !== 'off'
  } catch {
    return true
  }
}

export function setAiCorrectionsEnabled(enabled: boolean) {
  try {
    window.localStorage.setItem(CORRECTIONS_KEY, enabled ? 'on' : 'off')
  } catch {}
  window.dispatchEvent(new CustomEvent(TOGGLE_EVENT, { detail: enabled }))
}

// A correction replaces document text [from, to) with `insert`.
type Fix = { from: number; to: number; insert: string }
type Suggestion = { pos: number; text: string; fixes: Fix[] } | null
type ServerFix = { from: number; to: number; text: string; wrong: string }

const setSuggestion = StateEffect.define<Suggestion>()

// Grey continuation at the cursor, or the fix shown after a struck-out mistake.
class GhostText extends WidgetType {
  constructor(
    readonly text: string,
    readonly kind: 'ghost' | 'fix',
    readonly hint: boolean
  ) {
    super()
  }

  eq(other: GhostText) {
    return other.text === this.text && other.kind === this.kind && other.hint === this.hint
  }

  toDOM() {
    const wrapper = document.createElement('span')
    wrapper.setAttribute('aria-hidden', 'true')
    const text = document.createElement('span')
    text.className = this.kind === 'fix' ? 'ol-cm-ai-fix-new' : 'ol-cm-ai-ghost'
    text.textContent = this.text
    wrapper.appendChild(text)
    if (this.hint) {
      const hint = document.createElement('span')
      hint.className = 'ol-cm-ai-ghost-hint'
      hint.textContent = 'Tab'
      wrapper.appendChild(hint)
    }
    return wrapper
  }

  ignoreEvent() {
    return false
  }
}

const struckOut = Decoration.mark({ class: 'ol-cm-ai-fix-old' })

function decorationsFor(value: Suggestion) {
  if (!value) return Decoration.none
  const ranges = value.fixes.flatMap((fix, i) => [
    struckOut.range(fix.from, fix.to),
    Decoration.widget({
      widget: new GhostText(fix.insert, 'fix', !value.text && i === value.fixes.length - 1),
      side: 1,
    }).range(fix.to),
  ])
  if (value.text) {
    ranges.push(
      Decoration.widget({ widget: new GhostText(value.text, 'ghost', true), side: 1 }).range(value.pos)
    )
  }
  return Decoration.set(ranges, true)
}

type Change = { fromA: number; toA: number; text: string }

const suggestionField = StateField.define<Suggestion>({
  create: () => null,
  update(value: Suggestion, tr: Transaction): Suggestion {
    for (const effect of tr.effects) {
      if (effect.is(setSuggestion)) return effect.value
    }
    if (!value) return value
    if (tr.docChanged) {
      const changes: Change[] = []
      tr.changes.iterChanges(
        (fromA: number, toA: number, _fromB: number, _toB: number, inserted: Text) => {
          changes.push({ fromA, toA, text: inserted.toString() })
        }
      )
      // Typing the next characters of the suggestion keeps the rest of it
      // (corrections are before the cursor, so they stay where they are).
      const [typed] = changes
      if (
        changes.length === 1 &&
        typed.fromA === value.pos &&
        typed.toA === value.pos &&
        typed.text.length > 0 &&
        typed.text.length < value.text.length &&
        value.text.startsWith(typed.text)
      ) {
        return {
          pos: value.pos + typed.text.length,
          text: value.text.slice(typed.text.length),
          fixes: value.fixes,
        }
      }
      // Any other edit at the cursor or on a correction ends it; edits elsewhere
      // (e.g. a collaborator's) keep it, moved with the text.
      const touches = (from: number, to: number) =>
        changes.some(change => change.fromA <= to && change.toA >= from)
      if (touches(value.pos, value.pos) || value.fixes.some(fix => touches(fix.from, fix.to))) {
        return null
      }
      const pos = tr.changes.mapPos(value.pos, 1)
      const fixes = value.fixes.map(fix => ({
        from: tr.changes.mapPos(fix.from, 1),
        to: tr.changes.mapPos(fix.to, -1),
        insert: fix.insert,
      }))
      const { main } = tr.state.selection
      return main.empty && main.head === pos ? { pos, text: value.text, fixes } : null
    }
    if (tr.selection) {
      const { main } = tr.state.selection
      if (!main.empty || main.head !== value.pos) return null
    }
    return value
  },
  provide: (field: StateField<Suggestion>) => EditorView.decorations.from(field, decorationsFor),
})

function accept(view: EditorView) {
  const value = view.state.field(suggestionField, false)
  if (!value || completionStatus(view.state) === 'active') return false
  const { main } = view.state.selection
  if (!main.empty || main.head !== value.pos) return false
  // Corrections and continuation in one transaction: one undo step.
  const changes = view.state.changes([
    ...value.fixes.map(fix => ({ from: fix.from, to: fix.to, insert: fix.insert })),
    ...(value.text ? [{ from: value.pos, insert: value.text }] : []),
  ])
  view.dispatch({
    changes,
    selection: { anchor: changes.mapPos(value.pos, 1) },
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
      pausedUntil = 0 // after a 429 (rate limit or token quota), wait before asking again

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
        const typing = update.transactions.some((tr: Transaction) => tr.isUserEvent('input.type'))
        if (!typing || update.state.field(suggestionField, false)) return
        this.timer = window.setTimeout(() => this.request(), DELAY_MS)
      }

      request() {
        const { view } = this
        const { state } = view
        const { main } = state.selection
        if (
          this.blocked ||
          Date.now() < this.pausedUntil ||
          !isAiAutocompleteEnabled() ||
          !view.hasFocus ||
          view.composing || // IME input (e.g. Chinese, Japanese) still being composed
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
        if (MID_WORD.test(beforeOnLine) || SKIP_BEFORE.test(beforeOnLine)) return
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
            corrections: isAiCorrectionsEnabled(),
          },
          signal: controller.signal,
        })
          .then((data: { completion?: string; fixes?: ServerFix[] }) => {
            if (this.controller !== controller) return
            this.controller = null
            const current = view.state
            const text = typeof data?.completion === 'string' ? data.completion : ''
            // Fix offsets are relative to the cursor; each must still match the text.
            const fixes: Fix[] = []
            for (const fix of Array.isArray(data?.fixes) ? data.fixes : []) {
              const from = pos + fix.from
              const to = pos + fix.to
              if (from < 0 || to > pos || from >= to || typeof fix.text !== 'string') continue
              if (current.sliceDoc(from, to) !== fix.wrong) continue
              if (fixes.some(other => from < other.to && to > other.from)) continue
              fixes.push({ from, to, insert: fix.text })
            }
            if (
              (!text && !fixes.length) ||
              current.doc !== doc ||
              !current.selection.main.empty ||
              current.selection.main.head !== pos ||
              !view.hasFocus ||
              completionStatus(current) !== null
            ) {
              return
            }
            view.dispatch({ effects: setSuggestion.of({ pos, text, fixes }) })
          })
          .catch((error: any) => {
            if (this.controller === controller) this.controller = null
            const status = error?.response?.status
            if (status === 403 || status === 404) this.blocked = true
            if (status === 429) this.pausedUntil = Date.now() + 60_000
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
  '.ol-cm-ai-fix-old': {
    textDecoration: 'line-through',
    textDecorationColor: '#e5484d',
    textDecorationThickness: '1.5px',
    backgroundColor: 'rgba(229, 72, 77, 0.08)',
    borderRadius: '2px',
  },
  '.ol-cm-ai-fix-new': {
    marginLeft: '2px',
    padding: '0 2px',
    borderRadius: '3px',
    color: '#12805c',
    backgroundColor: 'rgba(18, 128, 92, 0.1)',
    whiteSpace: 'pre',
  },
  '&dark .ol-cm-ai-fix-new': {
    color: '#3ecf8e',
    backgroundColor: 'rgba(62, 207, 142, 0.12)',
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
