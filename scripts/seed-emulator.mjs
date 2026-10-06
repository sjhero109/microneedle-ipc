// 에뮬레이터 전용 시험 계정을 만든다. 실제 프로젝트에는 쓰지 않는다.
// 실행: npm run emulators (다른 터미널) → node scripts/seed-emulator.mjs
const PROJECT = 'demo-microneedle-ipc'
const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1'
const STORE = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`

export const ACCOUNTS = [
  { email: 'admin@emulator.test', password: 'emulator-admin-1', name: '시험관리자', role: 'admin' },
  { email: 'user@emulator.test', password: 'emulator-user-1', name: '시험작업자', role: 'user' },
]

for (const a of ACCOUNTS) {
  const res = await fetch(`${AUTH}/accounts:signUp?key=demo-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: a.email, password: a.password, returnSecureToken: true }),
  })
  const body = await res.json()
  if (!res.ok) {
    console.log(`${a.email}: ${body.error?.message}`)
    continue
  }
  // "Bearer owner" 는 에뮬레이터에서만 통하는 관리자 토큰이다
  await fetch(`${STORE}/users/${body.localId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
    body: JSON.stringify({
      fields: {
        uid: { stringValue: body.localId },
        name: { stringValue: a.name },
        email: { stringValue: a.email },
        role: { stringValue: a.role },
        active: { booleanValue: true },
      },
    }),
  })
  console.log(`${a.email}: ${a.role} 계정 생성`)
}
