import * as XLSX from 'xlsx'
import { trayLabels } from './model'
import type { ImportRow } from './store'
import type { AuditEntry, Batch, Correction, DispenserId, IpcRecord } from './types'

const BAND = { ok: '', yellow: '주의', red: '경고', purple: '이탈' } as const

const time = (t?: number) => (t ? new Date(t).toLocaleString('ko-KR') : '')

export function exportWorkbook(
  filename: string,
  records: IpcRecord[],
  batches: Batch[],
  corrections: Correction[],
  audit: AuditEntry[],
) {
  const wb = XLSX.utils.book_new()
  const labels = trayLabels(records)
  const recRows = records.map((r) => ({
    제품명: r.productName,
    배치번호: r.batchNo,
    토출기: r.dispenserId,
    물질명: r.materialName,
    순번: r.seq,
    트레이번호: r.tray,
    '트레이-회차': labels.get(r.id) ?? '',
    Pulse: r.pulse,
    'IPC 배수': r.shots,
    '합산 중량(mg)': r.totalWeight,
    '1회 중량(mg)': +r.weight.toFixed(4),
    '목표(mg)': r.target,
    '편차(%)': +r.devPct.toFixed(2),
    경고: BAND[r.band],
    판정: r.pass ? '적합' : '부적합',
    '추천 Pulse': r.recommendedPulse ?? '',
    '추정 수준(mg)': r.model ? +r.model.level.toFixed(4) : '',
    이상치후보: r.outlier ? 'Y' : '',
    테스트: r.test ? 'Y' : '',
    제외: r.excluded ? 'Y' : '',
    제외사유: r.excludeReason ?? '',
    입력경로: r.source === 'import' ? `가져오기(${r.importFile ?? ''})` : '직접 입력',
    작성자: r.createdByName,
    작성시각: time(r.createdAt),
  }))
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(recRows), 'IPC 기록')

  const ids = new Set(records.map((r) => r.batchId))
  const sumRows = batches
    .filter((b) => ids.has(b.id))
    .flatMap((b) => {
      const own = records.filter((r) => r.batchId === b.id && !r.excluded && !r.test)
      return [...new Set(own.map((r) => r.dispenserId))].sort().map((d) => {
        const rs = own.filter((r) => r.dispenserId === d).sort((a, c) => a.seq - c.seq)
        const changes = rs.filter((r, i) => i > 0 && r.pulse !== rs[i - 1].pulse).length
        return {
          제품명: b.productName,
          배치번호: b.batchNo,
          제조일자: b.mfgDate,
          약액부명: b.drugName,
          기저부명: b.baseName,
          'IPC 배수': b.shots,
          토출기: d,
          'IPC 횟수': rs.length,
          '평균 편차(%)': +(rs.reduce((s, r) => s + r.devPct, 0) / rs.length).toFixed(2),
          '부적합 횟수': rs.filter((r) => !r.pass).length,
          'Pulse 조정 횟수': changes,
        }
      })
    })
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sumRows), '배치 요약')

  const recIds = new Set(records.map((r) => r.id))
  const corRows = corrections
    .filter((c) => recIds.has(c.recordId))
    .map((c) => ({
      기록ID: c.recordId,
      항목: c.field,
      '정정 전': c.oldValue,
      '정정 후': c.newValue,
      사유: c.reason,
      상태: { pending: '대기', approved: '승인', rejected: '반려' }[c.status],
      요청자: c.requestedByName,
      요청시각: time(c.requestedAt),
      검토자: c.reviewedByName ?? '',
      검토시각: time(c.reviewedAt),
      검토의견: c.reviewNote ?? '',
    }))
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(corRows), '정정 이력')

  const auditRows = audit.map((a) => ({
    시각: time(a.at),
    이름: a.name,
    계정: a.email,
    권한: a.role === 'admin' ? '관리자' : '일반 사용자',
    작업: a.action,
    대상: a.target,
    대상ID: a.targetId,
    사유: a.reason ?? '',
    변경전: a.before === undefined ? '' : JSON.stringify(a.before),
    변경후: a.after === undefined ? '' : JSON.stringify(a.after),
  }))
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(auditRows), 'Audit trail')

  XLSX.writeFile(wb, filename)
}

export interface ParsedSheet {
  name: string
  rows: ImportRow[]
  /** 엑셀의 중량 열이 합산값인지, 1회분인지 */
  weightKind: 'total' | 'per-shot'
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const text = (v: unknown) => String(v ?? '').replace(/\s/g, '').toUpperCase()

/**
 * 토출기별로 열이 나뉜 표를 읽는다.
 *   1행: "토출기 1" | … | "토출기 2" | …      (기저부는 "기저부 1")
 *   2행: 회차 | PULSE | 중량  또는  PULSE | 중량*3 | 중량
 * 합산 중량 열(중량*N)이 있으면 그 값을, 없으면 1회분 중량을 읽는다.
 */
export function parseImport(data: ArrayBuffer, shots: number): ParsedSheet[] {
  const wb = XLSX.read(data)
  const out: ParsedSheet[] = []
  for (const name of wb.SheetNames) {
    const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: null })
    const top = grid.findIndex((row) => row.some((c) => /토출기\d|기저부\d/.test(text(c))))
    if (top < 0 || !grid[top + 1]) continue
    const head = grid[top]
    const sub = grid[top + 1].map(text)
    const starts = head.map((c, i) => ({ i, m: /(토출기|기저부)(\d)/.exec(text(c)) })).filter((x) => x.m)
    const rows: ImportRow[] = []
    let weightKind: ParsedSheet['weightKind'] = 'per-shot'
    starts.forEach((s, k) => {
      const end = starts[k + 1]?.i ?? sub.length
      const cols = sub.map((h, i) => ({ h, i })).filter((c) => c.i >= s.i && c.i < end)
      const pulse = cols.find((c) => c.h.startsWith('PULSE'))?.i
      const total = cols.find((c) => /^중량\*\d/.test(c.h))?.i
      const single = cols.find((c) => c.h === '중량')?.i
      const tray = cols.find((c) => c.h === '회차' || c.h.startsWith('트레이'))?.i
      if (pulse === undefined || (total === undefined && single === undefined)) return
      if (total !== undefined) weightKind = 'total'
      const dispenserId = `${s.m![1] === '기저부' ? 'B' : 'D'}${s.m![2]}` as DispenserId
      grid.slice(top + 2).forEach((r, idx) => {
        const p = num(r[pulse])
        const w = total !== undefined ? num(r[total]) : single !== undefined ? num(r[single]) : null
        if (p === null || w === null) return
        const perShotToTotal = total !== undefined ? 1 : dispenserId.startsWith('D') ? shots : 1
        rows.push({
          dispenserId,
          tray: (tray !== undefined ? num(r[tray]) : null) ?? idx + 1,
          pulse: p,
          totalWeight: +(w * perShotToTotal).toFixed(4),
        })
      })
    })
    if (rows.length) out.push({ name, rows, weightKind })
  }
  return out
}
