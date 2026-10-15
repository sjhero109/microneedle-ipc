import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useActor } from '../data/auth'
import { dispenserView, unused } from '../data/model'
import { buildReport, type DispenserStats } from '../data/report'
import { logEvent, useDb } from '../data/store'
import type { Batch, IpcRecord } from '../data/types'
import { CORRECTION_LABEL, DISPENSERS, PARAM_UNIT, adjustOf, contentOf } from '../data/types'
import { Button, dateTime, fmt, signed, timeOnly } from './common'

const ZONE_COLOR = ['#3b8a1e', '#e0a100', '#d03b3b', '#7c3aed']
const BAND_COLOR = { ok: '#15181e', yellow: '#e0a100', red: '#d03b3b', purple: '#7c3aed' } as const
const devOf = (r: IpcRecord) => (r.weight / r.target - 1) * 100

/** 토출기 한 대의 추이: 위는 목표 대비 편차(개별값·추정 수준), 아래는 Pulse·Speed 계단선 */
function DispenserChart({ s, batch, levels, labels }: { s: DispenserStats; batch: Batch; levels: Map<string, number>; labels: Map<string, string> }) {
  const W = 340
  const H = 176
  const L = 30
  const R = 8
  const top = 22
  const mainH = 96
  const pTop = top + mainH + 10
  const pH = 30
  const adjust = adjustOf(batch, s.type) - 100
  const head = (
    <text x={2} y={11} fontSize="10.5" fill="#15181e" fontWeight={600}>
      {s.id}
      <tspan fontWeight={400} fill="#5b6472">
        {s.n ? `  n=${s.n} · 적합 ${s.pass}/${s.n}${s.cpk !== null ? ` · Cpk ${s.cpk.toFixed(2)}` : ''}` : '  기록 없음'}
      </tspan>
    </text>
  )
  if (s.all.length === 0) {
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {head}
        <rect x={L} y={top} width={W - L - R} height={mainH + pH + 10} fill="#f4f5f7" />
        <text x={(W + L) / 2} y={top + 64} textAnchor="middle" fontSize="10" fill="#5b6472">
          이 배치에 IPC 기록이 없습니다
        </text>
      </svg>
    )
  }
  const pts = s.all
  const usedDev = s.used.map(devOf)
  // 추정 수준도 목표 대비 편차(%)로 바꿔 범위에 넣는다
  const lv = s.used.filter((r) => levels.has(r.id)).map((r) => (levels.get(r.id)! / r.target - 1) * 100)
  const vals = [batch.passLowPct, batch.passHighPct, adjust, 0, ...usedDev, ...lv]
  let lo = Math.min(...vals)
  let hi = Math.max(...vals)
  const pad = Math.max(2, (hi - lo) * 0.08)
  lo -= pad
  hi += pad
  const n = pts.length
  const x = (i: number) => L + 8 + (n === 1 ? (W - L - R - 16) / 2 : (i * (W - L - R - 16)) / (n - 1))
  const y = (v: number) => top + ((hi - v) / (hi - lo)) * mainH
  const inR = (v: number) => v >= lo && v <= hi
  const params = s.used.map((r) => r.pulse)
  const pMin = params.length ? Math.min(...params) : 0
  const pMax = params.length ? Math.max(...params) : 1
  const py = (v: number) => (pMax === pMin ? pTop + pH / 2 : pTop + pH - ((v - pMin) / (pMax - pMin)) * pH)
  const idx = new Map(pts.map((r, i) => [r.id, i]))
  const levelLine = s.used
    .map((r) => (levels.has(r.id) ? `${x(idx.get(r.id)!).toFixed(1)},${y(((levels.get(r.id)! / r.target) - 1) * 100).toFixed(1)}` : null))
    .filter(Boolean)
    .join(' ')
  let step = ''
  s.used.forEach((r, k) => {
    const xi = x(idx.get(r.id)!)
    step += k === 0 ? `M${xi},${py(r.pulse)}` : `H${xi}V${py(r.pulse)}`
  })
  if (s.used.length) step += `H${W - R}`
  const shotChanges = s.used.filter((r, k) => k > 0 && r.shots !== s.used[k - 1].shots)
  const grid = [10, -10, 20, -20, 40, -40, 60, -60, 80, 100].filter((v) => inR(v) && v !== batch.passHighPct && v !== batch.passLowPct)
  // 축 숫자는 0과 적합 한계를 먼저 적고, 나머지는 서로 8px 이상 떨어질 때만 적는다
  const shown: number[] = [0, batch.passHighPct, batch.passLowPct].map(y)
  const fits = (v: number) => {
    const yy = y(v)
    if (shown.some((o) => Math.abs(o - yy) < 8)) return false
    shown.push(yy)
    return true
  }
  const gridLabels = new Set(grid.filter(fits))
  const limitLabels = Math.abs(y(batch.passHighPct) - y(0)) >= 8
  const label = (r: IpcRecord) => labels.get(r.id) ?? String(r.tray)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {head}
      <rect x={L} y={y(batch.passHighPct)} width={W - L - R} height={y(batch.passLowPct) - y(batch.passHighPct)} fill="#e6f4df" />
      {grid.map((v) => (
        <g key={v}>
          <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#dcdfe5" strokeWidth="0.6" />
          {gridLabels.has(v) && (
            <text x={L - 3} y={y(v) + 3} textAnchor="end" fontSize="8" fill="#5b6472">
              {signed(v, 0)}
            </text>
          )}
        </g>
      ))}
      <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} stroke="#15181e" strokeWidth="0.7" />
      <text x={L - 3} y={y(0) + 3} textAnchor="end" fontSize="8" fill="#15181e">
        0
      </text>
      {limitLabels && [batch.passHighPct, batch.passLowPct].map((v) => (
        <text key={v} x={L - 3} y={y(v) + 3} textAnchor="end" fontSize="8" fill="#3b8a1e">
          {signed(v, 0)}
        </text>
      ))}
      <line x1={L} x2={W - R} y1={y(adjust)} y2={y(adjust)} stroke="#5b6472" strokeWidth="0.6" strokeDasharray="3 2" />
      <text x={W - R} y={y(adjust) - 2} textAnchor="end" fontSize="7.5" fill="#5b6472">
        {adjust + 100}%
      </text>
      {shotChanges.map((r) => (
        <g key={r.id}>
          <line x1={x(idx.get(r.id)!) - 4} x2={x(idx.get(r.id)!) - 4} y1={top} y2={pTop + pH} stroke="#1f5fd1" strokeWidth="0.7" strokeDasharray="2 2" />
          <text x={x(idx.get(r.id)!) - 2} y={top + 7} fontSize="7.5" fill="#1f5fd1">
            {r.shots}회
          </text>
        </g>
      ))}
      {levelLine && <polyline points={levelLine} fill="none" stroke="#1f5fd1" strokeWidth="1.2" />}
      {pts.map((r, i) => {
        const v = devOf(r)
        const off = unused(r)
        if (off && !inR(v)) return null
        const cy = y(Math.min(hi, Math.max(lo, v)))
        return off ? (
          <circle key={r.id} cx={x(i)} cy={cy} r="2.3" fill="#fff" stroke="#9aa1ad" strokeWidth="1" />
        ) : (
          <circle key={r.id} cx={x(i)} cy={cy} r="2.6" fill={BAND_COLOR[r.band]} />
        )
      })}
      <line x1={L} x2={W - R} y1={pTop - 4} y2={pTop - 4} stroke="#dcdfe5" strokeWidth="0.5" />
      {step && <path d={step} fill="none" stroke="#15181e" strokeWidth="1" />}
      <text x={L - 3} y={pTop + 6} textAnchor="end" fontSize="7.5" fill="#5b6472">
        {fmt(pMax, 3).replace(/\.?0+$/, '')}
      </text>
      <text x={L - 3} y={pTop + pH + 2} textAnchor="end" fontSize="7.5" fill="#5b6472">
        {fmt(pMin, 3).replace(/\.?0+$/, '')}
      </text>
      <text x={2} y={pTop + pH / 2 + 3} fontSize="7.5" fill="#5b6472">
        {s.param}
      </text>
      <text x={x(0)} y={H - 1} textAnchor="middle" fontSize="7.5" fill="#5b6472">
        {label(pts[0])}
      </text>
      {n > 1 && (
        <text x={x(n - 1)} y={H - 1} textAnchor="middle" fontSize="7.5" fill="#5b6472">
          {label(pts[n - 1])}
        </text>
      )}
    </svg>
  )
}

function ZoneChart({ list }: { list: DispenserStats[] }) {
  const W = 340
  const H = 176
  const max = Math.max(1, ...list.map((s) => s.n))
  const barW = W - 60
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <text x={2} y={11} fontSize="10.5" fill="#15181e" fontWeight={600}>
        편차 구간 분포 <tspan fontWeight={400} fill="#5b6472">(건수)</tspan>
      </text>
      {list.map((s, i) => {
        let acc = 0
        const yy = 26 + i * 24
        return (
          <g key={s.id}>
            <text x={2} y={yy + 10} fontSize="9" fill="#15181e">
              {s.id}
            </text>
            <rect x={28} y={yy} width={barW} height={14} fill="#f4f5f7" />
            {s.zones.map((c, z) => {
              const w = (c / max) * barW
              const el = c ? <rect key={z} x={28 + acc} y={yy} width={w} height={14} fill={ZONE_COLOR[z]} /> : null
              acc += w
              return el
            })}
            <text x={W - 2} y={yy + 10} textAnchor="end" fontSize="8.5" fill="#5b6472">
              {s.n ? s.zones.join('·') : '–'}
            </text>
          </g>
        )
      })}
      {['≤2%', '2–5%', '5–10%', '>10%'].map((t, z) => (
        <g key={t}>
          <rect x={28 + z * 70} y={H - 12} width={9} height={9} fill={ZONE_COLOR[z]} />
          <text x={40 + z * 70} y={H - 4} fontSize="8.5" fill="#5b6472">
            {t}
          </text>
        </g>
      ))}
    </svg>
  )
}

export function BatchReport({ batch, onClose }: { batch: Batch; onClose(): void }) {
  const db = useDb()
  const actor = useActor()
  const records = useMemo(() => db.records.filter((r) => r.batchId === batch.id), [db.records, batch.id])
  const corrections = useMemo(() => {
    const ids = new Set(records.map((r) => r.id))
    return db.corrections.filter((c) => ids.has(c.recordId)).sort((a, b) => a.requestedAt - b.requestedAt)
  }, [db.corrections, records])
  const report = useMemo(() => buildReport(batch, db.records, corrections.length), [batch, db.records, corrections.length])
  // 추정 수준은 지금의 계산식으로 다시 그린다 (결과 탭 그래프와 같다)
  const levels = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of report.dispensers) {
      if (!s.used.length) continue
      const steps = dispenserView(db, batch, s.id).model.steps
      s.used.forEach((r, i) => steps[i] && m.set(r.id, steps[i].levelAtPulse))
    }
    return m
  }, [db, batch, report])
  const printedAt = useMemo(() => Date.now(), [])
  const recipe = db.recipes.find((r) => r.id === batch.recipeId)

  useEffect(() => {
    document.body.classList.add('report-open')
    return () => document.body.classList.remove('report-open')
  }, [])

  const print = () => {
    void logEvent(actor, '보고서 출력', { batchNo: batch.batchNo, records: records.length })
    window.print()
  }

  const t = report.totals
  const docNo = `IPC-${batch.batchNo}`
  const shotsSet = [...new Set(records.filter((r) => r.materialType === 'drug').map((r) => r.shots))]
  // 토출기 순서(약액부 1~3, 기저부 1~2) → 입력 순서
  const order = (r: IpcRecord) => DISPENSERS.findIndex((d) => d.id === r.dispenserId)
  const raw = [...records].sort((a, b) => order(a) - order(b) || a.seq - b.seq)
  const corrected = new Set(corrections.filter((c) => c.status === 'approved').map((c) => c.recordId))
  const off = raw.filter((r) => r.test || r.excluded)

  const kpis: [string, string, string?][] = [
    ['IPC 총', `${t.n}회`],
    ['적합률', t.passRate === null ? '–' : `${t.passRate.toFixed(0)}%`, `${t.pass}/${t.n}`],
    ['평균 편차', t.meanDev === null ? '–' : signed(t.meanDev) + '%'],
    ['최대 이탈', t.worstDev === null ? '–' : signed(t.worstDev) + '%'],
    ['첫 적합 최장', t.longestFirstPass ? `${t.longestFirstPass.id} ${t.longestFirstPass.n}회` : '–'],
    ['조정', `${t.adjustments}회`],
  ]

  const header = (title: string) => (
    <div className="flex items-end justify-between border-b-[1.5px] border-[#15181e] pb-1">
      <div>
        <div className="text-[17px] font-bold">{title}</div>
        <div className="text-[11px] text-[#5b6472]">
          {batch.productName} · 배치 {batch.batchNo} · 제조일 {batch.mfgDate || '–'}
        </div>
      </div>
      <div className="text-right text-[10.5px] text-[#5b6472]">
        {docNo} · 출력 {dateTime(printedAt)} {actor.name}
        <br />
        {batch.status === 'closed' ? `완료 ${batch.closedAt ? dateTime(batch.closedAt) : ''}` : '진행 중'}
      </div>
    </div>
  )

  return createPortal(
    <div className="report-root fixed inset-0 z-[60] overflow-auto bg-[#e9ebef]">
      <div className="report-toolbar sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-line bg-panel px-4 py-2">
        <span className="text-sm font-semibold">배치 보고서 · {batch.batchNo}</span>
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
        {/* 1쪽: 요약 */}
        <section className="report-page report-first flex flex-col gap-[7px]">
          {header('토출 IPC 배치 요약 보고서')}
          <table className="rt">
            <tbody>
              <tr>
                <th>약액부 함량</th>
                <td>{contentOf(batch, recipe)}%</td>
                <th>약액부 목표(1회)</th>
                <td>{fmt(batch.drugTarget, 3)} mg</td>
                <th>기저부 목표</th>
                <td>{fmt(batch.baseTarget, 1)} mg</td>
                <th>적합 기준</th>
                <td>
                  {signed(batch.passLowPct, 0)}~{signed(batch.passHighPct, 0)}%
                </td>
              </tr>
              <tr>
                <th>조정 목표</th>
                <td>
                  약 {adjustOf(batch, 'drug')}% · 기 {adjustOf(batch, 'base')}%
                </td>
                <th>약액부 IPC 배수</th>
                <td>{shotsSet.length > 1 ? `${shotsSet.join('→')}회` : `${batch.shots}회`}</td>
                <th>약액부명</th>
                <td>{batch.drugName || '–'}</td>
                <th>기저부명</th>
                <td>{batch.baseName || '–'}</td>
              </tr>
            </tbody>
          </table>

          <div className="rounded-md bg-[#fff4d6] px-2.5 py-1.5 text-[11.5px] leading-snug text-[#3d2a00]">
            <b>결론</b> {report.conclusion}
          </div>

          <div className="grid grid-cols-6 gap-1.5">
            {kpis.map(([k, v, sub]) => (
              <div key={k} className="rounded-md bg-[#f0f1f4] px-2 py-1">
                <div className="text-[10px] text-[#5b6472]">{k}</div>
                <div className="text-[14px] font-bold leading-tight">
                  {v}
                  {sub && <span className="ml-1 text-[10px] font-normal text-[#5b6472]">{sub}</span>}
                </div>
              </div>
            ))}
          </div>

          <div className="rh">토출기별 통계 · 1회분 기준, 테스트·제외 기록 제외 · Cpk는 편차(%)와 적합 기준으로 계산한 참고값</div>
          <table className="rt">
            <thead>
              <tr>
                <th>토출기</th>
                <th>n</th>
                <th>평균 mg</th>
                <th>평균 편차</th>
                <th>SD mg</th>
                <th>RSD</th>
                <th>최소 mg</th>
                <th>최대 mg</th>
                <th>편차 범위</th>
                <th>적합</th>
                <th>첫 적합</th>
                <th>Cpk</th>
                <th>{`Pulse·Speed 시작→최종 (${PARAM_UNIT})`}</th>
              </tr>
            </thead>
            <tbody>
              {report.dispensers.map((s) => {
                const d = s.type === 'base' ? 1 : 3
                return (
                  <tr key={s.id}>
                    <td>{s.id}</td>
                    <td>{s.n || '–'}</td>
                    <td>{fmt(s.mean, d)}</td>
                    <td>{s.meanDev === null ? '–' : signed(s.meanDev) + '%'}</td>
                    <td>{fmt(s.sd, d)}</td>
                    <td>{s.rsd === null ? '–' : s.rsd.toFixed(1) + '%'}</td>
                    <td>{fmt(s.min, d)}</td>
                    <td>{fmt(s.max, d)}</td>
                    <td>{s.minDev === null ? '–' : `${signed(s.minDev)} ~ ${signed(s.maxDev!)}`}</td>
                    <td className={s.n && s.pass < s.n ? 'text-[#d03b3b]' : ''}>{s.n ? `${s.pass}/${s.n}` : '–'}</td>
                    <td>{s.n ? (s.firstPass ? `${s.firstPass}번째` : '미도달') : '–'}</td>
                    <td className={s.cpk !== null && s.cpk < 1 ? 'text-[#d03b3b]' : ''}>{s.cpk === null ? '–' : s.cpk.toFixed(2)}</td>
                    <td>{s.firstParam === null ? '–' : `${s.firstParam}→${s.lastParam}`}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <div className="rh">토출기별 추이 · 위: 목표 대비 편차(%) 개별값과 추정 수준, 아래: Pulse·Speed 변화</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            {report.dispensers.map((s) => (
              <DispenserChart key={s.id} s={s} batch={batch} levels={levels} labels={report.labels} />
            ))}
            <ZoneChart list={report.dispensers} />
          </div>
          <div className="text-[9.5px] leading-snug text-[#5b6472]">
            초록 띠 = 적합 범위, 점선 = 조정 목표, 파란 선 = 추정 수준, 점 색 = 편차 구간(검정 ≤2%, 노랑 2–5%, 빨강 5–10%, 보라 &gt;10%), 빈 원 = 테스트·제외,
            파란 세로 점선 = IPC 배수 변경. 그래프 아래 계단선의 숫자는 최소·최대 Pulse·Speed 값.
          </div>

          <div className="rh">고찰</div>
          {report.insights.length ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] leading-snug">
              {report.insights.map((i, k) => (
                <div key={k}>
                  <b>{i.title}</b> <span className="text-[#3a4250]">{i.text}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-[#5b6472]">특이 사항 없음.</div>
          )}

          <div className="mt-auto flex justify-between border-t border-[#dcdfe5] pt-1 text-[10px] text-[#5b6472]">
            <span>
              정정 {report.counts.corrections} · 제외 {report.counts.excluded} · 테스트 {report.counts.tests}건 (원자료 2쪽부터) · 작성자 {report.authors.join(', ') || '–'}
            </span>
            <span>마이크로니들 IPC</span>
          </div>
        </section>

        {/* 2쪽부터: 원자료 */}
        <section className="report-page report-raw flex flex-col gap-2">
          {header('원자료 · IPC 전체 기록')}
          <table className="rt rt-raw">
            <thead>
              <tr>
                <th>토출기</th>
                <th>#</th>
                <th>트레이</th>
                <th>저장</th>
                <th>{`Pulse·Speed (${PARAM_UNIT})`}</th>
                <th>배수</th>
                <th>합산 mg</th>
                <th>1회 mg</th>
                <th>목표 mg</th>
                <th>편차</th>
                <th>판정</th>
                <th>추천값</th>
                <th>추정 mg</th>
                <th>작성</th>
                <th>비고</th>
              </tr>
            </thead>
            <tbody>
              {raw.map((r) => {
                const d = r.materialType === 'base' ? 1 : 3
                const note = [r.test && '테스트', r.excluded && '제외', corrected.has(r.id) && '정정'].filter(Boolean).join('·')
                return (
                  <tr key={r.id} className={r.test || r.excluded ? 'text-[#9aa1ad]' : ''}>
                    <td>{r.dispenserId}</td>
                    <td>{r.seq}</td>
                    <td>{report.labels.get(r.id) ?? r.tray}</td>
                    <td>
                      {new Date(r.createdAt).toLocaleDateString('sv-SE').slice(5)} {timeOnly(r.createdAt)}
                    </td>
                    <td>{r.pulse}</td>
                    <td>{r.shots}</td>
                    <td>{fmt(r.totalWeight, 2)}</td>
                    <td>{fmt(r.weight, d)}</td>
                    <td>{fmt(r.target, d)}</td>
                    <td>{signed(devOf(r))}%</td>
                    <td className={!r.pass && !(r.test || r.excluded) ? 'text-[#d03b3b]' : ''}>{r.pass ? '적합' : '부적합'}</td>
                    <td>{r.recommendedPulse ?? '–'}</td>
                    <td>{r.model ? fmt(r.model.level, d) : '–'}</td>
                    <td>{r.createdByName}</td>
                    <td>{note}</td>
                  </tr>
                )
              })}
              {raw.length === 0 && (
                <tr>
                  <td colSpan={15}>기록이 없습니다.</td>
                </tr>
              )}
            </tbody>
          </table>

          <div className="rh mt-2">정정 이력</div>
          {corrections.length ? (
            <table className="rt">
              <thead>
                <tr>
                  <th>기록</th>
                  <th>항목</th>
                  <th>정정 전 → 후</th>
                  <th className="w-[30%]">사유</th>
                  <th>상태</th>
                  <th>요청</th>
                  <th>검토</th>
                </tr>
              </thead>
              <tbody>
                {corrections.map((c) => {
                  const r = records.find((x) => x.id === c.recordId)
                  return (
                    <tr key={c.id}>
                      <td>{r ? `${r.dispenserId} ${report.labels.get(r.id) ?? r.tray}` : '–'}</td>
                      <td>{CORRECTION_LABEL[c.field]}</td>
                      <td>
                        {c.oldValue} → {c.newValue}
                      </td>
                      <td className="text-left">{c.reason}</td>
                      <td>{{ pending: '대기', approved: '승인', rejected: '반려' }[c.status]}</td>
                      <td>
                        {c.requestedByName} {dateTime(c.requestedAt)}
                      </td>
                      <td>{c.reviewedByName ? `${c.reviewedByName} ${c.reviewedAt ? dateTime(c.reviewedAt) : ''}` : '–'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <div className="text-[11px] text-[#5b6472]">정정 이력이 없습니다.</div>
          )}

          <div className="rh mt-2">테스트·제외 기록</div>
          {off.length ? (
            <table className="rt">
              <thead>
                <tr>
                  <th>기록</th>
                  <th>구분</th>
                  <th className="w-[60%]">사유</th>
                </tr>
              </thead>
              <tbody>
                {off.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.dispenserId} {report.labels.get(r.id) ?? r.tray}
                    </td>
                    <td>{[r.test && '테스트', r.excluded && '제외'].filter(Boolean).join('·')}</td>
                    <td className="text-left">{r.excludeReason || (r.test ? '테스트 모드로 저장' : '–')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-[11px] text-[#5b6472]">테스트·제외 기록이 없습니다.</div>
          )}
        </section>
      </div>
    </div>,
    document.body,
  )
}

