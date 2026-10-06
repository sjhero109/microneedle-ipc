import type { Band } from './types'

export interface BandSpec {
  /** 편차 경계(%): [노랑 시작, 빨강 시작, 보라 시작] */
  limits: [number, number, number]
  /** 편차를 재는 기준점(목표 대비 %) */
  centerPct: number
}

export const DEFAULT_BANDS: BandSpec = { limits: [2, 5, 10], centerPct: 100 }

/** 목표 대비 편차(%)와 경고 구간. 첫 경계 이내는 표시 없음('ok') */
export function classify(weight: number, target: number, spec: BandSpec = DEFAULT_BANDS): { devPct: number; band: Band } {
  const devPct = (weight / target) * 100 - spec.centerPct
  const a = Math.abs(devPct)
  const [y, r, p] = spec.limits
  const band: Band = a > p ? 'purple' : a > r ? 'red' : a > y ? 'yellow' : 'ok'
  return { devPct, band }
}

/** 적합 판정: 목표 대비 편차가 [lowPct, highPct] 안인지 */
export function isPass(weight: number, target: number, lowPct: number, highPct: number): boolean {
  const dev = (weight / target - 1) * 100
  return dev >= lowPct && dev <= highPct
}
