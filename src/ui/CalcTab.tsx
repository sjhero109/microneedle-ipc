import type { Batch } from '../data/types'
import { DISPENSERS } from '../data/types'
import { DispenserCard } from './DispenserCard'

export function CalcTab({ batch }: { batch: Batch | null }) {
  if (!batch) {
    return <p className="rounded-xl border border-dashed border-line px-4 py-10 text-center text-sub">위에서 제품과 배치번호를 입력하고 배치를 시작하세요.</p>
  }
  const drug = DISPENSERS.filter((d) => d.type === 'drug')
  const base = DISPENSERS.filter((d) => d.type === 'base')
  return (
    <div className="flex flex-col gap-5">
      <section>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-sub">
          <span className="inline-block size-2.5 rounded-sm bg-drug" />
          약액부
        </h2>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {drug.map((d) => (
            <DispenserCard key={`${batch.id}-${d.id}`} batch={batch} dispenser={d} />
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
            <DispenserCard key={`${batch.id}-${d.id}`} batch={batch} dispenser={d} />
          ))}
        </div>
      </section>
    </div>
  )
}
