import type { Batch, DispenserId, IpcRecord } from './types'
import { DISPENSERS, controlOf, ctrlName, targetOf } from './types'
import { trayLabels, unused } from './model'

/** 편차 구간: 2/5/10% 경계 (배치 기준값) */
export type Zone = 0 | 1 | 2 | 3

export interface DispenserStats {
  id: DispenserId
  type: 'drug' | 'base'
  param: string
  target: number
  /** 계산에 쓴 기록 (테스트·제외 빼고), 순서대로 */
  used: IpcRecord[]
  /** 테스트·제외 포함 전체 */
  all: IpcRecord[]
  n: number
  /** 1회분 중량(mg) */
  mean: number | null
  sd: number | null
  rsd: number | null
  min: number | null
  max: number | null
  /** 목표 대비 편차(%) */
  meanDev: number | null
  minDev: number | null
  maxDev: number | null
  pass: number
  zones: [number, number, number, number]
  /** 몇 번째 IPC에서 처음 적합했는지 (1부터). 없으면 null */
  firstPass: number | null
  /** Pulse·Speed를 바꾼 횟수 */
  adjustments: number
  firstParam: number | null
  lastParam: number | null
  lastPass: boolean | null
  /** 편차(%) 기준 공정능력지수. 2건 이상이고 흔들림이 있을 때만 */
  cpk: number | null
}

export interface Insight {
  title: string
  text: string
  /** 클수록 먼저 보인다 */
  weight: number
}

export interface BatchReport {
  dispensers: DispenserStats[]
  totals: {
    n: number
    pass: number
    passRate: number | null
    meanDev: number | null
    worstDev: number | null
    longestFirstPass: { id: DispenserId; n: number } | null
    adjustments: number
  }
  conclusion: string
  insights: Insight[]
  labels: Map<string, string>
  counts: { corrections: number; excluded: number; tests: number }
  authors: string[]
}

const devOf = (r: IpcRecord) => (r.weight / r.target - 1) * 100

function mean(xs: number[]) {
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

function sd(xs: number[]) {
  if (xs.length < 2) return null
  const m = mean(xs)
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b)
  const i = Math.floor(s.length / 2)
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2
}

const pct = (v: number, d = 1) => `${v > 0 ? '+' : ''}${v.toFixed(d)}%`

export function dispenserStats(batch: Batch, records: IpcRecord[], id: DispenserId): DispenserStats {
  const d = DISPENSERS.find((x) => x.id === id)!
  const all = records.filter((r) => r.dispenserId === id).sort((a, b) => a.seq - b.seq)
  const used = all.filter((r) => !unused(r))
  const w = used.map((r) => r.weight)
  const dev = used.map(devOf)
  const [y, r5, p] = batch.bands
  const zones: [number, number, number, number] = [0, 0, 0, 0]
  for (const x of dev) {
    const a = Math.abs(x)
    zones[a <= y ? 0 : a <= r5 ? 1 : a <= p ? 2 : 3]++
  }
  const s = sd(w)
  const sdDev = sd(dev)
  const m = w.length ? mean(w) : null
  const md = dev.length ? mean(dev) : null
  const fp = used.findIndex((x) => x.pass)
  const cpk = md !== null && sdDev && sdDev > 0 ? Math.min(batch.passHighPct - md, md - batch.passLowPct) / (3 * sdDev) : null
  return {
    id,
    type: d.type,
    param: ctrlName(controlOf(batch), d.type),
    target: targetOf(batch, d.type),
    used,
    all,
    n: used.length,
    mean: m,
    sd: s,
    rsd: s !== null && m ? (s / m) * 100 : null,
    min: w.length ? Math.min(...w) : null,
    max: w.length ? Math.max(...w) : null,
    meanDev: md,
    minDev: dev.length ? Math.min(...dev) : null,
    maxDev: dev.length ? Math.max(...dev) : null,
    pass: used.filter((x) => x.pass).length,
    zones,
    firstPass: fp >= 0 ? fp + 1 : null,
    adjustments: used.filter((x, i) => i > 0 && x.pulse !== used[i - 1].pulse).length,
    firstParam: used[0]?.pulse ?? null,
    lastParam: used.at(-1)?.pulse ?? null,
    lastPass: used.length ? used.at(-1)!.pass : null,
    cpk,
  }
}

/** 데이터에서 규칙으로 뽑는 고찰. 근거 수치를 함께 적는다 */
function insightsFor(stats: DispenserStats[], labels: Map<string, string>): Insight[] {
  const out: Insight[] = []
  const lb = (r: IpcRecord) => labels.get(r.id) ?? String(r.tray)

  // 반복성: 같은 Pulse로 이어진 두 IPC의 차이가 가장 큰 경우
  let worst: { s: DispenserStats; a: IpcRecord; b: IpcRecord; diff: number } | null = null
  for (const s of stats) {
    for (let i = 1; i < s.used.length; i++) {
      const a = s.used[i - 1]
      const b = s.used[i]
      if (a.pulse !== b.pulse) continue
      const diff = (b.weight / a.weight - 1) * 100
      if (!worst || Math.abs(diff) > Math.abs(worst.diff)) worst = { s, a, b, diff }
    }
  }
  if (worst && Math.abs(worst.diff) >= 5) {
    out.push({
      title: '반복성',
      text: `${worst.s.id} 같은 ${worst.s.param} ${worst.a.pulse}에서 ${worst.a.weight.toFixed(3)} → ${worst.b.weight.toFixed(3)} mg (${pct(worst.diff)}). 기기·측정 반복성 점검 필요.`,
      weight: 40 + Math.abs(worst.diff),
    })
  } else {
    const noisy = stats.filter((s) => s.rsd !== null && s.n >= 3).sort((a, b) => b.rsd! - a.rsd!)[0]
    if (noisy && noisy.rsd! >= 5) out.push({ title: '반복성', text: `${noisy.id} RSD ${noisy.rsd!.toFixed(1)}% (n=${noisy.n})로 흔들림이 큼.`, weight: 30 + noisy.rsd! })
  }

  // 조정 반응: Pulse를 바꾼 전후 중량 변화로 구한 실측 감도와 계산식 감도 비교, 판정이 위아래로 번갈아 나오는지
  for (const s of stats) {
    const slopes: number[] = []
    for (let i = 1; i < s.used.length; i++) {
      const dp = s.used[i].pulse - s.used[i - 1].pulse
      // 아주 작은 변경은 측정 흔들림이 기울기를 좌우하므로 2% 이상 바꾼 경우만 쓴다
      if (Math.abs(dp) / s.used[i - 1].pulse >= 0.02) slopes.push((s.used[i].weight - s.used[i - 1].weight) / dp)
    }
    const b = s.used.at(-1)?.model?.b
    const flips = s.used.filter((x, i) => i > 0 && !x.pass && !s.used[i - 1].pass && Math.sign(devOf(x)) !== Math.sign(devOf(s.used[i - 1]))).length
    if (slopes.length >= 3 && b) {
      const real = median(slopes)
      const ratio = real / b
      if (real > 0 && (ratio > 1.5 || ratio < 0.67)) {
        out.push({
          title: '조정 반응',
          text: `${s.id} 실측 감도 ${real.toFixed(2)} vs 계산 ${b.toFixed(2)} mg/${s.param} — ${ratio > 1 ? '과보정' : '보정 부족'}${flips >= 2 ? `, 판정 방향 ${flips}회 반전` : ''}.`,
          weight: 35 + flips * 3,
        })
        continue
      }
    }
    if (flips >= 3) out.push({ title: '조정 반응', text: `${s.id} 부적합이 위·아래로 ${flips}회 번갈아 나옴 — 조정 폭 과다 의심.`, weight: 30 + flips })
  }

  // 운영 변경: 배치 중 IPC 배수 변경과 그 전후 흔들림
  for (const s of stats) {
    const i = s.used.findIndex((x, k) => k > 0 && x.shots !== s.used[k - 1].shots)
    if (i < 0) continue
    const before = s.used.slice(0, i).map(devOf)
    const after = s.used.slice(i).map(devOf)
    const spread = (xs: number[]) => (xs.length ? Math.max(...xs.map(Math.abs)) : 0)
    out.push({
      title: '운영 변경',
      text: `${s.id} ${lb(s.used[i])}부터 IPC ${s.used[i - 1].shots}회 → ${s.used[i].shots}회. 최대 편차 ${spread(before).toFixed(1)}% → ${spread(after).toFixed(1)}%.`,
      weight: 28,
    })
  }

  // 추천 이탈: 직전 추천과 다르게 조정한 경우 중 결과가 가장 나빴던 것
  let off: { s: DispenserStats; r: IpcRecord; rec: number; count: number } | null = null
  for (const s of stats) {
    let count = 0
    let pick: IpcRecord | null = null
    let rec = 0
    for (let i = 1; i < s.used.length; i++) {
      const prev = s.used[i - 1]
      const cur = s.used[i]
      if (prev.recommendedPulse === null || cur.pulse === prev.pulse) continue
      if (Math.abs(cur.pulse - prev.recommendedPulse) / prev.recommendedPulse <= 0.03) continue
      count++
      if (!pick || Math.abs(devOf(cur)) > Math.abs(devOf(pick))) {
        pick = cur
        rec = prev.recommendedPulse
      }
    }
    if (pick && (!off || Math.abs(devOf(pick)) > Math.abs(devOf(off.r)))) off = { s, r: pick, rec, count }
  }
  if (off) {
    out.push({
      title: '추천 이탈',
      text: `${off.s.id} ${lb(off.r)} 추천 ${off.rec} 대신 ${off.r.pulse} 사용 → ${pct(devOf(off.r))}${off.count > 1 ? ` (추천과 다른 조정 ${off.count}회)` : ''}.`,
      weight: 25 + Math.min(20, Math.abs(devOf(off.r)) / 3),
    })
  }

  // 도달: 마지막 두 IPC가 연속 적합인 토출기
  const settled = stats.filter((s) => s.used.length >= 2 && s.used.at(-1)!.pass && s.used.at(-2)!.pass)
  if (settled.length) {
    out.push({
      title: '안정',
      text: `${settled.map((s) => `${s.id}(${s.param} ${s.lastParam})`).join(', ')} 마지막 2회 연속 적합.`,
      weight: 10,
    })
  }
  return out.sort((a, b) => b.weight - a.weight)
}

export function buildReport(batch: Batch, records: IpcRecord[], correctionCount: number): BatchReport {
  const mine = records.filter((r) => r.batchId === batch.id)
  const labels = trayLabels(mine)
  const dispensers = DISPENSERS.map((d) => dispenserStats(batch, mine, d.id))
  const used = dispensers.flatMap((s) => s.used)
  const devs = used.map(devOf)
  const pass = used.filter((r) => r.pass).length
  const lfp = dispensers
    .filter((s) => s.n > 0)
    .map((s) => ({ id: s.id, n: s.firstPass ?? s.n }))
    .sort((a, b) => b.n - a.n)[0]
  const worstDev = devs.length ? devs.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a)) : null

  // 결론: 토출기별 도달 여부
  const withData = dispensers.filter((s) => s.n > 0)
  const ok = withData.filter((s) => s.lastPass)
  const notYet = withData.filter((s) => !s.lastPass)
  const parts: string[] = []
  if (ok.length) parts.push(`${ok.map((s) => s.id).join('·')} 최종 IPC 적합`)
  if (notYet.length) parts.push(`${notYet.map((s) => `${s.id}(${pct(devOf(s.used.at(-1)!))})`).join('·')} 최종 IPC 부적합 — 추가 조정 필요`)
  const hard = withData.filter((s) => (s.firstPass ?? s.n + 1) > 3).sort((a, b) => (b.firstPass ?? 99) - (a.firstPass ?? 99))[0]
  if (hard) parts.push(`${hard.id}는 ${hard.firstPass ? `${hard.firstPass}번째 IPC에서 처음 적합` : `${hard.n}회 IPC 동안 적합 없음`} (조정 ${hard.adjustments}회)`)
  const conclusion = withData.length ? `${parts.join('. ')}.` : '계산에 쓴 IPC 기록이 없습니다.'

  return {
    dispensers,
    totals: {
      n: used.length,
      pass,
      passRate: used.length ? (pass / used.length) * 100 : null,
      meanDev: devs.length ? mean(devs) : null,
      worstDev,
      longestFirstPass: lfp ?? null,
      adjustments: dispensers.reduce((s, d) => s + d.adjustments, 0),
    },
    conclusion,
    insights: insightsFor(dispensers, labels).slice(0, 4),
    labels,
    counts: { corrections: correctionCount, excluded: mine.filter((r) => r.excluded).length, tests: mine.filter((r) => r.test).length },
    authors: [...new Set(mine.map((r) => r.createdByName))],
  }
}

