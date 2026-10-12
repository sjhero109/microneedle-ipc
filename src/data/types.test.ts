import { describe, expect, it } from 'vitest'
import { baseTargetOf, contentOf, targetForContent, type Batch } from './types'

describe('함량에 따른 약액부 목표 중량', () => {
  it('함량 100%면 기준 중량 그대로다', () => {
    expect(targetForContent(6.11, 100)).toBe(6.11)
  })

  it('함량이 낮으면 더 많이, 높으면 덜 토출한다', () => {
    expect(targetForContent(6.11, 95)).toBeCloseTo(6.4316, 4)
    expect(targetForContent(6.11, 105)).toBeCloseTo(5.819, 4)
    // 환산한 중량에 들어 있는 유효성분은 항상 기준과 같다
    expect((targetForContent(6.11, 95) * 95) / 100).toBeCloseTo(6.11, 3)
  })

  it('함량 값이 없는 예전 배치는 레시피 기준 중량과 저장된 목표에서 함량을 구한다', () => {
    const old = { drugTarget: 7.5 } as Batch
    expect(baseTargetOf(old, { drugTarget: 6.11 })).toBe(6.11)
    expect(contentOf(old, { drugTarget: 6.11 })).toBeCloseTo(81.47, 2)
    expect(contentOf({ drugTarget: 6.11 } as Batch, { drugTarget: 6.11 })).toBe(100)
  })
})
