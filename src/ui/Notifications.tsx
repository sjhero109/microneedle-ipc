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


const SEEN_KEY = 'microneedle-ipc/notice-seen/'

/** 내 요청 결과를 마지막으로 확인한 시각. 이 기기에만 저장한다 */
function readSeen(uid: string): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY + uid) ?? 0)
  } catch {
    return 0
  }
}

function writeSeen(uid: string, at: number) {
  try {
    localStorage.setItem(SEEN_KEY + uid, String(at))
  } catch {
    // 저장이 막혀도 알림은 계속 보인다
  }
}

type Toast = { kind: 'request' | 'result'; c: Correction }

/**
 * 우측 상단 알림.
 * 관리자: 새 정정 요청을 알리고, 목록에서 그 자리에서 승인·반려한다.
 * 모든 사용자: 내가 낸 정정 요청이 승인·반려되면 알린다.
 */
export function NotificationBell() {
  const db = useDb()
  const actor = useActor()
  const admin = actor.role === 'admin'
  const [open, setOpen] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [seenAt, setSeenAt] = useState(() => readSeen(actor.uid))
  // 목록을 연 순간의 확인 시각. 열어 둔 동안에는 그 전에 온 결과에 "새" 표시를 남긴다
  const [newSince, setNewSince] = useState(seenAt)
  const pending = admin ? db.corrections.filter((c) => c.status === 'pending').sort((a, b) => b.requestedAt - a.requestedAt) : []
  // 내가 요청했고 다른 사람이 처리한 것 (최근 20건)
  const results = db.corrections
    .filter((c) => c.requestedBy === actor.uid && c.status !== 'pending' && c.reviewedBy !== actor.uid)
    .sort((a, b) => (b.reviewedAt ?? 0) - (a.reviewedAt ?? 0))
    .slice(0, 20)
  const unread = results.filter((c) => (c.reviewedAt ?? 0) > seenAt)
  const count = pending.length + unread.length

  // 처음 불러온 상태는 알리지 않고, 그 뒤에 바뀐 것만 알린다
  const prev = useRef<Map<string, Correction['status']> | null>(null)
  useEffect(() => {
    const now = new Map(db.corrections.map((c) => [c.id, c.status]))
    const before = prev.current
    if (before) {
      const decided = db.corrections.find((c) => c.requestedBy === actor.uid && c.reviewedBy !== actor.uid && c.status !== 'pending' && before.get(c.id) === 'pending')
      const requested = admin && db.corrections.find((c) => c.status === 'pending' && !before.has(c.id) && c.requestedBy !== actor.uid)
      if (decided) setToast({ kind: 'result', c: decided })
      else if (requested) setToast({ kind: 'request', c: requested })
    }
    prev.current = now
  }, [db.corrections, actor.uid, admin])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 10000)
    return () => clearTimeout(t)
  }, [toast])

  const openPanel = () => {
    setOpen(true)
    setNewSince(seenAt)
    // 목록을 열면 내 요청 결과는 읽은 것으로 본다
    const latest = Math.max(seenAt, ...results.map((c) => c.reviewedAt ?? 0))
    setSeenAt(latest)
    writeSeen(actor.uid, latest)
  }

  const record = (c: Correction) => {
    const r = db.records.find((x) => x.id === c.recordId)
    return r ? `${r.batchNo} · ${r.dispenserId} #${r.seq}` : '기록'
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`알림 ${count}건`}
        onClick={() => (open ? setOpen(false) : openPanel())}
        className="relative grid size-9 place-items-center rounded-lg border border-line bg-panel hover:bg-sunken"
      >
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {count > 0 && <span className="absolute -top-1.5 -right-1.5 min-w-5 rounded-full bg-bad px-1 text-center text-xs leading-5 font-semibold text-white">{count}</span>}
      </button>

      {open && (
        <div className="fixed top-16 right-3 z-50 w-[min(calc(100vw-1.5rem),26rem)] rounded-xl border border-line bg-panel shadow-lg">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="font-semibold">알림</span>
            <button type="button" className="h-8 px-2 text-sm text-sub" onClick={() => setOpen(false)}>
              닫기
            </button>
          </div>
          <div className="max-h-[65vh] overflow-y-auto">
            {admin && (
              <>
                <div className="bg-sunken px-3 py-1.5 text-xs font-semibold text-sub">정정 승인 대기 {pending.length}건</div>
                {pending.length === 0 ? (
                  <p className="px-3 py-4 text-center text-sm text-sub">승인을 기다리는 요청이 없습니다.</p>
                ) : (
                  <ul>
                    {pending.map((c) => (
                      <Item key={c.id} c={c} onDone={() => {}} />
                    ))}
                  </ul>
                )}
              </>
            )}
            <div className="bg-sunken px-3 py-1.5 text-xs font-semibold text-sub">내 정정 요청 결과</div>
            {results.length === 0 ? (
              <p className="px-3 py-4 text-center text-sm text-sub">처리된 요청이 없습니다.</p>
            ) : (
              <ul>
                {results.map((c) => (
                  <li key={c.id} className="num border-b border-line px-3 py-2.5 text-sm last:border-b-0">
                    <div>
                      <b className={c.status === 'approved' ? 'text-good' : 'text-bad'}>{c.status === 'approved' ? '승인' : '반려'}</b> · {record(c)} — {CORRECTION_LABEL[c.field]} {c.oldValue} → {c.newValue}
                      {(c.reviewedAt ?? 0) > newSince && <span className="ml-1 rounded bg-bad px-1 text-xs text-white">새</span>}
                    </div>
                    <div className="mt-0.5 text-xs text-sub">
                      {c.reviewedByName} · {c.reviewedAt ? dateTime(c.reviewedAt) : ''}
                      {c.reviewNote ? ` · ${c.reviewNote}` : ''}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {toast && !open && (
        <button
          type="button"
          role="alert"
          onClick={() => {
            setToast(null)
            openPanel()
          }}
          className={`fixed top-3 right-3 z-50 w-[min(92vw,22rem)] rounded-xl border-2 bg-panel px-4 py-3 text-left text-sm shadow-lg ${
            toast.kind === 'request' ? 'border-accent' : toast.c.status === 'approved' ? 'border-good' : 'border-bad'
          }`}
        >
          {toast.kind === 'request' ? (
            <>
              <b className="text-accent">새 정정 요청</b>
              <span className="mt-0.5 block">
                {toast.c.requestedByName} · {CORRECTION_LABEL[toast.c.field]} {toast.c.oldValue} → {toast.c.newValue}
              </span>
              <span className="mt-0.5 block text-xs text-sub">눌러서 확인·승인</span>
            </>
          ) : (
            <>
              <b className={toast.c.status === 'approved' ? 'text-good' : 'text-bad'}>정정 요청이 {toast.c.status === 'approved' ? '승인' : '반려'}되었습니다</b>
              <span className="mt-0.5 block">
                {record(toast.c)} — {CORRECTION_LABEL[toast.c.field]} {toast.c.oldValue} → {toast.c.newValue}
              </span>
              <span className="mt-0.5 block text-xs text-sub">
                {toast.c.reviewedByName}
                {toast.c.reviewNote ? ` · ${toast.c.reviewNote}` : ''}
              </span>
            </>
          )}
        </button>
      )}
    </div>
  )
}
