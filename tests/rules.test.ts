import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing'
import { collection, deleteDoc, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, where, writeBatch, type Firestore } from 'firebase/firestore'
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'

// 실행: npm run test:rules  (Firestore 에뮬레이터가 필요하다)

let env: RulesTestEnvironment

const PEOPLE = {
  admin: { uid: 'admin1', name: '관리자', email: 'admin@test.local', role: 'admin', active: true },
  user: { uid: 'user1', name: '작업자', email: 'user@test.local', role: 'user', active: true },
  other: { uid: 'user2', name: '다른작업자', email: 'other@test.local', role: 'user', active: true },
  stopped: { uid: 'user3', name: '중지', email: 'stopped@test.local', role: 'user', active: false },
} as const
type Who = keyof typeof PEOPLE

const as = (who: Who) => env.authenticatedContext(PEOPLE[who].uid, { email: PEOPLE[who].email }).firestore() as unknown as Firestore

let seq = 0
const id = (p: string) => `${p}-${++seq}`

function auditDoc(who: Who, over: Record<string, unknown> = {}) {
  const p = PEOPLE[who]
  return { uid: p.uid, name: p.name, email: p.email, role: p.role, at: serverTimestamp(), action: 'test', target: 't', targetId: 'x', ...over }
}

/** 데이터 쓰기 1건 + audit 기록 1건을 한 batch로 */
function withAudit(who: Who, path: string, data: Record<string, unknown>, opts: { merge?: boolean; audit?: Record<string, unknown> } = {}) {
  const db = as(who)
  const auditId = id('audit')
  const b = writeBatch(db)
  b.set(doc(db, 'auditLog', auditId), auditDoc(who, opts.audit))
  b.set(doc(db, path), { ...data, auditId }, { merge: opts.merge ?? false })
  return b.commit()
}

const record = (who: Who, over: Record<string, unknown> = {}) => ({
  batchId: 'batch1',
  dispenserId: 'D1',
  tray: 1,
  pulse: 3.9,
  totalWeight: 18.3,
  weight: 6.1,
  excluded: false,
  source: 'manual',
  createdBy: PEOPLE[who].uid,
  createdAt: serverTimestamp(),
  ...over,
})

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-microneedle-ipc',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host: '127.0.0.1', port: 8080 },
  })
})

afterAll(() => env.cleanup())

beforeEach(async () => {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore() as unknown as Firestore
    for (const p of Object.values(PEOPLE)) await setDoc(doc(db, 'users', p.uid), p)
    await setDoc(doc(db, 'recipes', 'r1'), { name: '고용량', drugTarget: 6.11 })
    await setDoc(doc(db, 'batches', 'batch1'), { batchNo: 'B-1', drugName: '고용량', shots: 3, createdBy: 'user1' })
    await setDoc(doc(db, 'records', 'rec1'), { ...record('user'), createdAt: new Date() })
    await setDoc(doc(db, 'auditLog', 'old-audit'), { ...auditDoc('user'), at: new Date() })
    await setDoc(doc(db, 'auditLog', 'others-audit'), { ...auditDoc('other'), at: new Date() })
    await setDoc(doc(db, 'corrections', 'c1'), { recordId: 'rec1', status: 'pending', requestedBy: 'user1' })
  })
})

describe('접근', () => {
  it('로그인하지 않으면 읽을 수 없다', async () => {
    const db = env.unauthenticatedContext().firestore() as unknown as Firestore
    await assertFails(getDoc(doc(db, 'records', 'rec1')))
    await assertFails(getDoc(doc(db, 'recipes', 'r1')))
  })

  it('users 문서가 없거나 사용 중지된 계정은 읽을 수 없다', async () => {
    const stranger = env.authenticatedContext('nobody', { email: 'x@test.local' }).firestore() as unknown as Firestore
    await assertFails(getDoc(doc(stranger, 'records', 'rec1')))
    await assertFails(getDoc(doc(as('stopped'), 'records', 'rec1')))
  })

  it('일반 사용자는 기록과 레시피를 읽을 수 있다', async () => {
    await assertSucceeds(getDoc(doc(as('user'), 'records', 'rec1')))
    await assertSucceeds(getDoc(doc(as('user'), 'recipes', 'r1')))
  })

  it('일반 사용자는 사용자 목록을 볼 수 없다', async () => {
    await assertFails(getDocs(collection(as('user'), 'users')))
    await assertSucceeds(getDoc(doc(as('user'), 'users', 'user1')))
    await assertSucceeds(getDocs(collection(as('admin'), 'users')))
  })
})

describe('audit trail', () => {
  it('audit 기록과 함께 쓰면 저장된다', async () => {
    await assertSucceeds(withAudit('user', `records/${id('rec')}`, record('user')))
  })

  it('audit 기록 없이 쓰면 거부된다', async () => {
    await assertFails(setDoc(doc(as('user'), 'records', id('rec')), record('user')))
    await assertFails(setDoc(doc(as('user'), 'records', id('rec')), { ...record('user'), auditId: 'no-such-audit' }))
  })

  it('예전 audit 기록을 다시 쓸 수 없다', async () => {
    await assertFails(setDoc(doc(as('user'), 'records', id('rec')), { ...record('user'), auditId: 'old-audit' }))
  })

  it('다른 사람 이름으로 기록할 수 없다', async () => {
    await assertFails(withAudit('user', `records/${id('rec')}`, record('user'), { audit: { uid: 'user2' } }))
    await assertFails(withAudit('user', `records/${id('rec')}`, record('user'), { audit: { name: '다른작업자' } }))
    await assertFails(withAudit('user', `records/${id('rec')}`, record('user'), { audit: { email: 'other@test.local' } }))
    await assertFails(withAudit('user', `records/${id('rec')}`, record('other')))
  })

  it('권한을 속여 기록할 수 없다', async () => {
    await assertFails(withAudit('user', `records/${id('rec')}`, record('user'), { audit: { role: 'admin' } }))
  })

  it('시각은 서버 시각이어야 한다', async () => {
    const past = new Date('2020-01-01')
    await assertFails(withAudit('user', `records/${id('rec')}`, record('user'), { audit: { at: past } }))
    await assertFails(withAudit('user', `records/${id('rec')}`, record('user', { createdAt: past })))
  })

  it('audit 기록은 관리자도 고치거나 지울 수 없다', async () => {
    await assertFails(updateDoc(doc(as('admin'), 'auditLog', 'old-audit'), { action: '수정' }))
    await assertFails(deleteDoc(doc(as('admin'), 'auditLog', 'old-audit')))
  })

  it('일반 사용자는 본인 audit 만, 관리자는 전체를 본다', async () => {
    await assertSucceeds(getDocs(query(collection(as('user'), 'auditLog'), where('uid', '==', 'user1'))))
    await assertFails(getDocs(collection(as('user'), 'auditLog')))
    await assertFails(getDoc(doc(as('user'), 'auditLog', 'others-audit')))
    await assertSucceeds(getDocs(collection(as('admin'), 'auditLog')))
  })

  it('데이터 변경이 없는 작업(로그인 등)도 기록할 수 있다', async () => {
    await assertSucceeds(setDoc(doc(as('user'), 'auditLog', id('audit')), auditDoc('user', { action: '로그인' })))
  })
})

describe('일반 사용자와 관리자', () => {
  it('레시피는 관리자만 만들고 고친다', async () => {
    const recipe = { name: '저용량', drugTarget: 3, updatedAt: serverTimestamp() }
    await assertFails(withAudit('user', `recipes/${id('r')}`, recipe))
    await assertSucceeds(withAudit('admin', `recipes/${id('r')}`, recipe))
    await assertFails(withAudit('user', 'recipes/r1', { name: '이름 변경', updatedAt: serverTimestamp() }, { merge: true }))
    await assertSucceeds(withAudit('admin', 'recipes/r1', { name: '이름 변경', updatedAt: serverTimestamp() }, { merge: true }))
  })

  it('가져오기(import)는 관리자만 한다', async () => {
    await assertFails(withAudit('user', `records/${id('rec')}`, record('user', { source: 'import' })))
    await assertSucceeds(withAudit('admin', `records/${id('rec')}`, record('admin', { source: 'import' })))
  })

  it('기록 수정은 관리자의 정정·제외만 허용된다', async () => {
    await assertFails(withAudit('user', 'records/rec1', { excluded: true, excludeReason: '임의' }, { merge: true }))
    await assertSucceeds(withAudit('admin', 'records/rec1', { excluded: true, excludeReason: '측정 오류' }, { merge: true }))
    await assertFails(withAudit('admin', 'records/rec1', { createdBy: 'admin1' }, { merge: true }))
    await assertFails(withAudit('admin', 'records/rec1', { batchId: 'other' }, { merge: true }))
  })

  it('제외된 상태로 새 기록을 만들 수 없다', async () => {
    await assertFails(withAudit('user', `records/${id('rec')}`, record('user', { excluded: true })))
  })

  it('기록과 배치는 누구도 지울 수 없다', async () => {
    await assertFails(deleteDoc(doc(as('admin'), 'records', 'rec1')))
    await assertFails(deleteDoc(doc(as('admin'), 'batches', 'batch1')))
    await assertFails(deleteDoc(doc(as('admin'), 'recipes', 'r1')))
    await assertFails(deleteDoc(doc(as('admin'), 'users', 'user1')))
  })

  it('배치는 약액부명·기저부명·배수 등 정해진 항목만 바꿀 수 있다', async () => {
    await assertSucceeds(withAudit('user', 'batches/batch1', { drugName: '고용량-2', shots: 5 }, { merge: true }))
    await assertFails(withAudit('user', 'batches/batch1', { batchNo: 'B-2' }, { merge: true }))
    await assertFails(withAudit('user', 'batches/batch1', { drugTarget: 9 }, { merge: true }))
  })

  it('정정은 누구나 요청하고 관리자만 승인한다', async () => {
    const req = { recordId: 'rec1', field: 'pulse', status: 'pending', requestedBy: 'user1', requestedAt: serverTimestamp() }
    await assertSucceeds(withAudit('user', `corrections/${id('c')}`, req))
    await assertFails(withAudit('user', `corrections/${id('c')}`, { ...req, status: 'approved' }))
    const review = { status: 'approved', reviewedBy: 'user1', reviewedAt: serverTimestamp() }
    await assertFails(withAudit('user', 'corrections/c1', review, { merge: true }))
    await assertSucceeds(withAudit('admin', 'corrections/c1', { ...review, reviewedBy: 'admin1' }, { merge: true }))
    // 이미 처리한 요청은 다시 바꿀 수 없다
    await assertFails(withAudit('admin', 'corrections/c1', { status: 'rejected', reviewedBy: 'admin1' }, { merge: true }))
  })

  it('사용자 권한은 관리자만 바꾸고, 자기 관리자 권한은 스스로 없앨 수 없다', async () => {
    await assertFails(withAudit('user', 'users/user1', { role: 'admin', active: true }, { merge: true }))
    await assertSucceeds(withAudit('admin', 'users/user1', { role: 'admin', active: true }, { merge: true }))
    await assertFails(withAudit('admin', 'users/admin1', { role: 'user', active: true }, { merge: true }))
    await assertFails(withAudit('admin', 'users/admin1', { role: 'admin', active: false }, { merge: true }))
  })
})

describe('가져오기 묶음 저장', () => {
  it('기록 200건을 audit 1건과 함께 한 번에 저장할 수 있다', async () => {
    const db = as('admin')
    const auditId = id('audit')
    const b = writeBatch(db)
    b.set(doc(db, 'auditLog', auditId), auditDoc('admin', { action: '데이터 가져오기' }))
    for (let i = 0; i < 200; i++) b.set(doc(db, 'records', id('imp')), { ...record('admin', { source: 'import', tray: i + 1 }), auditId })
    await assertSucceeds(b.commit())
  })
})

describe('앱에서 직접 가입', () => {
  const NEW = { uid: 'new1', email: 'new@test.local' }
  const fresh = () => env.authenticatedContext(NEW.uid, { email: NEW.email }).firestore() as unknown as Firestore
  const profile = (over: Record<string, unknown> = {}) => ({
    uid: NEW.uid,
    name: '신규',
    email: NEW.email,
    role: 'user',
    active: false,
    pending: true,
    createdAt: serverTimestamp(),
    ...over,
  })
  const markSetupDone = () =>
    env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore() as unknown as Firestore, 'meta', 'setup'), { uid: 'admin1' }))

  function signup(data: Record<string, unknown>, withSetup: boolean) {
    const db = fresh()
    const b = writeBatch(db)
    b.set(doc(db, 'users', NEW.uid), data)
    if (withSetup) b.set(doc(db, 'meta', 'setup'), { uid: NEW.uid, at: serverTimestamp() })
    return b.commit()
  }

  it('맨 처음 가입한 사람은 관리자가 된다', async () => {
    await assertSucceeds(signup(profile({ role: 'admin', active: true, pending: false }), true))
  })

  it('최초 등록 표시 없이 관리자로 가입할 수 없다', async () => {
    await assertFails(signup(profile({ role: 'admin', active: true, pending: false }), false))
  })

  it('최초 등록이 끝난 뒤에는 관리자로 가입할 수 없다', async () => {
    await markSetupDone()
    await assertFails(signup(profile({ role: 'admin', active: true, pending: false }), true))
    await assertFails(signup(profile({ role: 'admin', active: true, pending: false }), false))
  })

  it('그 뒤 가입자는 승인 대기 상태로만 만들 수 있다', async () => {
    await markSetupDone()
    await assertSucceeds(signup(profile(), false))
  })

  it('스스로 사용 가능한 상태로 가입할 수 없다', async () => {
    await markSetupDone()
    await assertFails(signup(profile({ active: true }), false))
    await assertFails(signup(profile({ pending: false, active: true }), false))
  })

  it('다른 사람 명의나 다른 이메일로 가입할 수 없다', async () => {
    await markSetupDone()
    const db = fresh()
    await assertFails(setDoc(doc(db, 'users', 'someone-else'), profile({ uid: 'someone-else' })))
    await assertFails(signup(profile({ email: 'admin@test.local' }), false))
  })

  it('승인 대기 중에는 아무것도 읽거나 쓸 수 없다', async () => {
    await markSetupDone()
    await signup(profile(), false)
    await assertFails(getDoc(doc(fresh(), 'records', 'rec1')))
    await assertFails(setDoc(doc(fresh(), 'users', NEW.uid), profile({ active: true }), { merge: true }))
  })

  it('관리자가 승인하면 사용할 수 있다', async () => {
    await markSetupDone()
    await signup(profile(), false)
    await assertSucceeds(withAudit('admin', `users/${NEW.uid}`, { active: true, pending: false, role: 'user' }, { merge: true }))
    await assertSucceeds(getDoc(doc(fresh(), 'records', 'rec1')))
  })

  it('최초 등록 표시는 바꾸거나 지울 수 없다', async () => {
    await markSetupDone()
    await assertFails(setDoc(doc(as('admin'), 'meta', 'setup'), { uid: 'admin1' }))
    await assertFails(deleteDoc(doc(as('admin'), 'meta', 'setup')))
    await assertFails(setDoc(doc(as('user'), 'meta', 'setup'), { uid: 'user1' }))
  })
})

describe('로그인 실패와 계정 잠금', () => {
  const anon = () => env.unauthenticatedContext().firestore() as unknown as Firestore
  const EMAIL = PEOPLE.user.email
  const guard = (fails: number, over: Record<string, unknown> = {}) => ({ email: EMAIL, fails, locked: fails >= 5, updatedAt: serverTimestamp(), ...over })
  const seedGuard = (fails: number, locked = fails >= 5) =>
    env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore() as unknown as Firestore, 'loginGuard', EMAIL), { email: EMAIL, fails, locked }))
  const failAudit = (over: Record<string, unknown> = {}) => ({ uid: '', name: '', email: EMAIL, role: 'none', action: '로그인 실패', target: 'loginGuard', targetId: EMAIL, at: serverTimestamp(), ...over })

  it('로그인 전에도 실패를 1회씩 기록할 수 있다', async () => {
    await assertSucceeds(setDoc(doc(anon(), 'loginGuard', EMAIL), guard(1)))
    await assertSucceeds(setDoc(doc(anon(), 'loginGuard', EMAIL), guard(2)))
  })

  it('실패 횟수를 건너뛰거나 줄일 수 없다', async () => {
    await assertFails(setDoc(doc(anon(), 'loginGuard', EMAIL), guard(3)))
    await seedGuard(2)
    await assertFails(setDoc(doc(anon(), 'loginGuard', EMAIL), guard(4)))
    await assertFails(setDoc(doc(anon(), 'loginGuard', EMAIL), guard(1)))
    await assertFails(setDoc(doc(anon(), 'loginGuard', EMAIL), guard(0)))
  })

  it('5회째에 잠기고, 잠그지 않은 채로 5회를 기록할 수 없다', async () => {
    await seedGuard(4)
    await assertFails(setDoc(doc(anon(), 'loginGuard', EMAIL), guard(5, { locked: false })))
    await assertSucceeds(setDoc(doc(anon(), 'loginGuard', EMAIL), guard(5)))
    // 잠긴 뒤에는 더 바꿀 수 없다
    await assertFails(setDoc(doc(anon(), 'loginGuard', EMAIL), guard(6)))
  })

  it('잠긴 계정은 비밀번호가 맞아도 읽고 쓸 수 없다', async () => {
    await seedGuard(5)
    await assertFails(getDoc(doc(as('user'), 'records', 'rec1')))
    await assertFails(withAudit('user', `records/${id('rec')}`, record('user')))
    // 다른 사람은 영향이 없다
    await assertSucceeds(getDoc(doc(as('other'), 'records', 'rec1')))
  })

  it('잠긴 계정은 스스로 풀 수 없고 관리자가 푼다', async () => {
    await seedGuard(5)
    await assertFails(setDoc(doc(as('user'), 'loginGuard', EMAIL), guard(0)))
    await assertFails(setDoc(doc(anon(), 'loginGuard', EMAIL), guard(0)))
    await assertSucceeds(withAudit('admin', `loginGuard/${EMAIL}`, guard(0), { merge: true }))
    await assertSucceeds(getDoc(doc(as('user'), 'records', 'rec1')))
  })

  it('로그인에 성공하면 본인이 실패 횟수를 지운다', async () => {
    await seedGuard(3)
    await assertFails(setDoc(doc(as('other'), 'loginGuard', EMAIL), guard(0)))
    await assertSucceeds(setDoc(doc(as('user'), 'loginGuard', EMAIL), guard(0)))
  })

  it('로그인 전에는 로그인 실패·계정 잠금 기록만 남길 수 있다', async () => {
    await assertSucceeds(setDoc(doc(anon(), 'auditLog', id('audit')), failAudit()))
    await assertSucceeds(setDoc(doc(anon(), 'auditLog', id('audit')), failAudit({ action: '계정 잠금' })))
    await assertFails(setDoc(doc(anon(), 'auditLog', id('audit')), failAudit({ action: 'IPC 저장' })))
    await assertFails(setDoc(doc(anon(), 'auditLog', id('audit')), failAudit({ name: '관리자' })))
    await assertFails(setDoc(doc(anon(), 'auditLog', id('audit')), failAudit({ uid: 'admin1', role: 'admin' })))
    await assertFails(setDoc(doc(anon(), 'auditLog', id('audit')), failAudit({ at: new Date('2020-01-01') })))
    await assertFails(getDoc(doc(anon(), 'auditLog', 'old-audit')))
  })
})

describe('비밀번호 초기화', () => {
  const key = (v: string) => ({ key: v, updatedAt: serverTimestamp() })

  it('로그인 키는 본인과 관리자만 쓰고, 관리자만 읽는다', async () => {
    await assertSucceeds(setDoc(doc(as('user'), 'secrets', 'user1'), key('a')))
    await assertFails(setDoc(doc(as('other'), 'secrets', 'user1'), key('b')))
    await assertSucceeds(setDoc(doc(as('admin'), 'secrets', 'user1'), key('c')))
    await assertFails(getDoc(doc(as('user'), 'secrets', 'user1')))
    await assertFails(getDoc(doc(as('other'), 'secrets', 'user1')))
    await assertSucceeds(getDoc(doc(as('admin'), 'secrets', 'user1')))
    await assertFails(deleteDoc(doc(as('admin'), 'secrets', 'user1')))
  })

  it('"비밀번호 변경 필요" 표시는 관리자가 켜고 본인은 끌 수만 있다', async () => {
    await assertSucceeds(withAudit('admin', 'users/user1', { mustChangePassword: true }, { merge: true }))
    await assertFails(updateDoc(doc(as('other'), 'users', 'user1'), { mustChangePassword: false }))
    await assertFails(updateDoc(doc(as('user'), 'users', 'user1'), { mustChangePassword: false, role: 'admin' }))
    await assertSucceeds(updateDoc(doc(as('user'), 'users', 'user1'), { mustChangePassword: false }))
    await assertFails(updateDoc(doc(as('user'), 'users', 'user1'), { mustChangePassword: true }))
  })
})

describe('잠긴 관리자의 복구', () => {
  const anon = () => env.unauthenticatedContext().firestore() as unknown as Firestore
  const lock = (email: string) =>
    env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore() as unknown as Firestore, 'loginGuard', email), { email, fails: 5, locked: true }))
  const cleared = (email: string) => ({ email, fails: 0, locked: false, updatedAt: serverTimestamp() })

  it('잠긴 관리자는 스스로 풀 수 있지만 일반 사용자는 풀 수 없다', async () => {
    await lock(PEOPLE.admin.email)
    await lock(PEOPLE.user.email)
    // 잠긴 동안에는 관리자도 데이터를 읽을 수 없다
    await assertFails(getDoc(doc(as('admin'), 'records', 'rec1')))
    await assertFails(setDoc(doc(as('user'), 'loginGuard', PEOPLE.user.email), cleared(PEOPLE.user.email)))
    await assertFails(setDoc(doc(as('user'), 'loginGuard', PEOPLE.admin.email), cleared(PEOPLE.admin.email)))
    await assertSucceeds(setDoc(doc(as('admin'), 'loginGuard', PEOPLE.admin.email), cleared(PEOPLE.admin.email)))
    await assertSucceeds(getDoc(doc(as('admin'), 'records', 'rec1')))
  })

  it('관리자 해시 목록은 누구나 읽고 관리자만 쓴다', async () => {
    const list = { hashes: ['abc'], updatedAt: serverTimestamp() }
    await assertFails(setDoc(doc(as('user'), 'meta', 'admins'), list))
    await assertFails(setDoc(doc(anon(), 'meta', 'admins'), list))
    await assertSucceeds(setDoc(doc(as('admin'), 'meta', 'admins'), list))
    await assertSucceeds(getDoc(doc(anon(), 'meta', 'admins')))
  })

  it('재설정 메일을 보낸 사실을 로그인 전에 기록할 수 있다', async () => {
    const entry = { uid: '', name: '', email: PEOPLE.admin.email, role: 'none', action: '재설정 메일 발송', target: 'loginGuard', targetId: PEOPLE.admin.email, at: serverTimestamp() }
    await assertSucceeds(setDoc(doc(anon(), 'auditLog', id('audit')), entry))
  })
})

describe('배치 완료', () => {
  const close = { status: 'closed', closedAt: serverTimestamp(), closedBy: 'user1', closedByName: '작업자' }
  const seedClosed = () =>
    env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore() as unknown as Firestore, 'batches', 'batch1'), { status: 'closed' }))

  it('작업자가 배치를 완료할 수 있다', async () => {
    await assertSucceeds(withAudit('user', 'batches/batch1', close, { merge: true }))
  })

  it('완료된 배치에는 기록을 더할 수 없다', async () => {
    await assertSucceeds(withAudit('user', `records/${id('rec')}`, record('user')))
    await seedClosed()
    await assertFails(withAudit('user', `records/${id('rec')}`, record('user')))
    await assertFails(withAudit('admin', `records/${id('rec')}`, record('admin', { source: 'import' })))
  })

  it('완료된 배치는 다시 열기 전에는 고칠 수 없고, 작업자도 다시 열 수 있다', async () => {
    await seedClosed()
    await assertFails(withAudit('user', 'batches/batch1', { drugName: '변경' }, { merge: true }))
    await assertFails(withAudit('admin', 'batches/batch1', { drugName: '변경' }, { merge: true }))
    await assertSucceeds(withAudit('user', 'batches/batch1', { status: 'open' }, { merge: true }))
    await assertSucceeds(withAudit('user', 'batches/batch1', { drugName: '변경' }, { merge: true }))
    await assertSucceeds(withAudit('user', `records/${id('rec')}`, record('user')))
  })

  it('테스트 기록의 계산 편입은 관리자만 한다', async () => {
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore() as unknown as Firestore, 'records', 'rec1'), { test: true }))
    await assertFails(withAudit('user', 'records/rec1', { test: false }, { merge: true }))
    await assertSucceeds(withAudit('admin', 'records/rec1', { test: false }, { merge: true }))
  })
})
