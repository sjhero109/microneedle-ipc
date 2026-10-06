/** 토출 개시 전 IPC(적합까지 반복) / 공정 중 IPC(트레이 간격) */
export type Phase = 'startup' | 'routine'

export interface IpcPoint {
  tray: number
  pulse: number
  weight: number
  phase?: Phase
  /** 관리자가 확정 제외한 기록 — 필터와 추정에서 빠진다 */
  excluded?: boolean
}

export interface ModelParams {
  /** 감도: Pulse 1당 중량 변화 */
  b: number
  /** 관측 잡음 분산 (IPC 1회 값의 흔들림) */
  R: number
  /** 과정 잡음 분산 (IPC 사이 기준 수준의 움직임) */
  Q: number
  /** 트레이 1개당 수준 변화. 데이터로 확인될 때만 0이 아니다 */
  drift: number
  /** 기준 Pulse. 수준 L은 이 Pulse에서의 중량이다 */
  pRef: number
  /** 새 배치 시작 시 수준 초기값 */
  L0: number
  /** 추정에 사용한 기록 수 */
  n: number
  /** false면 감도 추정이 불안정하다 (화면에 표시) */
  bReliable: boolean
  source: 'history' | 'default'
}

export interface FilterState {
  L: number
  P: number
  tray: number | null
}

export interface FilterStep {
  point: IpcPoint
  /** 이 IPC 전에 예측한 중량 */
  predicted: number
  innovation: number
  /** 이번 IPC 반영 비율 (칼만 이득) */
  gain: number
  outlier: boolean
  /** 갱신 후 수준을 이 IPC의 Pulse 기준 중량으로 환산한 값 */
  levelAtPulse: number
  state: FilterState
}

export interface EngineOptions {
  /** 새 배치 시작 시 P0 = R × p0Factor */
  p0Factor: number
  /** 이상치 후보 판정 기준 (σ 배수) */
  outlierSigma: number
  /** 감도 탐색 범위: 비례 기울기(중량 중앙값 ÷ Pulse 중앙값)의 배수 */
  bRelMin: number
  bRelMax: number
  /** 이 수 미만이면 과거 데이터로 추정하지 않고 기본값을 쓴다 */
  minHistory: number
}

export const DEFAULT_OPTIONS: EngineOptions = {
  p0Factor: 4,
  outlierSigma: 3,
  bRelMin: 0.02,
  bRelMax: 3,
  minHistory: 8,
}

export type Band = 'ok' | 'yellow' | 'red' | 'purple'
