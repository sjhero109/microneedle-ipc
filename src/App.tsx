import { useState } from 'react'
import { AuthProvider, useAuth } from './data/auth'
import { useDb } from './data/store'
import type { Role } from './data/types'
import { AdminTab } from './ui/AdminTab'
import { BatchBar } from './ui/BatchBar'
import { CalcTab } from './ui/CalcTab'
import { Button, Field, Input } from './ui/common'
import { HistoryTab } from './ui/HistoryTab'
import { LogicTab } from './ui/LogicTab'

type Tab = 'calc' | 'logic' | 'history' | 'admin'
const BATCH_KEY = 'microneedle-ipc/batch'

function Login() {
  const { login } = useAuth()
  const [name, setName] = useState('')
  const enter = (role: Role) => name.trim() && login(name.trim(), role)
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

function Shell() {
  const { actor, logout } = useAuth()
  const db = useDb()
  const [tab, setTab] = useState<Tab>('calc')
  const [batchId, setBatchId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(BATCH_KEY)
    } catch {
      return null
    }
  })
  if (!actor) return <Login />

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
    ['history', '기록 조회'],
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
            <Button className="h-9 px-3 text-sm" onClick={logout}>
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
        {tab === 'history' && <HistoryTab />}
        {tab === 'admin' && actor.role === 'admin' && <AdminTab />}
      </main>

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
