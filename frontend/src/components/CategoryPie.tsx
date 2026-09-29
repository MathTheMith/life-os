import { useMemo, useState } from 'react'
import { colorForCategory, formatCategoryLabel } from '../categoryStyle'
import type { BudgetCategory } from '../api'

const SIZE = 220
const CENTER = SIZE / 2
const R_OUTER = 100
const R_INNER = 62
const GAP_DEGREES = 2
// Higher than the fixed category set (alimentation, transport, motorsport,
// loisirs, abonnements, logement, revenus, shopping, autre = 9) can ever
// realistically fill at once, so the "Autres catégories" aggregate below —
// intentionally not clickable, since it bundles more than one category —
// stays a rare edge case instead of routinely hiding real spend behind a
// dead tile.
const MAX_SLICES = 12

function polarToCartesian(angleDeg: number, radius: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return { x: CENTER + radius * Math.cos(rad), y: CENTER + radius * Math.sin(rad) }
}

function donutSlicePath(startAngle: number, endAngle: number): string {
  const outerStart = polarToCartesian(startAngle, R_OUTER)
  const outerEnd = polarToCartesian(endAngle, R_OUTER)
  const innerStart = polarToCartesian(endAngle, R_INNER)
  const innerEnd = polarToCartesian(startAngle, R_INNER)
  const largeArc = endAngle - startAngle > 180 ? 1 : 0

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${R_OUTER} ${R_OUTER} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerStart.x} ${innerStart.y}`,
    `A ${R_INNER} ${R_INNER} 0 ${largeArc} 0 ${innerEnd.x} ${innerEnd.y}`,
    'Z',
  ].join(' ')
}

const AGGREGATE_CATEGORY = 'autres_categories'

export function CategoryPie({
  categories,
  onSelectCategory,
  centerLabel = 'dépensés',
  emptyMessage = 'Pas encore de dépense ce mois-ci pour dessiner la répartition.',
  ariaLabel = 'Répartition des dépenses par catégorie',
}: {
  categories: BudgetCategory[]
  onSelectCategory?: (category: string) => void
  centerLabel?: string
  emptyMessage?: string
  ariaLabel?: string
}) {
  const [hovered, setHovered] = useState<string | null>(null)

  const slices = useMemo(() => {
    const withSpend = categories.filter((c) => c.spent > 0).sort((a, b) => b.spent - a.spent)
    if (withSpend.length === 0) return []

    let items = withSpend
    if (withSpend.length > MAX_SLICES) {
      const head = withSpend.slice(0, MAX_SLICES - 1)
      const tailSpent = withSpend.slice(MAX_SLICES - 1).reduce((s, c) => s + c.spent, 0)
      items = [...head, { category: AGGREGATE_CATEGORY, spent: tailSpent, limit: null }]
    }

    const total = items.reduce((s, c) => s + c.spent, 0)
    let cursor = 0
    return items.map((item) => {
      const sweep = (item.spent / total) * 360
      const start = cursor + GAP_DEGREES / 2
      const end = cursor + sweep - GAP_DEGREES / 2
      cursor += sweep
      return {
        category: item.category,
        spent: item.spent,
        percent: (item.spent / total) * 100,
        start: Math.min(start, end),
        end: Math.max(start, end),
      }
    })
  }, [categories])

  const total = slices.reduce((s, c) => s + c.spent, 0)

  if (slices.length === 0) {
    return (
      <div className="pie-empty">
        <p>{emptyMessage}</p>
      </div>
    )
  }

  return (
    <div className="pie-wrap">
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label={`${ariaLabel}, total ${total.toFixed(2)} euros`}
      >
        {slices.map((s) => {
          const isHovered = hovered === s.category
          const label = formatCategoryLabel(s.category)
          return (
            <path
              key={s.category}
              d={donutSlicePath(s.start, s.end)}
              fill={colorForCategory(s.category)}
              opacity={hovered && !isHovered ? 0.45 : 1}
              transform={isHovered ? `scale(1.035)` : undefined}
              style={{ transformOrigin: `${CENTER}px ${CENTER}px`, transition: 'opacity 150ms, transform 150ms' }}
              onMouseEnter={() => setHovered(s.category)}
              onMouseLeave={() => setHovered(null)}
            >
              <title>
                {label} — {s.spent.toFixed(2)} € ({s.percent.toFixed(0)} %)
              </title>
            </path>
          )
        })}
        <text
          x={CENTER}
          y={CENTER - 6}
          textAnchor="middle"
          className="pie-center-label"
        >
          {total.toFixed(0)} €
        </text>
        <text x={CENTER} y={CENTER + 16} textAnchor="middle" className="pie-center-sublabel">
          {centerLabel}
        </text>
      </svg>

      <ul className="pie-legend">
        {slices.map((s) => {
          const clickable = onSelectCategory && s.category !== AGGREGATE_CATEGORY
          return (
            <li
              key={s.category}
              className={hovered === s.category ? 'pie-legend-item pie-legend-item--active' : 'pie-legend-item'}
              onMouseEnter={() => setHovered(s.category)}
              onMouseLeave={() => setHovered(null)}
              onClick={clickable ? () => onSelectCategory!(s.category) : undefined}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              onKeyDown={clickable ? (e) => e.key === 'Enter' && onSelectCategory!(s.category) : undefined}
              style={clickable ? { cursor: 'pointer' } : undefined}
            >
              <span className="pie-legend-dot" style={{ background: colorForCategory(s.category) }} />
              <span className="pie-legend-name">{formatCategoryLabel(s.category)}</span>
              <span className="pie-legend-value">{s.spent.toFixed(2)} €</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
