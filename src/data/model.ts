import {
  buildBatchModel,
  classify,
  defaultParams,
  fitParams,
  isPass,
  median,
  recommend,
  type Band,
  type BatchModel,
  type IpcPoint,
  type ModelParams,
  type Recommendation,
} from '../engine'
import type { Batch, DbState, DispenserId, IpcRecord, MaterialType } from './types'
import { DISPENSERS, materialOf, shotsOf, targetOf } from './types'

export function toPoint(r: Pick<IpcRecord, 'tray' | 'pulse' | 'weight' | 'shots' | 'phase' | 'excluded'>): IpcPoint {
  return { tray: r.tray, pulse: r.pulse, weight: r.weight, shots: r.shots, phase: r.phase, excluded: r.excluded }
}

export function batchRecords(db: DbState, batchId: string, dispenserId: DispenserId): IpcRecord[] {
  return db.records.filter((r) => r.batchId === batchId && r.dispenserId === dispenserId).sort((a, b) => a.seq - b.seq)
}

function groupByBatch(records: IpcRecord[]): IpcPoint[][] {
  const groups = new Map<string, IpcRecord[]>()
  for (const r of records) {
    if (r.excluded) continue
    groups.set(r.batchId, [...(groups.get(r.batchId) ?? []), r])
  }
  return [...groups.values()].map((g) => g.sort((a, b) => a.seq - b.seq).map(toPoint))
}

export interface PriorInfo {
  params: ModelParams
  /** 사전값을 어디서 구했는지 */
  basis: 'same-material' | 'same-dispenser' | 'default'
  batches: number
}

/**
 * 과거 전체 데이터에서 사전값을 구한다.
 * 같은 토출기·같은 물질 → 같은 토출기·다른 물질 → 기본값 순으로 넓힌다.
 */
export function priorFor(db: DbState, batch: Batch, dispenserId: DispenserId, firstPulse: number): PriorInfo {
  const type = DISPENSERS.find((d) => d.id === dispenserId)!.type
  const target = targetOf(batch, type)
  const fallback = defaultParams(target, firstPulse, shotsOf(batch, type))
  const past = db.records.filter((r) => r.dispenserId === dispenserId && r.batchId !== batch.id)
  const same = groupByBatch(past.filter((r) => r.materialName === materialOf(batch, type)))
  let params = fitParams(same, fallback)
  if (params.source === 'history') return { params, basis: 'same-material', batches: same.length }
  const any = groupByBatch(past)
  params = fitParams(any, fallback)
  if (params.source === 'history') return { params, basis: 'same-dispenser', batches: any.length }
  return { params: fallback, basis: 'default', batches: 0 }
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
  target: number
  shots: number
  records: IpcRecord[]
  prior: PriorInfo
  model: BatchModel
  /** 기록이 하나도 없으면 null */
  recommendation: Recommendation | null
  trayInterval: number
}

/**
 * 한 토출기의 현재 상태. draft를 주면 저장 전 입력값까지 얹어 미리 계산한다.
 */
export function dispenserView(db: DbState, batch: Batch, dispenserId: DispenserId, draft?: IpcPoint): DispenserView {
  const type = DISPENSERS.find((d) => d.id === dispenserId)!.type
  const records = batchRecords(db, batch.id, dispenserId)
  const points = records.map(toPoint)
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
  const last = used[used.length - 1]
  const recommendation = last
    ? recommend({
        params: model.params,
        state: model.state,
        pulseNow: last.pulse,
        target,
        adjustPct: batch.adjustPct,
        trayInterval,
        pulseStep: batch.pulseStep,
      })
    : null
  return { type, target, shots: shotsOf(batch, type), records, prior, model, recommendation, trayInterval }
}
