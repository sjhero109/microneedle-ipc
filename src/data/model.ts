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
import type { Batch, DbState, DispenserId, IpcRecord, MaterialType } from './types'
import { DISPENSERS, materialOf, shotsOf, targetOf } from './types'

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
  /** 과거 기록도, 이번 배치 기록도 없으면 null */
  recommendation: Recommendation | null
  /** 추천의 기준이 된 Pulse: 이번 배치의 마지막 Pulse, 없으면 과거 기록의 기준 Pulse */
  pulseNow: number | null
  /** 이번 배치에서 계산에 쓴 기록 수 */
  usedCount: number
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
  // 이번 배치 기록이 아직 없어도, 과거 기록이 있으면 그 기준으로 시작 Pulse를 추천한다
  const pulseNow = used.at(-1)?.pulse ?? (prior.basis === 'default' ? null : roundTo(prior.params.pRef, batch.pulseStep))
  const recommendation =
    pulseNow !== null
    ? recommend({
        params: model.params,
        state: model.state,
        pulseNow,
        target,
        adjustPct: batch.adjustPct,
        trayInterval,
        pulseStep: batch.pulseStep,
      })
    : null
  return { type, target, shots: shotsOf(batch, type), records, prior, model, recommendation, trayInterval, pulseNow, usedCount: used.length }
}
