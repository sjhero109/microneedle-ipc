import { describe, expect, it } from 'vitest'
import { buildComparison, compareDiscussion, compareFindings, inBatchTrend } from './compare'
import type { Batch, IpcRecord } from './types'
import { DEFAULT_CRITERIA } from './types'

const batch = (id: string, date: string) =>
  ({ ...DEFAULT_CRITERIA, id, recipeId: 'r', productName: '고용량', batchNo: id, mfgDate: date, drugName: '', baseName: '', shots: 3, drugTarget: 6, baseTarget: 350, status: 'closed', createdAt: 0, createdBy: 'u' }) as Batch

let n = 0
const rec = (batchId: string, tray: number, pulse: number, weight: number): IpcRecord => {
  n++
  const dev = (weight / 6 - 1) * 100
  return {
    id: `r${n}`, batchId, recipeId: 'r', productName: '고용량', batchNo: batchId, dispenserId: 'D1', materialType: 'drug', materialName: '', seq: n, tray, pulse,
    shots: 3, totalWeight: weight * 3, weight, phase: 'routine', target: 6, devPct: dev, band: 'ok', pass: Math.abs(dev) <= 5, recommendedPulse: null, model: null,
    outlier: false, excluded: false, source: 'manual', createdAt: n, createdBy: 'u', createdByName: '작업자',
  }
}

describe('배치 비교', () => {
  it('Pulse 영향을 빼고 10트레이당 변화를 구한다', () => {
    // 트레이 10마다 1%씩 감소하고, 마지막 IPC는 Pulse를 올려 중량이 늘었다
    const t = inBatchTrend([rec('A', 1, 5, 6.18), rec('A', 11, 5, 6.12), rec('A', 21, 5, 6.06), rec('A', 31, 5.5, 6.6)])
    expect(t.pairs).toBe(4)
    expect(t.per10).toBeCloseTo(-1, 6)
  })

  it('제조일자 순으로 놓고 토출기별 차이를 요약한다', () => {
    const records = [rec('B', 1, 5, 6.3), rec('B', 11, 5, 6.0), rec('A', 1, 5, 6.0), rec('A', 11, 5, 6.06)]
    const cols = buildComparison([batch('B', '2026-10-02'), batch('A', '2026-10-01')], records)
    expect(cols.map((c) => c.batch.id)).toEqual(['A', 'B'])
    const f = compareFindings(cols)
    expect(f[0].id).toBe('D1')
    expect(f[0].text).toContain('적합률 최고 A')
  })

  it('비교 결과로 고찰을 쓴다', () => {
    const records = [rec('A', 1, 5, 6.6), rec('A', 11, 5.1, 5.4), rec('B', 1, 5, 6.05), rec('B', 11, 5, 6.1)]
    const d = compareDiscussion(buildComparison([batch('A', '2026-10-01'), batch('B', '2026-10-02')], records))
    const titles = d.map((x) => x.title)
    expect(titles).toContain('전반 경향')
    expect(titles.at(-1)).toBe('해석 시 유의')
    expect(d[0].text).toContain('0% → B 100%')
  })
})
