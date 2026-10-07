import { useMemo, useState } from 'react'
import { useActor, useAuth } from '../data/auth'
import { exportWorkbook } from '../data/excel'
import { logEvent, requestCorrection, setExcluded, useDb } from '../data/store'
import type { Correction, IpcRecord } from '../data/types'
import { DISPENSERS } from '../data/types'
import { Button, Deviation, Field, Input, Modal, NumInput, Panel, Select, dateTime, fmt, parseNum } from './common'

const PAGE = 50
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
    ['트레이 / 구분', `${record.tray} / ${record.phase === 'startup' ? '토출 개시 전' : '공정 중'}${record.test ? ' / 테스트' : ''}`],
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
              {a.name} ({a.role === 'admin' ? '관리자' : '일반'})
            </span>
            {a.reason && <span className="text-sub">{a.reason}</span>}
          </li>
        ))}
      </ul>
    </Modal>
  )
}

export function HistoryTab() {
  const db = useDb()
  const actor = useActor()
  const [product, setProduct] = useState('')
  const [batchNo, setBatchNo] = useState('')
  const [material, setMaterial] = useState('')
  const [dispenser, setDispenser] = useState('')
  const [author, setAuthor] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(0)
  const [openId, setOpenId] = useState<string | null>(null)

  const batches = useMemo(() => new Map(db.batches.map((b) => [b.id, b])), [db.batches])
  const products = [...new Set(db.records.map((r) => r.productName))]

  const rows = useMemo(() => {
    const f = from ? new Date(`${from}T00:00:00`).getTime() : -Infinity
    const t = to ? new Date(`${to}T23:59:59`).getTime() : Infinity
    const q = (s: string, v: string) => !v.trim() || s.toLowerCase().includes(v.trim().toLowerCase())
    return db.records
      .filter((r) => {
        const b = batches.get(r.batchId)
        return (
          (!product || r.productName === product) &&
          q(r.batchNo, batchNo) &&
          q(`${b?.drugName ?? ''} ${b?.baseName ?? ''} ${r.materialName}`, material) &&
          (!dispenser || r.dispenserId === dispenser) &&
          q(r.createdByName, author) &&
          r.createdAt >= f &&
          r.createdAt <= t
        )
      })
      .sort((a, b) => b.createdAt - a.createdAt || a.dispenserId.localeCompare(b.dispenserId) || b.seq - a.seq)
  }, [db.records, batches, product, batchNo, material, dispenser, author, from, to])

  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const cur = Math.min(page, pages - 1)
  const shown = rows.slice(cur * PAGE, (cur + 1) * PAGE)
  const open = openId ? db.records.find((r) => r.id === openId) : undefined

  function download() {
    const ymd = new Date().toLocaleDateString('sv-SE').replaceAll('-', '')
    const name = `IPC_${product || '전체'}_${batchNo.trim() || '전체'}_${ymd}.xlsx`
    const ids = new Set(rows.map((r) => r.id))
    const bids = new Set(rows.map((r) => r.batchId))
    const trail = db.audit.filter((a) => (ids.has(a.targetId) || bids.has(a.targetId)) && (actor.role === 'admin' || a.uid === actor.uid))
    exportWorkbook(name, rows, db.batches, db.corrections, trail)
    void logEvent(actor, '엑셀 내보내기', { file: name, count: rows.length })
  }

  const reset = () => setPage(0)

  return (
    <div className="flex flex-col gap-3">
      <Panel className="p-3">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8 xl:items-end">
          <Field label="제품명">
            <Select value={product} onChange={(e) => (setProduct(e.target.value), reset())}>
              <option value="">전체</option>
              {products.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </Select>
          </Field>
          <Field label="배치번호">
            <Input value={batchNo} onChange={(e) => (setBatchNo(e.target.value), reset())} />
          </Field>
          <Field label="약액부명·기저부명">
            <Input value={material} onChange={(e) => (setMaterial(e.target.value), reset())} />
          </Field>
          <Field label="토출기">
            <Select value={dispenser} onChange={(e) => (setDispenser(e.target.value), reset())}>
              <option value="">전체</option>
              {DISPENSERS.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="작성자">
            <Input value={author} onChange={(e) => (setAuthor(e.target.value), reset())} />
          </Field>
          <Field label="시작일">
            <Input type="date" value={from} onChange={(e) => (setFrom(e.target.value), reset())} />
          </Field>
          <Field label="종료일">
            <Input type="date" value={to} onChange={(e) => (setTo(e.target.value), reset())} />
          </Field>
          <Button variant="primary" onClick={download} disabled={rows.length === 0}>
            엑셀 내보내기
          </Button>
        </div>
      </Panel>

      <div className="num flex items-center justify-between text-sm text-sub">
        <span>{rows.length}건</span>
        {pages > 1 && (
          <span className="flex items-center gap-2">
            <Button className="h-9 px-3" disabled={cur === 0} onClick={() => setPage(cur - 1)}>
              이전
            </Button>
            {cur + 1} / {pages}
            <Button className="h-9 px-3" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>
              다음
            </Button>
          </span>
        )}
      </div>

      {/* PC: 표 */}
      <Panel className="hidden overflow-x-auto md:block">
        <table className="num w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-sub">
              {['작성시각', '제품명', '배치번호', '토출기', '물질명', '트레이', '구분', 'Pulse', '합산 중량', '편차', '판정', '추천 Pulse', '작성자'].map((h) => (
                <th key={h} className="px-3 py-2 font-medium whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} onClick={() => setOpenId(r.id)} className={`cursor-pointer border-b border-line/60 hover:bg-sunken ${r.excluded ? 'text-sub line-through' : ''}`}>
                <td className="px-3 py-2 whitespace-nowrap">{dateTime(r.createdAt)}</td>
                <td className="px-3 py-2">{r.productName}</td>
                <td className="px-3 py-2">{r.batchNo}</td>
                <td className="px-3 py-2">{r.dispenserId}</td>
                <td className="px-3 py-2">{r.materialName}</td>
                <td className="px-3 py-2">{r.tray}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {r.phase === 'startup' ? '개시 전' : '공정 중'}
                  {r.test && <span className="ml-1 rounded bg-sunken px-1 text-xs text-sub">테스트</span>}
                </td>
                <td className="px-3 py-2">{r.pulse}</td>
                <td className="px-3 py-2">{fmt(r.totalWeight, 2)}</td>
                <td className="px-3 py-2">
                  <Deviation devPct={r.devPct} band={r.band} />
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{r.pass ? '적합' : '부적합'}</td>
                <td className="px-3 py-2">{r.recommendedPulse ?? '–'}</td>
                <td className="px-3 py-2 whitespace-nowrap">{r.createdByName}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      {/* 모바일: 카드 */}
      <ul className="flex flex-col gap-2 md:hidden">
        {shown.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => setOpenId(r.id)} className={`num w-full rounded-xl border border-line bg-panel px-3 py-2.5 text-left ${r.excluded ? 'text-sub line-through' : ''}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold">
                  {r.dispenserId} · 트레이 {r.tray}
                  {r.phase === 'startup' && <span className="ml-1 text-xs font-normal text-sub">개시 전</span>}
                  {r.test && <span className="ml-1 text-xs font-normal text-sub">테스트</span>}
                </span>
                <Deviation devPct={r.devPct} band={r.band} />
              </div>
              <div className="mt-0.5 flex items-center justify-between gap-2 text-sm">
                <span>
                  Pulse {r.pulse} · {fmt(r.totalWeight, 2)} mg · {r.pass ? '적합' : '부적합'}
                </span>
              </div>
              <div className="mt-0.5 truncate text-xs text-sub">
                {r.productName} / {r.batchNo} · {r.createdByName} · {dateTime(r.createdAt)}
              </div>
            </button>
          </li>
        ))}
      </ul>

      {rows.length === 0 && <p className="py-8 text-center text-sub">조건에 맞는 기록이 없습니다.</p>}
      {open && <Detail record={open} onClose={() => setOpenId(null)} />}
    </div>
  )
}
