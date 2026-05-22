# Bulk Row Edit + JSON-Aware Row Editing — Design

**Date:** 2026-05-22
**Status:** Draft
**Scope:** `src/components/sql-editor/RowDetailPanel.tsx`, `QueryResults.tsx`, new bulk-edit panel, JSON field component, `JsonExpandModal.tsx`

## Goals

Two related improvements to the row-edit side panel:

1. **JSON/JSONB cells** in the row-edit panel get a real CodeMirror editor inline (with syntax highlighting, Format and Expand buttons) instead of a plain `<textarea>`.
2. The panel **auto-switches to bulk-edit mode** when ≥2 rows are selected, displaying "Multiple values" placeholders for differing columns and letting the user overwrite all selected rows' values for any column at once. Local edits highlight as amber, then stage as N `staged-update` rows feeding the existing preview/commit flow.

## Non-Goals

- Ctrl/Cmd+W tab close (deferred).
- Bulk insert / bulk delete (delete already exists via context menu + Delete key).
- Editors for arrays, composite types, hstore, ranges.
- Cross-table bulk edit (rows from a JOIN spanning multiple tables).
- Per-cell edit-in-grid (still goes through the side panel).

## Background

Existing relevant infrastructure (already in the codebase):

- `RowDetailPanel.tsx` — single-row side panel with `EditableField` per column. JSON columns currently use `<textarea>` (plain text) for edit; a separate `JsonExpandModal` exists with CodeMirror but lacks a Format button.
- `useRowSelection` (`src/hooks/useRowSelection.ts`) — multi-row selection with shift/ctrl ranges.
- `DisplayRow` model in `QueryResults.tsx` — per-row status (`normal | staged-update | staged-delete | staged-insert`) with `originalData` snapshot.
- `staged-changes.ts` — `generateUpdateSQL` already emits one `UPDATE ... WHERE pk = ...` per row across N rows in a single `StagedUpdateChange`. **No backend changes required for bulk edit.**
- Commit pipeline: `handleExecuteAll` joins all staged SQL, server wraps multi-statement in `BEGIN; ... COMMIT;` automatically.

## Architecture

### New files

| File | Purpose |
|---|---|
| `src/components/sql-editor/JsonField.tsx` | Inline CodeMirror JSON editor with Format + Expand toolbar. Used in single-row `EditableField` and `BulkEditableField`. |
| `src/components/sql-editor/BulkEditPanel.tsx` | Side-panel UI for bulk edit. Same dimensions/portal/escape behavior as `RowDetailPanel`; renders `BulkEditableField` per editable column. |
| `src/components/sql-editor/BulkEditableField.tsx` | Bulk-mode field renderer. Knows `same / multiple / allNull / overridden` state. Adds explicit "Set NULL" and "Set DEFAULT" buttons. |
| `src/lib/bulk-edit.ts` | Pure helpers: `computeColumnValueSummary`, `applyOverridesToRow`, `mergeBulkOverridesWithStaged`. |
| `src/lib/bulk-edit.test.ts` | Unit tests for the pure helpers. |
| `src/components/sql-editor/JsonField.test.tsx` | Tests for inline JSON editor (Format, Expand round-trip, invalid JSON). |
| `src/components/sql-editor/BulkEditPanel.test.tsx` | Tests for bulk panel (Multiple values, Save stages N rows, Reset, Cancel, NULL/DEFAULT). |

### Modified files

- **`RowDetailPanel.tsx`** — replace the inline JSON textarea branch (the `isMultiline` JSON path inside `EditableField`) with `<JsonField>`. Non-JSON paths unchanged.
- **`QueryResults.tsx`** — when `selectedIndices.size >= 2` and the user opens a row panel (double-click on any selected row, or "Edit" affordance), render `<BulkEditPanel>` instead of `<RowDetailPanel>`. Add `handleSaveBulkEdit(overrides)` that mutates each selected `displayRow` to `staged-update` with merged overrides.
- **`JsonExpandModal.tsx`** — add a "Format" button to the toolbar.
- **`useEditorTabs.ts` (`ColumnMetadata`)** — add optional `isGenerated?: boolean` flag if not already present (verify during implementation; add if missing). Hidden in bulk panel.
- **`server/services/query-service.ts` (`getColumnMetadata`)** — populate `isGenerated` from `pg_attribute.attgenerated` if the metadata field is added.

### Data model: bulk overrides

```ts
type BulkOverride =
  | { kind: 'value'; value: unknown }
  | { kind: 'null' }
  | { kind: 'default' };

type BulkOverrides = Record<string /* columnName */, BulkOverride>;
```

`applyOverridesToRow(originalRow, overrides)` returns a new row record:
- `kind: 'value'` → `result[col] = value`
- `kind: 'null'` → `result[col] = null`
- `kind: 'default'` → `result[col] = undefined` (matches existing convention: `undefined` means "use DEFAULT", which `generateInsertSQL` and `generateUpdateSQL` interpret correctly).

### Column value summary (for bulk panel display)

```ts
type ColumnValueSummary =
  | { kind: 'same'; value: unknown }
  | { kind: 'multiple' }
  | { kind: 'allNull' };

function computeColumnValueSummary(
  rows: Record<string, unknown>[],
  columnName: string,
): ColumnValueSummary;
```

`'allNull'` is a special case of `'same'` that the UI may render differently (e.g., italicized "NULL" placeholder). Treated as `'same'` for staging purposes.

### Data flow — bulk edit

```
User selects N rows (existing useRowSelection)
  ↓
User opens panel (double-click on a selected row, or new "Edit N rows" button)
  ↓
QueryResults: if selectedIndices.size >= 2 and selection is single-table
  → render <BulkEditPanel rows={selectedRows} columns={editableCols} ... />
  else → existing RowDetailPanel
  ↓
BulkEditPanel:
  - For each editable column: computeColumnValueSummary(selectedRows, col)
  - Local state: overrides: BulkOverrides
  - Renders BulkEditableField per (non-PK, non-generated) column
  - On Save: onSaveBulkEdit(overrides)
  ↓
QueryResults.handleSaveBulkEdit(overrides):
  - For each selected DisplayRow:
    - originalData = row.originalData ?? snapshot of current row.data
    - newData = applyOverridesToRow(row.data, overrides)
    - status = 'staged-update'
  - setDisplayRows(...)
  ↓
Existing stagedChanges derivation (QueryResults.tsx:935-1034) builds StagedUpdateChange
  ↓
Existing preview modal + Execute All flow handles commit (BEGIN/COMMIT wrapped server-side)
```

### Single-table guard

Before opening `BulkEditPanel`, `QueryResults` checks that all selected rows resolve to the same editable table using the existing `stagedType` logic (which single-row edit already relies on to decide whether a row is editable).

If selection spans multiple tables, show an inline banner inside the side panel:
> *"Bulk edit requires rows from a single table. Selected rows span N tables."*

with a Close button. No staging happens.

## UI Specification

### `JsonField` — inline CodeMirror

```
┌─ raw_request                                          jsonb ─┐
│ ┌──────────────────────────────────────────[Format] [⤢]──┐ │
│ │ {                                                       │ │  CodeMirror 6
│ │   "Credential": "gcp-vertexai-auth1",                   │ │  json language
│ │   "User-Agent": "Go-http-client",                       │ │  lineWrapping
│ │ }                                                       │ │  fold gutter
│ └─────────────────────────────────[drag-resize ↕]────────┘ │
│ Invalid JSON: Unexpected token } at position 47              │  (only when invalid)
└──────────────────────────────────────────────────────────────┘
```

- **Default height:** 120px. Auto-grows with content up to 400px, then scrolls.
- **Drag-resize:** 4px hit zone at bottom edge with `ns-resize` cursor. Min 80px, max viewport-bound.
- **Format button:** `JSON.parse(value)` then `JSON.stringify(parsed, null, 2)`. Disabled with tooltip "Invalid JSON" when parse fails.
- **Expand button (⤢):** Opens existing `JsonExpandModal` with the current draft. On modal save, value syncs back to inline editor.
- **Validation hint:** Small red text below the editor when JSON is invalid. Save button in the parent panel disabled while invalid.
- **Theme/extensions:** Mirror `JsonViewer.tsx` — `@codemirror/lang-json`, line wrapping, fold gutter, no line numbers.

### `BulkEditPanel`

Same right-side fixed positioning as `RowDetailPanel` (`fixed top-0 right-0 h-full w-96`), portaled to body, Escape closes (with confirm when overrides are dirty).

```
┌──────────────────────────────────────────────────────────┐
│  Bulk edit · 12 rows in litellm.caching             ✕    │
│  ┌────────────────────────────────────────────────────┐  │
│  │ ⚠  Editing 12 rows. Modified columns highlighted.  │  │
│  └────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  call_type                                          text │
│  ┌────────────────────────────────────────────────────┐  │
│  │ acompletion                                        │  │  ← all-same: shows shared value
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  api_key                                            text │
│  ┌────────────────────────────────────────────────────┐  │
│  │ ░░░ Multiple values ░░░                            │  │  ← greyed; click to overwrite
│  └────────────────────────────────────────────────────┘  │
│  [Set NULL]  [Set DEFAULT]                               │
│                                                          │
│  prompt_tokens                          *           int4 │  ← amber asterisk = overridden
│  ┌────────────────────────────────────────────────────┐  │
│  │ 18                                                 │  │  ← amber bg
│  └────────────────────────────────────────────────────┘  │
│  [↺ Reset this field]    [Set NULL]  [Set DEFAULT]       │
│                                                          │
│  raw_request                                       jsonb │
│  ┌────────────────────────────────────────────────────┐  │
│  │ ░░░ Multiple values ░░░                            │  │  ← clicking opens JsonField
│  └────────────────────────────────────────────────────┘  │
│  [Set NULL]                                              │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  [Reset all]                       [Cancel]  [Save 1 col]│
└──────────────────────────────────────────────────────────┘
```

#### Per-column states

- **`same`** — input pre-filled with the shared value, normal styling. Editing it transitions to `overridden`.
- **`multiple`** — placeholder text "Multiple values", greyed bg. Empty input value. Clicking focuses; typing transitions to `overridden`.
- **`allNull`** — italic "NULL" placeholder, greyed. Same edit affordances; overriding transitions to `overridden`.
- **`overridden`** — amber bg, asterisk on column header (matches existing single-row pattern at `RowDetailPanel.tsx:572`). Per-field "↺ Reset this field" link reverts.

#### Type-specific renderers (in `BulkEditableField`)

- **JSON / JSONB** → `<JsonField>`. Initial: empty in `multiple` state, prefilled in `same`.
- **Boolean** → `<select>` with options `(no change) | NULL | true | false | DEFAULT`. `(no change)` is the default when `multiple`.
- **Numeric / text / etc.** → `<input>` with placeholder text reflecting state.
- **Set NULL** / **Set DEFAULT** buttons sit below each editable field (always visible, de-emphasized styling). Clicking sets the override directly without typing.

#### Hidden columns (bulk mode only)

- All `isPrimaryKey` columns.
- All `isGenerated` columns (if metadata available; otherwise rely on backend rejection).

PK / generated columns are hidden, not shown disabled — Supabase-style.

#### Footer buttons

- **Reset all** — clears `overrides` state (no field is `overridden`). Doesn't close panel.
- **Cancel** — closes panel, drops local overrides, no staging. Confirm dialog when overrides dirty.
- **Save N col** — counter live-updates with the number of overridden columns. Disabled when N=0. On click: calls `onSaveBulkEdit(overrides)` then closes panel.

#### Header

- Title: `Bulk edit · {count} rows in {schema}.{table}`
- Subtitle banner (constant): `Modified columns highlighted. Changes are staged for review.`
- X (close) button — same as Cancel.

### Single-row JSON editing (existing `RowDetailPanel`)

The textarea branch in `EditableField` is replaced with `<JsonField>`. Save button in panel is disabled while JSON is invalid. All other column types unchanged.

### `JsonExpandModal` Format button

Add a `[Format]` button to the existing toolbar (`JsonExpandModal.tsx:106-137`), positioned to the left of `[Copy]`. Same parse-then-`stringify(_, null, 2)` logic. Disabled when JSON invalid.

### Modified-cell highlighting in the grid

When bulk-save stages N rows, the existing per-cell `isOverridden` highlight (`QueryResults.tsx:469-474, 572-577`) automatically lights up because `originalData[col] !== data[col]` on touched columns. **No new highlight code required.**

## Edge Cases

| Case | Behavior |
|---|---|
| Selection rows span multiple tables | Show banner "Bulk edit requires rows from a single table. Selected rows span N tables." Panel does not allow staging. |
| Selection includes `staged-delete` rows | Exclude those from the bulk-edit set. Header shows `Bulk edit · M rows (K excluded: pending delete)`. |
| Selection includes `staged-insert` rows | Allowed. Overrides apply directly to the row's `data` (the row stays `staged-insert`, not converted to `staged-update`). |
| Selection includes `staged-update` rows | Merge: keep existing `originalData`. New bulk overrides win on touched columns. Existing per-row overrides preserved on untouched columns. |
| Invalid JSON in a JSONB field | Save button disabled. Inline error under the field. |
| 0 columns overridden on Save | Save button disabled. |
| Selection becomes empty (e.g., row deleted via context menu while panel open) | Auto-close bulk panel. |
| Selection drops to 1 while panel open | If no overrides dirty: switch to single-row `RowDetailPanel` for that row. If dirty: show confirm "Discard bulk edits and switch to single-row?" |
| Selection grows from 1 to 2 while single-row panel open | If single-row panel is in view mode: silently switch to `BulkEditPanel`. If in edit mode with dirty changes: confirm "Discard single-row edits and switch to bulk?" |
| User Set NULL on a NOT NULL column | Allow staging. Postgres rejects at commit; existing error path surfaces it. (Future: add UI warning when `isNullable === false`.) |
| Commit fails partway | Existing rollback behavior (`BEGIN; ... COMMIT;` server-side wrapping in `query-service.ts:198-206`) — all or nothing. UI surfaces the error. |
| User wants to NULL only differing rows | Out of scope. Bulk edit is "overwrite all N for any touched column." Per-row edits use single-row mode. |

## Testing Strategy

### Unit tests

`src/lib/bulk-edit.test.ts`:
- `computeColumnValueSummary` for: all-same, all-null, mixed values, mixed null + values, single row.
- `applyOverridesToRow` for: value override, null override, default override (undefined), no overrides, partial overrides.
- Merge with existing `staged-update`: preserves original `originalData`, merges overrides correctly.

`src/components/sql-editor/JsonField.test.tsx`:
- Renders given JSON value.
- Format button parses + prettifies in place.
- Format disabled on invalid JSON.
- Expand opens modal; modal save round-trips back.
- Drag-resize updates height state.

`src/components/sql-editor/BulkEditPanel.test.tsx`:
- Renders "Multiple values" for differing columns.
- Renders shared value for same columns.
- Hides PK columns.
- Save calls `onSaveBulkEdit` with correct overrides shape.
- Reset clears overrides.
- Cancel does not call onSave.
- Set NULL / Set DEFAULT produce correct override kinds.
- Save N col counter updates with overridden count.

### Integration

If a Playwright (or equivalent) harness exists in the repo, add a flow:
1. Run a SELECT.
2. Select 3 rows (shift-click).
3. Double-click → bulk panel opens with "Multiple values" for differing columns.
4. Set one column → Save → 3 rows show amber `staged-update` highlight in the grid.
5. Click Preview changes → modal shows 3 UPDATEs.
6. Execute all → success → grid refreshes with new values.

If no e2e harness exists, only unit-level tests are in scope. (Verify during implementation.)

### Manual smoke

- JSON column: edit, format, expand, save in single-row panel.
- Bulk edit on a JOIN result spanning two tables → banner shown.
- Bulk edit on N rows with mix of staged-update / normal → resulting SQL preview matches expectation.

## Implementation Order Sketch

1. `src/lib/bulk-edit.ts` + tests (pure logic, no UI).
2. `JsonField.tsx` + tests. Add Format button to `JsonExpandModal`.
3. Wire `JsonField` into single-row `RowDetailPanel.EditableField`. Manual smoke.
4. `BulkEditableField.tsx` + `BulkEditPanel.tsx` + tests.
5. Wire `BulkEditPanel` into `QueryResults` (selection-based panel routing, `handleSaveBulkEdit`, single-table guard).
6. (Optional, if missing) Add `isGenerated` to backend column metadata and ColumnMetadata interface. Bulk panel falls back gracefully without it: generated columns appear editable in UI but Postgres rejects the UPDATE on commit. Adding the flag is a polish improvement, not a blocker.
7. End-to-end smoke against a real Postgres instance.

## Open Questions

None at design time. (Implementation may surface details around: existing `isGenerated` flag presence; exact `stagedType` API for cross-table detection; whether `JsonExpandModal` already has a way to be invoked from a non-modal source.)
