import { browserSessionPersistence, onAuthStateChanged, setPersistence, signOut, type User } from 'firebase/auth'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Field, Input, Modal } from '../ui/common'
import {
  changeOwnPassword,
  clearLoginFailures,
  firebaseBackend,
  firebaseEnabled,
  isAdminEmail,
  lastPasswordChange,
  loadProfile,
  loginLock,
  unlockOwnAccount,
  recordLoginFailure,
  services,
  signIn as signInAccount,
  signUp as createOwnAccount,
  verifyPassword,
} from './firebase'
import { clearBackend, logEvent, setBackend } from './store'
import type { Actor, Role } from './types'
import { MAX_LOGIN_FAILS } from './types'

/** 이 시간 동안 입력이 없으면 자동으로 로그아웃한다 */
const IDLE_MS = 15 * 60 * 1000
const LOCKED_ADMIN_MESSAGE = `로그인 ${MAX_LOGIN_FAILS}회 실패로 관리자 계정이 잠겼습니다. 가입한 이메일로 보낸 메일에서 새 비밀번호를 정한 뒤 로그인하면 잠금이 풀립니다.`
const LOCKED_MESSAGE = `로그인 ${MAX_LOGIN_FAILS}회 실패로 계정이 잠겼습니다. 관리자에게 잠금 해제를 요청하세요.`
/** 로그아웃 기록이 저장되기를 기다리는 최대 시간 */
const LOGOUT_WAIT_MS = 3000

interface AuthState {
  mode: 'demo' | 'firebase'
  actor: Actor | null
  /** 로그인 상태를 확인하는 중이면 false */
  ready: boolean
  error: string
  loginDemo(name: string, role: Role): void
  signIn(email: string, password: string): Promise<void>
  /** 가입 신청. 맨 처음 가입한 사람은 관리자가 된다 */
  signUp(name: string, email: string, password: string): Promise<void>
  /** 오류가 아닌 안내 문구 (가입 신청 접수 등) */
  notice: string
  /** 초기화된 비밀번호로 들어온 경우: 새 비밀번호를 정하기 전에는 쓸 수 없다 */
  mustChange: boolean
  changePassword(current: string, next: string): Promise<void>
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

  const [notice, setNotice] = useState('')
  const [mustChange, setMustChange] = useState(false)
  // 가입 처리 중에는 users 문서가 아직 없으므로 로그인 상태 변화를 잠시 무시한다
  const signingUp = useRef(false)

  const enter = useCallback(async (user: User) => {
    const { auth } = services()
    try {
      const profile = await loadProfile(user.uid)
      if (!profile || !profile.active) {
        await signOut(auth)
        if (profile?.pending) setNotice('가입 신청이 접수되어 있습니다. 관리자가 승인하면 로그인할 수 있습니다.')
        else setError('사용 권한이 없는 계정입니다. 관리자에게 문의하세요.')
        return
      }
      // 잠긴 계정은 비밀번호가 맞아도 들어올 수 없다. 잠기지 않았으면 실패 횟수를 지운다
      const email = (user.email ?? profile.email).toLowerCase()
      const lock = await loginLock(email)
      let selfUnlocked = false
      if (lock.locked) {
        // 잠긴 관리자는 메일로 비밀번호를 다시 정한 경우에만 들어올 수 있다
        const renewed = profile.role === 'admin' && (await lastPasswordChange(user)) > lock.updatedAt
        if (!renewed) {
          await signOut(auth)
          setError(profile.role === 'admin' ? LOCKED_ADMIN_MESSAGE : LOCKED_MESSAGE)
          return
        }
        await unlockOwnAccount(email)
        selfUnlocked = true
      } else if (lock.fails > 0) void clearLoginFailures(email).catch(() => {})
      const a: Actor = { uid: user.uid, name: profile.name, email: user.email ?? profile.email, role: profile.role }
      setBackend(firebaseBackend(a))
      setMustChange(profile.mustChangePassword === true)
      setActor(a)
      if (selfUnlocked) void logEvent(a, '계정 잠금 해제 (비밀번호 재설정)')
      if (explicit.current) void logEvent(a, '로그인')
      explicit.current = false
    } catch {
      await signOut(auth)
      setError('사용자 정보를 읽지 못했습니다. 네트워크를 확인하세요.')
    } finally {
      setReady(true)
    }
  }, [])

  useEffect(() => {
    if (!firebaseEnabled) return
    return onAuthStateChanged(services().auth, (user) => {
      if (signingUp.current) return
      if (!user) {
        clearBackend()
        setActor(null)
        setReady(true)
        return
      }
      void enter(user)
    })
  }, [enter])

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
    setNotice('')
    const { auth } = services()
    const key = email.toLowerCase()
    let lockedAdmin = false
    try {
      if ((await loginLock(key)).locked) {
        if (!(await isAdminEmail(key))) {
          setError(LOCKED_MESSAGE)
          return
        }
        // 관리자는 메일로 정한 새 비밀번호인지 확인해야 하므로 로그인을 시도하게 둔다
        lockedAdmin = true
      }
    } catch {
      // 잠금 여부를 읽지 못해도 로그인은 시도한다. 잠긴 계정은 규칙이 막는다
    }
    try {
      // 탭을 닫으면 로그인이 풀리게 한다 (공용 PC)
      await setPersistence(auth, browserSessionPersistence)
      explicit.current = true
      await signInAccount(email, password)
    } catch (e) {
      explicit.current = false
      const code = (e as { code?: string }).code ?? ''
      if (code === 'auth/too-many-requests') {
        setError('로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.')
        return
      }
      if (code === 'auth/network-request-failed') {
        setError('네트워크에 연결할 수 없습니다.')
        return
      }
      if (lockedAdmin) {
        setError(LOCKED_ADMIN_MESSAGE)
        return
      }
      try {
        const lock = await recordLoginFailure(key)
        setError(lock.mailed ? LOCKED_ADMIN_MESSAGE : lock.locked ? LOCKED_MESSAGE : `이메일 또는 비밀번호가 맞지 않습니다. (${lock.fails}/${MAX_LOGIN_FAILS}회 실패 – ${MAX_LOGIN_FAILS}회가 되면 계정이 잠깁니다)`)
      } catch {
        setError('이메일 또는 비밀번호가 맞지 않습니다.')
      }
    }
  }, [])

  const signUp = useCallback(
    async (name: string, email: string, password: string) => {
      setError('')
      setNotice('')
      const { auth } = services()
      signingUp.current = true
      try {
        await setPersistence(auth, browserSessionPersistence)
        await createOwnAccount(name, email, password)
        explicit.current = true
        signingUp.current = false
        if (auth.currentUser) await enter(auth.currentUser)
      } catch (e) {
        const code = (e as { code?: string }).code ?? ''
        setError(
          code === 'auth/weak-password'
            ? '비밀번호는 6자 이상이어야 합니다.'
            : code === 'auth/invalid-email'
              ? '이메일 형식이 올바르지 않습니다.'
              : code.startsWith('auth/')
                ? '이미 가입된 이메일입니다. 비밀번호를 확인하세요.'
                : '가입하지 못했습니다. 잠시 후 다시 시도하세요.',
        )
        if (auth.currentUser) await signOut(auth)
      } finally {
        signingUp.current = false
      }
    },
    [enter],
  )

  const changePassword = useCallback(
    async (current: string, next: string) => {
      await changeOwnPassword(current, next)
      setMustChange(false)
      if (actor) void logEvent(actor, '비밀번호 변경')
    },
    [actor],
  )

  const leave = useCallback(
    async (action: string) => {
      if (actor) {
        try {
          // 네트워크가 끊겨 기록이 전달되지 않아도 로그아웃은 막지 않는다
          await Promise.race([logEvent(actor, action), new Promise((r) => setTimeout(r, LOGOUT_WAIT_MS))])
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
    () => ({ mode: firebaseEnabled ? 'firebase' : 'demo', actor, ready, error, notice, mustChange, changePassword, loginDemo, signIn, signUp, logout: () => leave('로그아웃'), confirm }),
    [actor, ready, error, notice, mustChange, changePassword, loginDemo, signIn, signUp, leave, confirm],
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
