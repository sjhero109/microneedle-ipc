import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useActor } from '../data/auth'
import { buildComparison, compareDiscussion, compareFindings, type BatchColumn } from '../data/compare'
import type { DispenserStats } from '../data/report'
import { logEvent, useDb } from '../data/store'
import type { Batch } from '../data/types'
import { DISPENSERS, contentOf } from '../data/types'
import { Button, dateTime, fmt, signed } from './common'

const ZONE_COLOR = ['#3b8a1e', '#e0a100', '#d03b3b', '#7c3aed']
const NAVY = '#14284b'

/** 토출기 한 대의 배치 간 추이: 평균 편차(점), ±SD(굵은 막대), 최소~최대(가는 선), 적합 범위(띠) */
function TrendAcross({ id, cols, low, high }: { id: string; cols: BatchColumn[]; low: number; high: number }) {
  const W = 340
  const H = 170
  const L = 30
  const R = 8
  const top = 20
  const plotH = 108
  const items = cols.map((c) => c.stats.get(id as never)! as DispenserStats)
  const has = items.filter((s) => s.n > 0)
  const vals = [low, high, 0, ...has.flatMap((s) => [s.minDev!, s.maxDev!])]
  let lo = Math.min(...vals)
  let hi = Math.max(...vals)
  const pad = Math.max(2, (hi - lo) * 0.08)
  lo -= pad
  hi += pad
  const n = cols.length
  const step = (W - L - R) / n
  const x = (i: number) => L + step * (i + 0.5)
  const y = (v: number) => top + ((hi - v) / (hi - lo)) * plotH
  const grid = [10, -10, 20, -20, 40, -40, 60, 80].filter((v) => v > lo && v < hi)
  const line = items.map((s, i) => (s.n ? `${x(i).toFixed(1)},${y(s.meanDev!).toFixed(1)}` : null)).filter(Boolean).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <text x={2} y={11} fontSize="10.5" fontWeight={700} fill={NAVY}>
        {id}
        <tspan fontWeight={400} fill="#5b6472">
          {'  '}평균 편차 ±SD, 세로선 = 최소~최대
        </tspan>
      </text>
      <rect x={L} y={y(high)} width={W - L - R} height={y(low) - y(high)} fill="#e6f4df" />
      {grid.map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#e3e6ec" strokeWidth="0.6" />
          <text x={L - 3} y={y(v) + 3} textAnchor="end" fontSize="7.5" fill="#5b6472">
            {signed(v, 0)}
          </text>
        </g>
      ))}
      <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="#15181e" strokeWidth="0.7" />
      <text x={L - 3} y={y(0) + 3} textAnchor="end" fontSize="7.5" fill="#15181e">
        0
      </text>
      {[high, low].map((v) => (
        <text key={v} x={L - 3} y={y(v) + 3} textAnchor="end" fontSize="7.5" fill="#3b8a1e">
          {signed(v, 0)}
        </text>
      ))}
      {line && <polyline points={line} fill="none" stroke={NAVY} strokeWidth="1" strokeDasharray="3 2" />}
      {items.map((s, i) => {
        const cx = x(i)
        if (!s.n) {
          return (
            <text key={i} x={cx} y={top + plotH / 2} textAnchor="middle" fontSize="7.5" fill="#9aa1ad">
              기록 없음
            </text>
          )
        }
        const sdPct = s.sd !== null && s.mean ? (s.sd / s.mean) * 100 : 0
        return (
          <g key={i}>
            <line x1={cx} x2={cx} y1={y(s.maxDev!)} y2={y(s.minDev!)} stroke="#9aa1ad" strokeWidth="0.8" />
            <rect x={cx - 3.5} y={y(s.meanDev! + sdPct)} width={7} height={Math.max(1, y(s.meanDev! - sdPct) - y(s.meanDev! + sdPct))} fill="#c9d6ec" />
            <circle cx={cx} cy={y(s.meanDev!)} r="3" fill={NAVY} />
            <text x={cx + 6} y={y(s.meanDev!) + 3} fontSize="7.5" fill={NAVY}>
              {signed(s.meanDev!)}
            </text>
          </g>
        )
      })}
      {cols.map((c, i) => {
        const s = items[i]
        return (
          <g key={c.batch.id}>
            <text x={x(i)} y={top + plotH + 12} textAnchor="middle" fontSize="7.8" fill="#15181e">
              {c.batch.batchNo.length > 12 ? c.batch.batchNo.slice(0, 11) + '…' : c.batch.batchNo}
            </text>
            <text x={x(i)} y={top + plotH + 22} textAnchor="middle" fontSize="7" fill="#5b6472">
              {s.n ? `RSD ${s.rsd === null ? '–' : s.rsd.toFixed(1) + '%'} · ${Math.round((s.pass / s.n) * 100)}%` : ''}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function ZoneBar({ s }: { s: DispenserStats }) {
  if (!s.n) return <span className="text-[#9aa1ad]">–</span>
  return (
    <div>
      <div className="flex h-[9px] w-full overflow-hidden bg-[#f0f1f4]">
        {s.zones.map((c, z) => (c ? <div key={z} style={{ width: `${(c / s.n) * 100}%`, background: ZONE_COLOR[z] }} /> : null))}
      </div>
      <div className="mt-0.5 text-[8.5px] text-[#5b6472]">{s.zones.join('·')}</div>
    </div>
  )
}

export function CompareReport({ batches, onClose }: { batches: Batch[]; onClose(): void }) {
  const db = useDb()
  const actor = useActor()
  const cols = useMemo(() => buildComparison(batches, db.records), [batches, db.records])
  const findings = useMemo(() => compareFindings(cols), [cols])
  const discussion = useMemo(() => compareDiscussion(cols), [cols])
  const printedAt = useMemo(() => Date.now(), [])
  const active = DISPENSERS.filter((d) => cols.some((c) => c.stats.get(d.id)!.n > 0))
  const first = cols[0]?.batch

  useEffect(() => {
    document.body.classList.add('report-open')
    return () => document.body.classList.remove('report-open')
  }, [])

  const print = () => {
    void logEvent(actor, '비교 보고서 출력', { batches: cols.map((c) => c.batch.batchNo) })
    window.print()
  }

  const header = (title: string) => (
    <div className="flex items-end justify-between border-b-[1.5px] border-[#15181e] pb-1">
      <div>
        <div className="text-[17px] font-bold">{title}</div>
        <div className="text-[11px] text-[#5b6472]">
          {[...new Set(cols.map((c) => c.batch.productName))].join(', ')} · 배치 {cols.length}개 · 제조일 {cols[0]?.date} ~ {cols.at(-1)?.date}
        </div>
      </div>
      <div className="text-right text-[10.5px] text-[#5b6472]">
        출력 {dateTime(printedAt)} {actor.name}
      </div>
    </div>
  )

  return createPortal(
    <div className="report-root fixed inset-0 z-[60] overflow-auto bg-[#e9ebef]">
      <div className="report-toolbar sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-line bg-panel px-4 py-2">
        <span className="text-sm font-semibold">배치 비교 보고서 · {cols.length}개 배치</span>
        <div className="flex gap-2">
          <Button variant="primary" className="h-10 px-3 text-sm" onClick={print}>
            인쇄 · PDF 저장
          </Button>
          <Button className="h-10 px-3 text-sm" onClick={onClose}>
            닫기
          </Button>
        </div>
      </div>

      <div className="report-pages num text-[#15181e]">
        {/* 1쪽: 비교 대상, 요약, 요약 비교표 */}
        <section className="report-page report-sheet flex flex-col gap-[7px]">
          {header('토출 IPC 배치 비교 보고서')}
          <div className="rh">비교 대상</div>
          <table className="rt">
            <thead>
              <tr>
                <th>#</th>
                <th>배치번호</th>
                <th>제조일자</th>
                <th>제품</th>
                <th>상태</th>
                <th>약액부 함량</th>
                <th>약액부 목표</th>
                <th>IPC 배수</th>
                <th>IPC (테스트·제외 제외)</th>
              </tr>
            </thead>
            <tbody>
              {cols.map((c, i) => (
                <tr key={c.batch.id}>
                  <td>{i + 1}</td>
                  <td>{c.batch.batchNo}</td>
                  <td>{c.date}</td>
                  <td>{c.batch.productName}</td>
                  <td>{c.batch.status === 'closed' ? '완료' : '진행 중'}</td>
                  <td>{contentOf(c.batch, db.recipes.find((r) => r.id === c.batch.recipeId))}%</td>
                  <td>{fmt(c.batch.drugTarget, 3)} mg</td>
                  <td>{c.batch.shots}회</td>
                  <td>{[...c.stats.values()].reduce((s, x) => s + x.n, 0)}건</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="rh">요약</div>
          <div className="flex flex-col gap-1 rounded-md bg-[#eef2f8] px-2.5 py-2 text-[11px] leading-snug">
            {findings.length ? (
              findings.map((f) => (
                <div key={f.id}>
                  <b className="text-[#14284b]">{f.id}</b> {f.text}
                </div>
              ))
            ) : (
              <div>비교할 IPC 기록이 없습니다.</div>
            )}
          </div>

          <div className="rh">배치 × 토출기 요약 비교 · 1회분 기준, 테스트·제외 기록 제외</div>
          <table className="rt">
            <thead>
              <tr>
                <th>토출기</th>
                <th>배치</th>
                <th>n</th>
                <th>적합률</th>
                <th>평균 편차</th>
                <th>평균 mg</th>
                <th>SD mg</th>
                <th>RSD</th>
                <th>최소 mg</th>
                <th>최대 mg</th>
                <th>편차 범위</th>
                <th>Cpk</th>
              </tr>
            </thead>
            <tbody>
              {active.map((d) =>
                cols.map((c, i) => {
                  const s = c.stats.get(d.id)!
                  const dg = d.type === 'base' ? 1 : 3
                  return (
                    <tr key={d.id + c.batch.id} className={i === 0 ? 'border-t-[1.5px] border-[#14284b]' : ''}>
                      {i === 0 && (
                        <td rowSpan={cols.length} className="font-bold text-[#14284b]">
                          {d.id}
                        </td>
                      )}
                      <td>{c.batch.batchNo}</td>
                      <td>{s.n || '–'}</td>
                      <td className={s.n && s.pass / s.n < 0.8 ? 'text-[#d03b3b]' : ''}>{s.n ? `${Math.round((s.pass / s.n) * 100)}% (${s.pass}/${s.n})` : '–'}</td>
                      <td>{s.meanDev === null ? '–' : signed(s.meanDev) + '%'}</td>
                      <td>{fmt(s.mean, dg)}</td>
                      <td>{fmt(s.sd, dg)}</td>
                      <td>{s.rsd === null ? '–' : s.rsd.toFixed(1) + '%'}</td>
                      <td>{fmt(s.min, dg)}</td>
                      <td>{fmt(s.max, dg)}</td>
                      <td>{s.minDev === null ? '–' : `${signed(s.minDev)} ~ ${signed(s.maxDev!)}`}</td>
                      <td className={s.cpk !== null && s.cpk < 1 ? 'text-[#d03b3b]' : ''}>{s.cpk === null ? '–' : s.cpk.toFixed(2)}</td>
                    </tr>
                  )
                }),
              )}
            </tbody>
          </table>
          <div className="text-[9.5px] text-[#5b6472]">적합률 80% 미만과 Cpk 1 미만은 빨간색. Cpk는 IPC마다 설정을 조정하는 공정 특성상 참고값입니다.</div>
        </section>

        {/* 2쪽: 토출기별 배치 간 추이 */}
        <section className="report-page report-sheet flex flex-col gap-[7px]">
          {header('토출기별 배치 간 추이')}
          <div className="text-[10px] text-[#5b6472]">
            배치를 제조일자 순으로 놓았습니다. 점 = 평균 편차, 파란 막대 = ±SD(목표 대비 %), 회색 세로선 = 최소~최대, 초록 띠 = 적합 범위. 아래 숫자 = RSD · 적합률.
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            {active.map((d) => (
              <TrendAcross key={d.id} id={d.id} cols={cols} low={first?.passLowPct ?? -5} high={first?.passHighPct ?? 5} />
            ))}
          </div>
        </section>

        {/* 3쪽: 편차 구간 분포, 배치 안 추세 */}
        <section className="report-page report-sheet flex flex-col gap-[7px]">
          {header('편차 구간 분포 · 배치 안 추세')}
          <div className="rh">편차 구간 분포 비교 · 건수 비율 (≤2% / 2–5% / 5–10% / &gt;10%)</div>
          <table className="rt">
            <thead>
              <tr>
                <th className="w-[18%]">배치</th>
                {active.map((d) => (
                  <th key={d.id}>{d.id}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cols.map((c) => (
                <tr key={c.batch.id}>
                  <td>{c.batch.batchNo}</td>
                  {active.map((d) => (
                    <td key={d.id} className="!px-2">
                      <ZoneBar s={c.stats.get(d.id)!} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex gap-4 text-[9.5px] text-[#5b6472]">
            {['≤2%', '2–5%', '5–10%', '>10%'].map((t, z) => (
              <span key={t} className="inline-flex items-center gap-1">
                <span className="inline-block size-2.5" style={{ background: ZONE_COLOR[z] }} />
                {t}
              </span>
            ))}
          </div>

          <div className="rh mt-2">배치 안 추세 · 10트레이당 편차 변화(%p)</div>
          <div className="text-[10px] text-[#5b6472]">
            IPC마다 Pulse·Speed를 조정하므로 편차를 트레이와 Pulse·Speed로 함께 회귀해 설정 변경의 영향을 빼고, 토출이 진행되며 중량이 어떻게 변하는지 구했습니다(트레이 0 제외, 같은 IPC 배수 기록만). 음수 = 감소, 양수 = 증가. 괄호는 쓴 IPC 수(5건 미만은 참고).
          </div>
          <table className="rt">
            <thead>
              <tr>
                <th className="w-[18%]">배치</th>
                {active.map((d) => (
                  <th key={d.id}>{d.id}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cols.map((c) => (
                <tr key={c.batch.id}>
                  <td>{c.batch.batchNo}</td>
                  {active.map((d) => {
                    const t = c.trend.get(d.id)!
                    const strong = t.per10 !== null && t.pairs >= 5 && Math.abs(t.per10) >= 1
                    return (
                      <td key={d.id} className={strong ? (t.per10! < 0 ? 'font-bold text-[#d03b3b]' : 'font-bold text-[#1f5fd1]') : t.pairs < 5 ? 'text-[#9aa1ad]' : ''}>
                        {t.per10 === null ? '–' : `${signed(t.per10)} (${t.pairs})`}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="text-[9.5px] text-[#5b6472]">굵은 빨강 = 10트레이당 1%p 이상 감소, 굵은 파랑 = 1%p 이상 증가 (5건 이상일 때). IPC가 적거나 Pulse를 트레이와 함께 꾸준히 올린 배치는 두 영향을 가르기 어려워 값이 크게 흔들릴 수 있습니다.</div>
        </section>

        {/* 마지막: 고찰 */}
        <section className="report-page report-sheet flex flex-col gap-[7px]">
          {header('고찰')}
          <div className="text-[10px] text-[#5b6472]">앞쪽의 비교 결과를 규칙에 따라 정리한 것입니다. 수치는 테스트·제외 기록을 뺀 1회분 기준입니다.</div>
          <ol className="flex flex-col gap-2.5 pl-0">
            {discussion.map((d, i) => (
              <li key={d.title} className="flex gap-2.5 text-[11.5px] leading-relaxed">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center bg-[#14284b] text-[10px] font-bold text-white">{i + 1}</span>
                <div>
                  <div className="font-bold text-[#14284b]">{d.title}</div>
                  <div className="text-[#2a3240]">{d.text}</div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>,
    document.body,
  )
}
