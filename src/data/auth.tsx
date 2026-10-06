import { browserSessionPersistence, onAuthStateChanged, setPersistence, signInWithEmailAndPassword, signOut } from 'firebase/auth'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Field, Input, Modal } from '../ui/common'
import { firebaseBackend, firebaseEnabled, loadProfile, services, verifyPassword } from './firebase'
import { clearBackend, logEvent, setBackend } from './store'
import type { Actor, Role } from './types'

/** 이 시간 동안 입력이 없으면 자동으로 로그아웃한다 */
const IDLE_MS = 15 * 60 * 1000

interface AuthState {
  mode: 'demo' | 'firebase'
  actor: Actor | null
  /** 로그인 상태를 확인하는 중이면 false */
  ready: boolean
  error: string
  loginDemo(name: string, role: Role): void
  signIn(email: string, password: string): Promise<void>
  logout(): Promise<void>
  /** 중요 작업 전에 비밀번호를 다시 확인한다. 취소하거나 틀리면 예외를 던진다 */
  confirm(): Promise<void>
}

const Ctx = createContext<AuthState | null>(null)
const DEMO_KEY = 'microneedle-ipc/actor'

function loadDemo(): Actor | null {
  if (firebaseEnabled) return null
  try {
    return JSON.parse(sessionStorage.getItem(DEMO_KEY) ?? 'null')
  } catch {
    return null
  }
}

function PasswordPrompt({ onDone }: { onDone(ok: boolean): void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit() {
    setBusy(true)
    setError('')
    try {
      await verifyPassword(password)
      onDone(true)
    } catch {
      setError('비밀번호가 맞지 않습니다.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title="비밀번호 확인" onClose={() => onDone(false)}>
      <p className="mb-3 text-sm text-sub">이 작업은 본인 확인이 필요합니다. 비밀번호를 다시 입력하세요.</p>
      <Field label="비밀번호">
        <Input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </Field>
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
      <Button variant="primary" className="mt-3" disabled={!password || busy} onClick={submit}>
        확인
      </Button>
    </Modal>
  )
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [actor, setActor] = useState<Actor | null>(loadDemo)
  const [ready, setReady] = useState(!firebaseEnabled)
  const [error, setError] = useState('')
  const [prompt, setPrompt] = useState<{ done(ok: boolean): void } | null>(null)
  // 직접 로그인했을 때만 '로그인'을 기록한다 (새로고침으로 복원된 경우는 제외)
  const explicit = useRef(false)

  useEffect(() => {
    if (!firebaseEnabled) return
    const { auth } = services()
    return onAuthStateChanged(auth, async (user) => {
      if (!user) {
        clearBackend()
        setActor(null)
        setReady(true)
        return
      }
      try {
        const profile = await loadProfile(user.uid)
        if (!profile || !profile.active) {
          await signOut(auth)
          setError('사용 권한이 없는 계정입니다. 관리자에게 문의하세요.')
          return
        }
        const a: Actor = { uid: user.uid, name: profile.name, email: user.email ?? profile.email, role: profile.role }
        setBackend(firebaseBackend(a))
        setActor(a)
        if (explicit.current) void logEvent(a, '로그인')
        explicit.current = false
      } catch {
        await signOut(auth)
        setError('사용자 정보를 읽지 못했습니다. 네트워크를 확인하세요.')
      } finally {
        setReady(true)
      }
    })
  }, [])

  const loginDemo = useCallback((name: string, role: Role) => {
    const a: Actor = { uid: `local-${role}-${name}`, name, email: `${name}@local`, role }
    try {
      sessionStorage.setItem(DEMO_KEY, JSON.stringify(a))
    } catch {
      // 저장이 막혀도 이번 화면에서는 로그인 상태를 유지한다
    }
    setActor(a)
    void logEvent(a, '로그인')
  }, [])

  const signIn = useCallback(async (email: string, password: string) => {
    setError('')
    const { auth } = services()
    try {
      // 탭을 닫으면 로그인이 풀리게 한다 (공용 PC)
      await setPersistence(auth, browserSessionPersistence)
      explicit.current = true
      await signInWithEmailAndPassword(auth, email, password)
    } catch {
      explicit.current = false
      setError('이메일 또는 비밀번호가 맞지 않습니다.')
    }
  }, [])

  const leave = useCallback(
    async (action: string) => {
      if (actor) {
        try {
          await logEvent(actor, action)
        } catch {
          // 기록에 실패해도 로그아웃은 진행한다
        }
      }
      if (firebaseEnabled) {
        await signOut(services().auth)
      } else {
        try {
          sessionStorage.removeItem(DEMO_KEY)
        } catch {
          // 무시
        }
        setActor(null)
      }
    },
    [actor],
  )

  useEffect(() => {
    if (!actor) return
    let timer = setTimeout(() => void leave('자동 로그아웃'), IDLE_MS)
    const reset = () => {
      clearTimeout(timer)
      timer = setTimeout(() => void leave('자동 로그아웃'), IDLE_MS)
    }
    window.addEventListener('pointerdown', reset)
    window.addEventListener('keydown', reset)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('pointerdown', reset)
      window.removeEventListener('keydown', reset)
    }
  }, [actor, leave])

  const confirm = useCallback(() => {
    if (!firebaseEnabled) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      setPrompt({
        done(ok) {
          setPrompt(null)
          if (ok) resolve()
          else reject(new Error('본인 확인을 취소했습니다.'))
        },
      })
    })
  }, [])

  const value = useMemo<AuthState>(
    () => ({ mode: firebaseEnabled ? 'firebase' : 'demo', actor, ready, error, loginDemo, signIn, logout: () => leave('로그아웃'), confirm }),
    [actor, ready, error, loginDemo, signIn, leave, confirm],
  )
  return (
    <Ctx.Provider value={value}>
      {children}
      {prompt && <PasswordPrompt onDone={prompt.done} />}
    </Ctx.Provider>
  )
}

export function useAuth(): AuthState {
  const v = useContext(Ctx)
  if (!v) throw new Error('AuthProvider가 필요합니다.')
  return v
}

/** 로그인한 화면에서만 쓴다 */
export function useActor(): Actor {
  const { actor } = useAuth()
  if (!actor) throw new Error('로그인이 필요합니다.')
  return actor
}
