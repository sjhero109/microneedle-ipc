import { useState } from 'react'
import { useActor } from '../data/auth'
import { closeBatch, startBatch, updateBatch, useDb } from '../data/store'
import type { Batch } from '../data/types'
import { CONTENT_MAX, CONTENT_MIN, adjustOf, adjustRange, baseTargetOf, contentOf, targetForContent } from '../data/types'
import { Button, Field, Input, NumInput, Select, fmt, parseNum } from './common'

const today = () => new Date().toLocaleDateString('sv-SE')

/** 최상단 배치 정보: 제품명(레시피), 배치번호, 제조일자, 약액부명, 기저부명, IPC 배수 */
export function BatchBar({ batch, onSelect }: { batch: Batch | null; onSelect(id: string | null): void }) {
  const db = useDb()
  const actor = useActor()
  const recipes = db.recipes.filter((r) => r.active)
  // 레시피 목록은 화면이 뜬 뒤에 도착할 수 있으므로, 고르기 전에는 첫 레시피를 쓴다
  const [picked, setRecipeId] = useState('')
  const recipe = recipes.find((r) => r.id === picked) ?? recipes[0]
  const recipeId = recipe?.id ?? ''
  const [batchNo, setBatchNo] = useState('')
  const [mfgDate, setMfgDate] = useState(today)
  const [drugName, setDrugName] = useState<string | null>(null)
  const [baseName, setBaseName] = useState<string | null>(null)
  const [shots, setShots] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [drugAdjust, setDrugAdjust] = useState('')
  const [baseAdjust, setBaseAdjust] = useState('')
  const batchRecipe = batch ? db.recipes.find((r) => r.id === batch.recipeId) : undefined
  const [editing, setEditing] = useState(false)
  const [closing, setClosing] = useState(false)
  const [error, setError] = useState('')

  const saved = db.batches
    .filter((b) => b.status !== 'closed')
    .sort((a, b) => (b.mfgDate || '').localeCompare(a.mfgDate || '') || b.createdAt - a.createdAt)
  const names = (key: 'drugName' | 'baseName') => [...new Set(db.batches.map((b) => b[key]).filter(Boolean))]

  if (batch && !editing) {
    const items: [string, string][] = [
      ['제품명', db.recipes.find((r) => r.id === batch.recipeId)?.name ?? batch.productName],
      ['배치번호', batch.batchNo],
      ['제조일자', batch.mfgDate],
      ['약액부명', batch.drugName || '–'],
      ['기저부명', batch.baseName || '–'],
      ['약액부 함량', `${contentOf(batch, batchRecipe)}%`],
      ['약액부 목표 중량', `${fmt(batch.drugTarget, 3)} mg`],
      ['약액부 IPC 배수', batch.shots > 1 ? `${batch.shots}회 (${fmt(batch.drugTarget * batch.shots, 2)} mg)` : '1회'],
      ['약액부 조정 목표', `${adjustOf(batch, 'drug')}%`],
      ['기저부 조정 목표', `${adjustOf(batch, 'base')}%`],
    ]
    return (
      <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
        {/* 항목마다 이름과 값이 한 줄에 들어가도록 줄바꿈 없이 내용 폭만큼 차지하고, 자리가 모자라면 다음 줄로 넘긴다 */}
        <dl className="flex min-w-0 flex-1 basis-full flex-wrap gap-x-6 gap-y-2.5 xl:basis-0">
          {items.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-xs whitespace-nowrap text-sub">{k}</dt>
              <dd className="num font-semibold whitespace-nowrap">
                {v}
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex gap-2">
          <Button
            className="h-10 px-3 text-sm"
            onClick={() => {
              setDrugName(batch.drugName)
              setBaseName(batch.baseName)
              setShots(String(batch.shots))
              setContent(String(contentOf(batch, batchRecipe)))
              setDrugAdjust(String(adjustOf(batch, 'drug')))
              setBaseAdjust(String(adjustOf(batch, 'base')))
              setMfgDate(batch.mfgDate)
              setEditing(true)
            }}
          >
            정보 수정
          </Button>
          <Button className="h-10 px-3 text-sm" onClick={() => onSelect(null)}>
            다른 배치
          </Button>
          <Button variant="danger" className="h-10 px-3 text-sm" onClick={() => setClosing(true)}>
            배치 완료
          </Button>
        </div>
        {closing && (
          <div className="flex basis-full flex-wrap items-center gap-2 rounded-lg border border-bad/40 bg-bad/5 px-3 py-2.5 text-sm">
            <span className="min-w-0 flex-1">
              <b>{batch.batchNo}</b> 배치를 완료 처리합니다. 완료하면 IPC 탭에서 불러오거나 기록을 더할 수 없고, 결과 탭에서만 볼 수 있습니다.
            </span>
            <Button
              variant="danger"
              className="h-10 px-3 text-sm"
              onClick={async () => {
                try {
                  await closeBatch(actor, batch.id)
                  onSelect(null)
                } catch (e) {
                  setError(e instanceof Error ? e.message : '완료 처리하지 못했습니다.')
                }
              }}
            >
              완료 확정
            </Button>
            <Button className="h-10 px-3 text-sm" onClick={() => setClosing(false)}>
              취소
            </Button>
            {error && <span className="basis-full text-bad">{error}</span>}
          </div>
        )}
      </div>
    )
  }

  const drug = drugName ?? recipe?.defaultDrugName ?? ''
  const base = baseName ?? recipe?.defaultBaseName ?? ''
  const shotsText = shots ?? String(recipe?.defaultShots ?? 3)
  const n = parseNum(shotsText)
  const shotsOk = n !== null && Number.isInteger(n) && n >= 1
  // 약액부는 함량(%)을 입력하면 목표 중량을 환산한다: 함량 100% 기준 중량 × 100 ÷ 함량
  const contentText = content ?? String(batch ? contentOf(batch, batchRecipe) : 100)
  const cv = parseNum(contentText)
  const contentOk = cv !== null && cv >= CONTENT_MIN && cv <= CONTENT_MAX
  const baseTarget = batch ? baseTargetOf(batch, batchRecipe) : recipe?.drugTarget
  const tv = contentOk && baseTarget ? targetForContent(baseTarget, cv) : null
  const targetOk = tv !== null

  async function submit() {
    setError('')
    try {
      if (!shotsOk) throw new Error('IPC 배수는 1 이상의 정수로 입력하세요.')
      if (!contentOk) throw new Error(`약액부 함량은 ${CONTENT_MIN}~${CONTENT_MAX}% 사이로 입력하세요.`)
      if (batch) {
        const [lo, hi] = adjustRange(batch)
        const da = parseNum(drugAdjust)
        const ba = parseNum(baseAdjust)
        if (da === null || ba === null || da < lo || da > hi || ba < lo || ba > hi) throw new Error(`조정 목표는 적합 범위(${lo}~${hi}%) 안에서 입력하세요.`)
        await updateBatch(actor, batch.id, { drugName: drug, baseName: base, shots: n, mfgDate, contentPct: cv, drugAdjustPct: da, baseAdjustPct: ba })
        setEditing(false)
        return
      }
      if (!recipe) throw new Error('제품을 선택하세요.')
      if (!batchNo.trim()) throw new Error('배치번호를 입력하세요.')
      onSelect(await startBatch(actor, { recipeId: recipe.id, batchNo: batchNo.trim(), mfgDate, drugName: drug, baseName: base, shots: n, contentPct: cv }))
    } catch (e) {
      setError(e instanceof Error ? e.message : '처리하지 못했습니다.')
    }
  }

  const existing = !batch && db.batches.find((b) => b.recipeId === recipeId && b.batchNo === batchNo.trim() && b.status !== 'closed')

  return (
    <div className="flex flex-col gap-2">
      {!batch && (
        <>
          <Field label="기존 배치 불러오기" className="sm:max-w-md">
            <Select value="" onChange={(e) => e.target.value && onSelect(e.target.value)} disabled={saved.length === 0}>
              <option value="">{saved.length ? `배치를 선택하세요 (${saved.length}건)` : '저장된 배치가 없습니다'}</option>
              {saved.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.mfgDate || '제조일자 없음'} · {b.batchNo} · {b.productName}
                </option>
              ))}
            </Select>
          </Field>
          <div className="mt-1 text-xs font-semibold text-sub">새 배치 시작</div>
        </>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-[1.1fr_1.1fr_1fr_1.1fr_1.1fr_0.9fr_0.8fr_auto] lg:items-end">
        <Field label="제품명">
          {batch ? (
            <Input value={batch.productName} disabled />
          ) : (
            <Select
              value={recipeId}
              onChange={(e) => {
                setRecipeId(e.target.value)
                setDrugName(null)
                setBaseName(null)
                setShots(null)
                setContent(null)
              }}
            >
              {recipes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="배치번호">
          {batch ? (
            <Input value={batch.batchNo} disabled />
          ) : (
            <>
              <Input value={batchNo} onChange={(e) => setBatchNo(e.target.value)} list="batch-list" autoComplete="off" />
              <datalist id="batch-list">
                {db.batches
                  .filter((b) => b.recipeId === recipeId && b.status !== 'closed')
                  .map((b) => (
                    <option key={b.id} value={b.batchNo} />
                  ))}
              </datalist>
            </>
          )}
        </Field>
        <Field label="제조일자">
          <Input type="date" value={mfgDate} onChange={(e) => setMfgDate(e.target.value)} disabled={!!existing} />
        </Field>
        <Field label="약액부명">
          <Input value={drug} onChange={(e) => setDrugName(e.target.value)} list="drug-list" disabled={!!existing} />
          <datalist id="drug-list">
            {names('drugName').map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </Field>
        <Field label="기저부명">
          <Input value={base} onChange={(e) => setBaseName(e.target.value)} list="base-list" disabled={!!existing} />
          <datalist id="base-list">
            {names('baseName').map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </Field>
        <Field label="약액부 함량 (%)">
          <NumInput value={contentText} onChange={(e) => setContent(e.target.value)} disabled={!!existing} />
        </Field>
        <Field label="약액부 IPC 배수">
          <NumInput value={shotsText} onChange={(e) => setShots(e.target.value)} inputMode="numeric" disabled={!!existing} />
        </Field>
        {batch && (
          <>
            <Field label="약액부 조정 목표 (%)">
              <NumInput value={drugAdjust} onChange={(e) => setDrugAdjust(e.target.value)} />
            </Field>
            <Field label="기저부 조정 목표 (%)">
              <NumInput value={baseAdjust} onChange={(e) => setBaseAdjust(e.target.value)} />
            </Field>
          </>
        )}
        <div className="col-span-2 flex gap-2 sm:col-span-3 lg:col-span-1">
          <Button variant="primary" onClick={submit} className="flex-1">
            {batch ? '저장' : existing ? '배치 불러오기' : '배치 시작'}
          </Button>
          {batch && (
            <Button onClick={() => setEditing(false)} className="flex-1">
              취소
            </Button>
          )}
        </div>
      </div>
      {recipe && !batch && (
        <p className="num text-xs text-sub">
          목표 중량: 약액부 {targetOk ? fmt(tv, 3) : '–'} mg{targetOk ? ` (함량 ${cv}% 환산: ${fmt(baseTarget ?? 0, 2)} × 100 ÷ ${cv})` : ''}
          {targetOk && shotsOk && n > 1 ? ` · 같은 Pulse로 ${n}회 토출한 합계 ${fmt(tv * n, 2)} mg` : ''} · 기저부{' '}
          {fmt(recipe.baseTarget, 1)} mg
        </p>
      )}
      {batch && (
        <p className="text-xs text-sub">
          함량 {contentOk ? cv : '–'}% → 약액부 목표 중량 <b>{targetOk ? fmt(tv, 3) : '–'} mg</b> (= {fmt(baseTarget ?? 0, 2)} × 100 ÷ 함량). 함량을 바꾸면 그 뒤에 저장하는 IPC부터 새
          목표로 판정하고 추천 Pulse도 새 목표에 맞춰 계산합니다. 이미 저장한 기록의 판정은 바뀌지 않습니다. 기저부 목표 중량은 함량과 무관합니다.
          <br />
          조정 목표는 추천 Pulse·Speed를 계산할 때 맞추는 중량(목표 대비 %)입니다. 적합 범위({adjustRange(batch)[0]}~{adjustRange(batch)[1]}%) 안에서 약액부와 기저부를
          따로 정할 수 있고, 적합 판정 기준은 바뀌지 않습니다.
        </p>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
    </div>
  )
}
