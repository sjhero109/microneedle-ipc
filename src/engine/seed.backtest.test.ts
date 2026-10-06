import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { defaultParams, fitParams, walkForward, type IpcPoint } from './index'

// 공정 데이터는 저장소에 올리지 않으므로, 파일이 있는 PC에서만 실행된다
const SEED = 'data/seed/first-test.json'
const TARGET = 6.11

describe.skipIf(!existsSync(SEED))('1차 토출기 테스트 이력 백테스트', () => {
  const data: Record<string, IpcPoint[]> = existsSync(SEED) ? JSON.parse(readFileSync(SEED, 'utf8')) : {}
  for (const id of Object.keys(data)) {
    it(`${id}: 추정값과 예측 오차`, () => {
      const pts = data[id]
      const params = fitParams([pts], defaultParams(TARGET, pts[0].pulse))
      const rows = walkForward(pts, TARGET)
      const r4 = (_: string, v: unknown) => (typeof v === 'number' ? +v.toFixed(4) : v)
      console.log(id, JSON.stringify({ ...params, sigma: Math.sqrt(params.R) }, r4))
      console.log(rows.map((r) => `${r.model} MAE ${r.mae.toFixed(3)} RMSE ${r.rmse.toFixed(3)} med ${r.medianAe.toFixed(3)}`).join(' | '))
      expect(params.source).toBe('history')
      expect(rows[0].n).toBeGreaterThan(10)
    })
  }
})
