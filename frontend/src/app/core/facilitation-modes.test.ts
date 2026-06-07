import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MODE_ID,
  FACILITATION_MODES,
  getFacilitationMode,
} from '@ai-storm/shared'

/**
 * Facilitation modes (#61) — the catalog is the shared single source of truth
 * for the picker (frontend) and the priming append (backend). These lock the
 * invariants both sides rely on.
 */
describe('facilitation modes', () => {
  it('has unique ids and the default is first and free of a preset', () => {
    const ids = FACILITATION_MODES.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(FACILITATION_MODES[0].id).toBe(DEFAULT_MODE_ID)
    expect(FACILITATION_MODES[0].prime).toBe('')
  })

  it('gives every mode a label + hint, and a preset for every non-default mode', () => {
    for (const m of FACILITATION_MODES) {
      expect(m.label.length).toBeGreaterThan(0)
      expect(m.hint.length).toBeGreaterThan(0)
      if (m.id !== DEFAULT_MODE_ID) expect(m.prime.length).toBeGreaterThan(0)
    }
  })

  it('resolves a known id and falls back to the default for unknown/undefined', () => {
    expect(getFacilitationMode('scamper').id).toBe('scamper')
    expect(getFacilitationMode(undefined).id).toBe(DEFAULT_MODE_ID)
    expect(getFacilitationMode('nope').id).toBe(DEFAULT_MODE_ID)
  })
})
