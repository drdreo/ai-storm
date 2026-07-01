import { describe, expect, it } from 'vitest'
import { sessionIndicator } from './session-status'

describe('sessionIndicator', () => {
  it('reports offline as an error regardless of workspace status', () => {
    expect(sessionIndicator('closed', false, 'idle').tone).toBe('error')
    expect(sessionIndicator('closed', true, 'streaming')).toMatchObject({
      tone: 'error',
      label: 'backend offline',
    })
  })

  it('reports connecting as pending', () => {
    expect(sessionIndicator('connecting', false, 'idle')).toMatchObject({
      tone: 'pending',
      label: 'connecting',
    })
  })

  it('reports ready when connected but detached', () => {
    expect(sessionIndicator('open', false, 'idle')).toMatchObject({
      tone: 'ok',
      label: 'ready',
    })
  })

  it('reports the live session state when attached', () => {
    expect(sessionIndicator('open', true, 'active')).toMatchObject({
      tone: 'ok',
      label: 'session live',
    })
    expect(sessionIndicator('open', true, 'streaming')).toMatchObject({
      tone: 'ok',
      label: 'streaming',
    })
    expect(sessionIndicator('open', true, 'error')).toMatchObject({
      tone: 'error',
      label: 'session error',
    })
  })
})
