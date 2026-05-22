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
