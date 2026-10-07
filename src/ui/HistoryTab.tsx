import { useMemo, useState } from 'react'
import { useActor, useAuth } from '../data/auth'
import { exportWorkbook } from '../data/excel'
import { dispenserView, evaluate, trayLabels, unused } from '../data/model'
import { logEvent, requestCorrection, setExcluded, useDb } from '../data/store'
import type { Batch, Correction, IpcRecord } from '../data/types'
import { DISPENSERS, roleLabel, targetOf } from '../data/types'
import { TrendChart } from './TrendChart'
import { Button, Deviation, Field, Input, Modal, NumInput, Panel, Select, dateTime, fmt, parseNum } from './common'

const FIELD_LABEL: Record<Correction['field'], string> = { tray: '트레이번호', pulse: 'Pulse', totalWeight: '합산 중량' }
const STATUS = { pending: '승인 대기', approved: '승인', rejected: '반려' } as const

function Detail({ record, onClose }: { record: IpcRecord; onClose(): void }) {
  const db = useDb()
  const actor = useActor()
  const [field, setField] = useState<Correction['field']>('totalWeight')
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')
  const [exReason, setExReason] = useState('')
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
    ['Pulse', String(record.pulse)],
    ['합산 중량', `${fmt(record.totalWeight, 3)} mg (같은 Pulse로 ${record.shots}회 토출)`],
    ['1회 중량 / 목표', `${fmt(record.weight, 3)} / ${fmt(record.target, 2)} mg`],
    ['추천 Pulse', record.recommendedPulse === null ? '–' : String(record.recommendedPulse)],
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
        <Field label="항목">
          <Select value={field} onChange={(e) => setField(e.target.value as Correction['field'])}>
            {Object.entries(FIELD_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v} (현재 {record[k as Correction['field']]})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="정정할 값">
          <NumInput value={value} onChange={(e) => setValue(e.target.value)} />
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
  const target = targetOf(batch, dispenser.type)
  const used = records.filter((r) => !unused(r))
  // 추정 수준은 저장 당시 값이 아니라 지금의 계산식으로 다시 그린다
  const steps = useMemo(() => [...dispenserView(db, batch, dispenser.id).model.steps], [db, batch, dispenser.id])
  const levels = new Map(used.map((r, i) => [r.id, steps[i]?.levelAtPulse]))
  const fails = used.filter((r) => !r.pass).length
  const mean = used.length ? used.reduce((s, r) => s + r.weight, 0) / used.length : null
  const changes = used.filter((r, i) => i > 0 && r.pulse !== used[i - 1].pulse).length
  const items: [string, React.ReactNode][] = [
    ['IPC', `${used.length}회`],
    ['적합 / 부적합', `${used.length - fails} / ${fails}`],
    ['평균 중량', mean === null ? '–' : <>{fmt(mean, 3)} mg <Deviation {...evaluate(batch, dispenser.type, mean)} /></>],
    ['Pulse', used.length ? `${used[0].pulse} → ${used.at(-1)!.pulse} (조정 ${changes}회)` : '–'],
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
            pct: (r.weight / target) * 100,
            levelPct: levels.get(r.id) === undefined ? null : (levels.get(r.id)! / target) * 100,
            band: r.band,
            excluded: unused(r),
            test: r.test,
          }))}
          adjustPct={batch.adjustPct}
          passLow={batch.passLowPct}
          passHigh={batch.passHighPct}
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

  const all = useMemo(
    () => db.records.filter((r) => r.batchId === batch.id).sort((a, b) => a.dispenserId.localeCompare(b.dispenserId) || a.seq - b.seq),
    [db.records, batch.id],
  )
  const rows = dispenser ? all.filter((r) => r.dispenserId === dispenser) : all
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
  ]

  return (
    <div className="flex flex-col gap-3">
      <Panel className="p-3 sm:p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <Button onClick={onBack} className="h-10 px-3 text-sm">
            ← 배치 목록
          </Button>
          <div className="flex gap-2">
            <Button onClick={() => onOpenBatch(batch.id)} className="h-10 px-3 text-sm">
              계산 탭에서 열기
            </Button>
            <Button variant="primary" onClick={download} disabled={all.length === 0} className="h-10 px-3 text-sm">
              엑셀 내보내기
            </Button>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-3 xl:grid-cols-6">
          {info.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-xs text-sub">{k}</dt>
              <dd className="num font-semibold break-words">{v}</dd>
            </div>
          ))}
        </dl>
      </Panel>

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
              {['토출기', '#', '트레이-회차', '', 'Pulse', '합산 중량', '1회 중량', '편차', '판정', '추천 Pulse', '작성자', '작성시각'].map((h) => (
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
                Pulse {r.pulse} · {fmt(r.totalWeight, 2)} mg · {r.pass ? '적합' : '부적합'}
              </div>
              <div className="mt-0.5 truncate text-xs text-sub">
                {r.createdByName} · {dateTime(r.createdAt)}
              </div>
            </button>
          </li>
        ))}
      </ul>

      {rows.length === 0 && <p className="py-8 text-center text-sub">기록이 없습니다.</p>}
      {open && <Detail record={open} onClose={() => setOpenId(null)} />}
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
        </div>
      </Panel>

      <div className="num text-sm text-sub">배치 {list.length}건</div>

      {/* PC: 표 */}
      <Panel className="hidden overflow-x-auto md:block">
        <table className="num w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-sub">
              {['제조일자', '제품명', '배치번호', '약액부명', '기저부명', 'IPC 기록', '부적합', '테스트', '마지막 기록'].map((h) => (
                <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map(({ batch: b, date, count, fails, tests, last }) => (
              <tr key={b.id} onClick={() => setSelected(b.id)} className="cursor-pointer border-b border-line/60 hover:bg-sunken">
                <td className="px-3 py-2.5 whitespace-nowrap">{date}</td>
                <td className="px-3 py-2.5">{b.productName}</td>
                <td className="px-3 py-2.5 font-semibold">{b.batchNo}</td>
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
          <li key={b.id}>
            <button type="button" onClick={() => setSelected(b.id)} className="num w-full rounded-xl border border-line bg-panel px-3 py-2.5 text-left">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">{b.batchNo}</span>
                <span className="text-sm text-sub">{date}</span>
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
