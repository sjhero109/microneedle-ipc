import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { logEvent } from './store'
import type { Actor, Role } from './types'

interface Auth {
  actor: Actor | null
  login(name: string, role: Role): void
  logout(): void
}

const Ctx = createContext<Auth | null>(null)
const KEY = 'microneedle-ipc/actor'

function load(): Actor | null {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? 'null')
  } catch {
    return null
  }
}

/** 시연용 로그인. Firebase 연결 후에는 이메일/비밀번호 로그인으로 바뀐다 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [actor, setActor] = useState<Actor | null>(load)

  const login = useCallback((name: string, role: Role) => {
    const a: Actor = { uid: `local-${role}-${name}`, name, email: `${name}@local`, role }
    try {
      sessionStorage.setItem(KEY, JSON.stringify(a))
    } catch {
      // 저장이 막혀도 이번 화면에서는 로그인 상태를 유지한다
    }
    setActor(a)
    void logEvent(a, '로그인')
  }, [])

  const logout = useCallback(() => {
    if (actor) void logEvent(actor, '로그아웃')
    try {
      sessionStorage.removeItem(KEY)
    } catch {
      // 무시
    }
    setActor(null)
  }, [actor])

  const value = useMemo(() => ({ actor, login, logout }), [actor, login, logout])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): Auth {
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
