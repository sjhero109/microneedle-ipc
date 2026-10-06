import { deleteApp, initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app'
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  getAuth,
  reauthenticateWithCredential,
  signOut,
  type Auth,
} from 'firebase/auth'
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  initializeFirestore,
  onSnapshot,
  persistentLocalCache,
  persistentMultipleTabManager,
  query,
  serverTimestamp,
  Timestamp,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore'
import { firebaseConfig } from '../firebase.config'
import type { Backend, Collection } from './backend'
import type { Actor, DbState, UserProfile } from './types'

const EMULATOR = import.meta.env.VITE_EMULATOR === '1'
const EMULATOR_CONFIG: FirebaseOptions = { projectId: 'demo-microneedle-ipc', apiKey: 'demo-key', authDomain: 'localhost' }

const config: FirebaseOptions | null = EMULATOR ? EMULATOR_CONFIG : firebaseConfig

/** 설정이 없으면 이 브라우저에만 저장하는 시연 모드로 동작한다 */
export const firebaseEnabled = config !== null

let app: FirebaseApp | undefined
let auth: Auth | undefined
let fs: Firestore | undefined

export function services(): { auth: Auth; fs: Firestore } {
  if (!config) throw new Error('Firebase 설정이 없습니다.')
  if (!app) {
    app = initializeApp(config)
    auth = getAuth(app)
    fs = initializeFirestore(app, {
      ignoreUndefinedProperties: true,
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    })
    if (EMULATOR) {
      connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
      connectFirestoreEmulator(fs, '127.0.0.1', 8080)
    }
  }
  return { auth: auth!, fs: fs! }
}

export async function loadProfile(uid: string): Promise<UserProfile | null> {
  const snap = await getDoc(doc(services().fs, 'users', uid))
  return snap.exists() ? (snap.data() as UserProfile) : null
}

/** 중요 작업 전에 비밀번호를 다시 확인한다 (전자서명 역할) */
export async function verifyPassword(password: string) {
  const user = services().auth.currentUser
  if (!user?.email) throw new Error('로그인 상태가 아닙니다.')
  await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password))
}

/**
 * 관리자가 새 계정을 만든다. 현재 로그인을 유지하려고 별도 앱 인스턴스에서 만든 뒤 바로 닫는다.
 * 계정만으로는 아무 권한이 없고, users 문서가 있어야 접근할 수 있다.
 */
export async function createAccount(email: string, password: string): Promise<string> {
  if (!config) throw new Error('Firebase 설정이 없습니다.')
  const second = initializeApp(config, `signup-${Date.now()}`)
  try {
    const a = getAuth(second)
    if (EMULATOR) connectAuthEmulator(a, 'http://127.0.0.1:9099', { disableWarnings: true })
    const cred = await createUserWithEmailAndPassword(a, email, password)
    await signOut(a)
    return cred.user.uid
  } finally {
    await deleteApp(second)
  }
}

const COLLECTIONS: Record<keyof DbState, string> = {
  recipes: 'recipes',
  batches: 'batches',
  records: 'records',
  corrections: 'corrections',
  audit: 'auditLog',
  users: 'users',
}

/** 시각은 브라우저 시계가 아니라 서버 시각으로 남긴다 */
const TIME_FIELDS = ['createdAt', 'updatedAt', 'requestedAt', 'reviewedAt']

function plain(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) out[k] = v instanceof Timestamp ? v.toMillis() : v
  return out
}

export function firebaseBackend(actor: Actor): Backend {
  const { fs } = services()
  return {
    subscribe(cb) {
      let state: DbState = { recipes: [], batches: [], records: [], corrections: [], audit: [], users: [] }
      // 모든 컬렉션의 첫 응답이 온 뒤에 화면에 넘긴다
      const waiting = new Set<keyof DbState>()
      const stops = (Object.keys(COLLECTIONS) as (keyof DbState)[]).map((key) => {
        // 일반 사용자는 사용자 목록을 볼 수 없고, audit 은 본인 것만 볼 수 있다
        if (key === 'users' && actor.role !== 'admin') return () => {}
        waiting.add(key)
        const col = collection(fs, COLLECTIONS[key])
        const q = key === 'audit' && actor.role !== 'admin' ? query(col, where('uid', '==', actor.uid)) : col
        return onSnapshot(
          q,
          (snap) => {
            const rows = snap.docs.map((d) => ({ ...plain(d.data({ serverTimestamps: 'estimate' })), [key === 'users' ? 'uid' : 'id']: d.id }))
            if (key === 'audit') rows.sort((a, b) => (a as { at: number }).at - (b as { at: number }).at)
            state = { ...state, [key]: rows }
            waiting.delete(key)
            if (waiting.size === 0) cb(state)
          },
          (err) => {
            // 한 컬렉션을 읽지 못해도 나머지 화면은 열리게 한다
            console.error(`${COLLECTIONS[key]} 구독 실패`, err)
            waiting.delete(key)
            if (waiting.size === 0) cb(state)
          },
        )
      })
      return () => stops.forEach((s) => s())
    },

    async commit(writes, audit) {
      const batch = writeBatch(fs)
      const refs = audit.map(() => doc(collection(fs, 'auditLog')))
      audit.forEach((a, i) => batch.set(refs[i], { ...a, at: serverTimestamp() }))
      for (const w of writes) {
        const data: Record<string, unknown> = { ...w.data, auditId: refs[0].id }
        for (const f of TIME_FIELDS) if (typeof data[f] === 'number') data[f] = serverTimestamp()
        batch.set(doc(fs, COLLECTIONS[w.col as Collection], w.id), data, { merge: true })
      }
      await batch.commit()
    },
  }
}
