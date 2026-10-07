import { runFilter } from './filter'
import { driftFromPairs } from './fit'
import type { EngineOptions, FilterState, FilterStep, IpcPoint, ModelParams } from './types'
import { DEFAULT_OPTIONS } from './types'

/** 배치 안 기울기 추정에서 사전값이 갖는 무게(IPC 쌍 수) */
const DRIFT_PRIOR_PAIRS = 4
/** 배치 안 기울기를 쓰기 위해 필요한 최소 IPC 쌍 수 */
const DRIFT_MIN_PAIRS = 6
/** 한 배치 안에서 감도가 사전값에서 벗어날 수 있는 최대 배수 */
const B_MAX_CHANGE = 5

/**
 * 배치 안에서 Pulse를 바꾼 전후의 중량 변화로 감도를 조금씩 고친다.
 * 사전값의 불확실성(신뢰 가능 30%, 아니면 100%)과 관측 잡음(2R)으로 가중한다.
 */
function updateSensitivity(prior: ModelParams, points: IpcPoint[]): number {
  const sd = (prior.bReliable ? 0.3 : 1) * prior.b
  let num = prior.b / sd ** 2
  let den = 1 / sd ** 2
  for (let i = 1; i < points.length; i++) {
    const dp = points[i].pulse - points[i - 1].pulse
    if (Math.abs(dp) < 1e-9) continue
    const dt = Math.max(0, points[i].tray - points[i - 1].tray)
    const dw = points[i].weight - points[i - 1].weight - prior.drift * dt
    num += (dw * dp) / (2 * prior.R)
    den += (dp * dp) / (2 * prior.R)
  }
  return Math.min(Math.max(num / den, prior.b / B_MAX_CHANGE), prior.b * B_MAX_CHANGE)
}

export interface BatchModel {
  params: ModelParams
  steps: FilterStep[]
  state: FilterState
}

/**
 * 과거 전체에서 구한 사전값에 현재 배치의 IPC를 얹는다.
 * 새 배치는 수준의 불확실성을 크게 잡고 시작하므로 처음 몇 건이 추정을 이끈다.
 */
export function buildBatchModel(
  prior: ModelParams,
  points: IpcPoint[],
  opts: EngineOptions = DEFAULT_OPTIONS,
): BatchModel {
  const used = points.filter((p) => !p.excluded)
  // 배치 안의 감소 경향도 통계적으로 확인될 때만 쓴다. 잡음을 기울기로 읽으면 추정 수준이 한쪽으로 쏠린다
  const raw = driftFromPairs([used])
  const confirmed = raw.pairs >= DRIFT_MIN_PAIRS && Math.abs(raw.drift) > 1.96 * raw.se
  const params: ModelParams = {
    ...prior,
    b: updateSensitivity(prior, used),
    drift: confirmed ? driftFromPairs([used], prior.drift, DRIFT_PRIOR_PAIRS).drift : prior.drift,
  }
  return { params, ...runFilter(params, used, opts) }
}
