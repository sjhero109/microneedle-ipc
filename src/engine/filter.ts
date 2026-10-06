import type { EngineOptions, FilterState, FilterStep, IpcPoint, ModelParams } from './types'
import { DEFAULT_OPTIONS } from './types'

export function initialState(params: ModelParams, opts: EngineOptions = DEFAULT_OPTIONS): FilterState {
  return { L: params.L0, P: params.R * opts.p0Factor, tray: null }
}

/** 다음 IPC 전까지 수준이 어떻게 움직일지 예측한다 */
export function predictState(params: ModelParams, s: FilterState, tray: number): FilterState {
  const dTray = s.tray === null ? 0 : Math.max(0, tray - s.tray)
  return { L: s.L + params.drift * dTray, P: s.P + params.Q, tray }
}

export function weightAt(params: ModelParams, L: number, pulse: number): number {
  return L + params.b * (pulse - params.pRef)
}

/** IPC 1건으로 수준을 갱신한다. 이상치 후보는 빼지 않고 반영 비율만 낮춘다 */
export function step(
  params: ModelParams,
  prev: FilterState,
  point: IpcPoint,
  opts: EngineOptions = DEFAULT_OPTIONS,
): FilterStep {
  const pred = predictState(params, prev, point.tray)
  const predicted = weightAt(params, pred.L, point.pulse)
  const innovation = point.weight - predicted
  const S = pred.P + params.R
  const limit = opts.outlierSigma * Math.sqrt(S)
  const outlier = Math.abs(innovation) > limit
  const R = outlier ? params.R * (Math.abs(innovation) / limit) ** 2 : params.R
  const gain = pred.P / (pred.P + R)
  const state: FilterState = { L: pred.L + gain * innovation, P: (1 - gain) * pred.P, tray: point.tray }
  return { point, predicted, innovation, gain, outlier, levelAtPulse: weightAt(params, state.L, point.pulse), state }
}

export function runFilter(
  params: ModelParams,
  points: IpcPoint[],
  opts: EngineOptions = DEFAULT_OPTIONS,
): { steps: FilterStep[]; state: FilterState } {
  let state = initialState(params, opts)
  const steps: FilterStep[] = []
  for (const point of points) {
    if (point.excluded) continue
    const r = step(params, state, point, opts)
    steps.push(r)
    state = r.state
  }
  return { steps, state }
}
