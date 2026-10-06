import type { AuditEntry, DbState } from './types'
import { DEFAULT_CRITERIA } from './types'

export type Collection = Exclude<keyof DbState, 'audit'>

/** 문서 1건 쓰기. data는 기존 문서에 병합한다 */
export interface Write {
  col: Collection
  id: string
  data: Record<string, unknown>
}

export type AuditDraft = Omit<AuditEntry, 'id' | 'at'>

/**
 * 저장소. 데이터 쓰기와 audit 기록은 항상 한 묶음(commit)으로만 저장한다.
 */
export interface Backend {
  subscribe(cb: (s: DbState) => void): () => void
  commit(writes: Write[], audit: AuditDraft[]): Promise<void>
}

export const newId = () => crypto.randomUUID()

const KEY = 'microneedle-ipc/db/v1'

function seed(): DbState {
  return {
    recipes: [
      {
        ...DEFAULT_CRITERIA,
        id: 'recipe-high-dose',
        name: '고용량',
        drugTarget: 6.11,
        baseTarget: 350.0,
        defaultDrugName: '고용량',
        defaultBaseName: '',
        defaultShots: 3,
        active: true,
        updatedAt: Date.now(),
        updatedBy: 'system',
      },
    ],
    batches: [],
    records: [],
    corrections: [],
    audit: [],
    users: [],
  }
}

/** 이 브라우저에만 저장하는 개발·시연용 저장소 */
export function localBackend(): Backend {
  let state: DbState
  try {
    state = { ...seed(), ...(JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? {}) }
  } catch {
    state = seed()
  }
  const subs = new Set<(s: DbState) => void>()
  return {
    subscribe(cb) {
      subs.add(cb)
      cb(state)
      return () => subs.delete(cb)
    },
    async commit(writes, audit) {
      const next: DbState = { ...state }
      for (const w of writes) {
        const list = [...(next[w.col] as unknown as Record<string, unknown>[])]
        const key = w.col === 'users' ? 'uid' : 'id'
        const i = list.findIndex((d) => d[key] === w.id)
        if (i >= 0) list[i] = { ...list[i], ...w.data }
        else list.push({ [key]: w.id, ...w.data })
        ;(next as unknown as Record<string, unknown>)[w.col] = list
      }
      const at = Date.now()
      next.audit = [...state.audit, ...audit.map((a) => ({ ...a, id: newId(), at }))]
      state = next
      try {
        localStorage.setItem(KEY, JSON.stringify(state))
      } catch {
        // 저장 공간이 막혀 있어도 화면은 계속 동작한다
      }
      subs.forEach((cb) => cb(state))
    },
  }
}
