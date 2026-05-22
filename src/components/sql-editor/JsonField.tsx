import { useCallback, useEffect, useRef, useState } from 'react'
import { Expand, Wand2 } from 'lucide-react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { json } from '@codemirror/lang-json'
import { defaultHighlightStyle, syntaxHighlighting, foldGutter } from '@codemirror/language'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { JsonExpandModal } from './JsonExpandModal'

const editorTheme = EditorView.theme({
  '&': {
    fontSize: '13px',
    backgroundColor: 'white',
  },
  '.cm-content': {
    padding: '8px',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  },
  '.cm-line': { padding: '0' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: '#9ca3af',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto' },
})

interface JsonFieldProps {
  /** Current JSON document as a string (already prettified or compact — both fine). */
  value: string
  /** Called on every change. Pass-through; parent owns the canonical state. */
  onChange: (next: string) => void
  /** Called whenever validity transitions. Lets parents disable Save while invalid. */
  onValidityChange?: (valid: boolean) => void
  /** Visible label for the modal title (column name). */
  columnName: string
  /** Auto-focus the editor on mount. */
  autoFocus?: boolean
}

const MIN_HEIGHT = 80
const DEFAULT_HEIGHT = 120
const MAX_HEIGHT_CAP = 600

export function JsonField({
  value,
  onChange,
  onValidityChange,
  columnName,
  autoFocus,
}: JsonFieldProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const valueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const onValidityRef = useRef(onValidityChange)
  const [height, setHeight] = useState(DEFAULT_HEIGHT)
  const [error, setError] = useState<string | null>(null)
  const [expandOpen, setExpandOpen] = useState(false)

  // Keep refs current so the CM updateListener always sees the latest callbacks
  // without needing to recreate the EditorView.
  onChangeRef.current = onChange
  onValidityRef.current = onValidityChange

  const validate = useCallback((doc: string) => {
    if (doc.trim() === '') {
      setError(null)
      onValidityRef.current?.(true)
      return
    }
    try {
      JSON.parse(doc)
      setError(null)
      onValidityRef.current?.(true)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Invalid JSON'
      setError(msg)
      onValidityRef.current?.(false)
    }
  }, [])

  // Initialize the editor once.
  useEffect(() => {
    if (!containerRef.current) return

    const state = EditorState.create({
      doc: value,
      extensions: [
        json(),
        syntaxHighlighting(defaultHighlightStyle),
        foldGutter(),
        editorTheme,
        EditorView.lineWrapping,
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const next = update.state.doc.toString()
            valueRef.current = next
            onChangeRef.current(next)
            validate(next)
          }
        }),
      ],
    })

    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view
    valueRef.current = value
    validate(value)

    if (autoFocus) {
      requestAnimationFrame(() => view.focus())
    }

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // We deliberately initialize once. Subsequent external value changes are
    // applied through the syncing effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync external value changes into the editor (only when they actually differ
  // from what the editor already has).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      })
      valueRef.current = value
      validate(value)
    }
  }, [value, validate])

  const handleFormat = useCallback(() => {
    const view = viewRef.current
    if (!view) return
    const doc = view.state.doc.toString()
    if (doc.trim() === '') return
    try {
      const parsed = JSON.parse(doc)
      const pretty = JSON.stringify(parsed, null, 2)
      if (pretty === doc) return
      view.dispatch({
        changes: { from: 0, to: doc.length, insert: pretty },
      })
    } catch {
      // Format button is disabled when invalid; defensive no-op here.
    }
  }, [])

  const canFormat = error === null && value.trim() !== ''

  // Drag-resize handler (vertical).
  const startY = useRef(0)
  const startHeight = useRef(0)
  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    startY.current = e.clientY
    startHeight.current = height
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientY - startY.current
      const next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT_CAP, startHeight.current + delta))
      setHeight(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [height])

  const initialModalValue = value

  return (
    <div className="space-y-1">
      <div className="relative border border-gray-300 rounded bg-white overflow-hidden">
        <div className="absolute top-1 right-1 z-10 flex items-center gap-1">
          <button
            type="button"
            onClick={handleFormat}
            disabled={!canFormat}
            title={canFormat ? 'Format (prettify) JSON' : 'Invalid JSON — fix errors before formatting'}
            className="p-1 rounded bg-white/90 hover:bg-gray-100 text-gray-500 hover:text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Wand2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setExpandOpen(true)}
            title="Expand in modal"
            className="p-1 rounded bg-white/90 hover:bg-gray-100 text-gray-500 hover:text-gray-700"
          >
            <Expand className="w-3.5 h-3.5" />
          </button>
        </div>
        <div
          ref={containerRef}
          className="overflow-auto"
          style={{ height: `${height}px` }}
        />
        <div
          onMouseDown={onResizeMouseDown}
          className="h-1 cursor-ns-resize bg-gray-100 hover:bg-gray-200"
          title="Drag to resize"
        />
      </div>
      {error && (
        <div className="text-xs text-red-600 font-mono">Invalid JSON: {error}</div>
      )}
      <JsonExpandModal
        open={expandOpen}
        onClose={() => setExpandOpen(false)}
        value={initialModalValue}
        columnName={columnName}
        onSave={(next) => {
          onChangeRef.current(next)
          // Also dispatch into the inline editor so it reflects immediately.
          const view = viewRef.current
          if (view) {
            const cur = view.state.doc.toString()
            view.dispatch({ changes: { from: 0, to: cur.length, insert: next } })
          }
          setExpandOpen(false)
        }}
      />
    </div>
  )
}
