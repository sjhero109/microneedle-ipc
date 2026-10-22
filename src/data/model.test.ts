import { describe, expect, it } from 'vitest'
import { dispenserView } from './model'
import type { Batch, DbState, DoeSettings, IpcRecord } from './types'
import { DEFAULT_CRITERIA } from './types'

const batch = {
  ...DEFAULT_CRITERIA,
  id: 'b1',
  recipeId: 'r1',
  productName: '고용량',
  batchNo: 'T-1',
  mfgDate: '2026-10-22',
  drugName: '고용량',
  baseName: '',
  shots: 1,
  drugTarget: 5.864,
  baseTarget: 350,
  adjustPct: 103,
  status: 'open',
  createdAt: 0,
  createdBy: 'u',
} as Batch

const doe: DoeSettings = {
  id: 'doe',
  dispensers: { D1: { k: 70, p0: 0.36, pMin: 0.32, pMax: 0.39, settle: 1 } },
  updatedAt: 0,
  updatedBy: 'u',
  updatedByName: '관리자',
}

let seq = 0
function rec(pulse: number, weight: number, over: Partial<IpcRecord> = {}): IpcRecord {
  seq++
  return {
    id: `r${seq}`,
    batchId: 'b1',
    recipeId: 'r1',
    productName: '고용량',
    batchNo: 'T-1',
    dispenserId: 'D1',
    materialType: 'drug',
    materialName: '고용량',
    seq,
    tray: seq,
    pulse,
    control: 'pressure',
    shots: 1,
    totalWeight: weight,
    weight,
    phase: 'routine',
    target: 5.864,
    devPct: (weight / 5.864 - 1) * 100,
    band: 'ok',
    pass: true,
    recommendedPulse: null,
    model: null,
    outlier: false,
    excluded: false,
    source: 'manual',
    createdAt: seq,
    createdBy: 'u',
    createdByName: '작업자',
    ...over,
  }
}

const db = (records: IpcRecord[], withDoe = true): DbState => ({
  settings: withDoe ? [doe] : [],
  recipes: [],
  batches: [batch],
  records,
  corrections: [],
  audit: [],
  users: [],
  guards: [],
})

describe('압력 방식 추천', () => {
  it('압력 기록이 없으면 DOE 기준 압력에서 시작하고 0.001 MPa로 반올림한다', () => {
    const v = dispenserView(db([]), batch, 'D1')
    expect(v.control).toBe('pressure')
    expect(v.prior.basis).toBe('doe')
    expect(v.pulseNow).toBe(0.36)
    // 103% = 6.040 mg, 감도 70 mg/MPa → 0.36 + 0.176/70 = 0.3625 → 0.363
    expect(v.recommendation?.pulse).toBe(0.363)
  })

  it('이번 배치 첫 IPC로 수준을 잡고 압력을 고친다', () => {
    const v = dispenserView(db([rec(0.36, 5.5)]), batch, 'D1')
    // 0.36 + (6.040 − 5.5)/70 ≈ 0.3677 → 0.368
    expect(v.recommendation?.pulse).toBe(0.368)
    expect(v.recommendation?.limited).toBeUndefined()
  })

  it('계산값이 DOE 상한을 넘으면 상한으로 자르고 알린다', () => {
    const v = dispenserView(db([rec(0.36, 3.5)]), batch, 'D1')
    expect(v.recommendation?.pulse).toBe(0.39)
    expect(v.recommendation?.limited).toBe('max')
  })

  it('예전 Pulse 기록은 압력 사전값에 쓰지 않는다', () => {
    const old = Array.from({ length: 12 }, (_, i) => rec(4 + (i % 3) * 0.2, 5.9 + (i % 3) * 0.2, { batchId: 'old', control: undefined }))
    const v = dispenserView(db(old), batch, 'D1')
    expect(v.prior.basis).toBe('doe')
  })

  it('DOE 값이 없으면 기록이 생길 때까지 추천하지 않는다', () => {
    const v = dispenserView(db([], false), batch, 'D1')
    expect(v.prior.basis).toBe('default')
    expect(v.recommendation).toBeNull()
  })

  it('Pulse 방식 배치는 DOE 값을 쓰지 않는다', () => {
    const pulseBatch = { ...batch, control: 'pulse' } as Batch
    const v = dispenserView({ ...db([]), batches: [pulseBatch] }, pulseBatch, 'D1')
    expect(v.control).toBe('pulse')
    expect(v.doe).toBeNull()
    expect(v.prior.basis).toBe('default')
  })
})
