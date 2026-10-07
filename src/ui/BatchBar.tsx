import { useState } from 'react'
import { useActor } from '../data/auth'
import { startBatch, updateBatch, useDb } from '../data/store'
import type { Batch } from '../data/types'
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
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')

  const recent = [...db.batches].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6)
  const names = (key: 'drugName' | 'baseName') => [...new Set(db.batches.map((b) => b[key]).filter(Boolean))]

  if (batch && !editing) {
    const items: [string, string][] = [
      ['제품명', db.recipes.find((r) => r.id === batch.recipeId)?.name ?? batch.productName],
      ['배치번호', batch.batchNo],
      ['제조일자', batch.mfgDate],
      ['약액부명', batch.drugName || '–'],
      ['기저부명', batch.baseName || '–'],
      ['약액부 IPC 배수', `같은 Pulse로 ${batch.shots}회 (${fmt(batch.drugTarget * batch.shots, 2)} mg)`],
    ]
    return (
      <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
        <dl className="grid min-w-0 flex-1 basis-full grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-3 xl:basis-0 xl:grid-cols-6">
          {items.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-xs text-sub">{k}</dt>
              <dd className="num font-semibold break-words">{v}</dd>
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
              setMfgDate(batch.mfgDate)
              setEditing(true)
            }}
          >
            정보 수정
          </Button>
          <Button className="h-10 px-3 text-sm" onClick={() => onSelect(null)}>
            다른 배치
          </Button>
        </div>
      </div>
    )
  }

  const drug = drugName ?? recipe?.defaultDrugName ?? ''
  const base = baseName ?? recipe?.defaultBaseName ?? ''
  const shotsText = shots ?? String(recipe?.defaultShots ?? 3)
  const n = parseNum(shotsText)
  const shotsOk = n !== null && Number.isInteger(n) && n >= 1

  async function submit() {
    setError('')
    try {
      if (!shotsOk) throw new Error('IPC 배수는 1 이상의 정수로 입력하세요.')
      if (batch) {
        await updateBatch(actor, batch.id, { drugName: drug, baseName: base, shots: n, mfgDate })
        setEditing(false)
        return
      }
      if (!recipe) throw new Error('제품을 선택하세요.')
      if (!batchNo.trim()) throw new Error('배치번호를 입력하세요.')
      onSelect(await startBatch(actor, { recipeId: recipe.id, batchNo: batchNo.trim(), mfgDate, drugName: drug, baseName: base, shots: n }))
    } catch (e) {
      setError(e instanceof Error ? e.message : '처리하지 못했습니다.')
    }
  }

  const existing = !batch && db.batches.find((b) => b.recipeId === recipeId && b.batchNo === batchNo.trim())

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-[1.2fr_1.2fr_1fr_1.2fr_1.2fr_0.8fr_auto] lg:items-end">
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
                  .filter((b) => b.recipeId === recipeId)
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
        <Field label="약액부 IPC 배수">
          <NumInput value={shotsText} onChange={(e) => setShots(e.target.value)} inputMode="numeric" disabled={!!existing} />
        </Field>
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
          목표 중량: 약액부 {fmt(recipe.drugTarget, 2)} mg{shotsOk && n > 1 ? ` (같은 Pulse로 ${n}회 토출한 합계 = ${fmt(recipe.drugTarget * n, 2)} mg)` : ''} · 기저부{' '}
          {fmt(recipe.baseTarget, 1)} mg
        </p>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
      {!batch && recent.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-sub">최근 배치</span>
          {recent.map((b) => (
            <button key={b.id} type="button" onClick={() => onSelect(b.id)} className="num h-9 rounded-lg border border-line px-3 text-sm hover:bg-sunken">
              {b.batchNo}
              <span className="ml-1.5 text-xs text-sub">{b.mfgDate || b.productName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
