import { useMemo, useState } from 'react'
import { useActor, useAuth } from '../data/auth'
import { exportWorkbook } from '../data/excel'
import { dispenserView, recordControl, trayLabels, unused } from '../data/model'
import { classify } from '../engine'
import { adminEditBatch, correctDirectly, fixImportedTotals, importedMultiShot, includeTestRecords, reviewCorrection, logEvent, reopenBatch, requestCorrection, setExcluded, useDb } from '../data/store'
import type { Batch, Correction, IpcRecord } from '../data/types'
import { CORRECTION_LABEL, DISPENSERS, PARAM_UNIT, adjustOf, controlOf, ctrlName, ctrlUnit, roleLabel, targetOf } from '../data/types'
import { BatchReport } from './BatchReport'
import { CompareReport } from './CompareReport'
import { TrendChart } from './TrendChart'
import { Button, Deviation, Field, Input, Modal, NumInput, Panel, Select, dateTime, fmt, parseNum } from './common'

const FIELD_LABEL = CORRECTION_LABEL
const STATUS = { pending: '승인 대기', approved: '승인', rejected: '반려' } as const

/** IPC 기록 한 건의 상세. 결과 탭과 IPC 탭의 기록 목록에서 연다 */
export function RecordDetail({ record, onClose }: { record: IpcRecord; onClose(): void }) {
  const db = useDb()
  const actor = useActor()
  const [field, setField] = useState<Correction['field']>('tray')
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')
  const [exReason, setExReason] = useState('')
  const [reviewNote, setReviewNote] = useState('')
  const { confirm } = useAuth()
  const [error, setError] = useState('')
  const corrections = db.corrections.filter((c) => c.recordId === record.id)
  const trail = db.audit.filter((a) => a.targetId === record.id).sort((a, b) => a.at - b.at)

  const run = async (fn: () => Promise<void>) => {
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : '처리하지 못했습니다.')
    }
  }

  const info: [string, string][] = [
    ['제품 / 배치', `${record.productName} / ${record.batchNo}`],
    ['토출기 / 물질', `${record.dispenserId} / ${record.materialName || '–'}`],
    ['트레이', `${record.tray}${record.test ? ' (테스트)' : ''}`],
    [ctrlName(recordControl(record), record.materialType), `${record.pulse} ${ctrlUnit(recordControl(record))}`],
    ...(record.pulseMs !== undefined ? [['고정 Pulse·Speed', `${record.pulseMs} ${PARAM_UNIT}`] as [string, string]] : []),
    ['합산 중량', record.shots > 1 ? `${fmt(record.totalWeight, 3)} mg (같은 설정으로 ${record.shots}회 토출)` : `${fmt(record.totalWeight, 3)} mg`],
    ['1회 중량 / 목표', `${fmt(record.weight, 3)} / ${fmt(record.target, 2)} mg`],
    [`추천 ${ctrlName(recordControl(record), record.materialType)}`, record.recommendedPulse === null ? '–' : `${record.recommendedPulse} ${ctrlUnit(recordControl(record))}`],
    ['추정 수준', record.model ? `${fmt(record.model.level, 3)} mg` : '–'],
    ['작성', `${record.createdByName} · ${dateTime(record.createdAt)}`],
    ['입력 경로', record.source === 'import' ? `가져오기 (${record.importFile})` : '직접 입력'],
  ]

  return (
    <Modal title={`IPC 기록 #${record.seq}`} onClose={onClose}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        {info.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-xs text-sub">{k}</dt>
            <dd className="num break-words">{v}</dd>
          </div>
        ))}
        <div>
          <dt className="text-xs text-sub">편차 / 판정</dt>
          <dd>
            <Deviation devPct={record.devPct} band={record.band} /> · {record.pass ? '적합' : '부적합'}
          </dd>
        </div>
        {record.excluded && (
          <div className="col-span-2">
            <dt className="text-xs text-sub">계산에서 제외됨</dt>
            <dd>{record.excludeReason}</dd>
          </div>
        )}
      </dl>

      <h3 className="mt-5 mb-2 font-semibold">정정 요청</h3>
      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2">
          <div className="mb-1 text-xs text-sub">정정할 항목</div>
          <div className="grid grid-cols-3 gap-1.5">
            {(Object.keys(FIELD_LABEL) as Correction['field'][]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setField(k)}
                className={`num rounded-lg border px-2 py-2 text-sm ${field === k ? 'border-accent bg-accent/10 font-semibold text-accent' : 'border-line hover:bg-sunken'}`}
              >
                {FIELD_LABEL[k]}
                <span className="block text-xs text-sub">현재 {record[k]}</span>
              </button>
            ))}
          </div>
        </div>
        <Field label={`정정할 ${FIELD_LABEL[field]}`} className="col-span-2">
          <NumInput value={value} onChange={(e) => setValue(e.target.value)} placeholder={field === 'tray' ? '예: 0 (생산 전 세팅), 1, 2 …' : ''} />
        </Field>
        <Field label="사유 (필수)" className="col-span-2">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <Button
        variant="primary"
        className="mt-2"
        disabled={parseNum(value) === null || !reason.trim()}
        onClick={() =>
          run(async () => {
            await requestCorrection(actor, record.id, field, parseNum(value)!, reason)
            setValue('')
            setReason('')
          })
        }
      >
        정정 요청
      </Button>
      {actor.role === 'admin' && (
        <Button
          className="mt-2 ml-2"
          disabled={parseNum(value) === null || !reason.trim()}
          onClick={() =>
            run(async () => {
              await confirm()
              await correctDirectly(actor, record.id, field, parseNum(value)!, reason)
              setValue('')
              setReason('')
            })
          }
        >
          바로 정정 (관리자)
        </Button>
      )}

      {actor.role === 'admin' && record.test && (
        <>
          <h3 className="mt-5 mb-2 font-semibold">테스트 기록</h3>
          <p className="mb-2 text-sm text-sub">테스트로 저장되어 계산에 쓰이지 않는 기록입니다. 편입하면 추천값 계산과 이후 배치의 기준에 반영됩니다.</p>
          <Button onClick={() => run(async () => (await confirm(), void (await includeTestRecords(actor, [record.id]))))}>계산에 편입</Button>
        </>
      )}

      {actor.role === 'admin' && (
        <>
          <h3 className="mt-5 mb-2 font-semibold">계산에서 제외</h3>
          {record.excluded ? (
            <Button onClick={() => run(async () => (await confirm(), setExcluded(actor, record.id, false, '제외 취소')))}>제외 취소</Button>
          ) : (
            <div className="flex gap-2">
              <Input placeholder="제외 사유 (필수)" value={exReason} onChange={(e) => setExReason(e.target.value)} />
              <Button variant="danger" disabled={!exReason.trim()} onClick={() => run(async () => (await confirm(), setExcluded(actor, record.id, true, exReason)))}>
                제외
              </Button>
            </div>
          )}
        </>
      )}
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}

      {corrections.length > 0 && (
        <>
          <h3 className="mt-5 mb-2 font-semibold">정정 이력</h3>
          <ul className="space-y-1.5 text-sm">
            {corrections.map((c) => (
              <li key={c.id} className="num rounded-lg bg-sunken px-3 py-2">
                {FIELD_LABEL[c.field]} {c.oldValue} → {c.newValue} · <b>{STATUS[c.status]}</b>
                <div className="text-xs text-sub">
                  {c.requestedByName} · {dateTime(c.requestedAt)} · {c.reason}
                  {c.reviewedByName && ` / 검토 ${c.reviewedByName} · ${c.reviewNote ?? ''}`}
                </div>
                {/* 관리자는 기록 상세에서 바로 승인·반려한다 (관리자 탭의 정정·이상치 검토와 같다) */}
                {actor.role === 'admin' && c.status === 'pending' && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Input className="!h-10 min-w-40 flex-1" placeholder="검토 의견" value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} />
                    <Button variant="primary" className="h-10" onClick={() => run(async () => (await confirm(), await reviewCorrection(actor, c.id, true, reviewNote), setReviewNote('')))}>
                      승인
                    </Button>
                    <Button className="h-10" onClick={() => run(async () => (await confirm(), await reviewCorrection(actor, c.id, false, reviewNote), setReviewNote('')))}>
                      반려
                    </Button>
                  </div>
                )}
                {actor.role !== 'admin' && c.status === 'pending' && <div className="mt-1 text-xs text-sub">관리자가 승인하면 반영됩니다.</div>}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="mt-5 mb-2 font-semibold">Audit trail</h3>
      <ul className="space-y-1 text-sm">
        {trail.map((a) => (
          <li key={a.id} className="num flex flex-wrap gap-x-2 border-b border-line/60 py-1">
            <span className="text-sub">{dateTime(a.at)}</span>
            <span className="font-medium">{a.action}</span>
            <span>
              {a.name} ({roleLabel(a.role)})
            </span>
            {a.reason && <span className="text-sub">{a.reason}</span>}
          </li>
        ))}
      </ul>
    </Modal>
  )
}

const ymd = (t: number) => new Date(t).toLocaleDateString('sv-SE')

/** 토출기 한 대의 배치 결과: 횟수, 적합 여부, 평균 편차, Pulse 변화, 추이 */
function DispenserResult({ batch, dispenser, records, labels }: { batch: Batch; dispenser: (typeof DISPENSERS)[number]; records: IpcRecord[]; labels: Map<string, string> }) {
  const db = useDb()
  const used = records.filter((r) => !unused(r))
  // 배치 중에 목표 중량이 바뀔 수 있으므로 기록마다 저장 당시의 목표로 계산한다
  const targets = [...new Set(used.map((r) => r.target))]
  const meanDev = used.length ? used.reduce((s, r) => s + (r.weight / r.target - 1) * 100, 0) / used.length : null
  // 추정 수준은 저장 당시 값이 아니라 지금의 계산식으로 다시 그린다
  const steps = useMemo(() => [...dispenserView(db, batch, dispenser.id).model.steps], [db, batch, dispenser.id])
  const levels = new Map(used.map((r, i) => [r.id, steps[i]?.levelAtPulse]))
  const fails = used.filter((r) => !r.pass).length
  const mean = used.length ? used.reduce((s, r) => s + r.weight, 0) / used.length : null
  const changes = used.filter((r, i) => i > 0 && r.pulse !== used[i - 1].pulse).length
  const items: [string, React.ReactNode][] = [
    ['IPC', `${used.length}회`],
    ['적합 / 부적합', `${used.length - fails} / ${fails}`],
    ['목표 중량', targets.length ? `${targets.map((t) => fmt(t, 2)).join(' → ')} mg` : `${fmt(targetOf(batch, dispenser.type), 2)} mg`],
    [
      targets.length > 1 ? '평균 편차' : '평균 중량',
      mean === null || meanDev === null ? (
        '–'
      ) : (
        <>
          {targets.length > 1 ? '' : `${fmt(mean, 3)} mg `}
          <Deviation {...classify(100 + meanDev, 100, { limits: batch.bands, centerPct: batch.bandCenterPct })} />
        </>
      ),
    ],
    [ctrlName(controlOf(batch), dispenser.type), used.length ? `${used[0].pulse} → ${used.at(-1)!.pulse} ${ctrlUnit(controlOf(batch))} (조정 ${changes}회)` : '–'],
  ]
  return (
    <Panel className={`border-t-4 p-3 ${dispenser.type === 'drug' ? 'border-t-drug' : 'border-t-base'}`}>
      <h3 className="font-semibold">{dispenser.label}</h3>
      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
        {items.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-xs text-sub">{k}</dt>
            <dd className="num font-semibold">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-2">
        <TrendChart
          points={records.map((r) => ({
            seq: r.seq,
            tray: r.tray,
            label: labels.get(r.id),
            pulse: r.pulse,
            pct: (r.weight / r.target) * 100,
            weight: r.weight,
            levelPct: levels.get(r.id) === undefined ? null : (levels.get(r.id)! / r.target) * 100,
            band: r.band,
            excluded: unused(r),
            test: r.test,
          }))}
          target={targetOf(batch, dispenser.type)}
          adjustPct={adjustOf(batch, dispenser.type)}
          passLow={batch.passLowPct}
          passHigh={batch.passHighPct}
          paramLabel={ctrlName(controlOf(batch), dispenser.type)}
          unit={ctrlUnit(controlOf(batch))}
        />
      </div>
    </Panel>
  )
}

/** 배치 한 건의 결과와 기록 목록 */
function BatchRecords({ batch, onBack, onOpenBatch }: { batch: Batch; onBack(): void; onOpenBatch(id: string): void }) {
  const db = useDb()
  const actor = useActor()
  const [dispenser, setDispenser] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [reporting, setReporting] = useState(false)
  // 관리자 배치 정보 수정 (완료된 배치도 가능)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({ batchNo: batch.batchNo, mfgDate: batch.mfgDate, drugName: batch.drugName, baseName: batch.baseName, reason: '' })
  const [editMsg, setEditMsg] = useState('')
  const [editBusy, setEditBusy] = useState(false)

  const all = useMemo(
    () => db.records.filter((r) => r.batchId === batch.id).sort((a, b) => a.dispenserId.localeCompare(b.dispenserId) || a.seq - b.seq),
    [db.records, batch.id],
  )
  const rows = dispenser ? all.filter((r) => r.dispenserId === dispenser) : all
  const { confirm } = useAuth()
  const [note, setNote] = useState('')
  const [reason, setReason] = useState('')
  const closed = batch.status === 'closed'
  const tests = all.filter((r) => r.test)
  const imported = actor.role === 'admin' ? importedMultiShot(batch.id) : []
  const act = async (fn: () => Promise<string>) => {
    setNote('')
    try {
      await confirm()
      setNote(await fn())
    } catch (e) {
      setNote(e instanceof Error ? e.message : '처리하지 못했습니다.')
    }
  }
  const labels = useMemo(() => trayLabels(all), [all])
  const open = openId ? db.records.find((r) => r.id === openId) : undefined

  function download() {
    const name = `IPC_${batch.productName}_${batch.batchNo}_${ymd(Date.now()).replaceAll('-', '')}.xlsx`
    const ids = new Set(all.map((r) => r.id))
    const trail = db.audit.filter((a) => (ids.has(a.targetId) || a.targetId === batch.id) && (actor.role === 'admin' || a.uid === actor.uid))
    exportWorkbook(name, all, db.batches, db.corrections, trail)
    void logEvent(actor, '엑셀 내보내기', { file: name, count: all.length })
  }

  const info: [string, string][] = [
    ['제품명', batch.productName],
    ['배치번호', batch.batchNo],
    ['제조일자', batch.mfgDate || '–'],
    ['약액부명', batch.drugName || '–'],
    ['기저부명', batch.baseName || '–'],
    ['약액부 IPC 배수', `${batch.shots}회`],
    ['상태', closed ? `완료${batch.closedByName ? ` (${batch.closedByName}${batch.closedAt ? ` · ${dateTime(batch.closedAt)}` : ''})` : ''}` : '진행 중'],
  ]

  return (
    <div className="flex flex-col gap-3">
      <Panel className="p-3 sm:p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <Button onClick={onBack} className="h-10 px-3 text-sm">
            ← 배치 목록
          </Button>
          <div className="flex gap-2">
            {!closed && (
              <Button onClick={() => onOpenBatch(batch.id)} className="h-10 px-3 text-sm">
                IPC 탭에서 열기
              </Button>
            )}
            <Button onClick={() => setReporting(true)} disabled={all.length === 0} className="h-10 px-3 text-sm">
              보고서
            </Button>
            <Button variant="primary" onClick={download} disabled={all.length === 0} className="h-10 px-3 text-sm">
              엑셀 내보내기
            </Button>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-3 xl:grid-cols-7">
          {info.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-xs text-sub">{k}</dt>
              <dd className="num font-semibold break-words">{v}</dd>
            </div>
          ))}
        </dl>
      </Panel>
      {reporting && <BatchReport batch={batch} onClose={() => setReporting(false)} />}

      {actor.role === 'admin' && (
        <Panel className="p-3 text-sm">
          {!editing ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sub">관리자: 배치번호·제조일자·약액부명·기저부명 수정 (완료된 배치 포함)</span>
              <Button
                className="h-10 px-3 text-sm"
                onClick={() => {
                  setForm({ batchNo: batch.batchNo, mfgDate: batch.mfgDate, drugName: batch.drugName, baseName: batch.baseName, reason: '' })
                  setEditMsg('')
                  setEditing(true)
                }}
              >
                배치 정보 수정
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <Field label="배치번호">
                  <Input value={form.batchNo} onChange={(e) => setForm({ ...form, batchNo: e.target.value })} />
                </Field>
                <Field label="제조일자">
                  <Input type="date" value={form.mfgDate} onChange={(e) => setForm({ ...form, mfgDate: e.target.value })} />
                </Field>
                <Field label="약액부명">
                  <Input value={form.drugName} onChange={(e) => setForm({ ...form, drugName: e.target.value })} />
                </Field>
                <Field label="기저부명">
                  <Input value={form.baseName} onChange={(e) => setForm({ ...form, baseName: e.target.value })} />
                </Field>
                <Field label="수정 사유 (필수)" className="col-span-2 md:col-span-4">
                  <Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
                </Field>
              </div>
              <p className="text-xs text-sub">이 배치의 IPC 기록 {all.length}건에 저장된 배치번호·물질명도 함께 바뀌고, 바꾸기 전후 값이 audit trail에 남습니다.</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  className="h-10 px-3 text-sm"
                  disabled={editBusy || !form.batchNo.trim() || !form.reason.trim()}
                  onClick={async () => {
                    setEditMsg('')
                    setEditBusy(true)
                    try {
                      await confirm()
                      const n = await adminEditBatch(actor, batch.id, form, form.reason, (d, t) => setEditMsg(`기록 반영 중 ${d} / ${t}건`))
                      setEditMsg(`배치 정보를 수정했습니다${n ? ` (기록 ${n}건 반영)` : ''}.`)
                      setEditing(false)
                    } catch (e) {
                      setEditMsg(e instanceof Error ? e.message : '수정하지 못했습니다.')
                    } finally {
                      setEditBusy(false)
                    }
                  }}
                >
                  저장
                </Button>
                <Button className="h-10 px-3 text-sm" disabled={editBusy} onClick={() => setEditing(false)}>
                  취소
                </Button>
              </div>
            </div>
          )}
          {editMsg && <p className="mt-2 text-sub">{editMsg}</p>}
        </Panel>
      )}

      {imported.length > 0 && (
        <Panel className="flex flex-wrap items-center gap-2 border-warn p-3 text-sm">
          <span className="min-w-0 flex-1">
            엑셀에서 가져온 약액부 기록 <b>{imported.length}건</b>(IPC 배수 {imported[0].shots}회). 엑셀 중량이 이미 {imported[0].shots}회 합계였는데 가져올 때 × {imported[0].shots}가 적용됐다면 보정하세요.
            예: 합산 {fmt(imported[0].totalWeight, 2)} mg → {fmt(imported[0].totalWeight / imported[0].shots, 2)} mg, 1회분 {fmt(imported[0].weight, 3)} → {fmt(imported[0].weight / imported[0].shots, 3)} mg.
          </span>
          <Button className="h-10 px-3 text-sm" onClick={() => act(async () => `가져온 기록 ${await fixImportedTotals(actor, batch.id)}건의 중량을 보정했습니다.`)}>
            가져온 기록 중량 보정 (÷ {imported[0].shots})
          </Button>
          {note && <span className="basis-full text-sub">{note}</span>}
        </Panel>
      )}

      {(closed || (actor.role === 'admin' && tests.length > 0)) && (
        <Panel className="flex flex-wrap items-center gap-2 p-3 text-sm">
          {actor.role === 'admin' && tests.length > 0 && (
            <Button className="h-10 px-3 text-sm" onClick={() => act(async () => `테스트 기록 ${await includeTestRecords(actor, tests.map((r) => r.id))}건을 계산에 편입했습니다.`)}>
              테스트 기록 {tests.length}건 계산에 편입
            </Button>
          )}
          {closed && (
            <>
              <Input className="!h-10 min-w-40 flex-1" placeholder="다시 여는 사유 (필수)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button className="h-10 px-3 text-sm" disabled={!reason.trim()} onClick={() => act(async () => (await reopenBatch(actor, batch.id, reason), '배치를 다시 열었습니다.'))}>
                배치 다시 열기
              </Button>
            </>
          )}
          {note && <span className="basis-full text-sub">{note}</span>}
        </Panel>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {DISPENSERS.filter((d) => all.some((r) => r.dispenserId === d.id)).map((d) => (
          <DispenserResult key={d.id} batch={batch} dispenser={d} records={all.filter((r) => r.dispenserId === d.id).sort((a, b) => a.seq - b.seq)} labels={labels} />
        ))}
      </div>

      <h3 className="mt-2 text-sm font-semibold text-sub">IPC 기록</h3>
      <div className="flex gap-1 overflow-x-auto">
        {[{ id: '', label: '전체' }, ...DISPENSERS].map((d) => {
          const n = d.id ? all.filter((r) => r.dispenserId === d.id).length : all.length
          return (
            <button
              key={d.id}
              type="button"
              onClick={() => setDispenser(d.id)}
              className={`num h-10 rounded-lg px-3 text-sm font-medium whitespace-nowrap ${dispenser === d.id ? 'bg-ink text-panel' : 'text-sub hover:bg-panel'}`}
            >
              {d.id || d.label} {n}
            </button>
          )
        })}
      </div>

      {/* PC: 표 */}
      <Panel className="hidden overflow-x-auto md:block">
        <table className="num w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-sub">
              {['토출기', '#', '트레이-회차', '', '설정값', '합산 중량', '1회 중량', '편차', '판정', '추천값', '작성자', '작성시각'].map((h) => (
                <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => setOpenId(r.id)} className={`cursor-pointer border-b border-line/60 hover:bg-sunken ${r.excluded ? 'text-sub line-through' : r.test ? 'text-sub' : ''}`}>
                <td className="px-3 py-2">{r.dispenserId}</td>
                <td className="px-3 py-2">{r.seq}</td>
                <td className="px-3 py-2">{labels.get(r.id) ?? r.tray}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.test && <span className="rounded bg-sunken px-1 text-xs">테스트</span>}</td>
                <td className="px-3 py-2">{r.pulse}</td>
                <td className="px-3 py-2">{fmt(r.totalWeight, 2)}</td>
                <td className="px-3 py-2">{fmt(r.weight, 3)}</td>
                <td className="px-3 py-2">
                  <Deviation devPct={r.devPct} band={r.band} />
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{r.pass ? '적합' : '부적합'}</td>
                <td className="px-3 py-2">{r.recommendedPulse ?? '–'}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.createdByName}</td>
                <td className="px-3 py-2 whitespace-nowrap">{dateTime(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {/* 모바일: 카드 */}
      <ul className="flex flex-col gap-2 md:hidden">
        {rows.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => setOpenId(r.id)} className={`num w-full rounded-xl border border-line bg-panel px-3 py-2.5 text-left ${r.excluded ? 'text-sub line-through' : r.test ? 'text-sub' : ''}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">
                  {r.dispenserId} · 트레이 {labels.get(r.id) ?? r.tray}
                  {r.test && <span className="ml-1 text-xs font-normal text-sub">테스트</span>}
                </span>
                <Deviation devPct={r.devPct} band={r.band} />
              </div>
              <div className="mt-0.5 text-sm">
                {ctrlName(recordControl(r), r.materialType)} {r.pulse} {ctrlUnit(recordControl(r))} · {fmt(r.totalWeight, 2)} mg · {r.pass ? '적합' : '부적합'}
              </div>
              <div className="mt-0.5 truncate text-xs text-sub">
                {r.createdByName} · {dateTime(r.createdAt)}
              </div>
            </button>
          </li>
        ))}
      </ul>

      {rows.length === 0 && <p className="py-8 text-center text-sub">기록이 없습니다.</p>}
      {open && <RecordDetail record={open} onClose={() => setOpenId(null)} />}
    </div>
  )
}

/** 배치 목록에서 고른 뒤 그 배치의 기록을 본다 */
export function HistoryTab({ onOpenBatch }: { onOpenBatch(id: string): void }) {
  const db = useDb()
  const actor = useActor()
  const [product, setProduct] = useState('')
  const [query, setQuery] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  // 비교 보고서에 넣을 배치
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [showCompare, setShowCompare] = useState(false)

  const list = useMemo(() => {
    const byBatch = new Map<string, IpcRecord[]>()
    for (const r of db.records) byBatch.set(r.batchId, [...(byBatch.get(r.batchId) ?? []), r])
    const q = query.trim().toLowerCase()
    return db.batches
      .map((b) => {
        const recs = byBatch.get(b.id) ?? []
        const counted = recs.filter((r) => !r.excluded && !r.test)
        return {
          batch: b,
          // 제조일자를 입력하지 않은 배치는 만든 날짜로 찾는다
          date: b.mfgDate || ymd(b.createdAt),
          count: recs.length,
          fails: counted.filter((r) => !r.pass).length,
          tests: recs.filter((r) => r.test).length,
          last: recs.reduce((m, r) => Math.max(m, r.createdAt), 0),
        }
      })
      .filter(
        (x) =>
          (!product || x.batch.productName === product) &&
          (!q || `${x.batch.batchNo} ${x.batch.drugName} ${x.batch.baseName}`.toLowerCase().includes(q)) &&
          (!from || x.date >= from) &&
          (!to || x.date <= to),
      )
      .sort((a, b) => b.date.localeCompare(a.date) || b.batch.createdAt - a.batch.createdAt)
  }, [db.batches, db.records, product, query, from, to])

  const chosen = selected ? db.batches.find((b) => b.id === selected) : undefined
  const comparing = db.batches.filter((b) => picked.has(b.id))
  const togglePick = (id: string) =>
    setPicked((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  if (chosen) return <BatchRecords batch={chosen} onBack={() => setSelected(null)} onOpenBatch={onOpenBatch} />

  const products = [...new Set(db.batches.map((b) => b.productName))]

  function downloadAll() {
    const ids = new Set(list.map((x) => x.batch.id))
    const rows = db.records.filter((r) => ids.has(r.batchId)).sort((a, b) => a.batchNo.localeCompare(b.batchNo) || a.dispenserId.localeCompare(b.dispenserId) || a.seq - b.seq)
    const recIds = new Set(rows.map((r) => r.id))
    const name = `IPC_${product || '전체'}_${from || '처음'}~${to || '현재'}_${ymd(Date.now()).replaceAll('-', '')}.xlsx`
    const trail = db.audit.filter((a) => (recIds.has(a.targetId) || ids.has(a.targetId)) && (actor.role === 'admin' || a.uid === actor.uid))
    exportWorkbook(name, rows, db.batches, db.corrections, trail)
    void logEvent(actor, '엑셀 내보내기', { file: name, batches: list.length, count: rows.length })
  }

  return (
    <div className="flex flex-col gap-3">
      <Panel className="p-3">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-5 md:items-end">
          <Field label="제조일자 시작">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="제조일자 끝">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="제품명">
            <Select value={product} onChange={(e) => setProduct(e.target.value)}>
              <option value="">전체</option>
              {products.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </Select>
          </Field>
          <Field label="배치번호 (약액부명·기저부명으로도 검색)">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} />
          </Field>
          <Button variant="primary" onClick={downloadAll} disabled={list.every((x) => x.count === 0)} className="col-span-2 md:col-span-1">
            조회된 배치 엑셀 내보내기
          </Button>
          <Button onClick={() => setShowCompare(true)} disabled={comparing.length === 0} className="col-span-2 md:col-span-1">
            선택한 배치 비교 보고서{comparing.length ? ` (${comparing.length})` : ''}
          </Button>
        </div>
      </Panel>

      <div className="num flex flex-wrap items-center gap-x-3 text-sm text-sub">
        <span>배치 {list.length}건</span>
        <span>· 비교할 배치를 왼쪽 칸에서 고르세요{comparing.length ? ` (선택 ${comparing.length}개)` : ''}</span>
        {comparing.length > 0 && (
          <button type="button" className="text-accent" onClick={() => setPicked(new Set())}>
            선택 해제
          </button>
        )}
      </div>
      {showCompare && comparing.length > 0 && <CompareReport batches={comparing} onClose={() => setShowCompare(false)} />}

      {/* PC: 표 */}
      <Panel className="hidden overflow-x-auto md:block">
        <table className="num w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-sub">
              <th className="w-8 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="조회된 배치 모두 선택"
                  checked={list.length > 0 && list.every((x) => picked.has(x.batch.id))}
                  onChange={(e) => setPicked(e.target.checked ? new Set(list.map((x) => x.batch.id)) : new Set())}
                />
              </th>
              {['제조일자', '제품명', '배치번호', '상태', '약액부명', '기저부명', 'IPC 기록', '부적합', '테스트', '마지막 기록'].map((h) => (
                <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map(({ batch: b, date, count, fails, tests, last }) => (
              <tr key={b.id} onClick={() => setSelected(b.id)} className="cursor-pointer border-b border-line/60 hover:bg-sunken">
                <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" aria-label={`${b.batchNo} 비교에 넣기`} checked={picked.has(b.id)} onChange={() => togglePick(b.id)} />
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">{date}</td>
                <td className="px-3 py-2.5">{b.productName}</td>
                <td className="px-3 py-2.5 font-semibold">{b.batchNo}</td>
                <td className="px-3 py-2.5 whitespace-nowrap">{b.status === 'closed' ? '완료' : <span className="text-accent">진행 중</span>}</td>
                <td className="px-3 py-2.5">{b.drugName || '–'}</td>
                <td className="px-3 py-2.5">{b.baseName || '–'}</td>
                <td className="px-3 py-2.5">{count}건</td>
                <td className="px-3 py-2.5">{fails ? `${fails}건` : '–'}</td>
                <td className="px-3 py-2.5">{tests ? `${tests}건` : '–'}</td>
                <td className="px-3 py-2.5 whitespace-nowrap">{last ? dateTime(last) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {/* 모바일: 카드 */}
      <ul className="flex flex-col gap-2 md:hidden">
        {list.map(({ batch: b, date, count, fails, tests }) => (
          <li key={b.id} className="flex items-stretch gap-2">
            <label className="flex items-center rounded-xl border border-line bg-panel px-3">
              <input type="checkbox" className="size-4" aria-label={`${b.batchNo} 비교에 넣기`} checked={picked.has(b.id)} onChange={() => togglePick(b.id)} />
            </label>
            <button type="button" onClick={() => setSelected(b.id)} className="num w-full min-w-0 rounded-xl border border-line bg-panel px-3 py-2.5 text-left">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{b.batchNo}</span>
                <span className="text-sm text-sub">
                  {date} · {b.status === 'closed' ? '완료' : '진행 중'}
                </span>
              </div>
              <div className="mt-0.5 text-sm">
                {b.productName} · {b.drugName || '–'} / {b.baseName || '–'}
              </div>
              <div className="mt-0.5 text-xs text-sub">
                IPC {count}건{fails ? ` · 부적합 ${fails}건` : ''}
                {tests ? ` · 테스트 ${tests}건` : ''}
              </div>
            </button>
          </li>
        ))}
      </ul>

      {list.length === 0 && <p className="py-8 text-center text-sub">조건에 맞는 배치가 없습니다.</p>}
    </div>
  )
}
