import { describe, it, expect } from 'vitest'
import { applyOverridesToRow, computeColumnValueSummary, type BulkOverrides } from '@/lib/bulk-edit'

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
