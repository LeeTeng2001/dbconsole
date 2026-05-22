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
 * - { kind: 'default' } -> sets the property to undefined.
 *   This matches the existing convention in generateInsertSQL, which filters
 *   undefined to emit DEFAULT in INSERT statements. Note that generateUpdateSQL
 *   currently treats undefined as NULL — bulk-edit "Set DEFAULT" on staged-update
 *   rows will be handled by callers / a later task that introduces an explicit
 *   DEFAULT marker if needed. For now, "Set DEFAULT" is most meaningful on
 *   staged-insert rows.
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

