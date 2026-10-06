import { useMemo, useState } from 'react'
import { dispenserView, toPoint } from '../data/model'
import { useDb } from '../data/store'
import type { Batch, DispenserId } from '../data/types'
import { DISPENSERS } from '../data/types'
import { walkForward } from '../engine'
import { Panel, Select, fmt } from './common'

const BASIS = { 'same-material': '같은 토출기·같은 물질', 'same-dispenser': '같은 토출기·다른 물질', default: '기본값 (기록 없음)' } as const

function Formula({ children }: { children: string }) {
  return <div className="num my-2 rounded-lg bg-sunken px-3 py-2 font-mono text-sm">{children}</div>
}

export function LogicTab({ batch }: { batch: Batch | null }) {
  const db = useDb()
  const [disp, setDisp] = useState<DispenserId>('D1')

  const views = useMemo(() => (batch ? DISPENSERS.map((d) => ({ d, v: dispenserView(db, batch, d.id) })) : []), [db, batch])

  // 선택한 토출기에서 기록이 가장 많은 배치로 예측 방식을 비교한다
  const backtest = useMemo(() => {
    const groups = new Map<string, typeof db.records>()
    for (const r of db.records) if (r.dispenserId === disp && !r.excluded) groups.set(r.batchId, [...(groups.get(r.batchId) ?? []), r])
    const biggest = [...groups.values()].sort((a, b) => b.length - a.length)[0]
    if (!biggest || biggest.length < 15) return null
    const sorted = [...biggest].sort((a, b) => a.seq - b.seq)
    return { batchNo: sorted[0].batchNo, n: sorted.length, rows: walkForward(sorted.map(toPoint), sorted[0].target) }
  }, [db, disp])

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel className="p-4 lg:col-span-2">
        <h2 className="mb-1 text-lg font-semibold">추천 Pulse는 이렇게 계산합니다</h2>
        <ol className="list-decimal space-y-3 pl-5 text-sm leading-relaxed [&>li]:min-w-0">
          <li>
            <b>중량은 "기준 수준 + Pulse 효과"로 봅니다.</b> Pulse(토출부가 열리는 시간)를 늘리면 중량이 늘지만, 정확히 비례하지는 않습니다.
            <Formula>중량 = 기준 수준 L + 감도 b × (Pulse − 기준 Pulse)</Formula>
            감도 b는 Pulse를 1 올릴 때 늘어나는 중량(mg)이고, 토출기와 물질마다 과거 기록에서 따로 구합니다.
          </li>
          <li>
            <b>IPC 한 번의 값은 흔들립니다.</b> 그래서 측정값을 그대로 믿지 않고, 지금까지의 추정과 새 측정값을 섞어 기준 수준을 고칩니다.
            <Formula>새 수준 = 이전 수준 + 반영 비율 K × (측정값 − 예상값)</Formula>
            반영 비율 K는 추정이 불확실할수록 커집니다. 새 배치의 첫 IPC는 약 80%를 반영하고, 기록이 쌓일수록 낮아져 안정됩니다. 약액부처럼 여러 번
            토출해 합산한 값은 그만큼 덜 흔들리므로 더 많이 반영합니다.
          </li>
          <li>
            <b>과거 전체 기록은 출발점, 현재 배치 기록이 우선입니다.</b> 감도, 흔들림의 크기, 토출 중 감소량은 같은 토출기·같은 물질의 과거 배치 전체에서
            구합니다. 새 배치가 시작되면 기준 수준만 불확실하게 두고 다시 시작하므로, 이 배치의 IPC 2~3건이면 이 배치의 값이 추정을 이끕니다.
          </li>
          <li>
            <b>조정할 때는 목표의 105%에 맞춥니다.</b> 토출이 진행되면 중량이 서서히 줄기 때문에 여유를 얹어 둡니다.
            <Formula>추천 Pulse = 현재 Pulse + (목표 × 105% − 현재 추정 중량) ÷ 감도 b</Formula>
          </li>
          <li>
            <b>토출 중 감소량</b>은 같은 Pulse로 이어진 IPC 두 건의 중량 차이를 트레이 수로 나눠 구합니다. 과거 기록에서 통계적으로 확인될 때만 쓰고,
            현재 배치에서 적합 뒤 다음 IPC 값이 쌓이면 그 값으로 고쳐 갑니다.
          </li>
          <li>
            <b>예상 범위를 크게 벗어난 값</b>(예측 오차가 3σ 초과)은 "재측정 권장"으로 표시하고 반영 비율을 낮춥니다. 계산에서 완전히 빼는 것은 관리자가
            사유를 남기고 확정할 때만 합니다.
          </li>
        </ol>
      </Panel>

      <Panel className="p-4 lg:col-span-2">
        <h2 className="mb-2 text-lg font-semibold">현재 배치의 모델 값</h2>
        {!batch ? (
          <p className="text-sm text-sub">배치를 시작하면 표시됩니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="num w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-sub">
                  {['토출기', '사전값 기준', '과거 기록', '현재 배치', '추정 수준', '감도 b', '흔들림 σ', '감소/트레이', '다음 반영 비율'].map((h) => (
                    <th key={h} className="py-1.5 pr-3 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {views.map(({ d, v }) => {
                  const p = v.model.params
                  const s = v.model.state
                  const r0 = (p.R * p.shotsRef) / v.shots
                  const last = v.model.steps.at(-1)
                  return (
                    <tr key={d.id} className="border-b border-line/60">
                      <td className="py-1.5 pr-3 font-semibold">{d.label}</td>
                      <td className="py-1.5 pr-3">{BASIS[v.prior.basis]}</td>
                      <td className="py-1.5 pr-3">
                        {p.n}건 / {v.prior.batches}배치
                      </td>
                      <td className="py-1.5 pr-3">{v.model.steps.length}건</td>
                      <td className="py-1.5 pr-3">{last ? `${fmt(last.levelAtPulse, 3)} mg` : '–'}</td>
                      <td className="py-1.5 pr-3">
                        {fmt(p.b, 3)}
                        {!p.bReliable && <span className="ml-1 text-xs text-sub">신뢰도 낮음</span>}
                      </td>
                      <td className="py-1.5 pr-3">{fmt(Math.sqrt(r0), 3)} mg</td>
                      <td className="py-1.5 pr-3">{fmt(p.drift, 4)}</td>
                      <td className="py-1.5 pr-3">{fmt(((s.P + p.Q) / (s.P + p.Q + r0)) * 100, 0)}%</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel className="p-4 lg:col-span-2">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">예측 방식 비교</h2>
          <Select value={disp} onChange={(e) => setDisp(e.target.value as DispenserId)} className="!h-10 !w-auto">
            {DISPENSERS.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </Select>
        </div>
        {!backtest ? (
          <p className="text-sm text-sub">한 배치에 기록이 15건 이상 쌓이면 표시됩니다.</p>
        ) : (
          <>
            <p className="mb-2 text-sm text-sub">
              배치 {backtest.batchNo}의 {backtest.n}건으로, 각 회차에서 그 이전 기록만 써서 다음 중량을 예측했을 때의 오차입니다. 작을수록 좋습니다.
            </p>
            <table className="num w-full max-w-xl text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-sub">
                  <th className="py-1.5 font-medium">예측 방식</th>
                  <th className="py-1.5 text-right font-medium">평균 오차 (mg)</th>
                  <th className="py-1.5 text-right font-medium">중앙 오차 (mg)</th>
                  <th className="py-1.5 pl-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {backtest.rows.map((r) => {
                  const max = Math.max(...backtest.rows.map((x) => x.mae))
                  return (
                    <tr key={r.model} className="border-b border-line/60">
                      <td className={`py-1.5 ${r.model === '칼만' ? 'font-semibold' : ''}`}>{r.model === '칼만' ? '칼만 (사용 중)' : r.model}</td>
                      <td className="py-1.5 text-right">{fmt(r.mae, 3)}</td>
                      <td className="py-1.5 text-right">{fmt(r.medianAe, 3)}</td>
                      <td className="w-2/5 py-1.5 pl-3">
                        <div className={`h-2 rounded-r ${r.model === '칼만' ? 'bg-accent' : 'bg-sub/40'}`} style={{ width: `${(r.mae / max) * 100}%` }} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </>
        )}
      </Panel>
    </div>
  )
}
