import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import type { Band } from '../engine'

export const fmt = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined || !Number.isFinite(n) ? '–' : n.toFixed(digits)

export const signed = (n: number, digits = 1) => `${n > 0 ? '+' : ''}${n.toFixed(digits)}`

export const dateTime = (t: number) =>
  new Date(t).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })

/** 입력란의 문자열을 숫자로. 비었거나 숫자가 아니면 null */
export function parseNum(s: string): number | null {
  if (s.trim() === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export const BAND_LABEL: Record<Band, string> = { ok: '', yellow: '주의', red: '경고', purple: '이탈' }

const BAND_CHIP: Record<Band, string> = {
  ok: '',
  yellow: 'bg-warn text-warn-ink',
  red: 'bg-bad text-white',
  purple: 'bg-severe text-white',
}

/** 편차(%) 표시. 첫 경계 이내는 색 없이 숫자만 보여준다 */
export function Deviation({ devPct, band, className = '' }: { devPct: number; band: Band; className?: string }) {
  if (band === 'ok') return <span className={`num ${className}`}>{signed(devPct)}%</span>
  return (
    <span className={`num inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-semibold ${BAND_CHIP[band]} ${className}`}>
      {signed(devPct)}%<span className="text-[0.8em] font-medium">{BAND_LABEL[band]}</span>
    </span>
  )
}

export function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <span className="text-xs font-medium text-sub">{label}</span>
      {children}
    </label>
  )
}

const INPUT =
  'h-11 w-full min-w-0 rounded-lg border border-line bg-panel px-3 text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:bg-sunken disabled:text-sub'

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${INPUT} ${props.className ?? ''}`} />
}

export function NumInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input inputMode="decimal" autoComplete="off" {...props} className={`${INPUT} num ${props.className ?? ''}`} />
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${INPUT} ${props.className ?? ''}`} />
}

type Variant = 'primary' | 'ghost' | 'danger'

const BTN: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:opacity-90',
  ghost: 'border border-line bg-panel text-ink hover:bg-sunken',
  danger: 'bg-bad text-white hover:opacity-90',
}

export function Button({ variant = 'ghost', className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex h-11 items-center justify-center gap-1.5 rounded-lg px-4 font-medium whitespace-nowrap transition disabled:cursor-not-allowed disabled:opacity-40 ${BTN[variant]} ${className}`}
    />
  )
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`min-w-0 rounded-xl border border-line bg-panel ${className}`}>{children}</section>
}

export function Modal({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-panel p-4 sm:max-w-2xl sm:rounded-2xl sm:p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <Button onClick={onClose} className="h-9 px-3">
            닫기
          </Button>
        </div>
        {children}
      </div>
    </div>
  )
}
