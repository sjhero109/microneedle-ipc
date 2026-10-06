import { describe, expect, it } from 'vitest'
import {
  buildBatchModel,
  classify,
  defaultParams,
  fitParams,
  isPass,
  recommend,
  roundTo,
  type IpcPoint,
  type ModelParams,
} from './index'

/** 재현 가능한 난수 (mulberry32 + Box–Muller) */
function rng(seed: number) {
  let a = seed
  const u = () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u())
}

const TARGET = 6.11

/** 가상의 토출기: 중량 = level + b·(pulse − 3) + drift·tray + 잡음 */
function plant(o: { level: number; b: number; drift?: number; sigma?: number; seed?: number }) {
  const noise = rng(o.seed ?? 1)
  return (tray: number, pulse: number) =>
    o.level + o.b * (pulse - 3) + (o.drift ?? 0) * tray + (o.sigma ?? 0) * noise()
}

function history(o: Parameters<typeof plant>[0], n = 60, interval = 1): IpcPoint[] {
  const f = plant(o)
  return Array.from({ length: n }, (_, i) => {
    const pulse = 3 + 0.3 * Math.sin(i / 4) + (i % 7 === 0 ? 0.4 : 0)
    return { tray: (i + 1) * interval, pulse: roundTo(pulse, 0.001), weight: f((i + 1) * interval, pulse) }
  })
}

describe('사전값 추정', () => {
  it('감도와 잡음 크기를 되찾는다', () => {
    const p = fitParams([history({ level: 6, b: 1.2, sigma: 0.3 }, 200)], defaultParams(TARGET, 3))
    expect(p.source).toBe('history')
    expect(p.bReliable).toBe(true)
    expect(p.b).toBeGreaterThan(0.9)
    expect(p.b).toBeLessThan(1.5)
    expect(Math.sqrt(p.R)).toBeGreaterThan(0.2)
    expect(Math.sqrt(p.R)).toBeLessThan(0.4)
  })

  it('감소 경향은 데이터로 확인될 때만 반영한다', () => {
    const flat = history({ level: 6, b: 1, sigma: 0.3 }, 80).map((p) => ({ ...p, pulse: 3 }))
    expect(fitParams([flat], defaultParams(TARGET, 3)).drift).toBe(0)

    const f = plant({ level: 6.4, b: 1, drift: -0.02, sigma: 0.05, seed: 3 })
    const falling = Array.from({ length: 40 }, (_, i) => ({ tray: i * 5, pulse: 3, weight: f(i * 5, 3) }))
    const d = fitParams([falling], defaultParams(TARGET, 3)).drift
    expect(d).toBeLessThan(-0.015)
    expect(d).toBeGreaterThan(-0.025)
  })

  it('데이터가 부족하면 기본값을 쓴다', () => {
    const fb = defaultParams(TARGET, 3)
    expect(fitParams([], fb)).toBe(fb)
    expect(fitParams([[{ tray: 1, pulse: 3, weight: 6 }]], fb)).toBe(fb)
  })

  it('Pulse가 모두 같으면 감도를 신뢰하지 않는다', () => {
    const same = history({ level: 6, b: 1, sigma: 0.3 }, 30).map((p) => ({ ...p, pulse: 3 }))
    const p = fitParams([same], defaultParams(TARGET, 3))
    expect(p.bReliable).toBe(false)
    expect(Number.isFinite(p.b)).toBe(true)
    expect(Number.isFinite(p.R)).toBe(true)
  })
})

describe('새 배치', () => {
  const prior = fitParams([history({ level: 6, b: 1.2, sigma: 0.3 }, 200)], defaultParams(TARGET, 3))

  it('물성이 달라져도 IPC 3회 안에 새 수준으로 수렴한다', () => {
    // 과거보다 15% 낮게 나오는 배치
    const f = plant({ level: 5.1, b: 1.2 })
    const pts = [1, 1, 1].map((tray) => ({ tray, pulse: 3, weight: f(tray, 3) }))
    const m = buildBatchModel(prior, pts)
    expect(m.steps[0].gain).toBeGreaterThan(0.7)
    expect(Math.abs(m.steps[2].levelAtPulse - 5.1) / 5.1).toBeLessThan(0.02)
  })

  it('추천 Pulse를 따라가면 목표의 105%에 도달한다', () => {
    const f = plant({ level: 5.1, b: 1.2 })
    const pts: IpcPoint[] = []
    let pulse = 3
    for (let i = 0; i < 4; i++) {
      pts.push({ tray: 1, pulse, weight: f(1, pulse), phase: 'startup' })
      const m = buildBatchModel(prior, pts)
      pulse = recommend({ params: m.params, state: m.state, pulseNow: pulse, target: TARGET, adjustPct: 105, trayInterval: 10, pulseStep: 0.001 }).pulse
    }
    expect(Math.abs(f(1, pulse) / (TARGET * 1.05) - 1)).toBeLessThan(0.01)
  })

  it('이상치 한 건에 끌려가지 않는다', () => {
    const f = plant({ level: 6, b: 1.2 })
    const pts = Array.from({ length: 8 }, (_, i) => ({ tray: i + 1, pulse: 3, weight: f(i + 1, 3) }))
    pts.push({ tray: 9, pulse: 3, weight: 2.9 })
    const m = buildBatchModel(prior, pts)
    const last = m.steps[m.steps.length - 1]
    expect(last.outlier).toBe(true)
    expect(last.levelAtPulse).toBeGreaterThan(5.5)
  })

  it('제외한 기록은 계산에서 빠진다', () => {
    const pts: IpcPoint[] = [
      { tray: 1, pulse: 3, weight: 6 },
      { tray: 2, pulse: 3, weight: 1, excluded: true },
    ]
    expect(buildBatchModel(prior, pts).steps).toHaveLength(1)
  })
})

describe('기준 데이터가 없는 토출기 (기저부)', () => {
  const base: ModelParams = defaultParams(350, 5)

  it('기록이 없어도 오류 없이 기본값으로 추천한다', () => {
    const m = buildBatchModel(base, [])
    const r = recommend({ params: m.params, state: m.state, pulseNow: 5, target: 350, adjustPct: 105, trayInterval: 10, pulseStep: 0.001 })
    expect(m.params.source).toBe('default')
    expect(Number.isFinite(r.pulse)).toBe(true)
    expect(r.pulse).toBeCloseTo(5.25, 3)
  })

  it('첫 IPC부터 측정값을 따라간다', () => {
    const m = buildBatchModel(base, [{ tray: 1, pulse: 5, weight: 330 }])
    expect(m.steps[0].levelAtPulse).toBeLessThan(336)
  })
})

describe('판정', () => {
  it('2/5/10% 경계로 구간을 나눈다', () => {
    expect(classify(6.11 * 1.019, 6.11).band).toBe('ok')
    expect(classify(6.11 * 1.03, 6.11).band).toBe('yellow')
    expect(classify(6.11 * 0.93, 6.11).band).toBe('red')
    expect(classify(6.11 * 0.88, 6.11).band).toBe('purple')
    expect(classify(6.11 * 1.05, 6.11, { limits: [2, 5, 10], centerPct: 105 }).band).toBe('ok')
  })

  it('적합 범위', () => {
    expect(isPass(6.11 * 1.04, 6.11, -5, 5)).toBe(true)
    expect(isPass(6.11 * 0.94, 6.11, -5, 5)).toBe(false)
  })

  it('Pulse 반올림', () => {
    expect(roundTo(3.94951, 0.001)).toBe(3.95)
    expect(roundTo(3.9449, 0.005)).toBe(3.945)
  })
})
