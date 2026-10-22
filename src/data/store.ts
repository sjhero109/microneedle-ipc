import { useSyncExternalStore } from 'react'
import type { Phase } from '../engine'
import { classify, isPass } from '../engine'
import { localBackend, newId, type AuditDraft, type Backend, type Write } from './backend'
import { firebaseEnabled } from './firebase'
import { batchRecords, dispenserView, evaluate } from './model'
import type { Actor, Batch, Correction, DbState, DispenserId, DoePrior, IpcRecord, Recipe, UserProfile } from './types'
import { CONTENT_MAX, CONTENT_MIN, DISPENSERS, EMPTY_DOE, IDLE_MAX, IDLE_MIN, adjustOf, adjustRange, controlOf, doeOf, idleMinutesOf, baseTargetOf, contentOf, materialOf, shotsOf, targetForContent, targetOf } from './types'

const EMPTY: DbState = { recipes: [], batches: [], records: [], corrections: [], audit: [], users: [], guards: [], settings: [] }

let backend: Backend | null = null
let state: DbState = EMPTY
const listeners = new Set<() => void>()
let unsubscribe = () => {}
// 저장소에서 첫 데이터가 모두 도착했는지
let loaded = false

function emit(s: DbState, isLoaded = true) {
  loaded = isLoaded
  state = s
  listeners.forEach((l) => l())
}

/** 저장소를 바꿔 끼운다 (Firebase 로그인 후 사용) */
export function setBackend(b: Backend) {
  generation++
  setPending(0)
  unsubscribe()
  backend = b
  unsubscribe = b.subscribe((s) => emit(s))
}

/** 로그아웃하면 화면에 남은 데이터도 비운다 */
export function clearBackend() {
  generation++
  setPending(0)
  unsubscribe()
  unsubscribe = () => {}
  backend = null
  emit(EMPTY, false)
}

if (!firebaseEnabled) setBackend(localBackend())

/**
 * 서버가 아직 받지 않은 저장 건수. 인터넷이 끊기면 저장은 이 창의 메모리에만 있다가 다시 연결될 때 올라가므로,
 * 이 값이 0이 아닌 동안에는 창을 닫거나 로그아웃하면 기록을 잃을 수 있다
 */
let pending = 0
let generation = 0
const pendingListeners = new Set<() => void>()
function setPending(n: number) {
  pending = n
  pendingListeners.forEach((l) => l())
}

export function pendingCount(): number {
  return pending
}

export function usePending(): number {
  return useSyncExternalStore(
    (l) => {
      pendingListeners.add(l)
      return () => pendingListeners.delete(l)
    },
    () => pending,
  )
}

async function commit(writes: Write[], entries: AuditDraft[]) {
  if (!backend) throw new Error('로그인이 필요합니다.')
  // 로그아웃 뒤에 끝난 저장이 다음 로그인의 대기 건수를 건드리지 않게 한다
  const gen = generation
  setPending(pending + 1)
  try {
    return await backend.commit(writes, entries)
  } finally {
    if (gen === generation) setPending(Math.max(0, pending - 1))
  }
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

export function useDbLoaded(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => loaded,
  )
}

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
  return commit([], [audit(actor, action, 'session', actor.uid, { after: detail })])
}

export type RecipeInput = Omit<Recipe, 'id' | 'updatedAt' | 'updatedBy'> & { id?: string }

export async function saveRecipe(actor: Actor, input: RecipeInput, reason?: string): Promise<string> {
  requireAdmin(actor)
  const id = input.id ?? newId()
  const before = state.recipes.find((r) => r.id === id)
  const data = { ...input, id, updatedAt: Date.now(), updatedBy: actor.uid }
  await commit(
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
  /** 약액부 함량(%). 비우면 100% */
  contentPct?: number
}

/** 같은 제품·배치번호가 있으면 그 배치를 돌려주고, 없으면 새로 만든다 */
export async function startBatch(actor: Actor, input: BatchInput): Promise<string> {
  const existing = state.batches.find((b) => b.recipeId === input.recipeId && b.batchNo === input.batchNo)
  if (existing?.status === 'closed') throw new Error('이미 완료된 배치번호입니다. 완료된 배치는 결과 탭에서 볼 수 있습니다.')
  if (existing) return existing.id
  const recipe = state.recipes.find((r) => r.id === input.recipeId)
  if (!recipe) throw new Error('레시피를 찾을 수 없습니다.')
  const content = input.contentPct ?? 100
  checkContent(content)
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
    drugTarget: targetForContent(recipe.drugTarget, content),
    contentPct: content,
    drugTargetBase: recipe.drugTarget,
    baseTarget: recipe.baseTarget,
    bands: recipe.bands,
    bandCenterPct: recipe.bandCenterPct,
    adjustPct: recipe.adjustPct,
    passLowPct: recipe.passLowPct,
    passHighPct: recipe.passHighPct,
    pulseStep: recipe.pulseStep,
    control: controlOf(recipe),
    ...(recipe.pressureStep !== undefined ? { pressureStep: recipe.pressureStep } : {}),
    status: 'open',
    createdAt: Date.now(),
    createdBy: actor.uid,
  }
  await commit([{ col: 'batches', id, data: { ...batch } }], [audit(actor, '배치 시작', 'batches', id, { after: batch })])
  return id
}

function checkContent(contentPct: number) {
  if (!(contentPct >= CONTENT_MIN && contentPct <= CONTENT_MAX)) throw new Error(`약액부 함량은 ${CONTENT_MIN}~${CONTENT_MAX}% 사이로 입력하세요.`)
}

export async function updateBatch(
  actor: Actor,
  id: string,
  patch: Partial<Pick<Batch, 'drugName' | 'baseName' | 'shots' | 'mfgDate' | 'contentPct' | 'drugAdjustPct' | 'baseAdjustPct' | 'status' | 'control' | 'fixed'>>,
) {
  const before = state.batches.find((b) => b.id === id)
  if (!before) throw new Error('배치를 찾을 수 없습니다.')
  const next: Partial<Batch> = { ...patch }
  for (const [d, f] of Object.entries(patch.fixed ?? {})) {
    if (f.pulse !== null && !(f.pulse > 0)) throw new Error(`${d}: 고정 Pulse·Speed는 0보다 커야 합니다.`)
    if (f.pressure !== null && !(f.pressure > 0 && f.pressure <= 1)) throw new Error(`${d}: 고정 압력은 MPa 단위(0~1)로 입력하세요.`)
  }
  const [lo, hi] = adjustRange(before)
  for (const v of [patch.drugAdjustPct, patch.baseAdjustPct]) {
    if (v !== undefined && !(v >= lo && v <= hi)) throw new Error(`조정 목표는 적합 범위(${lo}~${hi}%) 안에서 입력하세요.`)
  }
  // 함량을 바꾸면 목표 중량을 다시 환산한다. 기준 중량(함량 100%)은 그대로다
  if (patch.contentPct !== undefined) {
    checkContent(patch.contentPct)
    const base = baseTargetOf(before, state.recipes.find((r) => r.id === before.recipeId))
    next.drugTargetBase = base
    next.drugTarget = targetForContent(base, patch.contentPct)
  }
  // 조정 목표는 따로 정한 적이 없으면 레시피 값과 비교한다
  const current = { ...before, drugAdjustPct: adjustOf(before, 'drug'), baseAdjustPct: adjustOf(before, 'base') }
  const same = (k: string, v: unknown) => (k === 'fixed' ? JSON.stringify(current.fixed ?? {}) === JSON.stringify(v) : k === 'control' ? controlOf(current) === v : current[k as keyof Batch] === v)
  const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => !same(k, v)))
  if (Object.keys(changed).length === 0) return
  const prev = Object.fromEntries(Object.keys(changed).map((k) => [k, current[k as keyof Batch]]))
  await commit([{ col: 'batches', id, data: changed }], [audit(actor, '배치 정보 변경', 'batches', id, { before: prev, after: changed })])
}

/** 자동 로그아웃까지의 시간(분)을 정한다. 모든 사용자에게 적용된다 */
export async function saveIdleMinutes(actor: Actor, minutes: number) {
  requireAdmin(actor)
  if (!Number.isInteger(minutes) || minutes < IDLE_MIN || minutes > IDLE_MAX) throw new Error(`자동 로그아웃 시간은 ${IDLE_MIN}~${IDLE_MAX}분 사이의 정수로 입력하세요.`)
  const before = idleMinutesOf(state)
  if (before === minutes) return
  const data = { idleMinutes: minutes, updatedAt: Date.now(), updatedBy: actor.uid, updatedByName: actor.name }
  await commit([{ col: 'settings', id: 'app', data }], [audit(actor, '자동 로그아웃 시간 변경', 'settings', 'app', { before: { idleMinutes: before }, after: { idleMinutes: minutes } })])
}

/**
 * DOE(압력 응답 시험) 결과를 토출기별로 저장한다. 압력 방식 배치에서 과거 기록이 부족할 때 계산식의 출발점이 되고,
 * 추천 압력은 pMin~pMax 안으로 자른다
 */
export async function saveDoe(actor: Actor, next: Partial<Record<DispenserId, DoePrior>>, reason: string) {
  requireAdmin(actor)
  if (!reason.trim()) throw new Error('변경 사유를 입력하세요.')
  const dispensers = {} as Record<DispenserId, DoePrior>
  for (const d of DISPENSERS) {
    const v = { ...EMPTY_DOE, ...next[d.id] }
    for (const k of ['k', 'p0', 'pMin', 'pMax'] as const) {
      const x = v[k]
      if (x !== null && !(x > 0)) throw new Error(`${d.id}: 감도·압력은 0보다 큰 값으로 입력하세요.`)
    }
    if (v.p0 !== null && v.p0 > 1) throw new Error(`${d.id}: 압력은 MPa 단위로 입력하세요 (예: 0.36).`)
    if (v.pMin !== null && v.pMax !== null && !(v.pMin < v.pMax)) throw new Error(`${d.id}: 압력 하한은 상한보다 작아야 합니다.`)
    if (v.p0 !== null && ((v.pMin !== null && v.p0 < v.pMin) || (v.pMax !== null && v.p0 > v.pMax))) throw new Error(`${d.id}: 기준 압력이 압력 범위 밖입니다.`)
    if (v.settle !== null && !(Number.isInteger(v.settle) && v.settle >= 0 && v.settle <= 20)) throw new Error(`${d.id}: 버림 토출 횟수는 0~20 사이의 정수로 입력하세요.`)
    dispensers[d.id] = v
  }
  const before = Object.fromEntries(DISPENSERS.map((d) => [d.id, doeOf(state, d.id)]))
  const data = { dispensers, updatedAt: Date.now(), updatedBy: actor.uid, updatedByName: actor.name }
  await commit([{ col: 'settings', id: 'doe', data }], [audit(actor, 'DOE 값 변경', 'settings', 'doe', { before, after: dispensers, reason })])
}

/** 배치의 테스트 모드를 켜고 끈다. 모든 사용자에게 같은 상태로 보인다 */
export async function setTestMode(actor: Actor, id: string, on: boolean) {
  const batch = state.batches.find((b) => b.id === id)
  if (!batch) throw new Error('배치를 찾을 수 없습니다.')
  if (batch.status === 'closed') throw new Error('완료된 배치입니다.')
  if ((batch.testMode === true) === on) return
  const data = { testMode: on, testModeBy: actor.uid, testModeByName: actor.name, testModeAt: Date.now() }
  await commit([{ col: 'batches', id, data }], [audit(actor, on ? '테스트 모드 켜기' : '테스트 모드 끄기', 'batches', id, { before: { testMode: batch.testMode === true }, after: { testMode: on, batchNo: batch.batchNo } })])
}

/** 공정이 끝난 배치를 닫는다. 닫힌 배치는 불러오거나 기록을 더할 수 없고 결과 탭에서만 본다 */
export async function closeBatch(actor: Actor, id: string) {
  const batch = state.batches.find((b) => b.id === id)
  if (!batch) throw new Error('배치를 찾을 수 없습니다.')
  if (batch.status === 'closed') return
  const data = { status: 'closed', closedAt: Date.now(), closedBy: actor.uid, closedByName: actor.name }
  await commit([{ col: 'batches', id, data }], [audit(actor, '배치 완료', 'batches', id, { before: { status: batch.status }, after: { status: 'closed', batchNo: batch.batchNo } })])
}

/** 완료한 배치를 다시 연다. 사유를 남긴다 */
export async function reopenBatch(actor: Actor, id: string, reason: string) {
  if (!reason.trim()) throw new Error('다시 여는 사유를 입력하세요.')
  const batch = state.batches.find((b) => b.id === id)
  if (!batch) throw new Error('배치를 찾을 수 없습니다.')
  await commit([{ col: 'batches', id, data: { status: 'open' } }], [audit(actor, '배치 완료 취소', 'batches', id, { before: { status: batch.status }, after: { status: 'open', batchNo: batch.batchNo }, reason })])
}

/** 배치의 약액부 기록 중 지금 IPC 배수와 다르게 저장된 기록 */
export function recordsWithOtherShots(batchId: string, shots: number): IpcRecord[] {
  return state.records.filter((r) => r.batchId === batchId && r.materialType === 'drug' && r.shots !== shots)
}

/**
 * 이미 저장한 약액부 기록을 새 IPC 배수로 다시 계산한다 (관리자).
 * 합산 중량은 그대로 두고 1회분 = 합산 ÷ 배수, 편차·판정은 기록 당시의 목표로 다시 구한다.
 */
export async function rescaleShots(actor: Actor, batchId: string, shots: number) {
  requireAdmin(actor)
  if (!Number.isInteger(shots) || shots < 1) throw new Error('IPC 배수는 1 이상의 정수로 입력하세요.')
  const batch = state.batches.find((b) => b.id === batchId)
  if (!batch) throw new Error('배치를 찾을 수 없습니다.')
  const targets = recordsWithOtherShots(batchId, shots)
  for (let i = 0; i < targets.length; i += IMPORT_CHUNK) {
    const part = targets.slice(i, i + IMPORT_CHUNK)
    const writes = part.map((r) => {
      const weight = r.totalWeight / shots
      const { devPct, band } = classify(weight, r.target, { limits: batch.bands, centerPct: batch.bandCenterPct })
      return { col: 'records' as const, id: r.id, data: { shots, weight, devPct, band, pass: isPass(weight, r.target, batch.passLowPct, batch.passHighPct) } }
    })
    await commit(writes, [
      audit(actor, '기존 기록 IPC 배수 재계산', 'records', part[0].id, {
        before: part.map((r) => ({ id: r.id, dispenserId: r.dispenserId, seq: r.seq, shots: r.shots, weight: r.weight, devPct: r.devPct, pass: r.pass })),
        after: writes.map((w) => ({ id: w.id, ...w.data })),
        reason: `${batch.batchNo} 배치 IPC 배수를 ${shots}회로 맞춤`,
      }),
    ])
  }
  return targets.length
}

/** 엑셀에서 가져온 약액부 기록 중 배수가 2회 이상인 것 (중량을 1회분으로 잘못 읽었을 수 있는 기록) */
export function importedMultiShot(batchId: string): IpcRecord[] {
  return state.records.filter((r) => r.batchId === batchId && r.materialType === 'drug' && r.source === 'import' && r.shots > 1 && !r.importFixed)
}

/**
 * 가져올 때 엑셀 중량(이미 N회 합계)을 1회분으로 보고 × N 해 버린 기록을 되돌린다 (관리자).
 * 합산 중량 = 지금 합산 ÷ 배수 (= 엑셀 원래 값), 1회분 = 합산 ÷ 배수, 편차·판정은 기록 당시 목표로 다시 구한다.
 */
export async function fixImportedTotals(actor: Actor, batchId: string) {
  requireAdmin(actor)
  const batch = state.batches.find((b) => b.id === batchId)
  if (!batch) throw new Error('배치를 찾을 수 없습니다.')
  const targets = importedMultiShot(batchId)
  for (let i = 0; i < targets.length; i += IMPORT_CHUNK) {
    const part = targets.slice(i, i + IMPORT_CHUNK)
    const writes = part.map((r) => {
      const totalWeight = +(r.totalWeight / r.shots).toFixed(4)
      const weight = totalWeight / r.shots
      const { devPct, band } = classify(weight, r.target, { limits: batch.bands, centerPct: batch.bandCenterPct })
      return { col: 'records' as const, id: r.id, data: { totalWeight, weight, devPct, band, pass: isPass(weight, r.target, batch.passLowPct, batch.passHighPct), importFixed: true } }
    })
    await commit(writes, [
      audit(actor, '가져온 기록 중량 보정', 'records', part[0].id, {
        before: part.map((r) => ({ id: r.id, dispenserId: r.dispenserId, seq: r.seq, totalWeight: r.totalWeight, weight: r.weight, devPct: r.devPct, pass: r.pass })),
        after: writes.map((w) => ({ id: w.id, ...w.data })),
        reason: `${batch.batchNo} 엑셀 중량을 ${part[0].shots}회 합계로 바로잡음 (가져올 때 × ${part[0].shots} 적용됨)`,
      }),
    ])
  }
  return targets.length
}

export interface BatchIdentity {
  batchNo: string
  mfgDate: string
  drugName: string
  baseName: string
}

/**
 * 관리자가 배치의 이름 정보(배치번호, 제조일자, 약액부·기저부명)를 고친다. 완료된 배치도 된다.
 * 기록에도 배치번호·물질명이 함께 저장되어 있으므로 같이 바꾼다.
 */
export async function adminEditBatch(actor: Actor, id: string, next: BatchIdentity, reason: string, onProgress?: (done: number, total: number) => void) {
  requireAdmin(actor)
  if (!reason.trim()) throw new Error('수정 사유를 입력하세요.')
  const batch = state.batches.find((b) => b.id === id)
  if (!batch) throw new Error('배치를 찾을 수 없습니다.')
  const batchNo = next.batchNo.trim()
  if (!batchNo) throw new Error('배치번호를 입력하세요.')
  if (state.batches.some((b) => b.id !== id && b.recipeId === batch.recipeId && b.batchNo === batchNo)) throw new Error('같은 제품에 이미 있는 배치번호입니다.')
  const patch: Partial<BatchIdentity> = {}
  for (const k of ['mfgDate', 'drugName', 'baseName'] as const) if (next[k] !== batch[k]) patch[k] = next[k]
  if (batchNo !== batch.batchNo) patch.batchNo = batchNo
  if (Object.keys(patch).length === 0) return 0
  const before = Object.fromEntries(Object.keys(patch).map((k) => [k, batch[k as keyof BatchIdentity]]))
  await commit([{ col: 'batches', id, data: patch }], [audit(actor, '배치 정보 수정 (관리자)', 'batches', id, { before, after: patch, reason })])

  // 기록에 함께 저장된 배치번호·물질명을 맞춘다
  const recs = state.records.filter((r) => r.batchId === id)
  const recPatch = (r: IpcRecord) => {
    const d: Record<string, string> = {}
    if (patch.batchNo !== undefined && r.batchNo !== patch.batchNo) d.batchNo = patch.batchNo
    const name = r.materialType === 'drug' ? patch.drugName : patch.baseName
    if (name !== undefined && r.materialName !== name) d.materialName = name
    return d
  }
  const targets = recs.filter((r) => Object.keys(recPatch(r)).length)
  for (let i = 0; i < targets.length; i += IMPORT_CHUNK) {
    const part = targets.slice(i, i + IMPORT_CHUNK)
    await commit(
      part.map((r) => ({ col: 'records' as const, id: r.id, data: recPatch(r) })),
      [audit(actor, '배치 정보 수정 반영', 'records', part[0].id, { before: { batchNo: batch.batchNo }, after: { ...patch, records: part.map((r) => r.id) }, reason })],
    )
    onProgress?.(Math.min(i + IMPORT_CHUNK, targets.length), targets.length)
  }
  return targets.length
}

/** 테스트로 남긴 기록을 관리자가 계산에 편입한다 */
export async function includeTestRecords(actor: Actor, recordIds: string[]) {
  requireAdmin(actor)
  const targets = state.records.filter((r) => recordIds.includes(r.id) && r.test)
  for (let i = 0; i < targets.length; i += IMPORT_CHUNK) {
    const part = targets.slice(i, i + IMPORT_CHUNK)
    await commit(
      part.map((r) => ({ col: 'records', id: r.id, data: { test: false } })),
      [audit(actor, '테스트 기록 계산 편입', 'records', part[0].id, { before: { test: true }, after: { test: false, records: part.map((r) => r.id), batchNo: part[0].batchNo } })],
    )
  }
  return targets.length
}

export interface IpcInput {
  tray: number
  /** 조절값: 압력 방식이면 압력(MPa), 아니면 Pulse·Speed(ms) */
  pulse: number
  /** 압력 방식에서 고정해 둔 Pulse·Speed(ms). 기록용 */
  pulseMs?: number
  /** Pulse 방식에서 고정해 둔 압력(MPa). 기록용 */
  pressureMpa?: number
  totalWeight: number
  phase: Phase
  /** 테스트 기록: 계산식에 반영하지 않는다 */
  test?: boolean
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
  // 테스트 기록은 모델에 얹지 않는다
  const view = input.test
    ? dispenserView(db, batch, dispenserId)
    : dispenserView(db, batch, dispenserId, { tray: input.tray, pulse: input.pulse, weight, shots, phase: input.phase })
  const step = input.test ? undefined : view.model.steps[view.model.steps.length - 1]
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
    control: controlOf(batch),
    ...(input.pulseMs !== undefined ? { pulseMs: input.pulseMs } : {}),
    ...(input.pressureMpa !== undefined ? { pressureMpa: input.pressureMpa } : {}),
    shots,
    totalWeight: input.totalWeight,
    weight,
    phase: input.phase,
    target: targetOf(batch, type),
    ...(type === 'drug' ? { contentPct: contentOf(batch, db.recipes.find((r) => r.id === batch.recipeId)) } : {}),
    ...evaluate(batch, type, weight),
    recommendedPulse: view.recommendation?.pulse ?? null,
    model: step
      ? { level: step.levelAtPulse, b: view.model.params.b, drift: view.model.params.drift, gain: step.gain, source: view.prior.basis }
      : null,
    outlier: step?.outlier ?? false,
    test: input.test === true,
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
  if (batch.status === 'closed') throw new Error('완료된 배치에는 기록할 수 없습니다.')
  const seq = (batchRecords(state, batchId, dispenserId).at(-1)?.seq ?? 0) + 1
  // 테스트 여부는 화면이 아니라 서버에 저장된 배치의 테스트 모드로 정한다
  const rec = buildRecord(state, actor, batch, dispenserId, { ...input, test: batch.testMode === true }, seq)
  await commit([{ col: 'records', id: rec.id, data: { ...rec } }], [audit(actor, rec.test ? 'IPC 저장 (테스트)' : 'IPC 저장', 'records', rec.id, { after: rec })])
}

/**
 * 한 번에 저장하는 기록 수. 보안 규칙이 기록마다 사용자·audit 문서를 확인하는데,
 * 실제 서버는 한 묶음에서 확인할 수 있는 문서 수가 20건으로 제한되어 있어 작게 나눈다.
 */
const IMPORT_CHUNK = 2

export interface ImportRow {
  dispenserId: DispenserId
  tray: number
  pulse: number
  totalWeight: number
}

/** 엑셀에서 읽은 기록을 한 배치로 넣는다. 순서대로 쌓으면서 모델 값도 함께 남긴다 */
export async function importRecords(
  actor: Actor,
  batchId: string,
  rows: ImportRow[],
  file: string,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  requireAdmin(actor)
  const batch = state.batches.find((b) => b.id === batchId)
  if (!batch) throw new Error('배치를 찾을 수 없습니다.')
  let working = state
  const created: IpcRecord[] = []
  const seq = new Map<DispenserId, number>()
  // 가져오다 끊긴 배치에 다시 가져올 때는 이미 들어간 만큼 건너뛴다
  const skip = new Map<DispenserId, number>()
  for (const r of state.records) {
    if (r.batchId === batchId && r.source === 'import') skip.set(r.dispenserId, (skip.get(r.dispenserId) ?? 0) + 1)
  }
  for (const row of rows) {
    const left = skip.get(row.dispenserId) ?? 0
    if (left > 0) {
      skip.set(row.dispenserId, left - 1)
      continue
    }
    const next = (seq.get(row.dispenserId) ?? batchRecords(state, batchId, row.dispenserId).at(-1)?.seq ?? 0) + 1
    seq.set(row.dispenserId, next)
    const rec = buildRecord(working, actor, batch, row.dispenserId, { ...row, phase: row.tray === 0 || row.tray === 1 ? 'startup' : 'routine' }, next, {
      source: 'import',
      // 가져오기 화면에서 중량 열의 뜻(합계·1회분)을 정해 저장하므로 나중 보정 대상이 아니다
      importFixed: true,
      importFile: file,
    })
    created.push(rec)
    working = { ...working, records: [...working.records, rec] }
  }
  // 나눠 저장한다. 묶음마다 audit 기록이 하나씩 남는다
  for (let i = 0; i < created.length; i += IMPORT_CHUNK) {
    const part = created.slice(i, i + IMPORT_CHUNK)
    onProgress?.(i, created.length)
    await commit(
      part.map((r) => ({ col: 'records', id: r.id, data: { ...r } })),
      [audit(actor, '데이터 가져오기', 'batches', batchId, { after: { file, batchNo: batch.batchNo, from: i + 1, count: part.length, total: created.length } })],
    )
  }
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
  // 트레이번호 0은 생산 전 세팅(트레이 없이 측정)이다
  if (field === 'tray' ? newValue < 0 : newValue <= 0) throw new Error(field === 'tray' ? '트레이번호는 0 이상이어야 합니다.' : '0보다 큰 값을 입력하세요.')
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
  await commit([{ col: 'corrections', id: c.id, data: { ...c } }], [audit(actor, '정정 요청', 'corrections', c.id, { after: c, reason })])
  return c.id
}

/** 관리자가 요청과 승인을 한 번에 처리한다. audit trail에는 요청과 승인이 모두 남는다 */
export async function correctDirectly(actor: Actor, recordId: string, field: Correction['field'], newValue: number, reason: string) {
  requireAdmin(actor)
  const id = await requestCorrection(actor, recordId, field, newValue, reason)
  // 방금 저장한 요청이 화면 상태에 들어올 때까지 잠깐 기다린다
  for (let i = 0; i < 40 && !state.corrections.some((c) => c.id === id); i++) await new Promise((r) => setTimeout(r, 50))
  await reviewCorrection(actor, id, true, `관리자 직접 정정: ${reason}`)
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
  await commit(writes, [
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
  await commit(
    [{ col: 'records', id: recordId, data: { excluded, excludeReason: excluded ? reason : '' } }],
    [audit(actor, excluded ? '이상치 제외' : '이상치 제외 취소', 'records', recordId, { before: { excluded: rec.excluded }, after: { excluded }, reason })],
  )
}

/** 로그인 실패로 잠긴 계정을 관리자가 푼다 */
export async function unlockAccount(actor: Actor, email: string) {
  requireAdmin(actor)
  const before = state.guards.find((g) => g.id === email)
  await commit(
    [{ col: 'guards', id: email, data: { email, fails: 0, locked: false, updatedAt: Date.now() } }],
    [audit(actor, '계정 잠금 해제', 'loginGuard', email, { before: before && { fails: before.fails, locked: before.locked }, after: { fails: 0, locked: false } })],
  )
}

/** 비밀번호를 초기화한 사실을 남기고, 다음 로그인 때 새 비밀번호를 정하게 한다 */
export async function markPasswordReset(actor: Actor, user: UserProfile) {
  requireAdmin(actor)
  await commit(
    [{ col: 'users', id: user.uid, data: { mustChangePassword: true } }],
    [audit(actor, '비밀번호 초기화', 'users', user.uid, { after: { email: user.email, mustChangePassword: true } })],
  )
}

/** 데이터 변경은 없지만 대상이 있는 관리자 작업의 기록 (예: 비밀번호 재설정 메일 발송) */
export function logAdminAction(actor: Actor, action: string, target: string, targetId: string, detail?: unknown) {
  requireAdmin(actor)
  return commit([], [audit(actor, action, target, targetId, { after: detail })])
}

export async function saveUser(actor: Actor, user: UserProfile) {
  requireAdmin(actor)
  const before = state.users.find((u) => u.uid === user.uid)
  // 가입 시각은 처음 값 그대로 둔다
  const { uid, name, email, role, active, pending } = user
  const flag = user.mustChangePassword === undefined ? {} : { mustChangePassword: user.mustChangePassword }
  await commit([{ col: 'users', id: uid, data: { uid, name, email, role, active, pending: pending ?? false, ...flag } }], [audit(actor, '사용자 권한 변경', 'users', user.uid, { before, after: user })])
}
