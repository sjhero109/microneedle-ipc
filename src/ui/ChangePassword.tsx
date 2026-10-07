import { useState } from 'react'
import { useAuth } from '../data/auth'
import { Button, Field, Input } from './common'

/** 본인 비밀번호 변경. forced 이면 초기화된 비밀번호로 들어온 직후라 건너뛸 수 없다 */
export function ChangePassword({ forced, onDone }: { forced?: boolean; onDone?(): void }) {
  const { changePassword, logout } = useAuth()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    setError('')
    if (next.length < 6) return setError('새 비밀번호는 6자 이상이어야 합니다.')
    if (next !== again) return setError('새 비밀번호가 서로 다릅니다.')
    if (next === current) return setError('지금 비밀번호와 다른 값을 입력하세요.')
    setBusy(true)
    try {
      await changePassword(current, next)
      onDone?.()
    } catch (e) {
      const code = (e as { code?: string }).code ?? ''
      setError(code.startsWith('auth/') ? '지금 비밀번호가 맞지 않습니다.' : '비밀번호를 바꾸지 못했습니다. 잠시 후 다시 시도하세요.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {forced && <p className="text-sm text-sub">관리자가 비밀번호를 초기화했습니다. 계속하려면 새 비밀번호를 정하세요.</p>}
      <Field label={forced ? '지금 비밀번호 (초기화된 비밀번호)' : '지금 비밀번호'}>
        <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
      </Field>
      <Field label="새 비밀번호 (6자 이상)">
        <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      </Field>
      <Field label="새 비밀번호 확인">
        <Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </Field>
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex gap-2">
        <Button variant="primary" disabled={!current || !next || !again || busy} onClick={submit}>
          비밀번호 변경
        </Button>
        {forced && <Button onClick={() => void logout()}>로그아웃</Button>}
      </div>
    </div>
  )
}
