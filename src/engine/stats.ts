export function median(xs: number[]): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** 정규분포 σ에 대응하도록 보정한 MAD */
export function mad(xs: number[], center = median(xs)): number {
  return 1.4826 * median(xs.map((x) => Math.abs(x - center)))
}

export function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

export function roundTo(x: number, step: number): number {
  if (!(step > 0)) return x
  const r = Math.round(x / step) * step
  const digits = Math.max(0, Math.ceil(-Math.log10(step)))
  return +r.toFixed(digits)
}
