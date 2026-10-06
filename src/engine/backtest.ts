import { predictState, runFilter, weightAt } from './filter'
import { defaultParams, fitParams } from './fit'
import { median } from './stats'
import type { EngineOptions, IpcPoint } from './types'
import { DEFAULT_OPTIONS } from './types'

export interface BacktestRow {
  model: string
  mae: number
  rmse: number
  medianAe: number
  n: number
}

/**
 * 걸어가며 검증: 각 회차에서 그 이전 기록만으로 다음 중량을 예측한다.
 * 비교 대상은 직전값, 3회 이동평균, 비례 모델(중량 = k × Pulse)이다.
 */
export function walkForward(
  points: IpcPoint[],
  target: number,
  minTrain = 10,
  opts: EngineOptions = DEFAULT_OPTIONS,
): BacktestRow[] {
  const pts = points.filter((p) => !p.excluded)
  const errs: Record<string, number[]> = { 칼만: [], 직전값: [], '이동평균(3)': [], 비례: [] }
  for (let t = minTrain; t < pts.length; t++) {
    const past = pts.slice(0, t)
    const next = pts[t]
    const params = fitParams([past], defaultParams(target, past[0].pulse), opts)
    const start = { ...params, L0: past[0].weight - params.b * (past[0].pulse - params.pRef) }
    const { state } = runFilter(start, past, opts)
    const kalman = weightAt(start, predictState(start, state, next.tray).L, next.pulse)
    const last3 = past.slice(-3).map((p) => p.weight)
    const k = median(past.map((p) => p.weight / p.pulse))
    errs['칼만'].push(next.weight - kalman)
    errs['직전값'].push(next.weight - past[t - 1].weight)
    errs['이동평균(3)'].push(next.weight - last3.reduce((s, x) => s + x, 0) / last3.length)
    errs['비례'].push(next.weight - k * next.pulse)
  }
  return Object.entries(errs).map(([model, e]) => ({
    model,
    mae: e.reduce((s, x) => s + Math.abs(x), 0) / e.length,
    rmse: Math.sqrt(e.reduce((s, x) => s + x * x, 0) / e.length),
    medianAe: median(e.map(Math.abs)),
    n: e.length,
  }))
}
