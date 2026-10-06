import { useState } from 'react'
import type { Band } from '../engine'
import { BAND_LABEL, fmt, signed } from './common'

export interface TrendPoint {
  seq: number
  tray: number
  pulse: number
  /** 측정값(목표 대비 %) */
  pct: number
  /** 필터 추정 수준(목표 대비 %) */
  levelPct: number | null
  band: Band
  startup: boolean
  excluded: boolean
  draft?: boolean
}

const W = 340
const H = 150
const M = { l: 30, r: 34, t: 8, b: 18 }
const DOT: Record<Band, string> = { ok: 'var(--ink)', yellow: 'var(--warn)', red: 'var(--bad)', purple: 'var(--severe)' }

/** IPC 순서에 따른 중량 추이. 측정값은 점, 추정 수준은 선으로 그린다 */
export function TrendChart({ points, adjustPct, passLow, passHigh }: { points: TrendPoint[]; adjustPct: number; passLow: number; passHigh: number }) {
  const [hover, setHover] = useState<number | null>(null)
  if (points.length === 0) return null

  const values = points.flatMap((p) => (p.levelPct === null ? [p.pct] : [p.pct, p.levelPct]))
  const lo = Math.max(40, Math.min(100 + passLow - 3, ...values) - 2)
  const hi = Math.min(170, Math.max(adjustPct + 5, 100 + passHigh + 3, ...values) + 2)
  const n = points.length
  const PAD = 8
  const x = (i: number) => M.l + PAD + (n === 1 ? (W - M.l - M.r - 2 * PAD) / 2 : (i * (W - M.l - M.r - 2 * PAD)) / (n - 1))
  const y = (v: number) => M.t + ((hi - Math.min(hi, Math.max(lo, v))) * (H - M.t - M.b)) / (hi - lo)

  const level = points
    .map((p, i) => (p.levelPct === null || p.excluded ? null : `${x(i).toFixed(1)},${y(p.levelPct).toFixed(1)}`))
    .filter(Boolean)
    .join(' ')
  const h = hover === null ? null : points[hover]
  const tipLeft = hover !== null && x(hover) > W / 2

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full touch-none select-none"
        role="img"
        aria-label="IPC 순서별 중량 추이"
        onPointerLeave={() => setHover(null)}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          const px = ((e.clientX - r.left) / r.width) * W
          let best = 0
          points.forEach((_, i) => {
            if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i
          })
          setHover(best)
        }}
      >
        {[100 + passLow, 100 + passHigh].map((v) => (
          <line key={v} x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} stroke="var(--line)" strokeWidth="1" />
        ))}
        <line x1={M.l} x2={W - M.r} y1={y(100)} y2={y(100)} stroke="var(--sub)" strokeWidth="1" />
        <line x1={M.l} x2={W - M.r} y1={y(adjustPct)} y2={y(adjustPct)} stroke="var(--sub)" strokeWidth="1" strokeDasharray="4 3" />
        <text x={M.l - 4} y={y(100) + 3.5} textAnchor="end" fontSize="10" fill="var(--sub)">
          100
        </text>
        <text x={W - M.r + 4} y={y(adjustPct) + 3.5} fontSize="10" fill="var(--sub)">
          {adjustPct}%
        </text>
        <text x={M.l - 4} y={y(100 + passLow) + 3.5} textAnchor="end" fontSize="10" fill="var(--sub)">
          {100 + passLow}
        </text>
        {100 + passHigh !== adjustPct && (
          <text x={M.l - 4} y={y(100 + passHigh) + 3.5} textAnchor="end" fontSize="10" fill="var(--sub)">
            {100 + passHigh}
          </text>
        )}

        {/* Pulse를 바꾼 지점 */}
        {points.map((p, i) =>
          i > 0 && p.pulse !== points[i - 1].pulse ? (
            <line key={`p${i}`} x1={x(i)} x2={x(i)} y1={H - M.b} y2={H - M.b + 5} stroke="var(--accent)" strokeWidth="2" />
          ) : null,
        )}
        <line x1={M.l} x2={W - M.r} y1={H - M.b} y2={H - M.b} stroke="var(--line)" strokeWidth="1" />

        {level && <polyline points={level} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}

        {points.map((p, i) => (
          <circle
            key={i}
            cx={x(i)}
            cy={y(p.pct)}
            r={hover === i ? 5.5 : 4}
            fill={p.excluded || p.startup ? 'var(--panel)' : DOT[p.band]}
            stroke={p.excluded ? 'var(--sub)' : p.startup ? DOT[p.band] : 'var(--panel)'}
            strokeWidth={p.startup || p.excluded ? 2 : 1.5}
            strokeDasharray={p.draft ? '2 2' : undefined}
            opacity={p.excluded ? 0.5 : 1}
          />
        ))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={M.t} y2={H - M.b} stroke="var(--sub)" strokeWidth="1" opacity="0.5" />}
      </svg>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-sub">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block size-2 rounded-full bg-ink" />
          측정값
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block size-2 rounded-full border-2 border-ink" />
          토출 개시 전
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 rounded bg-accent" />
          추정 수준
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-0.5 bg-accent" />
          Pulse 변경
        </span>
      </div>

      {h && (
        <div
          className={`pointer-events-none absolute top-1 z-10 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-xs shadow-lg ${tipLeft ? 'left-1' : 'right-1'}`}
        >
          <div className="font-semibold">
            {h.draft ? '입력 중' : `${h.seq}번째`} · 트레이 {h.tray}
            {h.startup ? ' · 개시 전' : ''}
          </div>
          <div className="num">
            측정 {fmt(h.pct, 1)}% ({signed(h.pct - 100)}%) {BAND_LABEL[h.band]}
          </div>
          {h.levelPct !== null && <div className="num">추정 {fmt(h.levelPct, 1)}%</div>}
          <div className="num">Pulse {h.pulse}</div>
          {h.excluded && <div>계산에서 제외됨</div>}
        </div>
      )}
    </div>
  )
}
