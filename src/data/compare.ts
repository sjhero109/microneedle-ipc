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

export interface Discussion {
  title: string
  text: string
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length

/**
 * 배치 비교 고찰: 비교한 배치 전체를 보고 경향과 원인 후보, 권장 사항을 근거 수치와 함께 적는다.
 * 데이터가 없는 항목은 건너뛴다.
 */
export function compareDiscussion(cols: BatchColumn[]): Discussion[] {
  const out: Discussion[] = []
  const drugs = DISPENSERS.filter((d) => d.type === 'drug')
  const active = DISPENSERS.filter((d) => cols.some((c) => c.stats.get(d.id)!.n > 0))
  if (!active.length) return out

  // 1. 전반 경향: 배치별 전체 적합률의 변화
  const rates = cols
    .map((c) => {
      const s = [...c.stats.values()].filter((x) => x.n > 0)
      const n = s.reduce((a, x) => a + x.n, 0)
      return { c, n, rate: n ? (s.reduce((a, x) => a + x.pass, 0) / n) * 100 : null }
    })
    .filter((x) => x.rate !== null)
  if (rates.length >= 2) {
    const first = rates[0]
    const last = rates.at(-1)!
    const best = [...rates].sort((a, b) => b.rate! - a.rate!)[0]
    const diff = last.rate! - first.rate!
    out.push({
      title: '전반 경향',
      text: `전체 적합률은 ${first.c.batch.batchNo} ${first.rate!.toFixed(0)}% → ${last.c.batch.batchNo} ${last.rate!.toFixed(0)}%로 ${
        Math.abs(diff) < 5 ? '비슷한 수준' : diff > 0 ? `${diff.toFixed(0)}%p 개선` : `${(-diff).toFixed(0)}%p 저하`
      }입니다. 가장 좋았던 배치는 ${best.c.batch.batchNo}(${best.rate!.toFixed(0)}%, IPC ${best.n}건)입니다.`,
    })
  }

  // 2. 토출기 안정성: 배치 평균 RSD가 가장 큰·작은 토출기
  const rsd = active
    .map((d) => {
      const xs = cols.map((c) => c.stats.get(d.id)!.rsd).filter((v): v is number => v !== null)
      return { d, avg: xs.length ? mean(xs) : null, max: xs.length ? Math.max(...xs) : null }
    })
    .filter((x) => x.avg !== null)
  const drugRsd = rsd.filter((x) => x.d.type === 'drug')
  if (drugRsd.length >= 2) {
    const s = [...drugRsd].sort((a, b) => b.avg! - a.avg!)
    const worst = s[0]
    const best = s.at(-1)!
    const gap = worst.avg! / best.avg!
    out.push({
      title: '토출기 안정성',
      text: `약액부 중 흔들림이 가장 큰 토출기는 ${worst.d.id}(배치 평균 RSD ${worst.avg!.toFixed(1)}%, 최대 ${worst.max!.toFixed(1)}%), 가장 작은 토출기는 ${best.d.id}(${best.avg!.toFixed(1)}%)입니다.${
        gap >= 1.5 ? ` ${worst.d.id}가 ${gap.toFixed(1)}배 커서, 설정보다 기기(노즐·라인·압력) 쪽 점검이 우선입니다.` : ' 토출기 간 차이는 크지 않습니다.'
      }`,
    })
  }

  // 3. 토출기 간 차이: 같은 배치 안에서 약액부 평균 편차가 크게 갈리는지
  const spreads = cols
    .map((c) => {
      const m = drugs.map((d) => c.stats.get(d.id)!).filter((s) => s.n > 0)
      if (m.length < 2) return null
      const devs = m.map((s) => ({ id: s.id, v: s.meanDev! }))
      const hi = devs.reduce((a, b) => (b.v > a.v ? b : a))
      const lo = devs.reduce((a, b) => (b.v < a.v ? b : a))
      return { c, hi, lo, gap: hi.v - lo.v }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
  const wide = spreads.filter((x) => x.gap >= 5)
  if (spreads.length) {
    const w = [...spreads].sort((a, b) => b.gap - a.gap)[0]
    out.push({
      title: '토출기 간 차이',
      text: wide.length
        ? `${wide.length}개 배치에서 같은 배치 안 약액부 토출기끼리 평균 편차가 5%p 이상 벌어졌습니다(최대 ${w.c.batch.batchNo}: ${w.hi.id} ${pct(w.hi.v)} vs ${w.lo.id} ${pct(w.lo.v)}). 같은 약액인데 토출기마다 결과가 다르므로, 토출기별 압력·Pulse 기준값을 따로 관리할 필요가 있습니다.`
        : `같은 배치 안 약액부 토출기 간 평균 편차 차이는 최대 ${w.gap.toFixed(1)}%p(${w.c.batch.batchNo})로, 토출기끼리 비슷하게 맞춰졌습니다.`,
    })
  }

  // 4. 배치 안 추세: 신뢰할 만한(5건 이상) 기울기의 평균과 조정 목표 여유
  const drifts = cols.flatMap((c) => drugs.map((d) => c.trend.get(d.id)!).filter((t) => t.per10 !== null && t.pairs >= 5)).map((t) => t.per10!)
  if (drifts.length) {
    const m = mean(drifts)
    const down = drifts.filter((v) => v <= -1).length
    const up = drifts.filter((v) => v >= 1).length
    const adjust = cols[0].batch.drugAdjustPct ?? cols[0].batch.adjustPct
    const margin = adjust - 100
    let text = `약액부 배치·토출기 ${drifts.length}건 중 감소 ${down}건, 증가 ${up}건, 평균 10트레이당 ${m > 0 ? "+" : ""}${m.toFixed(1)}%p입니다.`
    if (m <= -0.5 && margin > 0) text += ` 이 속도면 조정 목표 ${adjust}%의 여유 ${margin}%는 약 ${Math.round((margin / -m) * 10)}트레이분이므로, IPC 간격을 이보다 짧게 두는 것이 안전합니다.`
    else if (Math.abs(m) < 0.5) text += ' 토출 중 뚜렷한 감소가 없어, 조정 목표를 100%에 더 가깝게 낮추는 것도 검토할 수 있습니다.'
    else if (m >= 0.5) text += ` 오히려 증가 경향이라 조정 목표 ${adjust}%가 과할 수 있습니다.`
    if (down && up) text += ' 배치마다 방향이 달라 공정 조건(압력, 약액 상태)의 영향일 가능성이 있습니다.'
    out.push({ title: '토출 중 변화', text })
  }

  // 5. 이탈 비중: 10% 초과 비율이 높은 배치
  const purple = cols
    .map((c) => {
      const s = drugs.map((d) => c.stats.get(d.id)!).filter((x) => x.n > 0)
      const n = s.reduce((a, x) => a + x.n, 0)
      return { c, n, share: n ? (s.reduce((a, x) => a + x.zones[3], 0) / n) * 100 : 0 }
    })
    .filter((x) => x.n > 0)
  const heavy = purple.filter((x) => x.share >= 20).sort((a, b) => b.share - a.share)
  if (heavy.length) {
    out.push({
      title: '이탈 구간',
      text: `${heavy.map((x) => `${x.c.batch.batchNo} ${x.share.toFixed(0)}%`).join(', ')}에서 약액부 IPC의 10% 초과 이탈 비중이 큽니다. 개시 조정 구간의 반복 측정이 포함되었는지, IPC 배수(1회 측정)·입력 단위가 맞았는지 확인하세요.`,
    })
  }

  // 6. IPC 배수 영향: 배수가 다른 배치가 섞여 있으면 RSD 비교
  const byShots = new Map<number, number[]>()
  for (const c of cols)
    for (const d of drugs) {
      const s = c.stats.get(d.id)!
      if (s.rsd !== null) byShots.set(c.batch.shots, [...(byShots.get(c.batch.shots) ?? []), s.rsd])
    }
  if (byShots.size >= 2) {
    const parts = [...byShots].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}회 ${mean(v).toFixed(1)}%`)
    out.push({ title: 'IPC 배수', text: `IPC 배수별 약액부 평균 RSD는 ${parts.join(', ')}입니다. 배수가 클수록 측정 흔들림이 줄어 판정·추천이 안정됩니다.` })
  }

  // 7. 한계
  out.push({
    title: '해석 시 유의',
    text: '압력 등 Pulse·Speed 외 설정값은 기록되지 않아, 배치·토출기 간 차이 일부는 기록되지 않은 조건 차이일 수 있습니다. IPC 수가 적은 배치의 RSD·Cpk·추세는 참고용입니다.',
  })
  return out
}
