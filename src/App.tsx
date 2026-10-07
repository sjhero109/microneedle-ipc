import { useState } from 'react'
import { AuthProvider, useAuth } from './data/auth'
import { useDb, useDbLoaded } from './data/store'
import type { Role } from './data/types'
import { AdminTab } from './ui/AdminTab'
import { BatchBar } from './ui/BatchBar'
import { CalcTab } from './ui/CalcTab'
import { ChangePassword } from './ui/ChangePassword'
import { Button, Field, Input, Modal } from './ui/common'
import { HistoryTab } from './ui/HistoryTab'
import { LogicTab } from './ui/LogicTab'

type Tab = 'calc' | 'logic' | 'history' | 'admin'
const BATCH_KEY = 'microneedle-ipc/batch'

function Login() {
  const { mode, loginDemo, signIn, signUp, error, notice } = useAuth()
  const [joining, setJoining] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  if (mode === 'demo') {
    const enter = (role: Role) => name.trim() && loginDemo(name.trim(), role)
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-4">
        <h1 className="text-2xl font-bold">마이크로니들 IPC</h1>
        <Field label="이름">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="primary" disabled={!name.trim()} onClick={() => enter('user')}>
            일반 사용자
          </Button>
          <Button disabled={!name.trim()} onClick={() => enter('admin')}>
            관리자
          </Button>
        </div>
        <p className="text-xs text-sub">시연 모드입니다. 기록은 이 브라우저에만 저장됩니다.</p>
      </main>
    )
  }

  async function submit() {
    setBusy(true)
    if (joining) await signUp(name.trim(), email.trim(), password)
    else await signIn(email.trim(), password)
    setBusy(false)
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-bold">마이크로니들 IPC</h1>
      {joining && (
        <Field label="이름">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </Field>
      )}
      <Field label="이메일">
        <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      </Field>
      <Field label={joining ? '비밀번호 (6자 이상)' : '비밀번호'}>
        <Input type="password" autoComplete={joining ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </Field>
      {error && <p className="text-sm text-bad">{error}</p>}
      {notice && <p className="text-sm text-good">{notice}</p>}
      <Button variant="primary" disabled={!email.trim() || !password || (joining && !name.trim()) || busy} onClick={submit}>
        {joining ? '회원가입' : '로그인'}
      </Button>
      <button type="button" className="h-11 text-sm text-accent" onClick={() => setJoining((j) => !j)}>
        {joining ? '로그인으로 돌아가기' : '회원가입'}
      </button>
      {joining && <p className="text-xs text-sub">가입한 뒤 관리자가 승인하면 사용할 수 있습니다.</p>}
    </main>
  )
}

function Shell() {
  const { actor, logout, ready, mustChange, mode } = useAuth()
  const [changing, setChanging] = useState(false)
  const db = useDb()
  const loaded = useDbLoaded()
  const [tab, setTab] = useState<Tab>('calc')
  const [batchId, setBatchId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(BATCH_KEY)
    } catch {
      return null
    }
  })
  if (!ready) return <p className="p-8 text-center text-sub">불러오는 중…</p>
  if (!actor) return <Login />
  if (mustChange) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 px-4">
        <h1 className="text-2xl font-bold">비밀번호 변경</h1>
        <ChangePassword forced />
      </main>
    )
  }
  if (!loaded) return <p className="p-8 text-center text-sub">불러오는 중…</p>

  const batch = db.batches.find((b) => b.id === batchId) ?? null
  const select = (id: string | null) => {
    setBatchId(id)
    try {
      if (id) localStorage.setItem(BATCH_KEY, id)
      else localStorage.removeItem(BATCH_KEY)
    } catch {
      // 저장이 막혀도 이번 화면에서는 선택을 유지한다
    }
  }

  const tabs: [Tab, string][] = [
    ['calc', '계산'],
    ['logic', '계산 로직'],
    ['history', '결과'],
  ]
  if (actor.role === 'admin') tabs.push(['admin', '관리자'])

  return (
    <div className="mx-auto flex min-h-screen max-w-[1500px] flex-col gap-3 px-3 pt-3 pb-6 sm:px-4">
      <header className="rounded-xl border border-line bg-panel p-3 sm:p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h1 className="text-lg font-bold whitespace-nowrap">마이크로니들 IPC</h1>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-right leading-tight whitespace-nowrap">
              <span className="block font-medium">{actor.name}</span>
              <span className="block text-xs text-sub">{actor.role === 'admin' ? '관리자' : '일반 사용자'}</span>
            </span>
            {mode === 'firebase' && (
              <Button className="h-9 px-3 text-sm" onClick={() => setChanging(true)}>
                비밀번호 변경
              </Button>
            )}
            <Button className="h-9 px-3 text-sm" onClick={() => void logout()}>
              로그아웃
            </Button>
          </div>
        </div>
        <BatchBar key={batch?.id ?? 'none'} batch={batch} onSelect={select} />
      </header>

      <nav className="flex gap-1 overflow-x-auto" role="tablist">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`h-11 rounded-lg px-4 font-medium whitespace-nowrap ${tab === id ? 'bg-accent text-accent-ink' : 'text-sub hover:bg-panel'}`}
          >
            {label}
          </button>
        ))}
      </nav>

      <main className="flex-1">
        {tab === 'calc' && <CalcTab batch={batch} />}
        {tab === 'logic' && <LogicTab batch={batch} />}
        {tab === 'history' && (
          <HistoryTab
            onOpenBatch={(id) => {
              select(id)
              setTab('calc')
            }}
          />
        )}
        {tab === 'admin' && actor.role === 'admin' && <AdminTab />}
      </main>

      {changing && (
        <Modal title="비밀번호 변경" onClose={() => setChanging(false)}>
          <ChangePassword onDone={() => setChanging(false)} />
        </Modal>
      )}

      <footer className="text-center text-xs text-sub">공정 보조 계산 도구 – 최종 판단과 공식 기록은 작업자와 공식 기록서 기준</footer>
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}
