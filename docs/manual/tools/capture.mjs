// 매뉴얼용 화면 캡처 (로컬 에뮬레이터 전용, 예시 데이터)
import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'

const OUT = process.argv[2]
mkdirSync(OUT, { recursive: true })
const URL = 'http://localhost:5181/microneedle-ipc/'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const ADMIN = ['admin@emulator.test', 'emulator-admin-1']
const USER = ['user@emulator.test', 'emulator-user-1']
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

import { spawn } from 'node:child_process'
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--lang=ko-KR', '--remote-debugging-port=9334', '--user-data-dir=' + process.env.TEMP + '/manual-cap-prof', 'about:blank'], { stdio: 'ignore' })
await wait(3000)
const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9334', defaultViewport: null })

async function newPage(width = 1280, height = 820) {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport({ width, height, deviceScaleFactor: 2 })
  await page.goto(URL, { waitUntil: 'networkidle0' })
  await page.evaluate(() => {
    window.H = {
      set(el, v) {
        const p = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(p, 'value').set.call(el, v)
        el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
      },
      btn: (t, root = document) => [...root.querySelectorAll('button')].find((b) => b.innerText.trim() === t),
      lab: (t, root = document) => [...root.querySelectorAll('label')].find((l) => l.innerText.includes(t))?.querySelector('input,select'),
      card: (t) => [...document.querySelectorAll('main article')].find((a) => a.innerText.startsWith(t)),
    }
  })
  return page
}
const ev = (page, fn, ...a) => page.evaluate(fn, ...a)
async function shot(page, name, el) {
  await wait(500)
  if (el) {
    const h = await page.evaluateHandle(el)
    await h.asElement().screenshot({ path: `${OUT}/${name}.png` })
  } else await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log('shot', name)
}
async function login(page, [email, pw]) {
  await ev(page, (e, p) => {
    H.set(H.lab('이메일'), e)
    H.set(H.lab('비밀번호'), p)
  }, email, pw)
  await wait(100)
  await ev(page, () => [...document.querySelectorAll('main button')].find((b) => b.innerText.trim() === '로그인').click())
  await wait(3000)
}
async function confirmPw(page, pw) {
  await wait(500)
  await ev(page, (p) => {
    const i = document.querySelector('input[type=password]')
    if (i) H.set(i, p)
  }, pw)
  await wait(150)
  await ev(page, () => H.btn('확인')?.click())
  await wait(1500)
}
const click = (page, t) => ev(page, (t) => H.btn(t).click(), t)
async function save(page, cardTitle, tray, pulse, total) {
  await ev(page, (c, t, p, w) => {
    const card = H.card(c)
    const ins = card.querySelectorAll('input')
    H.set(ins[0], t)
    if (p !== null) H.set(ins[1], p)
    H.set(ins[2], w)
  }, cardTitle, tray, pulse, total)
  await wait(300)
  await ev(page, (c) => [...H.card(c).querySelectorAll('button')].find((b) => b.innerText.trim().endsWith('저장')).click(), cardTitle)
  await wait(1400)
}
const fieldPulse = (page, c) => ev(page, (c) => Number(H.card(c).querySelectorAll('input')[1].value), c)

// ── 1. 로그인·회원가입 ──
const pub = await newPage()
await shot(pub, '01-login')
await click(pub, '회원가입')
await ev(pub, () => {
  H.set(H.lab('이름'), '작업자B')
  H.set(H.lab('이메일'), 'new@emulator.test')
})
await shot(pub, '02-signup')
await ev(pub, () => [...document.querySelectorAll('button')].filter((b) => b.innerText.trim() === '회원가입')[0].click())
await wait(3000)
await shot(pub, '03-signup-done')

// ── 2. 관리자: 승인, 레시피, 배치 ──
const admin = await newPage()
await login(admin, ADMIN)
await click(admin, '관리자')
await wait(300)
await click(admin, '사용자')
await wait(600)
await shot(admin, '10-admin-users-pending', () => document.querySelector('main'))
await ev(admin, () => [...[...document.querySelectorAll('li')].find((l) => l.innerText.includes('new@emulator.test')).querySelectorAll('button')].find((b) => b.innerText.trim() === '승인').click())
await confirmPw(admin, ADMIN[1])

await click(admin, '레시피')
await wait(300)
await click(admin, '레시피 추가')
await wait(300)
await ev(admin, () => {
  H.set(H.lab('제품명 (레시피명)'), '고용량')
  H.set(H.lab('기본 기저부명'), '기저 A')
})
await shot(admin, '11-admin-recipe-form', () => document.querySelector('main'))
await ev(admin, () => [...document.querySelectorAll('main button')].find((b) => b.innerText.trim() === '저장').click())
await confirmPw(admin, ADMIN[1])
await shot(admin, '12-admin-recipe-list', () => document.querySelector('main'))

// 첫 로그인 비밀번호 변경 (새 가입자)
const fresh = await newPage(1000, 700)
await login(fresh, ['new@emulator.test', 'dw1234'])
await shot(fresh, '04-first-login-change')

// ── 3. 작업자: 배치 시작과 IPC ──
const user = await newPage()
await login(user, USER)
await ev(user, () => {
  H.set(H.lab('배치번호'), 'MN-2610-01')
  H.set(H.lab('약액부 함량'), '98.5')
})
await wait(300)
await shot(user, '20-batch-new', () => document.querySelector('header'))
await click(user, '배치 시작')
await wait(1800)
await shot(user, '21-batch-started')

// 약액부: 생산 전 세팅(트레이 0) → 개시 IPC → 공정 중 IPC, 추천값을 따라 조정
const plants = {
  '약액부 토출기 1': (p) => 1.25 * p + 0.45,
  '약액부 토출기 2': (p) => 1.18 * p + 0.62,
  '약액부 토출기 3': (p) => 1.32 * p + 0.2,
  '기저부 토출기 1': (p) => 8.9 * p + 12,
  '기저부 토출기 2': (p) => 9.2 * p + 5,
}
const noise = [0.04, -0.06, 0.03, -0.02, 0.05, -0.04, 0.02, 0.01, -0.03, 0.04]
let k = 0
for (const [c, start] of [['약액부 토출기 1', 4.4], ['약액부 토출기 2', 4.6], ['약액부 토출기 3', 4.2]]) {
  let p = start
  for (const tray of ['0', '1', '1', '10', '20', '30']) {
    const per = plants[c](p) + noise[k++ % noise.length] - (Number(tray) / 10) * 0.05
    await save(user, c, tray, String(p), (per * 3).toFixed(2))
    p = await fieldPulse(user, c)
  }
}
for (const [c, start] of [['기저부 토출기 1', 37.5], ['기저부 토출기 2', 37]]) {
  let p = start
  for (const tray of ['1', '1', '10', '20']) {
    const per = plants[c](p) + noise[k++ % noise.length] * 20
    await save(user, c, tray, String(p), per.toFixed(1))
    p = await fieldPulse(user, c)
  }
}
await ev(user, () => window.scrollTo(0, 0))
await shot(user, '22-ipc-overview')
// 입력 중 미리보기
await ev(user, () => {
  const card = H.card('약액부 토출기 1')
  const ins = card.querySelectorAll('input')
  H.set(ins[0], '40')
  H.set(ins[2], '18.62')
  card.scrollIntoView({ block: 'start' })
})
await wait(600)
await shot(user, '23-card-preview', () => H.card('약액부 토출기 1'))
await ev(user, () => H.set(H.card('약액부 토출기 1').querySelectorAll('input')[2], ''))

// 테스트 모드
await ev(user, () => window.scrollTo(0, 0))
await ev(user, () => document.querySelector('main input[type=checkbox]').click())
await wait(1500)
await shot(user, '24-test-mode', () => document.querySelector('main section').parentElement)
await ev(user, () => document.querySelector('main input[type=checkbox]').click())
await wait(1500)

// 정보 수정
await click(user, '정보 수정')
await wait(400)
await shot(user, '25-batch-edit', () => document.querySelector('header'))
await click(user, '취소')
await wait(300)

// 기록 상세·정정 요청 (관리자 알림 확인용으로 관리자 화면은 IPC 탭에 둔다)
await click(admin, 'IPC')
await ev(admin, () => {
  const s = document.querySelector('select')
  const o = [...s.options].find((o) => o.text.includes('MN-2610-01'))
  H.set(s, o.value)
})
await wait(1500)
await ev(user, () => H.card('약액부 토출기 2').querySelector('tbody tr').click())
await wait(600)
await ev(user, () => {
  H.set(H.lab('정정할 트레이번호'), '0')
  H.set(H.lab('사유 (필수)'), '생산 전 세팅 측정을 1로 입력함')
})
await shot(user, '26-record-detail', () => document.querySelector('[role=dialog], .fixed.inset-0 > div') ?? document.body)
await click(user, '정정 요청')
await wait(2000)
await click(user, '닫기')
await shot(admin, '30-admin-toast')
await ev(admin, () => document.querySelector('[aria-label^="알림"]').click())
await wait(500)
await shot(admin, '31-admin-bell-panel')
await ev(admin, () => {
  const panel = document.querySelector('.fixed.top-16')
  H.set(panel.querySelector('input'), '확인함')
  ;[...panel.querySelectorAll('button')].find((b) => b.innerText.trim() === '승인').click()
})
await confirmPw(admin, ADMIN[1])
await ev(admin, () => document.querySelector('[aria-label^="알림"]').click())
await wait(1500)
await shot(user, '27-user-result-toast')

// ── 4. 결과·보고서 ──
await click(user, '결과')
await wait(800)
await shot(user, '40-results-list', () => document.querySelector('main'))
await ev(user, () => [...document.querySelectorAll('main *')].find((e) => e.children.length === 0 && e.innerText === 'MN-2610-01').click())
await wait(1000)
await shot(user, '41-results-batch')
await click(user, '보고서')
await wait(2000)
await shot(user, '42-report-p1', () => document.querySelector('.report-first'))
await shot(user, '43-report-p2', () => document.querySelector('.report-raw'))
await click(user, '닫기')
await wait(300)

await click(user, '계산 로직')
await wait(800)
await shot(user, '50-logic', () => document.querySelector('main'))

// ── 5. 관리자 화면 ──
await click(admin, '관리자')
await wait(400)
await click(admin, '정정·이상치 검토')
await wait(500)
await shot(admin, '32-admin-review', () => document.querySelector('main'))
await click(admin, 'Audit trail')
await wait(600)
await shot(admin, '33-admin-audit', () => document.querySelector('main'))
await click(admin, '설정')
await wait(400)
await shot(admin, '34-admin-settings', () => document.querySelector('main'))
await click(admin, '사용자')
await wait(500)
await shot(admin, '13-admin-users', () => document.querySelector('main'))
await click(admin, '데이터 가져오기')
await wait(400)
await shot(admin, '35-admin-import', () => document.querySelector('main'))

// 배치 완료 확인
await click(user, 'IPC')
await wait(500)
await click(user, '배치 완료')
await wait(400)
await shot(user, '28-batch-close', () => document.querySelector('header'))
await click(user, '취소')

// 모바일 화면
const mobile = await newPage(390, 844)
await login(mobile, USER)
await ev(mobile, () => {
  const s = document.querySelector('select')
  const o = [...s.options].find((o) => o.text.includes('MN-2610-01'))
  if (o) H.set(s, o.value)
})
await wait(1500)
await ev(mobile, () => H.card('약액부 토출기 1').scrollIntoView({ block: 'start' }))
await wait(500)
await shot(mobile, '29-mobile')

await browser.close()
chrome.kill()
console.log('done')
