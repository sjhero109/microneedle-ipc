import { useState } from 'react'
import { useActor, useAuth } from '../data/auth'
import { createAccount, firebaseEnabled } from '../data/firebase'
import { exportWorkbook, parseImport, type ParsedSheet } from '../data/excel'
import { importRecords, logEvent, reviewCorrection, saveRecipe, saveUser, setExcluded, startBatch, useDb, type RecipeInput } from '../data/store'
import type { Recipe, Role, UserProfile } from '../data/types'
import { DEFAULT_CRITERIA } from '../data/types'
import { Button, Deviation, Field, Input, NumInput, Panel, Select, dateTime, fmt, parseNum } from './common'

type Section = 'recipes' | 'import' | 'review' | 'audit' | 'users'
const SECTIONS: [Section, string][] = [
  ['recipes', '레시피'],
  ['import', '데이터 가져오기'],
  ['review', '정정·이상치 검토'],
  ['audit', 'Audit trail'],
  ['users', '사용자'],
]

const BLANK: RecipeInput = {
  ...DEFAULT_CRITERIA,
  name: '',
  drugTarget: 0,
  baseTarget: 0,
  defaultDrugName: '',
  defaultBaseName: '',
  defaultShots: 3,
  active: true,
}

type NumKey = 'drugTarget' | 'baseTarget' | 'defaultShots' | 'adjustPct' | 'bandCenterPct' | 'passLowPct' | 'passHighPct' | 'pulseStep'

function RecipeForm({ recipe, first, onDone }: { recipe: Recipe | null; first: boolean; onDone(): void }) {
  const actor = useActor()
  const { confirm } = useAuth()
  // 첫 레시피는 최초 적용 제품(고용량) 값으로 채워 둔다
  const init: RecipeInput = recipe ?? (first ? { ...BLANK, name: '고용량', drugTarget: 6.11, baseTarget: 350, defaultDrugName: '고용량' } : BLANK)
  const [name, setName] = useState(init.name)
  const [drugName, setDrugName] = useState(init.defaultDrugName)
  const [baseName, setBaseName] = useState(init.defaultBaseName)
  const [active, setActive] = useState(init.active)
  const [bands, setBands] = useState(init.bands.map(String))
  const [nums, setNums] = useState<Record<NumKey, string>>({
    drugTarget: String(init.drugTarget || ''),
    baseTarget: String(init.baseTarget || ''),
    defaultShots: String(init.defaultShots),
    adjustPct: String(init.adjustPct),
    bandCenterPct: String(init.bandCenterPct),
    passLowPct: String(init.passLowPct),
    passHighPct: String(init.passHighPct),
    pulseStep: String(init.pulseStep),
  })
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')

  const num = (k: NumKey, label: string) => (
    <Field label={label}>
      <NumInput value={nums[k]} onChange={(e) => setNums({ ...nums, [k]: e.target.value })} />
    </Field>
  )

  async function save() {
    setError('')
    try {
      const v = Object.fromEntries(Object.entries(nums).map(([k, s]) => [k, parseNum(s)])) as Record<NumKey, number | null>
      const b = bands.map(parseNum)
      if (!name.trim()) throw new Error('제품명을 입력하세요.')
      if (Object.values(v).some((x) => x === null) || b.some((x) => x === null)) throw new Error('숫자 항목을 모두 입력하세요.')
      if (!(v.drugTarget! > 0) || !(v.baseTarget! > 0)) throw new Error('목표 중량은 0보다 커야 합니다.')
      if (!(b[0]! < b[1]! && b[1]! < b[2]!)) throw new Error('경고 구간은 작은 값부터 순서대로 입력하세요.')
      if (!(v.passLowPct! < v.passHighPct!)) throw new Error('적합 범위의 하한은 상한보다 작아야 합니다.')
      if (!Number.isInteger(v.defaultShots) || v.defaultShots! < 1) throw new Error('IPC 배수는 1 이상의 정수입니다.')
      if (recipe && !reason.trim()) throw new Error('변경 사유를 입력하세요.')
      await confirm()
      await saveRecipe(
        actor,
        {
          id: recipe?.id,
          name: name.trim(),
          defaultDrugName: drugName.trim(),
          defaultBaseName: baseName.trim(),
          active,
          bands: b as [number, number, number],
          ...(v as Record<NumKey, number>),
        },
        reason,
      )
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : '저장하지 못했습니다.')
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Field label="제품명 (레시피명)" className="col-span-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {num('drugTarget', '약액부 목표 중량 (mg, 1회)')}
        {num('baseTarget', '기저부 목표 중량 (mg)')}
        <Field label="기본 약액부명">
          <Input value={drugName} onChange={(e) => setDrugName(e.target.value)} />
        </Field>
        <Field label="기본 기저부명">
          <Input value={baseName} onChange={(e) => setBaseName(e.target.value)} />
        </Field>
        {num('defaultShots', '약액부 IPC 배수 기본값')}
        {num('pulseStep', 'Pulse 최소 단위')}
        {num('passLowPct', '적합 하한 (목표 대비 %)')}
        {num('passHighPct', '적합 상한 (목표 대비 %)')}
        {num('adjustPct', '조정 희망 비율 (목표 대비 %)')}
        {num('bandCenterPct', '경고 기준점 (목표 대비 %)')}
        {(['노란색', '빨간색', '보라색'] as const).map((c, i) => (
          <Field key={c} label={`${c} 경고 시작 (±%)`}>
            <NumInput value={bands[i]} onChange={(e) => setBands(bands.map((x, j) => (j === i ? e.target.value : x)))} />
          </Field>
        ))}
        <label className="flex items-end gap-2 pb-2.5 text-sm">
          <input type="checkbox" className="size-5" checked={active} onChange={(e) => setActive(e.target.checked)} />
          사용
        </label>
      </div>
      {recipe && (
        <Field label="변경 사유 (필수)">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}
      {recipe && <p className="text-xs text-sub">변경한 값은 이후에 시작하는 배치부터 적용됩니다. 진행 중인 배치는 시작할 때의 값을 유지합니다.</p>}
      {error && <p className="text-sm text-bad">{error}</p>}
      <div className="flex gap-2">
        <Button variant="primary" onClick={save}>
          저장
        </Button>
        <Button onClick={onDone}>취소</Button>
      </div>
    </div>
  )
}

function Recipes() {
  const db = useDb()
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  if (editing) return <RecipeForm recipe={db.recipes.find((r) => r.id === editing) ?? null} first={db.recipes.length === 0} onDone={() => setEditing(null)} />
  return (
    <div className="flex flex-col gap-2">
      {db.recipes.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2.5">
          <div className="min-w-0">
            <div className="font-semibold">
              {r.name} {!r.active && <span className="text-xs font-normal text-sub">(사용 안 함)</span>}
            </div>
            <div className="num text-sm text-sub">
              약액부 {fmt(r.drugTarget, 2)} mg × {r.defaultShots} · 기저부 {fmt(r.baseTarget, 1)} mg · 적합 {r.passLowPct}~+{r.passHighPct}% · 경고 ±{r.bands.join('/')}% · 조정{' '}
              {r.adjustPct}%
            </div>
          </div>
          <Button className="h-10 px-3 text-sm" onClick={() => setEditing(r.id)}>
            수정
          </Button>
        </div>
      ))}
      <Button variant="primary" className="self-start" onClick={() => setEditing('new')}>
        레시피 추가
      </Button>
    </div>
  )
}

function Import() {
  const db = useDb()
  const actor = useActor()
  const recipes = db.recipes.filter((r) => r.active)
  // 레시피 목록은 화면이 뜬 뒤에 도착할 수 있으므로, 고르기 전에는 첫 레시피를 쓴다
  const [picked, setRecipeId] = useState('')
  const recipe = recipes.find((r) => r.id === picked) ?? recipes[0]
  const recipeId = recipe?.id ?? ''
  const [batchNo, setBatchNo] = useState('')
  const [mfgDate, setMfgDate] = useState('')
  const [drugName, setDrugName] = useState<string | null>(null)
  const [baseName, setBaseName] = useState<string | null>(null)
  const [shots, setShots] = useState('3')
  const [file, setFile] = useState<{ name: string; data: ArrayBuffer } | null>(null)
  const [sheet, setSheet] = useState(0)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const { confirm } = useAuth()

  const n = parseNum(shots)
  let sheets: ParsedSheet[] = []
  if (file && n && n >= 1) {
    try {
      sheets = parseImport(file.data, n)
    } catch {
      sheets = []
    }
  }
  const chosen = sheets[Math.min(sheet, sheets.length - 1)]
  const tally = new Map<string, number>()
  for (const r of chosen?.rows ?? []) tally.set(r.dispenserId, (tally.get(r.dispenserId) ?? 0) + 1)
  const counts = [...tally].map(([k, v]) => `${k} ${v}건`)

  async function run() {
    setError('')
    setMsg('')
    setBusy(true)
    try {
      if (!recipe || !chosen || !file || !n) throw new Error('파일과 제품을 선택하세요.')
      if (!batchNo.trim()) throw new Error('배치번호를 입력하세요.')
      if (db.batches.some((b) => b.recipeId === recipe.id && b.batchNo === batchNo.trim())) throw new Error('같은 배치번호가 이미 있습니다. 다른 번호를 쓰세요.')
      await confirm()
      const id = await startBatch(actor, {
        recipeId: recipe.id,
        batchNo: batchNo.trim(),
        mfgDate,
        drugName: drugName ?? recipe.defaultDrugName,
        baseName: baseName ?? recipe.defaultBaseName,
        shots: n,
      })
      const count = await importRecords(actor, id, chosen.rows, file.name)
      setMsg(`${count}건을 가져왔습니다.`)
      setFile(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '가져오지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-sub">
        1행에 "토출기 1" / "기저부 1" 같은 제목, 2행에 "회차 · PULSE · 중량"(또는 "PULSE · 중량*3 · 중량") 열이 있는 엑셀을 한 배치로 가져옵니다.
      </p>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <Field label="제품명">
          <Select value={recipeId} onChange={(e) => setRecipeId(e.target.value)}>
            {recipes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="배치번호">
          <Input value={batchNo} onChange={(e) => setBatchNo(e.target.value)} />
        </Field>
        <Field label="제조일자">
          <Input type="date" value={mfgDate} onChange={(e) => setMfgDate(e.target.value)} />
        </Field>
        <Field label="약액부명">
          <Input value={drugName ?? recipe?.defaultDrugName ?? ''} onChange={(e) => setDrugName(e.target.value)} />
        </Field>
        <Field label="기저부명">
          <Input value={baseName ?? recipe?.defaultBaseName ?? ''} onChange={(e) => setBaseName(e.target.value)} />
        </Field>
        <Field label="약액부 IPC 배수">
          <NumInput value={shots} onChange={(e) => setShots(e.target.value)} inputMode="numeric" />
        </Field>
      </div>
      <input
        type="file"
        accept=".xlsx,.xls"
        className="text-sm file:mr-3 file:h-11 file:rounded-lg file:border file:border-line file:bg-panel file:px-4 file:text-ink"
        onChange={async (e) => {
          const f = e.target.files?.[0]
          setFile(f ? { name: f.name, data: await f.arrayBuffer() } : null)
          setSheet(0)
          setMsg('')
        }}
      />
      {file && sheets.length === 0 && <p className="text-sm text-bad">읽을 수 있는 표를 찾지 못했습니다.</p>}
      {chosen && (
        <div className="rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={sheet} onChange={(e) => setSheet(Number(e.target.value))} className="!h-10 !w-auto">
              {sheets.map((s, i) => (
                <option key={s.name} value={i}>
                  {s.name}
                </option>
              ))}
            </Select>
            <span className="num text-sm">
              {counts.join(' · ')} · 중량 열: {chosen.weightKind === 'total' ? '합산값' : `1회분 (× ${n}배로 환산)`}
            </span>
          </div>
          <table className="num mt-2 w-full max-w-md text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-sub">
                <th className="py-1 font-medium">토출기</th>
                <th className="py-1 font-medium">트레이</th>
                <th className="py-1 font-medium">Pulse</th>
                <th className="py-1 text-right font-medium">합산 중량</th>
              </tr>
            </thead>
            <tbody>
              {chosen.rows.slice(0, 5).map((r, i) => (
                <tr key={i} className="border-b border-line/60">
                  <td className="py-1">{r.dispenserId}</td>
                  <td className="py-1">{r.tray}</td>
                  <td className="py-1">{r.pulse}</td>
                  <td className="py-1 text-right">{fmt(r.totalWeight, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-sub">앞의 5건만 미리 보여줍니다.</p>
        </div>
      )}
      {error && <p className="text-sm text-bad">{error}</p>}
      {msg && <p className="text-sm text-good">{msg}</p>}
      <Button variant="primary" className="self-start" disabled={!chosen || busy} onClick={run}>
        가져오기
      </Button>
    </div>
  )
}

function Review() {
  const db = useDb()
  const actor = useActor()
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const pending = db.corrections.filter((c) => c.status === 'pending')
  const outliers = db.records.filter((r) => r.outlier && !r.excluded).sort((a, b) => b.createdAt - a.createdAt)
  const { confirm } = useAuth()
  const run = async (fn: () => Promise<void>) => {
    setError('')
    try {
      await confirm()
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : '처리하지 못했습니다.')
    }
  }
  return (
    <div className="flex flex-col gap-5">
      {error && <p className="text-sm text-bad">{error}</p>}
      <div>
        <h3 className="mb-2 font-semibold">정정 승인 대기 {pending.length}건</h3>
        <ul className="flex flex-col gap-2">
          {pending.map((c) => {
            const r = db.records.find((x) => x.id === c.recordId)
            return (
              <li key={c.id} className="num rounded-lg border border-line p-3 text-sm">
                <div className="font-medium">
                  {r?.productName} / {r?.batchNo} · {r?.dispenserId} #{r?.seq} — {c.field} {c.oldValue} → {c.newValue}
                </div>
                <div className="text-xs text-sub">
                  {c.requestedByName} · {dateTime(c.requestedAt)} · {c.reason}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Input className="!h-10 min-w-40 flex-1" placeholder="검토 의견" value={notes[c.id] ?? ''} onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })} />
                  <Button variant="primary" className="h-10" onClick={() => run(() => reviewCorrection(actor, c.id, true, notes[c.id] ?? ''))}>
                    승인
                  </Button>
                  <Button className="h-10" onClick={() => run(() => reviewCorrection(actor, c.id, false, notes[c.id] ?? ''))}>
                    반려
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      </div>
      <div>
        <h3 className="mb-2 font-semibold">이상치 후보 {outliers.length}건</h3>
        <ul className="flex flex-col gap-2">
          {outliers.slice(0, 50).map((r) => (
            <li key={r.id} className="num rounded-lg border border-line p-3 text-sm">
              <div className="flex flex-wrap items-center gap-x-2">
                <span className="font-medium">
                  {r.productName} / {r.batchNo} · {r.dispenserId} #{r.seq}
                </span>
                <span>
                  Pulse {r.pulse} · {fmt(r.weight, 3)} mg
                </span>
                <Deviation devPct={r.devPct} band={r.band} />
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Input className="!h-10 min-w-40 flex-1" placeholder="제외 사유 (필수)" value={notes[r.id] ?? ''} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} />
                <Button variant="danger" className="h-10" disabled={!notes[r.id]?.trim()} onClick={() => run(() => setExcluded(actor, r.id, true, notes[r.id]))}>
                  계산에서 제외
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function Audit() {
  const db = useDb()
  const actor = useActor()
  const [q, setQ] = useState('')
  const rows = [...db.audit]
    .reverse()
    .filter((a) => !q.trim() || `${a.name} ${a.email} ${a.action} ${a.reason ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Input placeholder="이름, 작업, 사유로 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button
          onClick={() => {
            const name = `IPC_audit_${new Date().toLocaleDateString('sv-SE').replaceAll('-', '')}.xlsx`
            exportWorkbook(name, [], [], [], [...rows].reverse())
            void logEvent(actor, 'Audit trail 내보내기', { file: name, count: rows.length })
          }}
        >
          엑셀
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="num w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-sub">
              {['시각', '이름', '권한', '작업', '대상', '사유'].map((h) => (
                <th key={h} className="py-1.5 pr-3 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 200).map((a) => (
              <tr key={a.id} className="border-b border-line/60">
                <td className="py-1.5 pr-3 whitespace-nowrap">{dateTime(a.at)}</td>
                <td className="py-1.5 pr-3">{a.name}</td>
                <td className="py-1.5 pr-3">{a.role === 'admin' ? '관리자' : '일반'}</td>
                <td className="py-1.5 pr-3">{a.action}</td>
                <td className="py-1.5 pr-3 text-xs text-sub">{a.target}</td>
                <td className="py-1.5 pr-3">{a.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 200 && <p className="text-xs text-sub">최근 200건만 표시합니다. 전체는 엑셀로 내려받으세요.</p>}
    </div>
  )
}

function Users() {
  const db = useDb()
  const actor = useActor()
  const { confirm } = useAuth()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('user')
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  if (!firebaseEnabled) return <p className="text-sm text-sub">시연 모드에서는 사용자 계정을 관리하지 않습니다.</p>

  const run = async (fn: () => Promise<void>) => {
    setError('')
    setMsg('')
    try {
      await confirm()
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : '처리하지 못했습니다.')
    }
  }
  const change = (u: UserProfile, patch: Partial<UserProfile>) => run(() => saveUser(actor, { ...u, ...patch }))

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-2">
        {db.users.map((u) => (
          <li key={u.uid} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2.5">
            <div className="min-w-0">
              <div className="font-semibold">
                {u.name} {!u.active && <span className="text-xs font-normal text-sub">(사용 중지)</span>}
              </div>
              <div className="truncate text-sm text-sub">{u.email}</div>
            </div>
            <div className="flex items-center gap-2">
              <Select className="!h-10 !w-auto" value={u.role} disabled={u.uid === actor.uid} onChange={(e) => change(u, { role: e.target.value as Role })}>
                <option value="user">일반 사용자</option>
                <option value="admin">관리자</option>
              </Select>
              <Button className="h-10 px-3 text-sm" disabled={u.uid === actor.uid} onClick={() => change(u, { active: !u.active })}>
                {u.active ? '사용 중지' : '다시 사용'}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <div>
        <h3 className="mb-2 font-semibold">계정 추가</h3>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Field label="이름">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="이메일">
            <Input type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="임시 비밀번호 (6자 이상)">
            <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="권한">
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="user">일반 사용자</option>
              <option value="admin">관리자</option>
            </Select>
          </Field>
        </div>
        <Button
          variant="primary"
          className="mt-2"
          disabled={!name.trim() || !email.trim() || password.length < 6}
          onClick={() =>
            run(async () => {
              const uid = await createAccount(email.trim(), password)
              await saveUser(actor, { uid, name: name.trim(), email: email.trim(), role, active: true })
              setMsg(name.trim() + " 계정을 만들었습니다.")
              setName('')
              setEmail('')
              setPassword('')
            })
          }
        >
          계정 만들기
        </Button>
      </div>
      {error && <p className="text-sm text-bad">{error}</p>}
      {msg && <p className="text-sm text-good">{msg}</p>}
    </div>
  )
}

export function AdminTab() {
  const [section, setSection] = useState<Section>('recipes')
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1 overflow-x-auto">
        {SECTIONS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setSection(id)}
            className={`h-10 rounded-lg px-3 text-sm font-medium whitespace-nowrap ${section === id ? 'bg-ink text-panel' : 'text-sub hover:bg-sunken'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <Panel className="p-4">
        {section === 'recipes' && <Recipes />}
        {section === 'import' && <Import />}
        {section === 'review' && <Review />}
        {section === 'audit' && <Audit />}
        {section === 'users' && <Users />}
      </Panel>
    </div>
  )
}
