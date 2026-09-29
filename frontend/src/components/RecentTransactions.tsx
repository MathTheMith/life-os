import { useEffect, useState } from 'react'
import { fetchTransactions, type Transaction } from '../api'
import { colorForCategory, formatCategoryLabel } from '../categoryStyle'

const DAY_FORMAT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' })

function formatDay(isoDate: string): string {
  return DAY_FORMAT.format(new Date(`${isoDate}T00:00:00`))
}

// A flat, all-time feed (not scoped to the month picker above it) — the
// most recent activity regardless of which month is currently selected,
// closer to how a bank statement reads.
export function RecentTransactions({ refreshKey }: { refreshKey: number }) {
  const [transactions, setTransactions] = useState<Transaction[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchTransactions({ limit: 20 })
      .then(setTransactions)
      .catch((err) => setError((err as Error).message))
  }, [refreshKey])

  return (
    <div className="glass-card recent-tx-card">
      <h2 className="section-title" style={{ marginBottom: 10 }}>
        Dernières transactions
      </h2>
      {error && <div className="error">{error}</div>}
      {!error && !transactions && <div className="loading">Chargement…</div>}
      {transactions && transactions.length === 0 && <p className="pie-empty">Aucune transaction pour l'instant.</p>}
      {transactions && transactions.length > 0 && (
        <ul className="tx-list">
          {transactions.map((t) => (
            <li key={t.id} className="tx-row">
              <div className="tx-row-day">{formatDay(t.date)}</div>
              <span
                className="tx-row-category-dot"
                style={{ background: colorForCategory(t.category) }}
                title={formatCategoryLabel(t.category)}
              />
              <div className="tx-row-main">
                <span className="tx-row-label">{t.label}</span>
              </div>
              <span className={t.amount < 0 ? 'tx-row-amount tx-row-amount--negative' : 'tx-row-amount tx-row-amount--positive'}>
                {t.amount > 0 ? '+' : ''}
                {t.amount.toFixed(2)} €
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
