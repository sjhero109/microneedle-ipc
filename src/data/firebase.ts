import { deleteApp, initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app'
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  getAuth,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  type Auth,
  type User,
} from 'firebase/auth'
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  initializeFirestore,
  onSnapshot,
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
import { MAX_LOGIN_FAILS } from './types'

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
    // 탭과 기기마다 서버에 직접 연결한다. 탭끼리 연결을 공유하면 뒤에 있는 탭 때문에 저장이 늦게 전달될 수 있다
    fs = initializeFirestore(app, { ignoreUndefinedProperties: true })
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

/**
 * 로그인에 실제로 쓰는 키. 입력한 비밀번호를 이메일과 함께 변환한 값이며, 비밀번호 자체는 어디에도 저장하지 않는다.
 * 이 키를 secrets 에 보관해 두기 때문에 관리자가 사용자의 비밀번호를 초기화할 수 있다
 * (서버 프로그램 없이는 다른 사람의 비밀번호를 직접 바꿀 수 없다).
 */
export async function passwordKey(email: string, password: string): Promise<string> {
  const enc = new TextEncoder()
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(`microneedle-ipc:${email.toLowerCase()}`), iterations: 100_000 },
    base,
    256,
  )
  return [...new Uint8Array(bits)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

const BAD_CREDENTIAL = ['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-login-credentials']
const isBadCredential = (e: unknown) => BAD_CREDENTIAL.includes((e as { code?: string }).code ?? '')

function saveKey(uid: string, key: string) {
  return setDoc(doc(services().fs, 'secrets', uid), { key, updatedAt: serverTimestamp() })
}

/**
 * 로그인한다. 키 방식 이전에 만든 계정은 입력한 비밀번호 그대로 한 번 더 시도하고,
 * 맞으면 그 자리에서 키 방식으로 바꿔 둔다.
 */
export async function signIn(email: string, password: string): Promise<void> {
  const { auth } = services()
  const key = await passwordKey(email, password)
  let user: User
  changedBeforeMigration = null
  try {
    user = (await signInWithEmailAndPassword(auth, email, key)).user
  } catch (e) {
    if (!isBadCredential(e)) throw e
    user = (await signInWithEmailAndPassword(auth, email, password)).user
    changedBeforeMigration = await passwordUpdatedAt(user).catch(() => 0)
    await updatePassword(user, key)
  }
  // 초기화에 쓸 키를 항상 최신으로 맞춰 둔다. 실패해도 로그인은 계속한다
  await saveKey(user.uid, key).catch(() => {})
}

/**
 * 앱에서 직접 가입한다. 맨 처음 가입한 사람은 관리자가 되고, 그 뒤로는 관리자 승인을 기다린다.
 * 이미 있는 계정이면 그 계정으로 로그인해서 이어 간다.
 */
export async function signUp(name: string, email: string, password: string): Promise<void> {
  const { auth, fs } = services()
  const key = await passwordKey(email, password)
  let uid: string
  try {
    uid = (await createUserWithEmailAndPassword(auth, email, key)).user.uid
    await saveKey(uid, key).catch(() => {})
  } catch (e) {
    if ((e as { code?: string }).code !== 'auth/email-already-in-use') throw e
    await signIn(email, password)
    uid = auth.currentUser!.uid
  }
  if (await loadProfile(uid)) return
  const first = !(await getDoc(doc(fs, 'meta', 'setup'))).exists()
  const batch = writeBatch(fs)
  batch.set(doc(fs, 'users', uid), {
    uid,
    name,
    email,
    role: first ? 'admin' : 'user',
    active: first,
    pending: !first,
    createdAt: serverTimestamp(),
  })
  if (first) batch.set(doc(fs, 'meta', 'setup'), { uid, at: serverTimestamp() })
  await batch.commit()
}

export interface LockState {
  fails: number
  locked: boolean
  /** 마지막으로 바뀐 시각(ms). 잠긴 계정이면 잠긴 시각이다 */
  updatedAt: number
  /** 이번 실패로 관리자 계정이 잠겨 재설정 메일을 보냈는지 */
  mailed?: boolean
}

/** 이메일의 로그인 실패 횟수와 잠금 여부 */
export async function loginLock(email: string): Promise<LockState> {
  const snap = await getDoc(doc(services().fs, 'loginGuard', email))
  const d = snap.data()
  return { fails: Number(d?.fails ?? 0), locked: d?.locked === true, updatedAt: d?.updatedAt instanceof Timestamp ? d.updatedAt.toMillis() : 0 }
}

async function sha256(text: string): Promise<string> {
  const bits = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bits)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/** 로그인 전에 "이 이메일이 관리자인지"만 알아본다. 목록에는 이메일이 아니라 해시가 들어 있다 */
export async function isAdminEmail(email: string): Promise<boolean> {
  const snap = await getDoc(doc(services().fs, 'meta', 'admins'))
  const hashes: string[] = snap.data()?.hashes ?? []
  return hashes.includes(await sha256(email.toLowerCase()))
}

/** 관리자 목록이 바뀌면 해시 목록을 맞춰 둔다 (관리자로 로그인해 있을 때) */
export async function syncAdminList(users: UserProfile[]) {
  const { fs } = services()
  const hashes = (await Promise.all(users.filter((u) => u.role === 'admin' && u.active).map((u) => sha256(u.email.toLowerCase())))).sort()
  const snap = await getDoc(doc(fs, 'meta', 'admins'))
  if (JSON.stringify(snap.data()?.hashes ?? null) === JSON.stringify(hashes)) return
  await setDoc(doc(fs, 'meta', 'admins'), { hashes, updatedAt: serverTimestamp() })
}

/**
 * 로그인 실패를 1회 기록한다. 정해진 횟수가 되면 계정이 잠긴다.
 * 로그인 전이라 이름을 알 수 없으므로 audit 기록에는 이메일만 남는다.
 */
export async function recordLoginFailure(email: string): Promise<LockState> {
  const { fs } = services()
  const cur = await loginLock(email)
  if (cur.locked) return cur
  const next: LockState = { fails: cur.fails + 1, locked: cur.fails + 1 >= MAX_LOGIN_FAILS, updatedAt: Date.now() }
  const batch = writeBatch(fs)
  batch.set(doc(fs, 'loginGuard', email), { email, fails: next.fails, locked: next.locked, updatedAt: serverTimestamp() })
  const entry = { uid: '', name: '', email, role: 'none', target: 'loginGuard', targetId: email, at: serverTimestamp() }
  batch.set(doc(collection(fs, 'auditLog')), { ...entry, action: '로그인 실패', after: { fails: next.fails } })
  if (next.locked) batch.set(doc(collection(fs, 'auditLog')), { ...entry, action: '계정 잠금', after: { fails: next.fails } })
  await batch.commit()
  // 관리자 계정이 잠기면 풀어 줄 사람이 없을 수 있으므로, 가입한 이메일로 재설정 메일을 바로 보낸다
  if (next.locked && (await isAdminEmail(email).catch(() => false))) {
    await sendPasswordResetEmail(services().auth, email)
    await setDoc(doc(collection(fs, 'auditLog')), { ...entry, action: '재설정 메일 발송', after: { reason: '관리자 계정 잠금' } }).catch(() => {})
    next.mailed = true
  }
  return next
}

/** 잠긴 관리자가 메일로 비밀번호를 다시 정하고 들어왔을 때 잠금을 푼다 */
export async function unlockOwnAccount(email: string) {
  await clearLoginFailures(email)
}

/** 비밀번호가 마지막으로 바뀐 시각(ms). 잠긴 뒤에 비밀번호를 다시 정했는지 확인하는 데 쓴다 */
async function passwordUpdatedAt(user: User): Promise<number> {
  const base = EMULATOR ? 'http://127.0.0.1:9099/identitytoolkit.googleapis.com' : 'https://identitytoolkit.googleapis.com'
  const res = await fetch(`${base}/v1/accounts:lookup?key=${config!.apiKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken: await user.getIdToken() }),
  })
  const body = await res.json()
  return Number(body.users?.[0]?.passwordUpdatedAt ?? 0)
}

// 예전 방식 계정은 로그인 직후 키 방식으로 바꾸면서 변경 시각이 새로 찍히므로, 바꾸기 전 값을 잡아 둔다
let changedBeforeMigration: number | null = null

export async function lastPasswordChange(user: User): Promise<number> {
  return changedBeforeMigration ?? (await passwordUpdatedAt(user))
}

/** 로그인에 성공하면 실패 횟수를 0으로 되돌린다 */
export async function clearLoginFailures(email: string) {
  const { fs } = services()
  await setDoc(doc(fs, 'loginGuard', email), { email, fails: 0, locked: false, updatedAt: serverTimestamp() })
}

/** 사용자가 스스로 새 비밀번호를 정할 수 있는 메일을 보낸다 */
export function sendPasswordReset(email: string) {
  return sendPasswordResetEmail(services().auth, email)
}

/** 중요 작업 전에 비밀번호를 다시 확인한다 (전자서명 역할) */
export async function verifyPassword(password: string) {
  const user = services().auth.currentUser
  if (!user?.email) throw new Error('로그인 상태가 아닙니다.')
  try {
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, await passwordKey(user.email, password)))
  } catch (e) {
    if (!isBadCredential(e)) throw e
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password))
  }
}

/** 본인 비밀번호를 바꾼다 */
export async function changeOwnPassword(current: string, next: string) {
  const { auth, fs } = services()
  const user = auth.currentUser
  if (!user?.email) throw new Error('로그인 상태가 아닙니다.')
  await verifyPassword(current)
  const key = await passwordKey(user.email, next)
  await updatePassword(user, key)
  await saveKey(user.uid, key)
  await updateDoc(doc(fs, 'users', user.uid), { mustChangePassword: false })
}

/** 별도 앱 인스턴스: 현재 로그인을 건드리지 않고 다른 계정을 다룬다 */
async function withSecondAuth<T>(fn: (a: Auth) => Promise<T>): Promise<T> {
  if (!config) throw new Error('Firebase 설정이 없습니다.')
  const second = initializeApp(config, `second-${Date.now()}`)
  try {
    const a = getAuth(second)
    if (EMULATOR) connectAuthEmulator(a, 'http://127.0.0.1:9099', { disableWarnings: true })
    const result = await fn(a)
    await signOut(a)
    return result
  } finally {
    await deleteApp(second)
  }
}

/**
 * 관리자가 새 계정을 만든다. 계정만으로는 아무 권한이 없고, users 문서가 있어야 접근할 수 있다.
 */
export async function createAccount(email: string, password: string): Promise<string> {
  const key = await passwordKey(email, password)
  const uid = await withSecondAuth(async (a) => (await createUserWithEmailAndPassword(a, email, key)).user.uid)
  await saveKey(uid, key)
  return uid
}

/**
 * 관리자가 사용자의 비밀번호를 정해진 값으로 초기화한다.
 * 보관해 둔 키로 그 계정에 잠시 들어가 비밀번호를 바꾸는 방식이다.
 */
export async function adminResetPassword(target: { uid: string; email: string }, newPassword: string) {
  const snap = await getDoc(doc(services().fs, 'secrets', target.uid))
  const oldKey = snap.data()?.key as string | undefined
  if (!oldKey) throw new Error('이 계정은 새 로그인 방식으로 한 번도 로그인하지 않아 초기화할 수 없습니다. 재설정 메일을 보내세요.')
  const newKey = await passwordKey(target.email, newPassword)
  try {
    await withSecondAuth(async (a) => updatePassword((await signInWithEmailAndPassword(a, target.email, oldKey)).user, newKey))
  } catch (e) {
    if (isBadCredential(e)) throw new Error('보관된 로그인 키가 현재 비밀번호와 맞지 않아 초기화할 수 없습니다. 재설정 메일을 보내세요.')
    throw e
  }
  await saveKey(target.uid, newKey)
}

const COLLECTIONS: Record<keyof DbState, string> = {
  recipes: 'recipes',
  batches: 'batches',
  records: 'records',
  corrections: 'corrections',
  audit: 'auditLog',
  users: 'users',
  guards: 'loginGuard',
}

/** 시각은 브라우저 시계가 아니라 서버 시각으로 남긴다 */
const TIME_FIELDS = ['createdAt', 'updatedAt', 'requestedAt', 'reviewedAt', 'closedAt']

function plain(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) out[k] = v instanceof Timestamp ? v.toMillis() : v
  return out
}

export function firebaseBackend(actor: Actor): Backend {
  const { fs } = services()
  return {
    subscribe(cb) {
      let state: DbState = { recipes: [], batches: [], records: [], corrections: [], audit: [], users: [], guards: [] }
      // 모든 컬렉션의 첫 응답이 온 뒤에 화면에 넘긴다
      const waiting = new Set<keyof DbState>()
      const stops = (Object.keys(COLLECTIONS) as (keyof DbState)[]).map((key) => {
        // 일반 사용자는 사용자 목록을 볼 수 없고, audit 은 본인 것만 볼 수 있다
        if ((key === 'users' || key === 'guards') && actor.role !== 'admin') return () => {}
        waiting.add(key)
        const col = collection(fs, COLLECTIONS[key])
        const q = key === 'audit' && actor.role !== 'admin' ? query(col, where('uid', '==', actor.uid)) : col
        return onSnapshot(
          q,
          (snap) => {
            const rows = snap.docs.map((d) => ({ ...plain(d.data({ serverTimestamps: 'estimate' })), [key === 'users' ? 'uid' : 'id']: d.id }))
            if (key === 'audit') rows.sort((a, b) => (a as { at: number }).at - (b as { at: number }).at)
            state = { ...state, [key]: rows }
            if (key === 'users') void syncAdminList(rows as unknown as UserProfile[]).catch(() => {})
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
