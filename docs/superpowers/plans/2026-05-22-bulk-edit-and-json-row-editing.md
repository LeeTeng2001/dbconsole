# Bulk Row Edit + JSON-Aware Row Editing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace plain `<textarea>` JSON editing in the row-edit side panel with an inline CodeMirror editor (Format + Expand toolbar), and add a "bulk edit" mode that auto-engages when ≥2 rows are selected, letting the user overwrite a column's value across N rows in one action that flows through the existing staged-changes preview/commit pipeline.

**Architecture:** Extract a reusable `JsonField` component (CodeMirror 6 + json language + Format/Expand toolbar) used in both single-row and bulk edit. Build a sibling `BulkEditPanel` that mirrors `RowDetailPanel`'s portal/positioning/Escape behavior. `QueryResults.tsx` decides which panel to render based on `selection.selectedIndices.size`. Bulk save mutates each selected `DisplayRow` to `staged-update`, feeding the existing `stagedChanges` derivation — no backend changes.

**Tech Stack:** React 19, Vite, TypeScript, CodeMirror 6 (`@codemirror/lang-json`, `@codemirror/state`, `@codemirror/view`, `@codemirror/language`, `@codemirror/commands`), Tailwind v4, `@base-ui/react/dialog` for modals, `lucide-react` icons, Vitest (Node env).

**Test runner:** `vitest` configured with `environment: 'node'` (no jsdom). All automated tests in this plan are pure-logic tests in `tests/`. Component verification is manual smoke against `pnpm dev`.

**Spec:** `docs/superpowers/specs/2026-05-22-bulk-edit-and-json-row-editing-design.md`

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `src/lib/bulk-edit.ts` | Pure helpers: `computeColumnValueSummary`, `applyOverridesToRow`. Discriminated `BulkOverride` type. |
| `tests/bulk-edit.test.ts` | Vitest tests for `src/lib/bulk-edit.ts`. |
| `src/components/sql-editor/JsonField.tsx` | Inline CodeMirror JSON editor with Format + Expand buttons. ~120px default, drag-resizable, manages its own `JsonExpandModal` instance. |
| `src/components/sql-editor/BulkEditableField.tsx` | Per-column input renderer for bulk mode. Knows `same / multiple / allNull / overridden` state. Includes Set NULL / Set DEFAULT buttons. |
| `src/components/sql-editor/BulkEditPanel.tsx` | Right-side portal panel. Maps over editable columns, manages local `BulkOverrides` state, exposes Cancel / Reset all / Save. |

### Modified files

| File | Change |
|---|---|
| `src/components/sql-editor/JsonExpandModal.tsx` | Add `[Format]` button to footer toolbar (left of Cancel). |
| `src/components/sql-editor/RowDetailPanel.tsx` | Inside `EditableField`, replace the JSON `<textarea>` branch with `<JsonField>`. Surface JSON validity to parent so `Save` can be disabled while invalid. |
| `src/components/sql-editor/QueryResults.tsx` | When `selection.selectedIndices.size >= 2` and selection is single-table, render `<BulkEditPanel>` instead of `<RowDetailPanel>`. Add `handleSaveBulkEdit`. Handle selection-size transitions. |

---

## Task 1: `BulkOverride` type + `applyOverridesToRow`

**Files:**
- Create: `src/lib/bulk-edit.ts`
- Test: `tests/bulk-edit.test.ts`

- [ ] **Step 1.1: Write the failing test**

Create `tests/bulk-edit.test.ts` with this content:

```ts
import { describe, it, expect } from 'vitest'
import { applyOverridesToRow, type BulkOverrides } from '@/lib/bulk-edit'

describe('applyOverridesToRow', () => {
  it('returns a new object (does not mutate input)', () => {
    const row = { a: 1, b: 2 }
    const out = applyOverridesToRow(row, {})
    expect(out).not.toBe(row)
    expect(out).toEqual(row)
  })

  it('applies value overrides', () => {
    const overrides: BulkOverrides = { a: { kind: 'value', value: 99 } }
    expect(applyOverridesToRow({ a: 1, b: 2 }, overrides)).toEqual({ a: 99, b: 2 })
  })

  it('applies null overrides', () => {
    const overrides: BulkOverrides = { a: { kind: 'null' } }
    expect(applyOverridesToRow({ a: 1, b: 2 }, overrides)).toEqual({ a: null, b: 2 })
  })

  it('applies default overrides as undefined', () => {
    const overrides: BulkOverrides = { a: { kind: 'default' } }
    const out = applyOverridesToRow({ a: 1, b: 2 }, overrides)
    expect(out.a).toBeUndefined()
    expect(out.b).toBe(2)
    expect('a' in out).toBe(true)
  })

  it('applies multiple overrides at once', () => {
    const overrides: BulkOverrides = {
      a: { kind: 'value', value: 'x' },
      b: { kind: 'null' },
      c: { kind: 'default' },
    }
    const out = applyOverridesToRow({ a: 1, b: 2, c: 3, d: 4 }, overrides)
    expect(out).toEqual({ a: 'x', b: null, c: undefined, d: 4 })
  })

  it('leaves untouched columns unchanged (preserves null)', () => {
    expect(applyOverridesToRow({ a: null, b: 2 }, {})).toEqual({ a: null, b: 2 })
  })
})
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `pnpm vitest run tests/bulk-edit.test.ts`
Expected: FAIL with "Cannot find module '@/lib/bulk-edit'" or similar resolve error.

- [ ] **Step 1.3: Write minimal implementation**

Create `src/lib/bulk-edit.ts`:

```ts
/**
 * Bulk edit helpers.
 *
 * A BulkOverride represents the user's intent to set a column to a value,
 * NULL, or DEFAULT across N selected rows.
 */

export type BulkOverride =
  | { kind: 'value'; value: unknown }
  | { kind: 'null' }
  | { kind: 'default' }

export type BulkOverrides = Record<string, BulkOverride>

/**
 * Apply bulk overrides to a single row, producing a new row record.
 *
 * - { kind: 'value' } -> sets the property to that value
 * - { kind: 'null' }  -> sets the property to null
 * - { kind: 'default' } -> sets the property to undefined
 *   (matches existing convention where undefined means "use DEFAULT" in
 *    generateInsertSQL/generateUpdateSQL).
 *
 * Untouched columns are preserved exactly (including null vs undefined).
 */
export function applyOverridesToRow(
  row: Record<string, unknown>,
  overrides: BulkOverrides,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }
  for (const [col, override] of Object.entries(overrides)) {
    if (override.kind === 'value') {
      out[col] = override.value
    } else if (override.kind === 'null') {
      out[col] = null
    } else {
      out[col] = undefined
    }
  }
  return out
}
```

- [ ] **Step 1.4: Run the test to verify it passes**

Run: `pnpm vitest run tests/bulk-edit.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 1.5: Commit**

```bash
git add src/lib/bulk-edit.ts tests/bulk-edit.test.ts
git commit -m "feat(bulk-edit): add BulkOverride type and applyOverridesToRow"
```

---

## Task 2: `computeColumnValueSummary`

**Files:**
- Modify: `src/lib/bulk-edit.ts`
- Modify: `tests/bulk-edit.test.ts`

- [ ] **Step 2.1: Write the failing test (append to `tests/bulk-edit.test.ts`)**

Append this `describe` block to `tests/bulk-edit.test.ts` (after the existing `describe('applyOverridesToRow', ...)` block):

```ts
import { computeColumnValueSummary } from '@/lib/bulk-edit'

describe('computeColumnValueSummary', () => {
  it('returns "same" when all rows share the same value', () => {
    const rows = [{ x: 1 }, { x: 1 }, { x: 1 }]
    expect(computeColumnValueSummary(rows, 'x')).toEqual({ kind: 'same', value: 1 })
  })

  it('returns "allNull" when every row is null', () => {
    const rows = [{ x: null }, { x: null }]
    expect(computeColumnValueSummary(rows, 'x')).toEqual({ kind: 'allNull' })
  })

  it('returns "multiple" when values differ', () => {
    const rows = [{ x: 1 }, { x: 2 }]
    expect(computeColumnValueSummary(rows, 'x')).toEqual({ kind: 'multiple' })
  })

  it('treats null vs non-null as multiple', () => {
    const rows = [{ x: null }, { x: 1 }]
    expect(computeColumnValueSummary(rows, 'x')).toEqual({ kind: 'multiple' })
  })

  it('returns "same" for single-row input', () => {
    expect(computeColumnValueSummary([{ x: 'hello' }], 'x'))
      .toEqual({ kind: 'same', value: 'hello' })
  })

  it('returns "allNull" for single-row null input', () => {
    expect(computeColumnValueSummary([{ x: null }], 'x'))
      .toEqual({ kind: 'allNull' })
  })

  it('returns "multiple" for empty rows array (defensive)', () => {
    expect(computeColumnValueSummary([], 'x')).toEqual({ kind: 'multiple' })
  })

  it('compares JSON values structurally (objects)', () => {
    const rows = [{ x: { a: 1 } }, { x: { a: 1 } }]
    expect(computeColumnValueSummary(rows, 'x')).toEqual({ kind: 'same', value: { a: 1 } })
  })

  it('detects different objects as multiple', () => {
    const rows = [{ x: { a: 1 } }, { x: { a: 2 } }]
    expect(computeColumnValueSummary(rows, 'x')).toEqual({ kind: 'multiple' })
  })

  it('treats undefined and missing keys identically', () => {
    const rows = [{ x: undefined }, {}]
    expect(computeColumnValueSummary(rows, 'x')).toEqual(
      { kind: 'same', value: undefined }
    )
  })
})
```

- [ ] **Step 2.2: Run the test to verify it fails**

Run: `pnpm vitest run tests/bulk-edit.test.ts`
Expected: FAIL with "computeColumnValueSummary is not a function" or import error.

- [ ] **Step 2.3: Implement (append to `src/lib/bulk-edit.ts`)**

Append this to `src/lib/bulk-edit.ts`:

```ts
export type ColumnValueSummary =
  | { kind: 'same'; value: unknown }
  | { kind: 'multiple' }
  | { kind: 'allNull' }

/**
 * Compare a column's value across N rows.
 *
 * - 'allNull'  — every row has null in this column.
 * - 'same'     — every row has the same value (compared structurally for
 *                objects/arrays via JSON.stringify; works fine for the JSON
 *                values pg returns).
 * - 'multiple' — rows differ, OR the input is empty (defensive default).
 *
 * `undefined` and missing keys are treated identically.
 */
export function computeColumnValueSummary(
  rows: Record<string, unknown>[],
  columnName: string,
): ColumnValueSummary {
  if (rows.length === 0) return { kind: 'multiple' }

  const first = rows[0][columnName]
  const firstIsNull = first === null
  let allNull = firstIsNull

  for (let i = 1; i < rows.length; i++) {
    const v = rows[i][columnName]
    if (v === null) {
      if (!firstIsNull) return { kind: 'multiple' }
      continue
    }
    if (firstIsNull) return { kind: 'multiple' }
    allNull = false
    if (!structurallyEqual(first, v)) return { kind: 'multiple' }
  }

  if (allNull) return { kind: 'allNull' }
  return { kind: 'same', value: first }
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  // For pg result values (JSONB returned as parsed objects, arrays, primitives),
  // JSON.stringify is sufficient. Order-sensitive for objects, which is fine
  // because pg returns them with stable key order.
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
```

- [ ] **Step 2.4: Run the test to verify it passes**

Run: `pnpm vitest run tests/bulk-edit.test.ts`
Expected: PASS, 16 tests total (6 from Task 1 + 10 from Task 2).

- [ ] **Step 2.5: Commit**

```bash
git add src/lib/bulk-edit.ts tests/bulk-edit.test.ts
git commit -m "feat(bulk-edit): add computeColumnValueSummary"
```

---

## Task 3: `JsonField` component (inline CodeMirror with Format/Expand)

**Files:**
- Create: `src/components/sql-editor/JsonField.tsx`

This component is verified by manual smoke (no jsdom test infra). It is wired into `RowDetailPanel` in Task 5 and gets a manual smoke test there.

- [ ] **Step 3.1: Implement `JsonField`**

Create `src/components/sql-editor/JsonField.tsx`:

```tsx
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
```

- [ ] **Step 3.2: Type-check the file**

Run: `pnpm tsc -b --noEmit` (or `pnpm tsc --noEmit`)
Expected: No errors. (If `tsc -b` complains about unrelated pre-existing errors, run `pnpm tsc --noEmit src/components/sql-editor/JsonField.tsx` to scope; expected: clean.)

- [ ] **Step 3.3: Commit**

```bash
git add src/components/sql-editor/JsonField.tsx
git commit -m "feat(json): add JsonField inline CodeMirror editor with Format and Expand"
```

---

## Task 4: Add `Format` button to `JsonExpandModal`

**Files:**
- Modify: `src/components/sql-editor/JsonExpandModal.tsx`

- [ ] **Step 4.1: Read the current file**

Read `src/components/sql-editor/JsonExpandModal.tsx` to confirm the import list at the top and the footer button row at lines 130–137 (per spec exploration).

- [ ] **Step 4.2: Add `Wand2` to lucide imports**

Replace this line in `src/components/sql-editor/JsonExpandModal.tsx`:
```tsx
import { Copy, Check, X } from 'lucide-react'
```
with:
```tsx
import { Copy, Check, X, Wand2 } from 'lucide-react'
```

- [ ] **Step 4.3: Add a `handleFormat` callback**

Inside the `JsonExpandModal` component, after the existing `handleSave` callback (around line 98), add:

```tsx
const handleFormat = useCallback(() => {
  const view = viewRef.current
  if (!view) return
  const doc = view.state.doc.toString()
  if (doc.trim() === '') return
  try {
    const parsed = JSON.parse(doc)
    const pretty = JSON.stringify(parsed, null, 2)
    if (pretty === doc) return
    view.dispatch({ changes: { from: 0, to: doc.length, insert: pretty } })
  } catch {
    /* button disabled when invalid; no-op fallback */
  }
}, [])

const [isValid, setIsValid] = useState(true)
```

Then extend the EditorView's `updateListener` (the existing one inside `initEditor`) to also track validity. Replace this block:

```tsx
EditorView.updateListener.of((update) => {
  if (update.docChanged) {
    setHasChanges(update.state.doc.toString() !== initialValue)
  }
}),
```

with:

```tsx
EditorView.updateListener.of((update) => {
  if (update.docChanged) {
    const doc = update.state.doc.toString()
    setHasChanges(doc !== initialValue)
    if (doc.trim() === '') {
      setIsValid(true)
    } else {
      try {
        JSON.parse(doc)
        setIsValid(true)
      } catch {
        setIsValid(false)
      }
    }
  }
}),
```

- [ ] **Step 4.4: Add the Format button to the footer**

Locate the footer block (lines 130–137 today):

```tsx
<div className="flex items-center justify-end gap-2 p-4 pt-2">
  <Button variant="ghost" size="sm" onClick={onClose}>
    Cancel
  </Button>
  <Button variant="default" size="sm" onClick={handleSave} disabled={!hasChanges}>
    Save
  </Button>
</div>
```

Replace with:

```tsx
<div className="flex items-center justify-between gap-2 p-4 pt-2">
  <Button
    variant="ghost"
    size="sm"
    onClick={handleFormat}
    disabled={!isValid}
    title={isValid ? 'Format (prettify) JSON' : 'Invalid JSON'}
  >
    <Wand2 className="w-3.5 h-3.5 mr-1" />
    Format
  </Button>
  <div className="flex items-center gap-2">
    <Button variant="ghost" size="sm" onClick={onClose}>
      Cancel
    </Button>
    <Button
      variant="default"
      size="sm"
      onClick={handleSave}
      disabled={!hasChanges || !isValid}
    >
      Save
    </Button>
  </div>
</div>
```

- [ ] **Step 4.5: Type-check**

Run: `pnpm tsc -b --noEmit` (or filter to this file). Expected: clean.

- [ ] **Step 4.6: Manual smoke**

Start the dev server (if not already running): `pnpm dev`. In a SELECT result containing a JSON/JSONB column, click the Expand button on a JSON cell. Verify:
- The Format button is visible at the bottom-left of the modal toolbar.
- Clicking Format prettifies the document.
- After typing invalid JSON (e.g. delete a closing `}`), the Format and Save buttons are disabled.

- [ ] **Step 4.7: Commit**

```bash
git add src/components/sql-editor/JsonExpandModal.tsx
git commit -m "feat(json): add Format button and validity tracking to JsonExpandModal"
```

---

## Task 5: Wire `JsonField` into `RowDetailPanel.EditableField`

**Files:**
- Modify: `src/components/sql-editor/RowDetailPanel.tsx`

- [ ] **Step 5.1: Add the import**

In `src/components/sql-editor/RowDetailPanel.tsx`, near the existing imports (around line 7):

```tsx
import { JsonViewer } from './JsonViewer'
```

Add a new line below it:

```tsx
import { JsonField } from './JsonField'
```

- [ ] **Step 5.2: Extend `EditableField` props with validity reporting and column name**

Find the `EditableField` props type (around lines 141–161). Replace this signature:

```tsx
function EditableField({
  value,
  colType,
  isNullable,
  hasDefault,
  isNewRow,
  onChange,
  onSetNull,
  onSetDefault,
  autoFocus,
}: {
  value: unknown
  colType: string
  isNullable: boolean
  hasDefault: boolean
  isNewRow: boolean
  onChange: (value: string) => void
  onSetNull: () => void
  onSetDefault: () => void
  autoFocus?: boolean
}) {
```

with:

```tsx
function EditableField({
  value,
  colName,
  colType,
  isNullable,
  hasDefault,
  isNewRow,
  onChange,
  onSetNull,
  onSetDefault,
  onValidityChange,
  autoFocus,
}: {
  value: unknown
  colName: string
  colType: string
  isNullable: boolean
  hasDefault: boolean
  isNewRow: boolean
  onChange: (value: string) => void
  onSetNull: () => void
  onSetDefault: () => void
  onValidityChange?: (valid: boolean) => void
  autoFocus?: boolean
}) {
```

- [ ] **Step 5.3: Replace the JSON-textarea branch with `JsonField`**

In `EditableField`, locate the multiline branch (around lines 218–226):

```tsx
) : isMultiline ? (
  <textarea
    ref={inputRef as React.RefObject<HTMLTextAreaElement>}
    value={editValue}
    onChange={(e) => onChange(e.target.value)}
    placeholder={isNull ? 'null' : ''}
    className="w-full px-2 py-1.5 text-xs bg-white border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 min-h-[80px] max-h-64 resize-y font-mono"
    rows={4}
  />
) : (
```

Replace with:

```tsx
) : isJson ? (
  <JsonField
    value={editValue}
    columnName={colName}
    onChange={onChange}
    onValidityChange={onValidityChange}
    autoFocus={autoFocus}
  />
) : isMultiline ? (
  <textarea
    ref={inputRef as React.RefObject<HTMLTextAreaElement>}
    value={editValue}
    onChange={(e) => onChange(e.target.value)}
    placeholder={isNull ? 'null' : ''}
    className="w-full px-2 py-1.5 text-xs bg-white border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 min-h-[80px] max-h-64 resize-y font-mono"
    rows={4}
  />
) : (
```

The new `isJson ?` branch precedes the `isMultiline ?` branch, so JSON columns hit `JsonField` and other multiline text still uses the textarea.

- [ ] **Step 5.4: Track per-column JSON validity in `RowDetailPanel` and disable Save when invalid**

In `RowDetailPanel` (around lines 302–304), find the existing state declarations:

```tsx
const [search, setSearch] = useState('')
const [highlightedColumn, setHighlightedColumn] = useState<string | null>(null)
const [editedValues, setEditedValues] = useState<Record<string, unknown>>({})
```

Add below them:

```tsx
const [jsonInvalidColumns, setJsonInvalidColumns] = useState<Set<string>>(new Set())
```

Reset it when entering/leaving edit mode by extending the existing effect at lines 309–315. Replace:

```tsx
useEffect(() => {
  if (isEditing) {
    setEditedValues({ ...row })
  } else {
    setEditedValues({})
  }
}, [isEditing, row])
```

with:

```tsx
useEffect(() => {
  if (isEditing) {
    setEditedValues({ ...row })
    setJsonInvalidColumns(new Set())
  } else {
    setEditedValues({})
    setJsonInvalidColumns(new Set())
  }
}, [isEditing, row])
```

Then update the existing `hasChanges` memo at lines 354–358. Replace:

```tsx
const hasChanges = useMemo(() => {
  // For new rows, check if PK columns are filled
  if (isNewRow) return !missingRequiredPK
  return columns.some(col => editedValues[col.name] !== row[col.name])
}, [columns, editedValues, row, isNewRow, missingRequiredPK])
```

with:

```tsx
const hasChanges = useMemo(() => {
  // Disable Save if any JSON field is currently invalid
  if (jsonInvalidColumns.size > 0) return false
  // For new rows, check if PK columns are filled
  if (isNewRow) return !missingRequiredPK
  return columns.some(col => editedValues[col.name] !== row[col.name])
}, [columns, editedValues, row, isNewRow, missingRequiredPK, jsonInvalidColumns])
```

- [ ] **Step 5.5: Wire `colName` and `onValidityChange` into `EditableField` call site**

Find the `<EditableField ...>` JSX (around lines 595–606). Replace:

```tsx
<EditableField
  value={value}
  colType={colType}
  isNullable={col.isNullable}
  hasDefault={col.hasDefault}
  isNewRow={isNewRow || false}
  onChange={(newValue) => handleFieldChange(colName, newValue, colType)}
  onSetNull={() => setEditedValues(prev => ({ ...prev, [colName]: null }))}
  onSetDefault={() => setEditedValues(prev => ({ ...prev, [colName]: undefined }))}
  autoFocus={autoEditColumn === colName}
/>
```

with:

```tsx
<EditableField
  value={value}
  colName={colName}
  colType={colType}
  isNullable={col.isNullable}
  hasDefault={col.hasDefault}
  isNewRow={isNewRow || false}
  onChange={(newValue) => handleFieldChange(colName, newValue, colType)}
  onSetNull={() => setEditedValues(prev => ({ ...prev, [colName]: null }))}
  onSetDefault={() => setEditedValues(prev => ({ ...prev, [colName]: undefined }))}
  onValidityChange={(valid) => {
    setJsonInvalidColumns(prev => {
      const next = new Set(prev)
      if (valid) next.delete(colName)
      else next.add(colName)
      return next
    })
  }}
  autoFocus={autoEditColumn === colName}
/>
```

- [ ] **Step 5.6: Type-check**

Run: `pnpm tsc -b --noEmit`
Expected: clean.

- [ ] **Step 5.7: Manual smoke**

Run `pnpm dev`. Open a result with a JSON/JSONB column, double-click a row to enter edit mode on a JSON column. Verify:
- The JSON cell renders a CodeMirror editor with syntax highlighting.
- Format button prettifies the JSON.
- Expand button opens the modal; modal Save round-trips back to the inline editor.
- Typing invalid JSON shows a red error line under the editor.
- The panel's top-right Save button becomes disabled while JSON is invalid; re-enables on fix.
- Non-JSON multiline text columns still use the textarea (regression check).
- Booleans still use the select (regression check).

- [ ] **Step 5.8: Commit**

```bash
git add src/components/sql-editor/RowDetailPanel.tsx
git commit -m "feat(row-edit): use JsonField for JSON/JSONB columns in row panel"
```

---

## Task 6: `BulkEditableField` component

**Files:**
- Create: `src/components/sql-editor/BulkEditableField.tsx`

- [ ] **Step 6.1: Implement `BulkEditableField`**

Create `src/components/sql-editor/BulkEditableField.tsx`:

```tsx
import { Undo2 } from 'lucide-react'
import { Button } from '../ui/button'
import { JsonField } from './JsonField'
import type { ColumnMetadata } from './hooks/useEditorTabs'
import type { BulkOverride, ColumnValueSummary } from '@/lib/bulk-edit'

function isJsonType(type: string): boolean {
  return type === 'json' || type === 'jsonb'
}

interface BulkEditableFieldProps {
  column: ColumnMetadata
  summary: ColumnValueSummary
  override: BulkOverride | undefined
  onOverride: (next: BulkOverride | undefined) => void
  /**
   * Reports JSON validity. Used to disable Save while JSON is invalid.
   * Always reports `true` for non-JSON columns.
   */
  onValidityChange?: (valid: boolean) => void
}

export function BulkEditableField({
  column,
  summary,
  override,
  onOverride,
  onValidityChange,
}: BulkEditableFieldProps) {
  const isJson = isJsonType(column.type)
  const isBool = column.type === 'boolean' || column.type === 'bool'
  const isOverridden = override !== undefined

  const placeholderText =
    summary.kind === 'multiple' ? 'Multiple values'
    : summary.kind === 'allNull' ? 'NULL'
    : ''

  // Input draft when an override of kind 'value' is active. Render derives from override.
  const draftValue =
    override?.kind === 'value' ? String(override.value ?? '')
    : summary.kind === 'same' && !isOverridden ? formatForInput(summary.value)
    : ''

  const setValue = (raw: string) => {
    onOverride({ kind: 'value', value: coerceForType(raw, column.type) })
  }

  const setNull = () => onOverride({ kind: 'null' })
  const setDefault = () => onOverride({ kind: 'default' })
  const reset = () => onOverride(undefined)

  // Boolean: dropdown with (no change) | NULL | true | false | DEFAULT
  if (isBool) {
    const selected =
      override?.kind === 'value' ? String(override.value)
      : override?.kind === 'null' ? '__null__'
      : override?.kind === 'default' ? '__default__'
      : '__nochange__'

    return (
      <FieldShell
        column={column}
        isOverridden={isOverridden}
        summaryKind={summary.kind}
        onReset={reset}
      >
        <select
          value={selected}
          onChange={(e) => {
            const v = e.target.value
            if (v === '__nochange__') reset()
            else if (v === '__null__') setNull()
            else if (v === '__default__') setDefault()
            else onOverride({ kind: 'value', value: v === 'true' })
          }}
          className={`w-full px-2 py-1.5 text-xs border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            isOverridden ? 'bg-amber-50 border-amber-300' : 'bg-white border-gray-300'
          }`}
        >
          <option value="__nochange__">(no change)</option>
          {column.isNullable && <option value="__null__">NULL</option>}
          {column.hasDefault && <option value="__default__">DEFAULT</option>}
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
        <NullDefaultButtons
          column={column}
          override={override}
          onSetNull={setNull}
          onSetDefault={setDefault}
        />
      </FieldShell>
    )
  }

  if (isJson) {
    return (
      <FieldShell
        column={column}
        isOverridden={isOverridden}
        summaryKind={summary.kind}
        onReset={reset}
      >
        {override?.kind === 'null' ? (
          <NullPill />
        ) : override?.kind === 'default' ? (
          <DefaultPill />
        ) : (
          <JsonField
            value={draftValue}
            columnName={column.name}
            onChange={setValue}
            onValidityChange={onValidityChange}
          />
        )}
        <NullDefaultButtons
          column={column}
          override={override}
          onSetNull={setNull}
          onSetDefault={setDefault}
        />
      </FieldShell>
    )
  }

  // Default: text input with placeholder reflecting summary state.
  return (
    <FieldShell
      column={column}
      isOverridden={isOverridden}
      summaryKind={summary.kind}
      onReset={reset}
    >
      {override?.kind === 'null' ? (
        <NullPill />
      ) : override?.kind === 'default' ? (
        <DefaultPill />
      ) : (
        <input
          type="text"
          value={draftValue}
          placeholder={placeholderText}
          onChange={(e) => setValue(e.target.value)}
          className={`w-full px-2 py-1.5 text-xs border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 ${
            isOverridden ? 'bg-amber-50 border-amber-300' : 'bg-white border-gray-300'
          } ${summary.kind === 'multiple' && !isOverridden ? 'placeholder:text-gray-400 placeholder:italic' : ''}`}
        />
      )}
      <NullDefaultButtons
        column={column}
        override={override}
        onSetNull={setNull}
        onSetDefault={setDefault}
      />
    </FieldShell>
  )
}

function FieldShell({
  column,
  isOverridden,
  summaryKind,
  onReset,
  children,
}: {
  column: ColumnMetadata
  isOverridden: boolean
  summaryKind: ColumnValueSummary['kind']
  onReset: () => void
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span
          className={`text-xs font-medium truncate ${isOverridden ? 'text-amber-600' : 'text-gray-700'}`}
        >
          {column.name}
          {summaryKind === 'multiple' && !isOverridden && (
            <span className="ml-1 text-gray-400 italic">(multiple)</span>
          )}
          {isOverridden && <span className="ml-1 text-amber-500">*</span>}
        </span>
        <div className="flex items-center gap-2">
          {isOverridden && (
            <button
              type="button"
              onClick={onReset}
              title="Reset this field"
              className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
            >
              <Undo2 className="w-3.5 h-3.5" />
            </button>
          )}
          <span className="text-xs text-gray-400">{column.type}</span>
        </div>
      </div>
      {children}
    </div>
  )
}

function NullDefaultButtons({
  column,
  override,
  onSetNull,
  onSetDefault,
}: {
  column: ColumnMetadata
  override: BulkOverride | undefined
  onSetNull: () => void
  onSetDefault: () => void
}) {
  const isNull = override?.kind === 'null'
  const isDefault = override?.kind === 'default'
  return (
    <div className="flex items-center gap-2 mt-1">
      {column.isNullable && (
        <Button
          variant={isNull ? 'default' : 'ghost'}
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={onSetNull}
        >
          Set NULL
        </Button>
      )}
      {column.hasDefault && (
        <Button
          variant={isDefault ? 'default' : 'ghost'}
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={onSetDefault}
        >
          Set DEFAULT
        </Button>
      )}
    </div>
  )
}

function NullPill() {
  return (
    <div className="w-full px-2 py-1.5 text-xs bg-amber-50 border border-amber-300 rounded italic text-gray-500">
      NULL
    </div>
  )
}

function DefaultPill() {
  return (
    <div className="w-full px-2 py-1.5 text-xs bg-amber-50 border border-amber-300 rounded italic text-gray-500">
      DEFAULT
    </div>
  )
}

function formatForInput(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

function coerceForType(raw: string, type: string): unknown {
  if (type === 'integer' || type === 'int4' || type === 'int8' || type === 'bigint' || type === 'smallint') {
    const n = parseInt(raw, 10)
    return isNaN(n) ? raw : n
  }
  if (type === 'numeric' || type === 'decimal' || type === 'real' || type === 'float4' || type === 'float8' || type === 'double precision') {
    const n = parseFloat(raw)
    return isNaN(n) ? raw : n
  }
  return raw
}
```

- [ ] **Step 6.2: Type-check**

Run: `pnpm tsc -b --noEmit`. Expected: clean.

- [ ] **Step 6.3: Commit**

```bash
git add src/components/sql-editor/BulkEditableField.tsx
git commit -m "feat(bulk-edit): add BulkEditableField component"
```

---

## Task 7: `BulkEditPanel` container

**Files:**
- Create: `src/components/sql-editor/BulkEditPanel.tsx`

- [ ] **Step 7.1: Implement `BulkEditPanel`**

Create `src/components/sql-editor/BulkEditPanel.tsx`:

```tsx
import { useCallback, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { Button } from '../ui/button'
import { useKeyboardShortcut } from '@/hooks/use-keyboard-shortcuts'
import { BulkEditableField } from './BulkEditableField'
import type { ColumnMetadata } from './hooks/useEditorTabs'
import {
  computeColumnValueSummary,
  type BulkOverrides,
  type BulkOverride,
} from '@/lib/bulk-edit'

interface BulkEditPanelProps {
  /** All currently selected rows (caller should already filter out staged-deletes). */
  rows: Record<string, unknown>[]
  columns: ColumnMetadata[]
  /** Number of rows excluded because they are pending delete. Shown in header if > 0. */
  excludedCount?: number
  open: boolean
  onClose: () => void
  /** Called with overrides to apply to every row in `rows`. */
  onSave: (overrides: BulkOverrides) => void
  /** Optional table label (e.g. "public.users") for the header. */
  tableLabel?: string
}

export function BulkEditPanel({
  rows,
  columns,
  excludedCount = 0,
  open,
  onClose,
  onSave,
  tableLabel,
}: BulkEditPanelProps) {
  const [overrides, setOverrides] = useState<BulkOverrides>({})
  const [invalidJsonColumns, setInvalidJsonColumns] = useState<Set<string>>(new Set())

  // Editable columns: hide PK and generated columns (Supabase-style).
  const editableColumns = useMemo(
    () => columns.filter((c) => !c.isPrimaryKey && !(c as { isGenerated?: boolean }).isGenerated),
    [columns],
  )

  const summaries = useMemo(() => {
    const out = new Map<string, ReturnType<typeof computeColumnValueSummary>>()
    for (const col of editableColumns) {
      out.set(col.name, computeColumnValueSummary(rows, col.name))
    }
    return out
  }, [editableColumns, rows])

  const overriddenCount = Object.keys(overrides).length
  const hasInvalidJson = invalidJsonColumns.size > 0
  const canSave = overriddenCount > 0 && !hasInvalidJson && rows.length > 0

  const setOverride = useCallback((colName: string, next: BulkOverride | undefined) => {
    setOverrides((prev) => {
      const out = { ...prev }
      if (next === undefined) delete out[colName]
      else out[colName] = next
      return out
    })
  }, [])

  const handleResetAll = useCallback(() => {
    setOverrides({})
  }, [])

  const handleCancel = useCallback(() => {
    if (overriddenCount > 0) {
      const ok = window.confirm('Discard bulk edits and close?')
      if (!ok) return
    }
    setOverrides({})
    onClose()
  }, [onClose, overriddenCount])

  const handleSave = useCallback(() => {
    if (!canSave) return
    onSave(overrides)
    setOverrides({})
  }, [canSave, onSave, overrides])

  useKeyboardShortcut(
    'bulk-edit-close',
    'Escape',
    () => handleCancel(),
    { when: () => open },
  )

  if (!open) return null

  const headerCount = rows.length
  const excludedSuffix =
    excludedCount > 0
      ? ` (${excludedCount} excluded: pending delete)`
      : ''

  return createPortal(
    <div className="fixed top-0 right-0 h-full w-96 bg-white border-l border-gray-200 shadow-lg flex flex-col z-50">
      {/* Header */}
      <div className="shrink-0 px-3 py-2 border-b border-gray-200">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium text-gray-700">
            Bulk edit · {headerCount} row{headerCount === 1 ? '' : 's'}
            {tableLabel ? ` in ${tableLabel}` : ''}
            {excludedSuffix}
          </div>
          <button
            type="button"
            onClick={handleCancel}
            className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="mt-2 px-2 py-1.5 rounded bg-amber-50 border border-amber-200 text-xs text-amber-800">
          Editing {headerCount} rows. Modified columns highlighted. Changes are staged for review.
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {editableColumns.length === 0 ? (
          <div className="text-xs text-gray-400 text-center py-4">
            No editable columns. (Primary key and generated columns are hidden.)
          </div>
        ) : (
          editableColumns.map((col) => {
            const summary = summaries.get(col.name) ?? { kind: 'multiple' as const }
            const override = overrides[col.name]
            return (
              <BulkEditableField
                key={col.name}
                column={col}
                summary={summary}
                override={override}
                onOverride={(next) => setOverride(col.name, next)}
                onValidityChange={(valid) => {
                  setInvalidJsonColumns((prev) => {
                    const out = new Set(prev)
                    if (valid) out.delete(col.name)
                    else out.add(col.name)
                    return out
                  })
                }}
              />
            )
          })
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 px-3 py-2 border-t border-gray-200 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={handleResetAll} disabled={overriddenCount === 0}>
          Reset all
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleCancel}>
            Cancel
          </Button>
          <Button variant="default" size="sm" onClick={handleSave} disabled={!canSave}>
            Save {overriddenCount > 0 ? `(${overriddenCount} col${overriddenCount === 1 ? '' : 's'})` : ''}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
```

- [ ] **Step 7.2: Type-check**

Run: `pnpm tsc -b --noEmit`. Expected: clean.

- [ ] **Step 7.3: Commit**

```bash
git add src/components/sql-editor/BulkEditPanel.tsx
git commit -m "feat(bulk-edit): add BulkEditPanel container"
```

---

## Task 8: Wire `BulkEditPanel` into `QueryResults`

**Files:**
- Modify: `src/components/sql-editor/QueryResults.tsx`

This task replaces the panel routing inside `QueryResults` so that when `selection.selectedIndices.size >= 2` (and selection is single-table), the bulk panel renders instead of `RowDetailPanel`.

- [ ] **Step 8.1: Add the import**

Near the top of `src/components/sql-editor/QueryResults.tsx`, alongside the existing imports for `RowDetailPanel`, add:

```tsx
import { BulkEditPanel } from './BulkEditPanel'
import { applyOverridesToRow, type BulkOverrides } from '@/lib/bulk-edit'
```

- [ ] **Step 8.2: Compute the bulk-eligible row set + table label**

Find the section in `QueryResults` after the `selection` hook is created (around lines 1167–1173). Add immediately below it:

```tsx
// Bulk edit: when 2+ rows are selected, render BulkEditPanel instead of RowDetailPanel.
const bulkSelection = useMemo(() => {
  if (selection.selectedIndices.size < 2) return null
  const indices = [...selection.selectedIndices]
  const allRows = indices.map((i) => displayRows[i - 1]).filter((r): r is NonNullable<typeof r> => !!r)

  // Exclude staged-deletes from the editable set.
  const editable = allRows.filter((r) => r.status !== 'staged-delete')
  const excludedCount = allRows.length - editable.length
  if (editable.length < 2) return null

  // Single-table guard: derive table label from columns; if any column metadata is missing
  // tableName/schemaName, fall back to undefined and show a generic header.
  const cols = activeResult?.result.columns ?? []
  const tableNames = new Set(cols.map((c) => `${c.schemaName}.${c.tableName}`))
  if (tableNames.size === 0) return null
  if (tableNames.size > 1) {
    return { kind: 'multi-table' as const, tableCount: tableNames.size }
  }

  const tableLabel = [...tableNames][0]
  const indexMap = new Map<Record<string, unknown>, number>()
  editable.forEach((dr, k) => indexMap.set(dr.data, indices[k]))

  return {
    kind: 'ok' as const,
    editableRows: editable,
    indices,
    excludedCount,
    tableLabel,
  }
}, [selection.selectedIndices, displayRows, activeResult])
```

- [ ] **Step 8.3: Add `handleSaveBulkEdit`**

Add this callback near `handleSaveEdit` (after the existing `handleSaveEdit` definition, currently at lines 1096–1118):

```tsx
const handleSaveBulkEdit = useCallback((overrides: BulkOverrides) => {
  if (!bulkSelection || bulkSelection.kind !== 'ok') return

  const targetIndices0 = bulkSelection.editableRows.map((dr) => {
    // Find the canonical 0-based index of this DisplayRow within displayRows
    return displayRows.indexOf(dr)
  }).filter((i) => i >= 0)

  setDisplayRows((prev) => prev.map((row, idx) => {
    if (!targetIndices0.includes(idx)) return row
    if (row.status === 'staged-delete') return row // safety; should be filtered
    if (row.status === 'staged-insert') {
      // Apply override to the in-flight insert directly; keep status.
      return { ...row, data: applyOverridesToRow(row.data, overrides) }
    }
    // staged-update or normal -> become/remain staged-update with merged data.
    const originalData = row.originalData ?? { ...row.data }
    const newData = applyOverridesToRow(row.data, overrides)
    return { ...row, data: newData, originalData, status: 'staged-update' }
  }))

  // Clear selection and close the panel.
  selectionRef.current?.clearSelection()
  setSelectedRow(null)
  setDrawerOpen(false)
}, [bulkSelection, displayRows])
```

- [ ] **Step 8.4: Replace the panel render block with bulk-aware routing**

Find the existing panel render block at lines 1577–1675 (the IIFE starting with `selectedRow && activeResult && !isExplainResult && (() => {`).

Wrap it with bulk-mode dispatch. Replace the entire block:

```tsx
{selectedRow && activeResult && !isExplainResult && (() => {
  // ... existing single-row rendering (pendingNewRow + selectedRow.displayRow paths)
})()}
```

with:

```tsx
{/* Bulk edit panel (≥2 rows selected) */}
{bulkSelection && activeResult && !isExplainResult && drawerOpen && (
  bulkSelection.kind === 'multi-table' ? (
    <MultiTableBulkBanner
      onClose={() => {
        setDrawerOpen(false)
        setSelectedRow(null)
      }}
      tableCount={bulkSelection.tableCount}
    />
  ) : (
    <BulkEditPanel
      rows={bulkSelection.editableRows.map((dr) => dr.data)}
      columns={activeResult.result.columns}
      excludedCount={bulkSelection.excludedCount}
      open={drawerOpen}
      onClose={() => {
        setDrawerOpen(false)
        setSelectedRow(null)
      }}
      onSave={handleSaveBulkEdit}
      tableLabel={bulkSelection.tableLabel}
    />
  )
)}

{/* Single-row panel (1 row or pending new row) */}
{!bulkSelection && selectedRow && activeResult && !isExplainResult && (() => {
  // ... ENTIRE existing IIFE body unchanged ...
})()}
```

(Keep the entire body of the existing IIFE — pendingNewRow branch + selectedRow.displayRow branch — unchanged inside the new `{!bulkSelection && ...}` guard.)

- [ ] **Step 8.5: Add `MultiTableBulkBanner` helper component**

At the top of `QueryResults.tsx`, just below the existing imports/helpers section (above the `QueryResults` component), add a small portal banner component:

```tsx
function MultiTableBulkBanner({
  tableCount,
  onClose,
}: {
  tableCount: number
  onClose: () => void
}) {
  return createPortal(
    <div className="fixed top-0 right-0 h-full w-96 bg-white border-l border-gray-200 shadow-lg flex flex-col z-50">
      <div className="shrink-0 px-3 py-2 border-b border-gray-200 flex items-center justify-between">
        <span className="text-xs font-medium text-gray-700">Bulk edit unavailable</span>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
        >
          ✕
        </button>
      </div>
      <div className="flex-1 p-4">
        <div className="text-xs text-gray-700">
          Bulk edit requires rows from a single table. Selected rows span {tableCount} tables.
        </div>
      </div>
    </div>,
    document.body,
  )
}
```

If `createPortal` isn't already imported in `QueryResults.tsx`, add it to the existing `react-dom` import (or add `import { createPortal } from 'react-dom'`).

- [ ] **Step 8.6: Open the panel on multi-row click**

The existing `handleRowClick` and double-click flow already opens the drawer for any row click. With `bulkSelection` now driving panel rendering, no changes are needed: a shift-click or ctrl-click that grows the selection to ≥2 will automatically cause `bulkSelection` to be non-null, and `setDrawerOpen(true)` (already called by `handleRowClick`) makes the bulk panel visible.

To prevent surprising "panel jumps" when the user is just multi-selecting without intending to edit, **change the behavior**: only open the bulk panel on double-click when ≥2 rows are selected. Locate `handleRowDoubleClick` (around lines 1301–1318) and adjust:

Replace:

```tsx
const handleRowDoubleClick = useCallback((rowIndex: number, row: Record<string, unknown>, column: string) => {
  // Don't do anything for EXPLAIN results
  if (isExplainResult) return
  const dr = displayRows[rowIndex - 1]
  if (!dr) return
  // Check if row is already staged or user lacks write permission - if so, don't auto-enter edit mode
  if (!hasWrite || dr.status !== 'normal') {
    // Just open the panel normally, don't enter edit mode
    setSelectedRow({ displayRow: dr, data: row, column })
    setDrawerOpen(true)
    return
  }
  // Open panel, enter edit mode, and set column to focus
  setSelectedRow({ displayRow: dr, data: row, column })
  setDrawerOpen(true)
  setIsEditingRow(true)
  setAutoEditColumn(column)
}, [displayRows, hasWrite, isExplainResult])
```

with:

```tsx
const handleRowDoubleClick = useCallback((rowIndex: number, row: Record<string, unknown>, column: string) => {
  // Don't do anything for EXPLAIN results
  if (isExplainResult) return
  const dr = displayRows[rowIndex - 1]
  if (!dr) return

  // Multi-row mode: if 2+ rows are selected, open the bulk panel.
  // (selection.selectedIndices may not include rowIndex yet if the dblclick landed
  //  on a non-selected row; ensure the row is in the selection first.)
  if (selectionRef.current && selectionRef.current.selectedIndices.size >= 2) {
    setSelectedRow({ displayRow: dr, data: row, column })
    setDrawerOpen(true)
    return
  }

  // Single-row path (existing behavior).
  if (!hasWrite || dr.status !== 'normal') {
    setSelectedRow({ displayRow: dr, data: row, column })
    setDrawerOpen(true)
    return
  }
  setSelectedRow({ displayRow: dr, data: row, column })
  setDrawerOpen(true)
  setIsEditingRow(true)
  setAutoEditColumn(column)
}, [displayRows, hasWrite, isExplainResult])
```

Also adjust `handleRowClick` (around lines 1292–1299) — when ≥2 rows are selected, do **not** open the drawer on a single click (clicking a non-selected row should still single-select and open the single-row panel as today; but if multi-selection is already active, the user is selecting more rows and shouldn't have the panel pop open until they double-click).

Replace:

```tsx
const handleRowClick = useCallback((rowIndex: number, row: Record<string, unknown>, column?: string) => {
  // Don't open detail panel for EXPLAIN results
  if (isExplainResult) return
  const dr = displayRows[rowIndex - 1]
  if (!dr) return
  setSelectedRow({ displayRow: dr, data: row, column })
  setDrawerOpen(true)
}, [isExplainResult, displayRows])
```

with:

```tsx
const handleRowClick = useCallback((rowIndex: number, row: Record<string, unknown>, column?: string) => {
  if (isExplainResult) return
  const dr = displayRows[rowIndex - 1]
  if (!dr) return
  // If user is actively multi-selecting (2+ already selected), don't auto-open the panel
  // on a plain row click — wait for explicit double-click to open bulk panel.
  if (selectionRef.current && selectionRef.current.selectedIndices.size >= 2) {
    setSelectedRow({ displayRow: dr, data: row, column })
    return
  }
  setSelectedRow({ displayRow: dr, data: row, column })
  setDrawerOpen(true)
}, [isExplainResult, displayRows])
```

- [ ] **Step 8.7: Auto-close panel when selection empties**

When the user deletes selected rows (via context menu) or the row data otherwise disappears, the panel should close instead of lingering with stale `selectedRow`. Add this effect alongside the other effects in `QueryResults`:

```tsx
// If the selected row is no longer in displayRows (deleted, query refreshed, etc.),
// or if the user has cleared the selection from outside the panel, close the panel.
useEffect(() => {
  if (!drawerOpen) return
  if (selectedRow?.displayRow && !displayRows.includes(selectedRow.displayRow)) {
    setDrawerOpen(false)
    setSelectedRow(null)
  }
}, [displayRows, selectedRow, drawerOpen])
```

Place this near the other `useEffect`s in `QueryResults` (search for `useEffect(` to find a sensible neighbor — placement doesn't matter for correctness).

- [ ] **Step 8.8: Type-check**

Run: `pnpm tsc -b --noEmit`. Expected: clean.

- [ ] **Step 8.9: Commit**

```bash
git add src/components/sql-editor/QueryResults.tsx
git commit -m "feat(bulk-edit): wire BulkEditPanel into QueryResults panel routing"
```

---

## Task 9: End-to-end manual smoke test

This task verifies the full feature against a real Postgres. No automated tests (per the spec — no jsdom in this repo).

- [ ] **Step 9.1: Start the app**

Run: `pnpm dev`

Connect to a Postgres database with a table containing at least: an `int` PK column, a `text` column, a `jsonb` column, a nullable `text` column, and a `boolean` column. Insert ~10 sample rows where some columns share values and others differ.

- [ ] **Step 9.2: Smoke — JSON inline editing in single-row mode**

1. Run `SELECT * FROM <table> LIMIT 10;`.
2. Double-click a JSON column cell. Single-row panel opens in edit mode focused on that column.
3. Verify CodeMirror editor with syntax highlighting renders.
4. Click Format button → JSON prettifies in place.
5. Type invalid JSON (delete a `"`). Red error appears below editor; panel Save button disables.
6. Fix the JSON. Save re-enables.
7. Click Expand button → modal opens with current draft.
8. Edit in modal, click Save → inline editor reflects modal's value.
9. Click panel Save → row goes amber (staged-update).
10. Click Preview Changes in the bottom bar → modal shows one `UPDATE`.
11. Execute → row updates and grid refreshes.

- [ ] **Step 9.3: Smoke — multi-row bulk edit**

1. Shift-click 3 rows (or ctrl/cmd-click).
2. Double-click any selected row.
3. Bulk panel opens, header reads `Bulk edit · 3 rows in <schema>.<table>`.
4. Columns where all 3 rows differ show "Multiple values" placeholder; same columns show shared value.
5. PK column is hidden.
6. Type a value in a non-PK column → field goes amber, header shows asterisk, footer Save counter updates.
7. Click Set NULL on a nullable column → field shows "NULL" amber pill.
8. Click Set DEFAULT on a column with default → "DEFAULT" amber pill.
9. Click Reset all → all overrides cleared.
10. Re-edit one column → click Save → all 3 rows go amber in grid (staged-update).
11. Preview changes → modal shows 3 `UPDATE` statements.
12. Execute → all 3 rows update atomically; refresh shows new values.

- [ ] **Step 9.4: Smoke — edge cases**

1. **Bulk edit with one staged-update + two normal rows:** Select all 3, bulk-edit a different column. Verify the staged-update row's existing per-column override is preserved (visible in preview as combined SET clauses), and the new bulk override applies to all 3.
2. **Bulk edit with a staged-delete in selection:** Select 2 normal + 1 staged-delete row. Open bulk panel — header reads `Bulk edit · 2 rows ... (1 excluded: pending delete)`. Save applies only to the 2.
3. **Cancel with dirty overrides:** Make changes in bulk panel, click Cancel → confirm dialog appears. Cancel the dialog → panel stays open. Confirm → panel closes, no staging.
4. **Escape to close:** With dirty overrides, press Escape → same confirm flow.
5. **Selection drops to 0 (delete via context menu while panel open):** Verify panel auto-closes.
6. **Multi-table selection:** Run a JOIN that returns columns from two tables. Select 2 rows. Double-click. Verify the "Bulk edit unavailable" banner appears with the correct table count.
7. **Invalid JSON in bulk panel:** Click into a JSON column in bulk mode, type invalid JSON. Save button disables.

- [ ] **Step 9.5: Smoke — regression checks (existing single-row flow)**

1. Single row selected → double-click → existing single-row panel opens, edit works as before.
2. Pending new row (Add row button) → single-row panel opens with `isNewRow={true}`, JSON columns now use `JsonField` (regression test for Task 5).
3. Boolean columns still render as a `<select>` in single-row edit mode.
4. Non-JSON multiline text columns (length > 100 or contains newline) still use `<textarea>`.

- [ ] **Step 9.6: If anything failed, fix and re-test**

If any smoke check failed, identify the task that introduced the regression, write the targeted fix, and re-run the relevant smoke step. Commit fixes separately with descriptive messages.

- [ ] **Step 9.7: No-op commit if nothing to fix (skip otherwise)**

If all smoke checks passed without further changes, no commit is needed for this task.

---

## Task 10 (optional, follow-up): backend `isGenerated` flag

This is a polish improvement, not a blocker. Bulk panel works without it; generated columns will appear editable in the UI but Postgres will reject the UPDATE on commit, surfacing the error.

**Files:**
- Modify: `server/services/query-service.ts`
- Modify: `src/components/sql-editor/hooks/useEditorTabs.ts`
- Modify: relevant proto if column metadata is RPC-shaped (verify; may not need)

- [ ] **Step 10.1: Add `isGenerated` to backend metadata**

In `server/services/query-service.ts`, locate `getColumnMetadata` (lines 61–137 per spec exploration). Modify the `pg_attribute` query to include `attgenerated`:

Find:
```ts
SELECT a.attname, a.attnotnull, ...
FROM pg_attribute a
...
```
(exact lines vary; consult the file). Add `a.attgenerated` to the SELECT list and to the returned metadata object as `isGenerated: row.attgenerated !== ''`.

- [ ] **Step 10.2: Add `isGenerated` to the frontend `ColumnMetadata` interface**

In `src/components/sql-editor/hooks/useEditorTabs.ts` (lines 23–31):

```ts
export interface ColumnMetadata {
  name: string
  type: string
  tableName: string
  schemaName: string
  isPrimaryKey: boolean
  isNullable: boolean
  hasDefault: boolean
}
```

Add:
```ts
  isGenerated?: boolean
```

The `BulkEditPanel.tsx` filter `(c as { isGenerated?: boolean }).isGenerated` already accommodates this. After this task lands, replace the cast with a direct property access.

- [ ] **Step 10.3: If the column metadata is sent over the wire (proto/RPC), regenerate**

Run: `pnpm gen` — regenerates from `proto/`. If proto needs updating, edit the relevant `.proto` to add `bool is_generated = N` and re-run.

- [ ] **Step 10.4: Smoke + commit**

Verify via `pnpm dev` that a generated column (e.g. `GENERATED ALWAYS AS (...) STORED`) is hidden in bulk mode.

```bash
git add -A
git commit -m "feat(bulk-edit): hide generated columns in bulk panel"
```

---

## Self-Review Checklist

After implementing each task, verify before committing:

1. **Spec coverage**:
   - [x] JSON inline editing with Format/Expand → Tasks 3, 4, 5
   - [x] BulkOverride model → Task 1
   - [x] computeColumnValueSummary → Task 2
   - [x] BulkEditableField (states: same/multiple/allNull/overridden) → Task 6
   - [x] BulkEditPanel (header, body, footer, Cancel/Reset/Save) → Task 7
   - [x] Single-table guard with banner → Task 8
   - [x] Selection-size routing (1 row → single panel, 2+ → bulk panel) → Task 8
   - [x] Merge with already-staged rows → Task 8 (handleSaveBulkEdit)
   - [x] Exclude staged-deletes → Task 8 (bulkSelection)
   - [x] Generated columns hidden → Task 7 (filter) + Task 10 (backend)
   - [x] PK columns hidden in bulk → Task 7
   - [x] JsonExpandModal Format button → Task 4

2. **Type consistency**: `BulkOverride`, `BulkOverrides`, `ColumnValueSummary`, `BulkEditPanelProps` all defined in Task 1/2/7 and used consistently in Tasks 6/7/8.

3. **No placeholders**: Every code block is complete and ready to paste.
