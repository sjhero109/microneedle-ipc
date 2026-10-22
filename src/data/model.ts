import {
  buildBatchModel,
  classify,
  defaultParams,
  fitParams,
  isPass,
  median,
  recommend,
  roundTo,
  type Band,
  type BatchModel,
  type IpcPoint,
  type ModelParams,
  type Recommendation,
} from '../engine'
import type { Batch, Control, DbState, DispenserId, DoePrior, IpcRecord, MaterialType } from './types'
import { DISPENSERS, adjustOf, controlOf, doeOf, materialOf, shotsOf, stepOf, targetOf } from './types'

/** 계산식에 넣지 않는 기록: 관리자가 제외했거나 테스트로 남긴 기록 */
export const unused = (r: Pick<IpcRecord, 'excluded' | 'test'>) => r.excluded || r.test === true

export function toPoint(r: Pick<IpcRecord, 'tray' | 'pulse' | 'weight' | 'shots' | 'phase' | 'excluded' | 'test'>): IpcPoint {
  return { tray: r.tray, pulse: r.pulse, weight: r.weight, shots: r.shots, phase: r.phase, excluded: unused(r) }
}

/**
 * 같은 배치·토출기·트레이에서 IPC를 반복한 순서를 붙인 표시값.
 * 트레이 1에서 세 번 했다면 1-1, 1-2, 1-3 이 된다.
 */
export function trayLabels(records: IpcRecord[]): Map<string, string> {
  const counts = new Map<string, number>()
  const labels = new Map<string, string>()
  const ordered = [...records].sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt)
  for (const r of ordered) {
    const key = `${r.batchId}|${r.dispenserId}|${r.tray}`
    const n = (counts.get(key) ?? 0) + 1
    counts.set(key, n)
    labels.set(r.id, `${r.tray}-${n}`)
  }
  return labels
}

export function batchRecords(db: DbState, batchId: string, dispenserId: DispenserId): IpcRecord[] {
  return db.records.filter((r) => r.batchId === batchId && r.dispenserId === dispenserId).sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt)
}

function groupByBatch(records: IpcRecord[]): IpcPoint[][] {
  const groups = new Map<string, IpcRecord[]>()
  for (const r of records) {
    if (unused(r)) continue
    groups.set(r.batchId, [...(groups.get(r.batchId) ?? []), r])
  }
  return [...groups.values()].map((g) => g.sort((a, b) => a.seq - b.seq).map(toPoint))
}

export const recordControl = (r: Pick<IpcRecord, 'control'>): Control => r.control ?? 'pulse'

export interface PriorInfo {
  params: ModelParams
  /** 사전값을 어디서 구했는지 */
  basis: 'same-material' | 'same-dispenser' | 'doe' | 'default'
  batches: number
}

/** DOE 감도와 기준 압력이 모두 있어야 계산식의 출발점으로 쓴다 */
export const doeReady = (d: DoePrior): d is DoePrior & { k: number; p0: number } => d.k !== null && d.k > 0 && d.p0 !== null && d.p0 > 0

/**
 * DOE에서 구한 사전값: 기준 압력 p0에서 목표 중량이 나오고, 압력 1 MPa당 k mg씩 변한다고 보고 시작한다.
 * 잡음 크기는 기본값을 쓰고, 이번 배치 IPC가 쌓이면 수준과 감도가 고쳐진다
 */
export function doeParams(target: number, d: DoePrior & { k: number; p0: number }, shotsRef = 1): ModelParams {
  return { ...defaultParams(target, d.p0, shotsRef), b: d.k, bReliable: true }
}

/**
 * 과거 전체 데이터에서 사전값을 구한다.
 * 같은 토출기·같은 물질 → 같은 토출기·다른 물질 → (압력 방식이면) DOE → 기본값 순으로 넓힌다.
 * 과거 기록은 이 배치와 조절 방식이 같은 것만 쓴다. Pulse 기록으로 압력 감도를 구할 수는 없다
 */
export function priorFor(db: DbState, batch: Batch, dispenserId: DispenserId, firstPulse: number): PriorInfo {
  const type = DISPENSERS.find((d) => d.id === dispenserId)!.type
  const target = targetOf(batch, type)
  const control = controlOf(batch)
  const doe = control === 'pressure' ? doeOf(db, dispenserId) : null
  const fromDoe = doe && doeReady(doe) ? doeParams(target, doe, shotsOf(batch, type)) : null
  const fallback = fromDoe ?? defaultParams(target, firstPulse, shotsOf(batch, type))
  // 기록으로 감도를 믿을 만큼 구하지 못했으면 DOE 감도를 쓴다
  const withDoe = (p: ModelParams) => (fromDoe && !p.bReliable ? { ...p, b: fromDoe.b, bReliable: true } : p)
  const past = db.records.filter((r) => r.dispenserId === dispenserId && r.batchId !== batch.id && recordControl(r) === control)
  const same = groupByBatch(past.filter((r) => r.materialName === materialOf(batch, type)))
  let params = fitParams(same, fallback)
  if (params.source === 'history') return { params: withDoe(params), basis: 'same-material', batches: same.length }
  const any = groupByBatch(past)
  params = fitParams(any, fallback)
  if (params.source === 'history') return { params: withDoe(params), basis: 'same-dispenser', batches: any.length }
  return { params: fallback, basis: fromDoe ? 'doe' : 'default', batches: 0 }
}

export interface Verdict {
  devPct: number
  band: Band
  pass: boolean
}

export function evaluate(batch: Batch, type: MaterialType, weight: number): Verdict {
  const target = targetOf(batch, type)
  const { devPct, band } = classify(weight, target, { limits: batch.bands, centerPct: batch.bandCenterPct })
  return { devPct, band, pass: isPass(weight, target, batch.passLowPct, batch.passHighPct) }
}

export interface DispenserView {
  type: MaterialType
  control: Control
  /** 압력 방식에서 DOE로 정한 값 (Pulse 방식이면 null) */
  doe: DoePrior | null
  target: number
  shots: number
  records: IpcRecord[]
  prior: PriorInfo
  model: BatchModel
  /** 과거 기록도, 이번 배치 기록도 없으면 null */
  recommendation: Recommendation | null
  /** 추천의 기준이 된 Pulse: 이번 배치의 마지막 Pulse, 없으면 과거 기록의 기준 Pulse */
  pulseNow: number | null
  /** 이번 배치에서 계산에 쓴 기록 수 */
  usedCount: number
  /** 기록 id → 지금 계산식의 추정 수준(mg). 다른 조절 방식·제외·테스트 기록은 없다 */
  levels: Map<string, number>
  /** 이번 배치에서 다른 조절 방식으로 남긴 기록 수 (계산에는 쓰지 않는다) */
  otherModeCount: number
  trayInterval: number
}

/**
 * 한 토출기의 현재 상태. draft를 주면 저장 전 입력값까지 얹어 미리 계산한다.
 */
export function dispenserView(db: DbState, batch: Batch, dispenserId: DispenserId, draft?: IpcPoint): DispenserView {
  const type = DISPENSERS.find((d) => d.id === dispenserId)!.type
  const control = controlOf(batch)
  const records = batchRecords(db, batch.id, dispenserId)
  // 세팅 단계에서 방식을 바꾸면 그 방식의 기록만으로 다시 추정한다. ms와 MPa를 한 식에 섞을 수 없다
  const sameMode = records.filter((r) => recordControl(r) === control)
  const points = sameMode.map(toPoint)
  if (draft) points.push(draft)
  const used = points.filter((p) => !p.excluded)
  const prior = priorFor(db, batch, dispenserId, used[0]?.pulse ?? 1)
  const model = buildBatchModel(prior.params, points)
  const gaps: number[] = []
  for (let i = 1; i < used.length; i++) {
    const g = used[i].tray - used[i - 1].tray
    if (g > 0) gaps.push(g)
  }
  const trayInterval = gaps.length ? median(gaps) : 0
  const target = targetOf(batch, type)
  // 이번 배치 기록이 아직 없어도, 과거 기록이 있으면 그 기준으로 시작 Pulse를 추천한다
  const step = stepOf(batch)
  const doe = control === 'pressure' ? doeOf(db, dispenserId) : null
  const levels = new Map<string, number>()
  sameMode.filter((r) => !unused(r)).forEach((r, i) => {
    const s = model.steps[i]
    if (s) levels.set(r.id, s.levelAtPulse)
  })
  // 압력 방식은 DOE 기준 압력에서 시작할 수 있다
  const pulseNow = used.at(-1)?.pulse ?? (prior.basis === 'default' ? null : roundTo(prior.params.pRef, step))
  const recommendation =
    pulseNow !== null
    ? recommend({
        params: model.params,
        state: model.state,
        pulseNow,
        target,
        adjustPct: adjustOf(batch, type),
        trayInterval,
        pulseStep: step,
        pulseMin: doe?.pMin ?? undefined,
        pulseMax: doe?.pMax ?? undefined,
      })
    : null
  return {
    type,
    control,
    doe,
    target,
    shots: shotsOf(batch, type),
    records,
    prior,
    model,
    recommendation,
    trayInterval,
    pulseNow,
    usedCount: used.length,
    levels,
    otherModeCount: records.length - sameMode.length,
  }
}
