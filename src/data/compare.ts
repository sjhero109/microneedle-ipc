import { dispenserStats, type DispenserStats } from './report'
import type { Batch, DispenserId, IpcRecord } from './types'
import { DISPENSERS } from './types'

/**
 * 배치 안 추세: 트레이가 진행될 때 편차가 어떻게 변하는지.
 * IPC마다 Pulse를 조정하므로 편차 = a + c·트레이 + k·Pulse 로 함께 맞춰 Pulse 영향을 빼고 c만 본다.
 * IPC 배수가 섞이면 같은 배수의 기록만 쓴다(가장 많은 배수).
 */
export interface InBatchTrend {
  /** 10트레이당 편차 변화(%p). 계산할 수 없으면 null */
  per10: number | null
  /** 쓴 IPC 수 */
  pairs: number
}

export interface BatchColumn {
  batch: Batch
  date: string
  stats: Map<DispenserId, DispenserStats>
  trend: Map<DispenserId, InBatchTrend>
}

export interface CompareFinding {
  id: DispenserId
  text: string
}

const devOf = (r: IpcRecord) => (r.weight / r.target - 1) * 100
const ymd = (t: number) => new Date(t).toLocaleDateString('sv-SE')

function solve3(m: number[][], v: number[]): number[] | null {
  // 3x3 연립방정식 (가우스 소거)
  const A = m.map((r, i) => [...r, v[i]])
  for (let c = 0; c < 3; c++) {
    let p = c
    for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r
    if (Math.abs(A[p][c]) < 1e-9) return null
    ;[A[c], A[p]] = [A[p], A[c]]
    for (let r = 0; r < 3; r++) {
      if (r === c) continue
      const f = A[r][c] / A[c][c]
      for (let k = c; k < 4; k++) A[r][k] -= f * A[c][k]
    }
  }
  return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]]
}

export function inBatchTrend(used: IpcRecord[]): InBatchTrend {
  // 생산 전 세팅(트레이 0)은 빼고, 가장 많이 쓴 IPC 배수의 기록만 쓴다
  const rows = used.filter((r) => r.tray > 0)
  const count = new Map<number, number>()
  for (const r of rows) count.set(r.shots, (count.get(r.shots) ?? 0) + 1)
  const shots = [...count].sort((a, b) => b[1] - a[1])[0]?.[0]
  const pts = rows.filter((r) => r.shots === shots)
  const trays = new Set(pts.map((r) => r.tray))
  if (pts.length < 4 || trays.size < 3) return { per10: null, pairs: pts.length }
  // 정규방정식: [1, tray, pulse]
  const X = pts.map((r) => [1, r.tray, r.pulse])
  const y = pts.map(devOf)
  const XtX = [0, 1, 2].map((i) => [0, 1, 2].map((j) => X.reduce((s, x) => s + x[i] * x[j], 0)))
  const Xty = [0, 1, 2].map((i) => X.reduce((s, x, n) => s + x[i] * y[n], 0))
  let sol = solve3(XtX, Xty)
  if (!sol) {
    // Pulse가 모두 같으면 트레이만으로 맞춘다
    const mt = pts.reduce((s, r) => s + r.tray, 0) / pts.length
    const my = y.reduce((s, v) => s + v, 0) / y.length
    const sxx = pts.reduce((s, r) => s + (r.tray - mt) ** 2, 0)
    const sxy = pts.reduce((s, r, n) => s + (r.tray - mt) * (y[n] - my), 0)
    sol = sxx ? [0, sxy / sxx, 0] : null
  }
  return { per10: sol ? sol[1] * 10 : null, pairs: pts.length }
}

/** 고른 배치를 제조일자 순으로 놓고 토출기별 지표를 구한다 */
export function buildComparison(batches: Batch[], records: IpcRecord[]): BatchColumn[] {
  return [...batches]
    .map((b) => ({ b, date: b.mfgDate || ymd(b.createdAt) }))
    .sort((x, y) => x.date.localeCompare(y.date) || x.b.createdAt - y.b.createdAt)
    .map(({ b, date }) => {
      const mine = records.filter((r) => r.batchId === b.id)
      const stats = new Map<DispenserId, DispenserStats>()
      const trend = new Map<DispenserId, InBatchTrend>()
      for (const d of DISPENSERS) {
        const s = dispenserStats(b, mine, d.id)
        stats.set(d.id, s)
        trend.set(d.id, inBatchTrend(s.used))
      }
      return { batch: b, date, stats, trend }
    })
}

const pct = (v: number, d = 1) => `${v > 0 ? '+' : ''}${v.toFixed(d)}%`

/** 토출기별로 배치 간 차이를 한두 문장으로 요약한다 */
export function compareFindings(cols: BatchColumn[]): CompareFinding[] {
  const out: CompareFinding[] = []
  for (const d of DISPENSERS) {
    const rows = cols.map((c) => ({ c, s: c.stats.get(d.id)!, t: c.trend.get(d.id)! })).filter((x) => x.s.n > 0)
    if (rows.length === 0) continue
    const parts: string[] = []
    const rate = (s: DispenserStats) => s.pass / s.n
    const best = [...rows].sort((a, b) => rate(b.s) - rate(a.s) || Math.abs(a.s.meanDev!) - Math.abs(b.s.meanDev!))[0]
    parts.push(`적합률 최고 ${best.c.batch.batchNo} (${Math.round(rate(best.s) * 100)}%, 평균 ${pct(best.s.meanDev!)})`)
    if (rows.length >= 2) {
      const withRsd = rows.filter((x) => x.s.rsd !== null)
      if (withRsd.length >= 2) {
        const first = withRsd[0].s.rsd!
        const last = withRsd.at(-1)!.s.rsd!
        const diff = last - first
        if (Math.abs(diff) >= 1) parts.push(`흔들림(RSD) ${first.toFixed(1)}% → ${last.toFixed(1)}% ${diff < 0 ? '개선' : '악화'}`)
        else parts.push(`흔들림(RSD) ${first.toFixed(1)}% → ${last.toFixed(1)}% 비슷`)
      }
      const means = rows.map((x) => x.s.meanDev!)
      const spread = Math.max(...means) - Math.min(...means)
      if (spread >= 5) parts.push(`배치 간 평균 편차 차이 ${spread.toFixed(1)}%p`)
    }
    const drifts = rows.filter((x) => x.t.per10 !== null && x.t.pairs >= 5)
    if (drifts.length) {
      const down = drifts.filter((x) => x.t.per10! <= -1).length
      const up = drifts.filter((x) => x.t.per10! >= 1).length
      if (down && !up) parts.push(`토출 중 감소 경향 ${down}/${drifts.length}개 배치`)
      else if (up && !down) parts.push(`토출 중 증가 경향 ${up}/${drifts.length}개 배치`)
      else if (!up && !down) parts.push('토출 중 뚜렷한 증감 없음')
      else parts.push(`토출 중 증감 방향이 배치마다 다름 (감소 ${down}, 증가 ${up})`)
    }
    out.push({ id: d.id, text: `${parts.join(' · ')}.` })
  }
  return out
}
