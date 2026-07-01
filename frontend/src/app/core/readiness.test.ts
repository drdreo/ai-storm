import { describe, expect, it } from 'vitest'
import { computeReadiness, hasBlockingIssues, type ReadinessInput } from './readiness'

const base: ReadinessInput = {
  connState: 'open',
  agentCommand: 'claude',
  cwd: undefined,
  modeId: 'free',
  background: 'B2B fintech, avoid ideas needing new hardware.',
}

describe('computeReadiness (#97)', () => {
  it('is all-ok and non-blocking for a fully configured, connected setup', () => {
    const checks = computeReadiness(base)
    expect(checks.every((c) => c.severity === 'ok')).toBe(true)
    expect(hasBlockingIssues(checks)).toBe(false)
  })

  it('blocks when the backend is closed', () => {
    const checks = computeReadiness({ ...base, connState: 'closed' })
    const conn = checks.find((c) => c.id === 'connection')
    expect(conn?.severity).toBe('blocking')
    expect(hasBlockingIssues(checks)).toBe(true)
  })

  it('warns (does not block) while the backend is still connecting', () => {
    const checks = computeReadiness({ ...base, connState: 'connecting' })
    const conn = checks.find((c) => c.id === 'connection')
    expect(conn?.severity).toBe('warning')
    expect(hasBlockingIssues(checks)).toBe(false)
  })

  it('blocks when the harness command is blank', () => {
    const checks = computeReadiness({ ...base, agentCommand: '   ' })
    const harness = checks.find((c) => c.id === 'harness')
    expect(harness?.severity).toBe('blocking')
    expect(hasBlockingIssues(checks)).toBe(true)
  })

  it('omits the cwd check entirely when unconfigured, warns when configured blank', () => {
    expect(computeReadiness(base).find((c) => c.id === 'cwd')).toBeUndefined()

    const blank = computeReadiness({ ...base, cwd: '   ' })
    expect(blank.find((c) => c.id === 'cwd')?.severity).toBe('warning')
    expect(hasBlockingIssues(blank)).toBe(false)

    const configured = computeReadiness({ ...base, cwd: '/home/user/project' })
    expect(configured.find((c) => c.id === 'cwd')?.severity).toBe('ok')
  })

  it('always resolves a facilitation mode (falls back to default) without blocking', () => {
    const unknown = computeReadiness({ ...base, modeId: 'not-a-real-mode' })
    const mode = unknown.find((c) => c.id === 'mode')
    expect(mode?.severity).toBe('ok')
    expect(mode?.detail).toBe('Free-form')
  })

  it('warns but does not block on empty background context', () => {
    const checks = computeReadiness({ ...base, background: '' })
    const bg = checks.find((c) => c.id === 'background')
    expect(bg?.severity).toBe('warning')
    expect(hasBlockingIssues(checks)).toBe(false)
  })
})
