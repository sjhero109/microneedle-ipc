import { describe, expect, it } from 'vitest'
import { buildReport } from './report'
import type { Batch, IpcRecord } from './types'
import { DEFAULT_CRITERIA } from './types'

const batch = {
  ...DEFAULT_CRITERIA,
  id: 'b1',
  recipeId: 'r1',
  productName: '고용량',
  batchNo: 'T-1',
  mfgDate: '2026-10-08',
  drugName: '고용량',
  baseName: '',
  shots: 3,
  drugTarget: 6,
  baseTarget: 350,
  status: 'open',
  createdAt: 0,
  createdBy: 'u',
} as Batch

let seq = 0
function rec(pulse: number, weight: number, over: Partial<IpcRecord> = {}): IpcRecord {
  seq++
  const target = 6
  const dev = (weight / target - 1) * 100
  return {
    id: `r${seq}`,
    batchId: 'b1',
    recipeId: 'r1',
    productName: '고용량',
    batchNo: 'T-1',
    dispenserId: 'D3',
    materialType: 'drug',
    materialName: '고용량',
    seq,
    tray: 1,
    pulse,
    shots: 1,
    totalWeight: weight,
    weight,
    phase: 'startup',
    target,
    devPct: dev,
    band: Math.abs(dev) > 10 ? 'purple' : Math.abs(dev) > 5 ? 'red' : Math.abs(dev) > 2 ? 'yellow' : 'ok',
    pass: Math.abs(dev) <= 5,
    recommendedPulse: null,
    model: { level: weight, b: 1, drift: 0, gain: 0.5, source: 'history' },
    outlier: false,
    excluded: false,
    source: 'manual',
    createdAt: seq,
    createdBy: 'u',
    createdByName: '작업자',
    ...over,
  }
}

describe('배치 보고서', () => {
  seq = 0
  const records = [
    rec(5, 6.25),
    rec(5, 5.4), // 같은 Pulse에서 −13.6%
    rec(5.5, 7.2, { recommendedPulse: 5.2 }),
    rec(4.8, 5.0, { recommendedPulse: 5.6 }), // 직전 추천 5.6과 다르게 4.8 사용
    rec(5.0, 6.06, { shots: 3, totalWeight: 18.18 }),
    rec(5.0, 6.12, { shots: 3, totalWeight: 18.36 }),
    rec(9, 1, { test: true }),
  ]
  const r = buildReport(batch, records, 0)
  const d3 = r.dispensers.find((d) => d.id === 'D3')!

  it('통계는 테스트·제외 기록을 빼고 1회분으로 구한다', () => {
    expect(d3.n).toBe(6)
    expect(d3.min).toBeCloseTo(5.0, 6)
    expect(d3.max).toBeCloseTo(7.2, 6)
    expect(d3.pass).toBe(3)
    expect(d3.firstPass).toBe(1)
    expect(d3.adjustments).toBe(3)
    expect(d3.zones.reduce((a, b) => a + b, 0)).toBe(6)
    expect(d3.cpk).not.toBeNull()
  })

  it('반복성·운영 변경·추천 이탈을 고찰로 뽑는다', () => {
    const titles = r.insights.map((i) => i.title)
    expect(titles).toContain('반복성')
    expect(titles).toContain('운영 변경')
    expect(titles.length).toBeLessThanOrEqual(4)
    expect(r.insights.find((i) => i.title === '반복성')!.text).toContain('6.250 → 5.400 mg (-13.6%)')
  })

  it('결론에 최종 판정을 적는다', () => {
    expect(r.conclusion).toContain('D3 최종 IPC 적합')
    expect(r.totals.n).toBe(6)
    expect(r.counts.tests).toBe(1)
  })
})
