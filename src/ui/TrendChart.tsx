import { useState } from 'react'
import type { Band } from '../engine'
import { BAND_LABEL, fmt, signed } from './common'

export interface TrendPoint {
  seq: number
  tray: number
  /** 트레이-반복 순서 (예: 1-2) */
  label?: string
  pulse: number
  /** 측정값(목표 대비 %) */
  pct: number
  /** 측정값(1회분 mg) */
  weight?: number
  /** 필터 추정 수준(목표 대비 %) */
  levelPct: number | null
  band: Band
  excluded: boolean
  /** 테스트 기록: 계산식에 반영하지 않는다 */
  test?: boolean
  draft?: boolean
}

const W = 340
const H = 150
const M = { l: 52, r: 34, t: 8, b: 18 }
const DOT: Record<Band, string> = { ok: 'var(--ink)', yellow: 'var(--warn)', red: 'var(--bad)', purple: 'var(--severe)' }

/** IPC 순서에 따른 중량 추이. 측정값은 점, 추정 수준은 선으로 그린다 */
export function TrendChart({
  points,
  target,
  adjustPct,
  passLow,
  passHigh,
  paramLabel = 'Pulse',
}: {
  points: TrendPoint[]
  /** 지금의 목표 중량(1회분 mg). 기준선 옆에 중량으로 적는다 */
  target: number
  adjustPct: number
  passLow: number
  passHigh: number
  /** 파라미터 이름: 약액부 Pulse, 기저부 Speed */
  paramLabel?: string
}) {
  const [hover, setHover] = useState<number | null>(null)
  if (points.length === 0) return null

  // 세로축은 계산에 쓰는 기록(테스트·제외 빼고)과 목표·조정 목표가 모두 보이는 범위로 확대한다.
  // 그 밖으로 벗어난 테스트·제외 값은 그리지 않는다
  const used = points.filter((p) => !p.excluded)
  const basis = used.length ? used : points
  const values = [100, adjustPct, ...basis.flatMap((p) => (p.levelPct === null ? [p.pct] : [p.pct, p.levelPct]))]
  const vMin = Math.min(...values)
  const vMax = Math.max(...values)
  const span = Math.max(vMax - vMin, 6)
  const mid = (vMin + vMax) / 2
  const lo = mid - span / 2 - span * 0.12
  const hi = mid + span / 2 + span * 0.12
  const inRange = (v: number) => v >= lo && v <= hi
  // 기준선: 목표(100%)와 ±적합 한계, ±10%. 범위 안에 있는 것만 그린다
  const refs = [...new Set([100 + passLow, 100 + passHigh, 90, 110])].filter((v) => v !== 100 && inRange(v))
  const mg = (pct: number) => fmt((target * pct) / 100, target >= 100 ? 1 : 3)
  const mgLabel = (pct: number) => `${mg(pct)} mg`
  const n = points.length
  const PAD = 8
  const x = (i: number) => M.l + PAD + (n === 1 ? (W - M.l - M.r - 2 * PAD) / 2 : (i * (W - M.l - M.r - 2 * PAD)) / (n - 1))
  const y = (v: number) => M.t + ((hi - Math.min(hi, Math.max(lo, v))) * (H - M.t - M.b)) / (hi - lo)

  const level = points
    .map((p, i) => (p.levelPct === null || p.excluded ? null : `${x(i).toFixed(1)},${y(p.levelPct).toFixed(1)}`))
    .filter(Boolean)
    .join(' ')
  // 글자가 겹치면 기준선 이름을 생략한다 (목표·조정 목표는 항상 적는다)
  const fits = (v: number, others: number[]) => others.every((o) => Math.abs(y(v) - y(o)) >= 11)
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
        {refs.map((v) => (
          <g key={v}>
            <line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} stroke={v === 100 + passLow || v === 100 + passHigh ? 'var(--bad)' : 'var(--line)'} strokeOpacity={v === 100 + passLow || v === 100 + passHigh ? 0.45 : 1} strokeWidth="1" />
            {fits(v, [100, adjustPct, ...refs.filter((o) => o !== v && Math.abs(o - 100) < Math.abs(v - 100))]) && (
              <>
                <text x={M.l - 4} y={y(v) + 3.5} textAnchor="end" fontSize="9.5" fill="var(--sub)">
                  {mgLabel(v)}
                </text>
                <text x={W - M.r + 4} y={y(v) + 3.5} fontSize="9.5" fill="var(--sub)">
                  {signed(v - 100, 0)}%
                </text>
              </>
            )}
          </g>
        ))}
        <line x1={M.l} x2={W - M.r} y1={y(100)} y2={y(100)} stroke="var(--sub)" strokeWidth="1" />
        <line x1={M.l} x2={W - M.r} y1={y(adjustPct)} y2={y(adjustPct)} stroke="var(--sub)" strokeWidth="1" strokeDasharray="4 3" />
        <text x={M.l - 4} y={y(100) + 3.5} textAnchor="end" fontSize="9.5" fontWeight="600" fill="var(--ink)">
          {mgLabel(100)}
        </text>
        {fits(adjustPct, [100]) && (
          <text x={M.l - 4} y={y(adjustPct) + 3.5} textAnchor="end" fontSize="9.5" fill="var(--sub)">
            {mgLabel(adjustPct)}
          </text>
        )}
        <text x={W - M.r + 4} y={y(adjustPct) + 3.5} fontSize="9.5" fill="var(--sub)">
          {adjustPct}%
        </text>
        {adjustPct !== 100 && fits(100, [adjustPct]) && (
          <text x={W - M.r + 4} y={y(100) + 3.5} fontSize="9.5" fill="var(--sub)">
            100%
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

        {points.map((p, i) =>
          p.excluded && !inRange(p.pct) ? null : (
          <circle
            key={i}
            cx={x(i)}
            cy={y(p.pct)}
            r={hover === i ? 5.5 : 4}
            fill={p.excluded ? 'var(--panel)' : DOT[p.band]}
            stroke={p.excluded ? 'var(--sub)' : 'var(--panel)'}
            strokeWidth={p.excluded ? 2 : 1.5}
            strokeDasharray={p.draft ? '2 2' : undefined}
            opacity={p.excluded ? 0.5 : 1}
          />
          ),
        )}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={M.t} y2={H - M.b} stroke="var(--sub)" strokeWidth="1" opacity="0.5" />}
      </svg>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-sub">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block size-2 rounded-full bg-ink" />
          측정값
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block size-2 rounded-full border-2 border-sub" />
          테스트·제외
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-0.5 w-4 rounded bg-accent" />
          추정 수준
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-0.5 bg-accent" />
          {paramLabel} 변경
        </span>
      </div>

      {h && (
        <div
          className={`pointer-events-none absolute top-1 z-10 rounded-lg border border-line bg-panel px-2.5 py-1.5 text-xs shadow-lg ${tipLeft ? 'left-1' : 'right-1'}`}
        >
          <div className="font-semibold">
            {h.draft ? '입력 중' : `${h.seq}번째`} · 트레이 {h.label ?? h.tray}
          </div>
          <div className="num">
            측정 {h.weight !== undefined ? `${fmt(h.weight, target >= 100 ? 1 : 3)} mg ` : ''}({signed(h.pct - 100)}%) {BAND_LABEL[h.band]}
          </div>
          {h.levelPct !== null && (
            <div className="num">
              추정 {mg(h.levelPct)} mg ({signed(h.levelPct - 100)}%)
            </div>
          )}
          <div className="num">
            {paramLabel} {h.pulse}
          </div>
          {h.test ? <div>테스트 기록 (계산에 미반영)</div> : h.excluded && <div>계산에서 제외됨</div>}
        </div>
      )}
    </div>
  )
}
