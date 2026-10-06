import { useMemo, useState } from 'react'
import { useActor } from '../data/auth'
import { dispenserView, evaluate } from '../data/model'
import { addRecord, useDb } from '../data/store'
import type { Batch, DispenserId, MaterialType } from '../data/types'
import { materialOf } from '../data/types'
import type { IpcPoint, Phase } from '../engine'
import { Button, Deviation, Field, NumInput, fmt, parseNum, signed } from './common'
import { TrendChart, type TrendPoint } from './TrendChart'

const BASIS_NOTE = {
  'same-material': null,
  'same-dispenser': '같은 물질의 기록이 없어 이 토출기의 다른 물질 기록을 기준으로 씁니다',
  default: '기준 데이터 없음 – 기본값 사용',
} as const

export function DispenserCard({ batch, dispenser }: { batch: Batch; dispenser: { id: DispenserId; label: string; type: MaterialType } }) {
  const db = useDb()
  const actor = useActor()
  const saved = useMemo(() => dispenserView(db, batch, dispenser.id), [db, batch, dispenser.id])
  const last = saved.records.at(-1)
  const passedOnce = saved.records.some((r) => r.pass && !r.excluded)

  const [tray, setTray] = useState(() => (last ? String(last.tray) : '1'))
  const [pulse, setPulse] = useState(() => (last ? String(last.pulse) : ''))
  const [total, setTotal] = useState('')
  const [phase, setPhase] = useState<Phase>(passedOnce ? 'routine' : 'startup')
  const [showAll, setShowAll] = useState(false)
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const t = parseNum(tray)
  const p = parseNum(pulse)
  const w = parseNum(total)
  const valid = t !== null && t >= 0 && p !== null && p > 0 && w !== null && w > 0
  const draft: IpcPoint | undefined = valid ? { tray: t, pulse: p, weight: w / saved.shots, shots: saved.shots, phase } : undefined
  const view = draft ? dispenserView(db, batch, dispenser.id, draft) : saved
  const verdict = draft ? evaluate(batch, dispenser.type, draft.weight) : null
  const step = draft ? view.model.steps.at(-1) : undefined
  const rec = view.recommendation
  const levelDev = (v: number) => evaluate(batch, dispenser.type, v)

  const points: TrendPoint[] = (() => {
    const steps = [...view.model.steps]
    const rows: TrendPoint[] = saved.records.map((r) => {
      const s = r.excluded ? undefined : steps.shift()
      return {
        seq: r.seq,
        tray: r.tray,
        pulse: r.pulse,
        pct: (r.weight / saved.target) * 100,
        levelPct: s ? (s.levelAtPulse / saved.target) * 100 : null,
        band: r.band,
        startup: r.phase === 'startup',
        excluded: r.excluded,
      }
    })
    if (draft && verdict) {
      const s = steps.shift()
      rows.push({
        seq: rows.length + 1,
        tray: draft.tray,
        pulse: draft.pulse,
        pct: (draft.weight / saved.target) * 100,
        levelPct: s ? (s.levelAtPulse / saved.target) * 100 : null,
        band: verdict.band,
        startup: phase === 'startup',
        excluded: false,
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
      await addRecord(actor, batch.id, dispenser.id, { tray: t, pulse: p, totalWeight: w, phase })
      setTotal('')
      if (verdict?.pass) setPhase('routine')
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

  return (
    <article className={`flex min-w-0 flex-col rounded-xl border border-t-4 border-line bg-panel ${accent}`}>
      <button type="button" className="flex items-start justify-between gap-2 px-4 pt-3 pb-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="min-w-0">
          <span className="block font-semibold">{dispenser.label}</span>
          <span className="num block truncate text-xs text-sub">
            {materialOf(batch, dispenser.type) || '물질명 미입력'} · 목표 {fmt(saved.target, 2)} mg
            {saved.shots > 1 ? ` × ${saved.shots} = ${fmt(totalTarget, 2)} mg` : ''}
          </span>
        </span>
        <span className="num shrink-0 text-xs text-sub">
          IPC {saved.records.length}건 <span className="lg:hidden">{open ? '▲' : '▼'}</span>
        </span>
      </button>

      <div className={`${open ? 'flex' : 'hidden'} flex-col gap-3 px-4 pb-4 lg:flex`}>
        {note && <p className="rounded-lg bg-sunken px-3 py-2 text-xs text-sub">{note}</p>}

        <div className="grid grid-cols-3 items-end gap-2">
          <Field label="트레이번호">
            <NumInput value={tray} onChange={(e) => setTray(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Pulse">
            <NumInput value={pulse} onChange={(e) => setPulse(e.target.value)} />
          </Field>
          <Field label={saved.shots > 1 ? `${saved.shots}회 합계 (mg)` : "중량 (mg)"}>
            <NumInput value={total} onChange={(e) => setTotal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
          </Field>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex flex-1 rounded-lg border border-line p-0.5" role="radiogroup" aria-label="IPC 구분">
            {(['startup', 'routine'] as const).map((ph) => (
              <button
                key={ph}
                type="button"
                role="radio"
                aria-checked={phase === ph}
                onClick={() => setPhase(ph)}
                className={`h-10 flex-1 rounded-md text-sm font-medium ${phase === ph ? 'bg-ink text-panel' : 'text-sub'}`}
              >
                {ph === 'startup' ? '토출 개시 전' : '공정 중'}
              </button>
            ))}
          </div>
          <Button variant="primary" onClick={save} disabled={!valid || busy} className="px-6">
            저장
          </Button>
        </div>
        {trayBack && <p className="text-xs text-bad">트레이번호가 직전 기록({last.tray})보다 작습니다.</p>}
        {error && <p className="text-xs text-bad">{error}</p>}

        {draft && verdict && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-line px-3 py-2.5 text-sm">
            <div>
              <div className="text-xs text-sub">측정값</div>
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
                <span className="font-semibold text-good">✓ 적합 – {phase === 'startup' ? '토출 시작 가능' : '토출 지속'}</span>
              ) : (
                <span className="font-semibold text-bad">✕ 부적합 – Pulse 조정 후 재IPC</span>
              )}
              {step && <span className="num text-xs text-sub">이번 IPC 반영 {fmt(step.gain * 100, 0)}%</span>}
            </div>
          </div>
        )}

        {rec && (
          <div className="flex items-end justify-between gap-3 rounded-lg bg-sunken px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-xs text-sub">
                추천 Pulse <span className="num">(목표의 {batch.adjustPct}% = {fmt((saved.target * batch.adjustPct) / 100, 3)} mg)</span>
              </div>
              <div className="num flex flex-wrap items-baseline gap-x-2">
                <span className="text-2xl font-bold">{rec.pulse}</span>
                <span className="text-sm text-sub">
                  현재 대비 {signed(rec.delta, 3)}
                  {!view.model.params.bReliable && ' · 감도 신뢰도 낮음'}
                </span>
              </div>
            </div>
            <Button onClick={() => setPulse(String(rec.pulse))} className="h-10 px-3 text-sm" disabled={String(rec.pulse) === pulse}>
              Pulse에 적용
            </Button>
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
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={`border-b border-line/60 ${r.excluded ? 'text-sub line-through' : ''}`}>
                    <td className="py-1.5">{r.seq}</td>
                    <td className="py-1.5">
                      {r.tray}
                      {r.phase === 'startup' && <span className="ml-1 text-xs text-sub">개시 전</span>}
                    </td>
                    <td className="py-1.5">{r.pulse}</td>
                    <td className="py-1.5 text-right">{fmt(r.totalWeight, 2)}</td>
                    <td className="py-1.5 text-right">
                      <Deviation devPct={r.devPct} band={r.band} />
                    </td>
                    <td className="py-1.5 text-right">{r.pass ? '적합' : '부적합'}</td>
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
