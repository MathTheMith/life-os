// Fixed categorical palette, validated for CVD-safe adjacency on a dark glass
// surface (see project notes — ran through the dataviz palette validator).
// Order matters: it's the CVD-safety mechanism, not cosmetic.
const CATEGORY_COLORS: Record<string, string> = {
  alimentation: '#3987e5',
  transport: '#d95926',
  motorsport: '#199e70',
  loisirs: '#c98500',
  abonnements: '#d55181',
  logement: '#9085e9',
  autre: '#e66767',
}

// Offered when reassigning a transaction's category by hand — the fixed
// palette above, plus the two freeform categories the keyword rules already
// use (revenus, shopping) but that have no dedicated color/tile styling.
export const CATEGORY_OPTIONS = ['alimentation', 'transport', 'motorsport', 'loisirs', 'abonnements', 'logement', 'revenus', 'shopping', 'autre']

const FALLBACK_POOL = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9', '#e66767']

const assignedFallbacks = new Map<string, string>()
let fallbackCursor = 0

export function colorForCategory(category: string): string {
  if (CATEGORY_COLORS[category]) return CATEGORY_COLORS[category]
  if (assignedFallbacks.has(category)) return assignedFallbacks.get(category)!
  const color = FALLBACK_POOL[fallbackCursor % FALLBACK_POOL.length]
  fallbackCursor += 1
  assignedFallbacks.set(category, color)
  return color
}

export function formatCategoryLabel(category: string): string {
  const withoutPrefix = category.startsWith('banque_')
    ? category.slice('banque_'.length)
    : category
  const spaced = withoutPrefix.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}
