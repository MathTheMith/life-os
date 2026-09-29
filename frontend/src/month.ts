export function currentMonth(): string {
  return new Date().toISOString().slice(0, 10).slice(0, 7)
}

export function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split('-').map(Number)
  const date = new Date(year, m - 1 + delta, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

const LABEL_FORMAT = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' })

export function formatMonthLabel(month: string): string {
  return LABEL_FORMAT.format(new Date(`${month}-01T00:00:00`))
}
