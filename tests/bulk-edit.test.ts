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
