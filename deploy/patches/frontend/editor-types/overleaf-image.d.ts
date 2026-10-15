// Editor-only (VS Code): loose stand-ins for modules that exist only inside the
// Overleaf image (its frontend sources and node_modules), so the patched editor
// extension opens without "Cannot find module" errors. They describe just what
// the patched files use, as `any`: the real check is deploy/frontend/typecheck.sh
// (strict tsc against the image). Not used by the build or by that check.

declare module '@codemirror/state' {
  export type Extension = any
  export type Text = any
  export type Transaction = any
  export type StateField<T = any> = any
  export const StateField: { define<T>(config: any): any }
  export const StateEffect: { define<T>(spec?: any): any }
  export const Prec: any
}

declare module '@codemirror/view' {
  export type EditorView = any
  export const EditorView: any
  export type ViewUpdate = any
  export const Decoration: any
  export const ViewPlugin: any
  export const WidgetType: any
  export const keymap: any
}

declare module '@codemirror/autocomplete' {
  export const completionStatus: (state: any) => 'active' | 'pending' | null
  export const hasNextSnippetField: (state: any) => boolean
}

declare module '@/infrastructure/fetch-json' {
  export const getJSON: (path: string, options?: any) => Promise<any>
  export const postJSON: (path: string, options?: any) => Promise<any>
  export const deleteJSON: (path: string, options?: any) => Promise<any>
}

declare module '@/utils/meta' {
  const getMeta: (name: string) => any
  export default getMeta
}

declare module '@/features/source-editor/extensions/visual/visual' {
  export const isVisual: (view: any) => boolean
}
