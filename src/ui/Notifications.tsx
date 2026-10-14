import { useEffect, useRef, useState } from 'react'
import { useActor, useAuth } from '../data/auth'
import { reviewCorrection, useDb } from '../data/store'
import type { Correction } from '../data/types'
import { CORRECTION_LABEL } from '../data/types'
import { Button, Input, dateTime } from './common'

/** 승인을 기다리는 정정 요청 한 건: 어떤 기록을 무엇으로 바꾸는지와 승인·반려 */
function Item({ c, onDone }: { c: Correction; onDone(): void }) {
  const db = useDb()
  const actor = useActor()
  const { confirm } = useAuth()
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const r = db.records.find((x) => x.id === c.recordId)
  const review = async (approve: boolean) => {
    setError('')
    try {
      await confirm()
      await reviewCorrection(actor, c.id, approve, note)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : '처리하지 못했습니다.')
    }
  }
  return (
    <li className="num border-b border-line px-3 py-3 text-sm last:border-b-0">
      <div className="font-medium">
        {r ? `${r.batchNo} · ${r.dispenserId} #${r.seq}` : '기록'} — {CORRECTION_LABEL[c.field]} {c.oldValue} → <b>{c.newValue}</b>
      </div>
      <div className="mt-0.5 text-xs text-sub">
        {c.requestedByName} · {dateTime(c.requestedAt)} · {c.reason}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Input className="!h-9 min-w-32 flex-1" placeholder="검토 의견" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button variant="primary" className="h-9 px-3 text-sm" onClick={() => void review(true)}>
          승인
        </Button>
        <Button className="h-9 px-3 text-sm" onClick={() => void review(false)}>
          반려
        </Button>
      </div>
      {error && <p className="mt-1 text-xs text-bad">{error}</p>}
    </li>
  )
}

/**
 * 우측 상단 알림 (관리자만). 새 정정 요청이 들어오면 잠깐 알림을 띄우고,
 * 종 버튼을 누르면 승인 대기 목록을 열어 그 자리에서 승인·반려한다.
 */
export function NotificationBell() {
  const db = useDb()
  const actor = useActor()
  const [open, setOpen] = useState(false)
  const [toast, setToast] = useState<Correction | null>(null)
  const pending = db.corrections.filter((c) => c.status === 'pending').sort((a, b) => b.requestedAt - a.requestedAt)
  const seen = useRef<Set<string> | null>(null)

  // 처음 불러온 목록은 알리지 않고, 그 뒤에 새로 들어온 요청만 알린다
  useEffect(() => {
    const ids = new Set(pending.map((c) => c.id))
    if (seen.current) {
      const fresh = pending.find((c) => !seen.current!.has(c.id) && c.requestedBy !== actor.uid)
      if (fresh) setToast(fresh)
    }
    seen.current = ids
  }, [pending, actor.uid])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 10000)
    return () => clearTimeout(t)
  }, [toast])

  if (actor.role !== 'admin') return null
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`알림 ${pending.length}건`}
        onClick={() => setOpen((o) => !o)}
        className="relative grid size-9 place-items-center rounded-lg border border-line bg-panel hover:bg-sunken"
      >
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {pending.length > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-5 rounded-full bg-bad px-1 text-center text-xs leading-5 font-semibold text-white">{pending.length}</span>
        )}
      </button>

      {open && (
        <div className="fixed top-16 right-3 z-50 w-[min(calc(100vw-1.5rem),26rem)] rounded-xl border border-line bg-panel shadow-lg">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="font-semibold">알림 · 정정 승인 대기 {pending.length}건</span>
            <button type="button" className="h-8 px-2 text-sm text-sub" onClick={() => setOpen(false)}>
              닫기
            </button>
          </div>
          {pending.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-sub">승인을 기다리는 요청이 없습니다.</p>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto">
              {pending.map((c) => (
                <Item key={c.id} c={c} onDone={() => {}} />
              ))}
            </ul>
          )}
        </div>
      )}

      {toast && !open && (
        <button
          type="button"
          role="alert"
          onClick={() => {
            setToast(null)
            setOpen(true)
          }}
          className="fixed top-3 right-3 z-50 w-[min(92vw,22rem)] rounded-xl border-2 border-accent bg-panel px-4 py-3 text-left text-sm shadow-lg"
        >
          <b className="text-accent">새 정정 요청</b>
          <span className="mt-0.5 block">
            {toast.requestedByName} · {CORRECTION_LABEL[toast.field]} {toast.oldValue} → {toast.newValue}
          </span>
          <span className="mt-0.5 block text-xs text-sub">눌러서 확인·승인</span>
        </button>
      )}
    </div>
  )
}
