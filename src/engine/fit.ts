import { runFilter } from './filter'
import { mad, median } from './stats'
import type { EngineOptions, IpcPoint, ModelParams } from './types'
import { DEFAULT_OPTIONS } from './types'

const Q_RATIOS = [0.005, 0.02, 0.05, 0.1, 0.2, 0.5, 1]
const B_GRID_SIZE = 40
/** 감도를 넣었을 때 예측 오차가 이만큼은 줄어야 감도를 신뢰한다 */
const B_MIN_IMPROVEMENT = 0.02

/** 과거 데이터가 없을 때: 비례 관계를 가정한 기본값 */
export function defaultParams(target: number, pRef: number): ModelParams {
  const R = (0.1 * target) ** 2
  return {
    b: pRef > 0 ? target / pRef : 1,
    R,
    Q: 0.1 * R,
    drift: 0,
    pRef,
    L0: target,
    n: 0,
    bReliable: false,
    source: 'default',
  }
}

function bGrid(k: number, opts: EngineOptions): number[] {
  const r = (opts.bRelMax / opts.bRelMin) ** (1 / (B_GRID_SIZE - 1))
  return Array.from({ length: B_GRID_SIZE }, (_, i) => k * opts.bRelMin * r ** i)
}

/** 잡음 크기와 무관하게(R=1) 필터를 돌려 한 스텝 앞 예측 오차를 모은다 */
function innovations(batches: IpcPoint[][], b: number, q: number, pRef: number): number[] {
  const out: number[] = []
  const diffuse: EngineOptions = { ...DEFAULT_OPTIONS, p0Factor: 1e6, outlierSigma: Infinity }
  for (const pts of batches) {
    if (pts.length === 0) continue
    const p: ModelParams = { b, R: 1, Q: q, drift: 0, pRef, L0: 0, n: 0, bReliable: true, source: 'history' }
    const { steps } = runFilter(p, pts, diffuse)
    for (let i = 1; i < steps.length; i++) out.push(steps[i].innovation)
  }
  return out
}

function meanAbs(xs: number[]): number {
  return xs.reduce((s, x) => s + Math.abs(x), 0) / xs.length
}

/**
 * 같은 Pulse로 이어진 IPC 쌍에서 트레이당 수준 변화를 구한다 (배치 경계는 넘지 않는다).
 * 원점을 지나는 최소제곱(Δw = d·Δtray)이며, 사전값은 n0 쌍만큼의 가중치로 섞는다.
 */
export function driftFromPairs(
  batches: IpcPoint[][],
  prior = 0,
  n0 = 0,
): { drift: number; pairs: number; se: number } {
  const dw: number[] = []
  const dt: number[] = []
  for (const batch of batches) {
    const pts = batch.filter((p) => !p.excluded)
    for (let i = 1; i < pts.length; i++) {
      const t = pts[i].tray - pts[i - 1].tray
      if (t > 0 && Math.abs(pts[i].pulse - pts[i - 1].pulse) < 1e-9) {
        dw.push(pts[i].weight - pts[i - 1].weight)
        dt.push(t)
      }
    }
  }
  if (dw.length === 0) return { drift: prior, pairs: 0, se: Infinity }
  // 이상치 한 건이 기울기를 끌고 가지 않도록 Δw를 3·MAD로 자른다
  const scale = mad(dw) || 1e-12
  const c = median(dw)
  const clipped = dw.map((x) => Math.min(Math.max(x, c - 3 * scale), c + 3 * scale))
  const sxx = dt.reduce((s, t) => s + t * t, 0)
  const sxy = clipped.reduce((s, x, i) => s + x * dt[i], 0)
  const raw = sxy / sxx
  const w0 = n0 * median(dt) ** 2
  const ss = clipped.reduce((s, x, i) => s + (x - raw * dt[i]) ** 2, 0)
  const se = dw.length > 1 ? Math.sqrt(ss / (dw.length - 1) / sxx) : Infinity
  return { drift: (prior * w0 + sxy) / (w0 + sxx), pairs: dw.length, se }
}

/** 과거 배치 전체에서 사전값(b, R, Q, drift, L0)을 추정한다 */
export function fitParams(
  history: IpcPoint[][],
  fallback: ModelParams,
  opts: EngineOptions = DEFAULT_OPTIONS,
): ModelParams {
  const batches = history.map((b) => b.filter((p) => !p.excluded)).filter((b) => b.length > 0)
  const all = batches.flat()
  if (all.length < opts.minHistory) return fallback

  const pRef = median(all.map((p) => p.pulse))
  let best = { loss: Infinity, b: fallback.b, q: 0.1 }
  let flat = Infinity // 감도를 거의 0으로 뒀을 때의 오차
  const grid = bGrid(median(all.map((p) => p.weight)) / pRef, opts)
  for (const q of Q_RATIOS) {
    flat = Math.min(flat, meanAbs(innovations(batches, 1e-9, q, pRef)))
    for (const b of grid) {
      const e = innovations(batches, b, q, pRef)
      if (e.length === 0) continue
      const loss = meanAbs(e)
      if (loss < best.loss) best = { loss, b, q }
    }
  }
  if (!Number.isFinite(best.loss)) return fallback

  const e = innovations(batches, best.b, best.q, pRef)
  const sigmaE = mad(e) || Math.sqrt(fallback.R)
  // 정상상태에서 예측 분산 P⁻ = pp·R 이므로 혁신 분산 = (1+pp)·R
  const pp = (best.q + Math.sqrt(best.q * best.q + 4 * best.q)) / 2
  const R = sigmaE ** 2 / (1 + pp)
  const Q = best.q * R

  const pulseSpread = Math.max(...all.map((p) => p.pulse)) - Math.min(...all.map((p) => p.pulse))
  const atEdge = best.b <= grid[0] * 1.001 || best.b >= grid[grid.length - 1] * 0.999
  const bReliable = pulseSpread > 0 && !atEdge && best.loss < flat * (1 - B_MIN_IMPROVEMENT)

  // 감소 경향은 신뢰구간이 0을 벗어날 때만 반영한다
  const pooled = driftFromPairs(batches)
  const drift = pooled.pairs >= 6 && Math.abs(pooled.drift) > 1.96 * pooled.se ? pooled.drift : 0

  const params: ModelParams = { b: best.b, R, Q, drift, pRef, L0: 0, n: all.length, bReliable, source: 'history' }
  const finals = batches.map((pts) => {
    const start = { ...params, L0: pts[0].weight - params.b * (pts[0].pulse - pRef) }
    return runFilter(start, pts, opts).state.L
  })
  return { ...params, L0: median(finals) }
}
