import { weightAt } from './filter'
import { roundTo } from './stats'
import type { FilterState, ModelParams } from './types'

export interface RecommendInput {
  params: ModelParams
  state: FilterState
  pulseNow: number
  target: number
  /** 조정 기준(%). 토출 중 감소분을 미리 얹어 둔다 */
  adjustPct: number
  /** 다음 IPC까지의 트레이 수 */
  trayInterval: number
  pulseStep: number
  pulseMin?: number
  pulseMax?: number
}

export interface Recommendation {
  targetWeight: number
  /** 현재 Pulse를 유지할 때 지금 나올 것으로 추정되는 중량 */
  expectedNow: number
  /** 현재 Pulse를 유지할 때 다음 IPC에서 예상되는 중량 */
  expectedNext: number
  pulse: number
  delta: number
  /** 추천 Pulse 적용 직후 예상 중량 */
  expectedAfter: number
}

/**
 * 조정 직후 중량이 목표×adjustPct 가 되도록 Pulse를 계산한다.
 * 조정 후에는 곧바로 IPC를 다시 하므로, 감소분은 adjustPct 여유로만 반영한다.
 */
export function recommend(i: RecommendInput): Recommendation {
  const { params, state } = i
  const targetWeight = (i.target * i.adjustPct) / 100
  const expectedNow = weightAt(params, state.L, i.pulseNow)
  const expectedNext = expectedNow + params.drift * i.trayInterval
  let pulse = i.pulseNow + (targetWeight - expectedNow) / params.b
  if (i.pulseMin !== undefined) pulse = Math.max(pulse, i.pulseMin)
  if (i.pulseMax !== undefined) pulse = Math.min(pulse, i.pulseMax)
  pulse = Math.max(roundTo(pulse, i.pulseStep), i.pulseStep)
  return {
    targetWeight,
    expectedNow,
    expectedNext,
    pulse,
    delta: roundTo(pulse - i.pulseNow, i.pulseStep),
    expectedAfter: weightAt(params, state.L, pulse),
  }
}
