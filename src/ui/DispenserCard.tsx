import { useMemo, useState } from 'react'
import { useActor } from '../data/auth'
import { dispenserView, evaluate, trayLabels, unused } from '../data/model'
import { addRecord, useDb } from '../data/store'
import type { Batch, DispenserId, MaterialType } from '../data/types'
import { materialOf } from '../data/types'
import type { IpcPoint, Phase } from '../engine'
import { Button, Deviation, Field, NumInput, fmt, parseNum, signed, timeOnly } from './common'
import { TrendChart, type TrendPoint } from './TrendChart'

const BASIS_NOTE = {
  'same-material': null,
  'same-dispenser': '같은 물질의 기록이 없어 이 토출기의 다른 물질 기록을 기준으로 씁니다',
  default: '기준 데이터 없음 – 기본값 사용',
} as const

interface Props {
  batch: Batch
  dispenser: { id: DispenserId; label: string; type: MaterialType }
  /** 테스트: 저장은 하되 계산식에 반영하지 않는다 */
  testMode: boolean
}

export function DispenserCard({ batch, dispenser, testMode }: Props) {
  const db = useDb()
  const actor = useActor()
  const saved = useMemo(() => dispenserView(db, batch, dispenser.id), [db, batch, dispenser.id])
  const last = saved.records.at(-1)
  const labels = useMemo(() => trayLabels(saved.records), [saved.records])
  const lastUsed = saved.records.filter((r) => !unused(r)).at(-1)

  const [tray, setTray] = useState(() => (last ? String(last.tray) : '1'))
  // Pulse 입력란에는 추천값을 미리 넣어 둔다. 직전 IPC가 적합이면 조정하지 않으므로 쓰던 Pulse를 그대로 둔다
  const [pulse, setPulse] = useState(() => {
    const r = saved.recommendation
    if (lastUsed) return String(lastUsed.pass || !r ? lastUsed.pulse : r.pulse)
    return r ? String(r.pulse) : last ? String(last.pulse) : ''
  })
  const [total, setTotal] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const t = parseNum(tray)
  const p = parseNum(pulse)
  const w = parseNum(total)
  const valid = t !== null && t >= 0 && p !== null && p > 0 && w !== null && w > 0
  // 토출 개시 전 IPC는 1번 트레이에서 한다. 따로 고르지 않고 트레이번호로만 구분한다
  const phase: Phase = t === 1 ? 'startup' : 'routine'
  const draft: IpcPoint | undefined = valid ? { tray: t, pulse: p, weight: w / saved.shots, shots: saved.shots, phase } : undefined
  // 테스트 값은 모델에 얹지 않으므로 추천과 추정 수준이 움직이지 않는다
  const view = draft && !testMode ? dispenserView(db, batch, dispenser.id, draft) : saved
  const verdict = draft ? evaluate(batch, dispenser.type, draft.weight) : null
  const step = draft && !testMode ? view.model.steps.at(-1) : undefined
  const rec = view.recommendation
  const levelDev = (v: number) => evaluate(batch, dispenser.type, v)

  const points: TrendPoint[] = (() => {
    const steps = [...view.model.steps]
    const rows: TrendPoint[] = saved.records.map((r) => {
      const s = unused(r) ? undefined : steps.shift()
      return {
        seq: r.seq,
        tray: r.tray,
        label: labels.get(r.id),
        pulse: r.pulse,
        pct: (r.weight / saved.target) * 100,
        levelPct: s ? (s.levelAtPulse / saved.target) * 100 : null,
        band: r.band,
        excluded: unused(r),
        test: r.test,
      }
    })
    if (draft && verdict) {
      const s = testMode ? undefined : steps.shift()
      rows.push({
        seq: rows.length + 1,
        tray: draft.tray,
        pulse: draft.pulse,
        pct: (draft.weight / saved.target) * 100,
        levelPct: s ? (s.levelAtPulse / saved.target) * 100 : null,
        band: verdict.band,
        excluded: testMode,
        test: testMode,
        draft: true,
      })
    }
    return rows
  })()

  async function save() {
    if (!valid) return
    setBusy(true)
    setError('')
    try {
      await addRecord(actor, batch.id, dispenser.id, { tray: t, pulse: p, totalWeight: w, phase, test: testMode })
      setTotal('')
      // 부적합이면 다음 IPC를 위해 추천 Pulse를 입력란에 넣어 둔다
      if (!testMode && verdict && !verdict.pass && rec) setPulse(String(rec.pulse))
    } catch (e) {
      setError(e instanceof Error ? e.message : '저장하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  const trayBack = t !== null && last && t < last.tray
  const note = BASIS_NOTE[view.prior.basis]
  const rows = showAll ? saved.records : saved.records.slice(-4)
  const accent = dispenser.type === 'drug' ? 'border-t-drug' : 'border-t-base'
  const totalTarget = saved.target * saved.shots
  const adjustTarget = (saved.target * batch.adjustPct) / 100
  const historyCount = view.prior.params.n

  return (
    <article className={`flex min-w-0 flex-col rounded-xl border border-t-4 border-line bg-panel ${accent}`}>
      <button type="button" className="flex items-start justify-between gap-2 px-4 pt-3 pb-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="min-w-0">
          <span className="block font-semibold">{dispenser.label}</span>
          <span className="num block text-xs text-sub">
            {materialOf(batch, dispenser.type) || '물질명 미입력'} · 목표 {fmt(saved.target, 2)} mg
            {saved.shots > 1 ? ` · 같은 Pulse로 ${saved.shots}회 = ${fmt(totalTarget, 2)} mg` : ''}
          </span>
        </span>
        <span className="num shrink-0 text-xs text-sub">
          IPC {saved.records.length}건 <span className="lg:hidden">{open ? '▲' : '▼'}</span>
        </span>
      </button>

      {/* 추천 Pulse: 카드를 접어도 항상 보인다 */}
      <div className="mx-4 mb-3 rounded-xl border-2 border-accent/50 bg-accent/5 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-accent">추천 Pulse</span>
          <span className="num text-xs text-sub">
            목표의 {batch.adjustPct}% = {fmt(adjustTarget, 3)} mg
          </span>
        </div>
        {rec && view.pulseNow !== null ? (
          <>
            <div className="mt-1 flex items-end justify-between gap-3">
              <span className="num text-4xl leading-none font-bold tracking-tight">{rec.pulse}</span>
              <Button variant="primary" onClick={() => setPulse(String(rec.pulse))} className="h-10 px-3 text-sm" disabled={String(rec.pulse) === pulse}>
                Pulse에 적용
              </Button>
            </div>
            <div className="num mt-2 text-sm">
              {view.usedCount > 0 ? '현재' : '기준'} Pulse {view.pulseNow}
              <span className="mx-1 text-sub">대비</span>
              <span className="font-semibold">{signed(rec.delta, 3)}</span>
              <span className="ml-2 text-sub">
                (지금 추정 {fmt(rec.expectedNow, 3)} mg, {signed((rec.expectedNow / saved.target - 1) * 100)}%)
              </span>
            </div>
            <div className="num mt-0.5 text-xs text-sub">
              누적 {historyCount + view.usedCount}건 기준 · 과거 {historyCount}건 + 이번 배치 {view.usedCount}건
              {!view.model.params.bReliable && ' · 감도 신뢰도 낮음'}
            </div>
          </>
        ) : (
          <p className="mt-1 text-sm text-sub">누적 기록이 없습니다. 첫 IPC를 저장하면 추천 Pulse가 표시됩니다.</p>
        )}
      </div>

      <div className={`${open ? 'flex' : 'hidden'} flex-col gap-3 px-4 pb-4 lg:flex`}>
        {note && <p className="rounded-lg bg-sunken px-3 py-2 text-xs text-sub">{note}</p>}

        <div className="grid grid-cols-3 items-end gap-2">
          <Field label="트레이번호">
            <NumInput value={tray} onChange={(e) => setTray(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label={rec && String(rec.pulse) === pulse ? 'Pulse (추천값)' : 'Pulse'}>
            <NumInput value={pulse} onChange={(e) => setPulse(e.target.value)} />
          </Field>
          <Field label={saved.shots > 1 ? `${saved.shots}회 합계 (mg)` : '중량 (mg)'}>
            <NumInput value={total} onChange={(e) => setTotal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
          </Field>
        </div>

        <Button variant="primary" onClick={save} disabled={!valid || busy}>
          {testMode ? '테스트 저장' : '저장'}
        </Button>
        {testMode && <p className="rounded-lg bg-warn/15 px-3 py-2 text-xs">테스트 중 – 이 값은 기록만 남고 추천 Pulse 계산에 반영되지 않습니다.</p>}
        {trayBack && <p className="text-xs text-bad">트레이번호가 직전 기록({last.tray})보다 작습니다.</p>}
        {error && <p className="text-xs text-bad">{error}</p>}

        {draft && verdict && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-line px-3 py-2.5 text-sm">
            <div>
              <div className="text-xs text-sub">측정값 (1회분)</div>
              <div className="num font-semibold">
                {fmt(draft.weight, 3)} mg <Deviation devPct={verdict.devPct} band={verdict.band} />
              </div>
            </div>
            <div>
              <div className="text-xs text-sub">추정 수준</div>
              <div className="num font-semibold">
                {step ? (
                  <>
                    {fmt(step.levelAtPulse, 3)} mg <Deviation {...levelDev(step.levelAtPulse)} />
                  </>
                ) : (
                  '–'
                )}
              </div>
            </div>
            <div className="col-span-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              {step?.outlier ? (
                <span className="font-semibold text-bad">⚠ 재측정 권장 – 예상 범위를 크게 벗어난 값입니다</span>
              ) : verdict.pass ? (
                <span className="font-semibold text-good">✓ 적합{testMode ? '' : ` – ${phase === 'startup' ? '토출 시작 가능' : '토출 지속'}`}</span>
              ) : (
                <span className="font-semibold text-bad">✕ 부적합{testMode ? '' : ' – Pulse 조정 후 재IPC'}</span>
              )}
              {step && <span className="num text-xs text-sub">이번 IPC 반영 {fmt(step.gain * 100, 0)}%</span>}
            </div>
          </div>
        )}

        <TrendChart points={points} adjustPct={batch.adjustPct} passLow={batch.passLowPct} passHigh={batch.passHighPct} />

        {saved.records.length > 0 && (
          <div>
            <table className="num w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-sub">
                  <th className="py-1 font-medium">#</th>
                  <th className="py-1 font-medium">트레이</th>
                  <th className="py-1 font-medium">Pulse</th>
                  <th className="py-1 text-right font-medium">중량</th>
                  <th className="py-1 text-right font-medium">편차</th>
                  <th className="py-1 text-right font-medium">판정</th>
                  <th className="py-1 pl-2 text-right font-medium">저장 (시각)</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-b border-line/60 ${r.excluded ? 'text-sub line-through' : r.test ? 'text-sub' : ''}`}>
                    <td className="py-1.5">{r.seq}</td>
                    <td className="py-1.5">
                      {labels.get(r.id) ?? r.tray}
                      {r.test && <span className="ml-1 rounded bg-sunken px-1 text-xs">테스트</span>}
                    </td>
                    <td className="py-1.5">{r.pulse}</td>
                    <td className="py-1.5 text-right">{fmt(r.totalWeight, 2)}</td>
                    <td className="py-1.5 text-right">
                      <Deviation devPct={r.devPct} band={r.band} />
                    </td>
                    <td className="py-1.5 text-right">{r.pass ? '적합' : '부적합'}</td>
                    <td className="py-1.5 pl-2 text-right text-xs text-sub">
                      <span className="block max-w-24 truncate">{r.createdByName}</span>
                      <span className="block">{timeOnly(r.createdAt)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {saved.records.length > 4 && (
              <button type="button" className="mt-1 h-9 text-xs text-accent" onClick={() => setShowAll((s) => !s)}>
                {showAll ? '최근 4건만 보기' : `전체 ${saved.records.length}건 보기`}
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  )
}
