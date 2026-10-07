import type { Band, Phase } from '../engine'

export type DispenserId = 'D1' | 'D2' | 'D3' | 'B1' | 'B2'
export type MaterialType = 'drug' | 'base'
export type Role = 'user' | 'admin'

export const DISPENSERS: { id: DispenserId; label: string; type: MaterialType }[] = [
  { id: 'D1', label: '약액부 토출기 1', type: 'drug' },
  { id: 'D2', label: '약액부 토출기 2', type: 'drug' },
  { id: 'D3', label: '약액부 토출기 3', type: 'drug' },
  { id: 'B1', label: '기저부 토출기 1', type: 'base' },
  { id: 'B2', label: '기저부 토출기 2', type: 'base' },
]

export interface Actor {
  uid: string
  name: string
  email: string
  role: Role
}

/** 판정 기준. 레시피에서 정하고, 배치 시작 시 배치에 복사해 둔다 */
export interface Criteria {
  /** 경고 구간 경계(%): 노랑, 빨강, 보라 */
  bands: [number, number, number]
  /** 경고 구간의 기준점(목표 대비 %) */
  bandCenterPct: number
  /** 조정 기준(목표 대비 %) */
  adjustPct: number
  /** 적합 범위(목표 대비 편차 %) */
  passLowPct: number
  passHighPct: number
  /** Pulse 최소 조정 단위 */
  pulseStep: number
}

export interface Recipe extends Criteria {
  id: string
  /** 제품명. 나중에 바꿀 수 있다 (기록은 id로 연결) */
  name: string
  /** 1회 토출 목표 중량(mg) */
  drugTarget: number
  baseTarget: number
  defaultDrugName: string
  defaultBaseName: string
  /** 약액부 IPC 배수의 기본값 */
  defaultShots: number
  active: boolean
  updatedAt: number
  updatedBy: string
}

export interface Batch extends Criteria {
  id: string
  recipeId: string
  productName: string
  batchNo: string
  mfgDate: string
  drugName: string
  baseName: string
  /** 약액부 IPC 배수: 이 횟수만큼 토출해 합산 중량을 잰다 */
  shots: number
  drugTarget: number
  baseTarget: number
  status: 'open' | 'closed'
  /** 배치 완료 처리한 시각과 사람 */
  closedAt?: number
  closedBy?: string
  closedByName?: string
  createdAt: number
  createdBy: string
}

export interface IpcRecord {
  id: string
  batchId: string
  recipeId: string
  productName: string
  batchNo: string
  dispenserId: DispenserId
  materialType: MaterialType
  materialName: string
  /** 같은 배치·토출기 안에서의 입력 순서 */
  seq: number
  tray: number
  pulse: number
  shots: number
  /** 측정한 합산 중량(mg) */
  totalWeight: number
  /** 1회 토출분 중량(mg) = totalWeight ÷ shots */
  weight: number
  phase: Phase
  /** 저장 당시 목표와 판정 */
  target: number
  devPct: number
  band: Band
  pass: boolean
  /** 저장 당시 추천 Pulse와 모델 값 (추적용) */
  recommendedPulse: number | null
  model: { level: number; b: number; drift: number; gain: number; source: string } | null
  outlier: boolean
  /** 테스트 기록: 기록은 남기되 계산식(현재 배치 추정과 과거 기준)에 반영하지 않는다 */
  test?: boolean
  excluded: boolean
  excludeReason?: string
  source: 'manual' | 'import'
  importFile?: string
  createdAt: number
  createdBy: string
  createdByName: string
}

export interface Correction {
  id: string
  recordId: string
  field: 'tray' | 'pulse' | 'totalWeight'
  oldValue: number
  newValue: number
  reason: string
  status: 'pending' | 'approved' | 'rejected'
  requestedBy: string
  requestedByName: string
  requestedAt: number
  reviewedBy?: string
  reviewedByName?: string
  reviewedAt?: number
  reviewNote?: string
}

export interface AuditEntry {
  id: string
  at: number
  uid: string
  name: string
  email: string
  /** 'none' 은 로그인 전에 남은 기록(로그인 실패, 계정 잠금)이다 */
  role: Role | 'none'
  action: string
  target: string
  targetId: string
  before?: unknown
  after?: unknown
  reason?: string
}

export interface UserProfile {
  uid: string
  name: string
  email: string
  role: Role
  active: boolean
  /** 가입 신청 후 관리자 승인을 기다리는 중 */
  pending?: boolean
  /** 관리자가 비밀번호를 초기화했거나 임시 비밀번호로 만든 계정: 로그인하면 먼저 비밀번호를 바꿔야 한다 */
  mustChangePassword?: boolean
}

/** 이메일별 로그인 실패 횟수. 5회가 되면 잠기고 관리자가 풀어야 한다 */
export interface LoginGuard {
  /** 문서 ID = 소문자 이메일 */
  id: string
  email: string
  fails: number
  locked: boolean
  updatedAt: number
}

export const MAX_LOGIN_FAILS = 5

/** 관리자가 비밀번호를 초기화하면 이 값이 된다 */
export const RESET_PASSWORD = 'dw1234'

export const roleLabel = (role: Role | 'none') => (role === 'admin' ? '관리자' : role === 'user' ? '일반 사용자' : '로그인 전')

export interface DbState {
  recipes: Recipe[]
  batches: Batch[]
  records: IpcRecord[]
  corrections: Correction[]
  audit: AuditEntry[]
  users: UserProfile[]
  guards: LoginGuard[]
}

export const DEFAULT_CRITERIA: Criteria = {
  bands: [2, 5, 10],
  bandCenterPct: 100,
  adjustPct: 103,
  passLowPct: -5,
  passHighPct: 5,
  pulseStep: 0.001,
}

export function targetOf(batch: Batch, type: MaterialType): number {
  return type === 'drug' ? batch.drugTarget : batch.baseTarget
}

export function materialOf(batch: Batch, type: MaterialType): string {
  return type === 'drug' ? batch.drugName : batch.baseName
}

/** IPC 배수는 약액부에만 적용한다 */
export function shotsOf(batch: Batch, type: MaterialType): number {
  return type === 'drug' ? batch.shots : 1
}
