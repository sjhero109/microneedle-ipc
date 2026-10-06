import { useSyncExternalStore } from 'react'
import type { Phase } from '../engine'
import { localBackend, newId, type AuditDraft, type Backend, type Write } from './backend'
import { batchRecords, dispenserView, evaluate } from './model'
import type { Actor, Batch, Correction, DbState, DispenserId, IpcRecord, Recipe, UserProfile } from './types'
import { DISPENSERS, materialOf, shotsOf, targetOf } from './types'

const EMPTY: DbState = { recipes: [], batches: [], records: [], corrections: [], audit: [], users: [] }

let backend: Backend = localBackend()
let state: DbState = EMPTY
const listeners = new Set<() => void>()
let unsubscribe = backend.subscribe((s) => {
  state = s
  listeners.forEach((l) => l())
})

/** 저장소를 바꿔 끼운다 (Firebase 연결 시 사용) */
export function setBackend(b: Backend) {
  unsubscribe()
  backend = b
  unsubscribe = backend.subscribe((s) => {
    state = s
    listeners.forEach((l) => l())
  })
}

export function useDb(): DbState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => state,
  )
}

export const getDb = () => state

function by(actor: Actor): Pick<AuditDraft, 'uid' | 'name' | 'email' | 'role'> {
  return { uid: actor.uid, name: actor.name, email: actor.email, role: actor.role }
}

function audit(actor: Actor, action: string, target: string, targetId: string, rest: Partial<AuditDraft> = {}): AuditDraft {
  return { ...by(actor), action, target, targetId, ...rest }
}

function requireAdmin(actor: Actor) {
  if (actor.role !== 'admin') throw new Error('관리자만 할 수 있는 작업입니다.')
}

/** 로그인·로그아웃·내보내기처럼 데이터 변경이 없는 작업의 기록 */
export function logEvent(actor: Actor, action: string, detail?: unknown) {
  return backend.commit([], [audit(actor, action, 'session', actor.uid, { after: detail })])
}

export type RecipeInput = Omit<Recipe, 'id' | 'updatedAt' | 'updatedBy'> & { id?: string }

export async function saveRecipe(actor: Actor, input: RecipeInput, reason?: string): Promise<string> {
  requireAdmin(actor)
  const id = input.id ?? newId()
  const before = state.recipes.find((r) => r.id === id)
  const data = { ...input, id, updatedAt: Date.now(), updatedBy: actor.uid }
  await backend.commit(
    [{ col: 'recipes', id, data }],
    [audit(actor, before ? '레시피 수정' : '레시피 생성', 'recipes', id, { before, after: data, reason })],
  )
  return id
}

export interface BatchInput {
  recipeId: string
  batchNo: string
  mfgDate: string
  drugName: string
  baseName: string
  shots: number
}

/** 같은 제품·배치번호가 있으면 그 배치를 돌려주고, 없으면 새로 만든다 */
export async function startBatch(actor: Actor, input: BatchInput): Promise<string> {
  const existing = state.batches.find((b) => b.recipeId === input.recipeId && b.batchNo === input.batchNo)
  if (existing) return existing.id
  const recipe = state.recipes.find((r) => r.id === input.recipeId)
  if (!recipe) throw new Error('레시피를 찾을 수 없습니다.')
  const id = newId()
  const batch: Batch = {
    id,
    recipeId: recipe.id,
    productName: recipe.name,
    batchNo: input.batchNo,
    mfgDate: input.mfgDate,
    drugName: input.drugName,
    baseName: input.baseName,
    shots: input.shots,
    drugTarget: recipe.drugTarget,
    baseTarget: recipe.baseTarget,
    bands: recipe.bands,
    bandCenterPct: recipe.bandCenterPct,
    adjustPct: recipe.adjustPct,
    passLowPct: recipe.passLowPct,
    passHighPct: recipe.passHighPct,
    pulseStep: recipe.pulseStep,
    status: 'open',
    createdAt: Date.now(),
    createdBy: actor.uid,
  }
  await backend.commit([{ col: 'batches', id, data: { ...batch } }], [audit(actor, '배치 시작', 'batches', id, { after: batch })])
  return id
}

export async function updateBatch(
  actor: Actor,
  id: string,
  patch: Partial<Pick<Batch, 'drugName' | 'baseName' | 'shots' | 'mfgDate' | 'status'>>,
) {
  const before = state.batches.find((b) => b.id === id)
  if (!before) throw new Error('배치를 찾을 수 없습니다.')
  const changed = Object.fromEntries(Object.entries(patch).filter(([k, v]) => before[k as keyof Batch] !== v))
  if (Object.keys(changed).length === 0) return
  const prev = Object.fromEntries(Object.keys(changed).map((k) => [k, before[k as keyof Batch]]))
  await backend.commit([{ col: 'batches', id, data: changed }], [audit(actor, '배치 정보 변경', 'batches', id, { before: prev, after: changed })])
}

export interface IpcInput {
  tray: number
  pulse: number
  totalWeight: number
  phase: Phase
}

function buildRecord(
  db: DbState,
  actor: Actor,
  batch: Batch,
  dispenserId: DispenserId,
  input: IpcInput,
  seq: number,
  extra: Partial<IpcRecord> = {},
): IpcRecord {
  const type = DISPENSERS.find((d) => d.id === dispenserId)!.type
  const shots = shotsOf(batch, type)
  const weight = input.totalWeight / shots
  const view = dispenserView(db, batch, dispenserId, { tray: input.tray, pulse: input.pulse, weight, shots, phase: input.phase })
  const step = view.model.steps[view.model.steps.length - 1]
  return {
    id: newId(),
    batchId: batch.id,
    recipeId: batch.recipeId,
    productName: batch.productName,
    batchNo: batch.batchNo,
    dispenserId,
    materialType: type,
    materialName: materialOf(batch, type),
    seq,
    tray: input.tray,
    pulse: input.pulse,
    shots,
    totalWeight: input.totalWeight,
    weight,
    phase: input.phase,
    target: targetOf(batch, type),
    ...evaluate(batch, type, weight),
    recommendedPulse: view.recommendation?.pulse ?? null,
    model: step
      ? { level: step.levelAtPulse, b: view.model.params.b, drift: view.model.params.drift, gain: step.gain, source: view.prior.basis }
      : null,
    outlier: step?.outlier ?? false,
    excluded: false,
    source: 'manual',
    createdAt: Date.now(),
    createdBy: actor.uid,
    createdByName: actor.name,
    ...extra,
  }
}

export async function addRecord(actor: Actor, batchId: string, dispenserId: DispenserId, input: IpcInput) {
  const batch = state.batches.find((b) => b.id === batchId)
  if (!batch) throw new Error('배치를 찾을 수 없습니다.')
  const seq = (batchRecords(state, batchId, dispenserId).at(-1)?.seq ?? 0) + 1
  const rec = buildRecord(state, actor, batch, dispenserId, input, seq)
  await backend.commit([{ col: 'records', id: rec.id, data: { ...rec } }], [audit(actor, 'IPC 저장', 'records', rec.id, { after: rec })])
}

export interface ImportRow {
  dispenserId: DispenserId
  tray: number
  pulse: number
  totalWeight: number
}

/** 엑셀에서 읽은 기록을 한 배치로 넣는다. 순서대로 쌓으면서 모델 값도 함께 남긴다 */
export async function importRecords(actor: Actor, batchId: string, rows: ImportRow[], file: string): Promise<number> {
  requireAdmin(actor)
  const batch = state.batches.find((b) => b.id === batchId)
  if (!batch) throw new Error('배치를 찾을 수 없습니다.')
  let working = state
  const created: IpcRecord[] = []
  const seq = new Map<DispenserId, number>()
  for (const row of rows) {
    const next = (seq.get(row.dispenserId) ?? batchRecords(state, batchId, row.dispenserId).at(-1)?.seq ?? 0) + 1
    seq.set(row.dispenserId, next)
    const rec = buildRecord(working, actor, batch, row.dispenserId, { ...row, phase: 'routine' }, next, {
      source: 'import',
      importFile: file,
    })
    created.push(rec)
    working = { ...working, records: [...working.records, rec] }
  }
  const writes: Write[] = created.map((r) => ({ col: 'records', id: r.id, data: { ...r } }))
  await backend.commit(writes, [
    audit(actor, '데이터 가져오기', 'batches', batchId, { after: { file, count: created.length, batchNo: batch.batchNo } }),
  ])
  return created.length
}

export async function requestCorrection(
  actor: Actor,
  recordId: string,
  field: Correction['field'],
  newValue: number,
  reason: string,
) {
  const rec = state.records.find((r) => r.id === recordId)
  if (!rec) throw new Error('기록을 찾을 수 없습니다.')
  if (!reason.trim()) throw new Error('정정 사유를 입력하세요.')
  const c: Correction = {
    id: newId(),
    recordId,
    field,
    oldValue: rec[field],
    newValue,
    reason,
    status: 'pending',
    requestedBy: actor.uid,
    requestedByName: actor.name,
    requestedAt: Date.now(),
  }
  await backend.commit([{ col: 'corrections', id: c.id, data: { ...c } }], [audit(actor, '정정 요청', 'corrections', c.id, { after: c, reason })])
}

export async function reviewCorrection(actor: Actor, correctionId: string, approve: boolean, note: string) {
  requireAdmin(actor)
  const c = state.corrections.find((x) => x.id === correctionId)
  const rec = c && state.records.find((r) => r.id === c.recordId)
  if (!c || !rec || c.status !== 'pending') throw new Error('처리할 정정 요청이 없습니다.')
  const review = {
    status: approve ? 'approved' : 'rejected',
    reviewedBy: actor.uid,
    reviewedByName: actor.name,
    reviewedAt: Date.now(),
    reviewNote: note,
  }
  const writes: Write[] = [{ col: 'corrections', id: c.id, data: review }]
  let after: Record<string, unknown> | undefined
  if (approve) {
    const batch = state.batches.find((b) => b.id === rec.batchId)
    const next = { ...rec, [c.field]: c.newValue }
    next.weight = next.totalWeight / next.shots
    after = { [c.field]: c.newValue, weight: next.weight }
    if (batch) Object.assign(after, evaluate(batch, rec.materialType, next.weight))
    writes.push({ col: 'records', id: rec.id, data: after })
  }
  await backend.commit(writes, [
    audit(actor, approve ? '정정 승인' : '정정 반려', 'records', rec.id, {
      before: { [c.field]: c.oldValue },
      after,
      reason: note || c.reason,
    }),
  ])
}

export async function setExcluded(actor: Actor, recordId: string, excluded: boolean, reason: string) {
  requireAdmin(actor)
  const rec = state.records.find((r) => r.id === recordId)
  if (!rec) throw new Error('기록을 찾을 수 없습니다.')
  if (excluded && !reason.trim()) throw new Error('제외 사유를 입력하세요.')
  await backend.commit(
    [{ col: 'records', id: recordId, data: { excluded, excludeReason: excluded ? reason : '' } }],
    [audit(actor, excluded ? '이상치 제외' : '이상치 제외 취소', 'records', recordId, { before: { excluded: rec.excluded }, after: { excluded }, reason })],
  )
}

export async function saveUser(actor: Actor, user: UserProfile) {
  requireAdmin(actor)
  const before = state.users.find((u) => u.uid === user.uid)
  await backend.commit([{ col: 'users', id: user.uid, data: { ...user } }], [audit(actor, '사용자 권한 변경', 'users', user.uid, { before, after: user })])
}
