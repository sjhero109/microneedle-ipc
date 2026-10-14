import { useState } from 'react'
import { useActor } from '../data/auth'
import { setTestMode } from '../data/store'
import type { Batch } from '../data/types'
import { DISPENSERS, adjustOf, targetOf } from '../data/types'
import { DispenserCard } from './DispenserCard'
import { timeOnly } from './common'

export function CalcTab({ batch }: { batch: Batch | null }) {
  const actor = useActor()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!batch) {
    return <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sub">위에서 제품과 배치번호를 입력하고 배치를 시작하세요.</p>
  }
  // 테스트 모드는 배치에 저장되어 탭을 옮기거나 다른 사람이 보아도 같다
  const testMode = batch.testMode === true
  async function toggle(on: boolean) {
    setBusy(true)
    setError('')
    try {
      await setTestMode(actor, batch!.id, on)
    } catch (e) {
      setError(e instanceof Error ? e.message : '테스트 모드를 바꾸지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }
  const drug = DISPENSERS.filter((d) => d.type === 'drug')
  const base = DISPENSERS.filter((d) => d.type === 'base')
  return (
    <div className="flex flex-col gap-5">
      <label className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${testMode ? 'border-warn bg-warn/15' : 'border-line bg-panel'}`}>
        <input type="checkbox" className="size-5 shrink-0" checked={testMode} disabled={busy} onChange={(e) => void toggle(e.target.checked)} />
        <span>
          <span className="font-semibold">테스트{testMode ? ' 모드 켜짐' : ''}</span>
          <span className="ml-2 text-sm text-sub">
            {testMode
              ? `${batch.testModeByName ?? ''}${batch.testModeAt ? ` · ${timeOnly(batch.testModeAt)}` : ''}부터 – 이 배치에서 누가 저장하든 테스트 기록이 되고 계산식에는 반영되지 않습니다.`
              : '체크하면 이 배치의 모든 사용자 화면에 함께 적용됩니다. 켜진 동안 저장하는 값은 기록만 남고 계산식에는 반영되지 않습니다.'}
          </span>
        </span>
      </label>
      {error && <p className="text-sm text-bad">{error}</p>}
      <section>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-sub">
          <span className="inline-block size-2.5 rounded-sm bg-drug" />
          약액부
        </h2>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {drug.map((d) => (
            <DispenserCard key={`${batch.id}-${d.id}-${targetOf(batch, d.type)}-${adjustOf(batch, d.type)}`} batch={batch} dispenser={d} testMode={testMode} />
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-sub">
          <span className="inline-block size-2.5 rounded-sm bg-base" />
          기저부
        </h2>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {base.map((d) => (
            <DispenserCard key={`${batch.id}-${d.id}-${targetOf(batch, d.type)}-${adjustOf(batch, d.type)}`} batch={batch} dispenser={d} testMode={testMode} />
          ))}
        </div>
      </section>
    </div>
  )
}
