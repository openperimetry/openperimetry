import { describe, it, expect } from 'vitest'
import { classifyPageLeave, pageLeaveMeta, type PageLeaveInfo } from './testLifecycle'

describe('classifyPageLeave', () => {
  it('flags bfcache when the page is persisted', () => {
    expect(classifyPageLeave({ persisted: true }).bfcache).toBe(true)
  })

  it('does not flag bfcache for a real teardown', () => {
    expect(classifyPageLeave({ persisted: false }).bfcache).toBe(false)
  })

  it('treats a missing event as a non-bfcache leave', () => {
    expect(classifyPageLeave(null).bfcache).toBe(false)
    expect(classifyPageLeave(undefined).bfcache).toBe(false)
  })

  it('always returns visibilityState and navType strings', () => {
    const info = classifyPageLeave({ persisted: false })
    expect(typeof info.visibilityState).toBe('string')
    expect(typeof info.navType).toBe('string')
  })
})

describe('pageLeaveMeta', () => {
  it('summarises bfcache leaves as leaveKind=bfcache so they can be excluded', () => {
    const info: PageLeaveInfo = { bfcache: true, visibilityState: 'hidden', navType: 'navigate' }
    expect(pageLeaveMeta(info).leaveKind).toBe('bfcache')
    expect(pageLeaveMeta(info).bfcache).toBe('true')
  })

  it('classifies a hidden terminal leave as a backgrounded abandonment', () => {
    const info: PageLeaveInfo = { bfcache: false, visibilityState: 'hidden', navType: 'navigate' }
    expect(pageLeaveMeta(info).leaveKind).toBe('hidden')
  })

  it('classifies a visible terminal leave as a deliberate close/navigate', () => {
    const info: PageLeaveInfo = { bfcache: false, visibilityState: 'visible', navType: 'reload' }
    expect(pageLeaveMeta(info).leaveKind).toBe('terminal')
    expect(pageLeaveMeta(info).navType).toBe('reload')
  })
})
