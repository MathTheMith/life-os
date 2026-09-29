import { useEffect, useState } from 'react'
import { fetchBudgetSummary, type BudgetSummary } from '../api'
import { CategoryPie } from './CategoryPie'
import { AddTransactionModal } from './AddTransactionModal'
import { CategoryTransactionsModal } from './CategoryTransactionsModal'
import { RecentTransactions } from './RecentTransactions'
import { currentMonth, shiftMonth, formatMonthLabel } from '../month'
import { PlusIcon, ChevronLeftIcon, ChevronRightIcon } from '../icons'

export function Budget() {
  const [month, setMonth] = useState(currentMonth)
  const [summary, setSummary] = useState<BudgetSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [openCategory, setOpenCategory] = useState<string | null>(null)
  const [view, setView] = useState<'depenses' | 'recus'>('depenses')
  const [recentTick, setRecentTick] = useState(0)

  async function load(forMonth: string) {
    try {
      setSummary(await fetchBudgetSummary(forMonth))
      setRecentTick((t) => t + 1)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  useEffect(() => {
    setSummary(null)
    load(month)
  }, [month])

  const isCurrentMonth = month === currentMonth()

  if (error) return <div className="error">{error}</div>
  if (!summary) return <div className="loading">Chargement…</div>

  const isPositive = summary.balance >= 0

  return (
    <div className="budget">
      <div className={`hero-card glass-card ${isPositive ? 'hero-card--positive' : 'hero-card--negative'}`}>
        <div className="hero-month-nav">
          <button
            className="month-arrow"
            onClick={() => setMonth((m) => shiftMonth(m, -1))}
            aria-label="Mois précédent"
          >
            <ChevronLeftIcon />
          </button>
          <span className="hero-card-label">{formatMonthLabel(month)}</span>
          <button
            className="month-arrow"
            onClick={() => setMonth((m) => shiftMonth(m, 1))}
            disabled={isCurrentMonth}
            aria-label="Mois suivant"
          >
            <ChevronRightIcon />
          </button>
        </div>
        <span className="hero-card-figure">
          {isPositive ? '+' : ''}
          {summary.balance.toFixed(2)} €
        </span>
        <div className="hero-card-split">
          <span>
            <span className="dot dot--positive" /> {summary.totalIncome.toFixed(2)} € reçus
          </span>
          <span>
            <span className="dot dot--negative" /> {summary.totalSpent.toFixed(2)} € dépensés
          </span>
        </div>
      </div>

      <div className="glass-card pie-card">
        <div className="section-header-row">
          <h2 className="section-title" style={{ marginBottom: 0 }}>
            {view === 'depenses' ? 'Répartition des dépenses' : 'Répartition des rentrées'}
          </h2>
          <div className="segmented segmented--compact">
            <button
              type="button"
              className={view === 'depenses' ? 'segmented-option segmented-option--active' : 'segmented-option'}
              onClick={() => setView('depenses')}
            >
              Dépenses
            </button>
            <button
              type="button"
              className={view === 'recus' ? 'segmented-option segmented-option--active' : 'segmented-option'}
              onClick={() => setView('recus')}
            >
              Reçus
            </button>
          </div>
        </div>
        {view === 'depenses' ? (
          <CategoryPie categories={summary.categories} onSelectCategory={setOpenCategory} />
        ) : (
          <CategoryPie
            categories={summary.incomeCategories}
            onSelectCategory={setOpenCategory}
            centerLabel="reçus"
            emptyMessage="Pas encore de rentrée ce mois-ci pour dessiner la répartition."
            ariaLabel="Répartition des rentrées par catégorie"
          />
        )}
      </div>

      <RecentTransactions refreshKey={recentTick} />

      <button className="fab" onClick={() => setShowAdd(true)} aria-label="Ajouter une dépense">
        <PlusIcon size={24} />
      </button>

      {showAdd && (
        <AddTransactionModal onClose={() => setShowAdd(false)} onCreated={() => load(month)} />
      )}

      {openCategory && (
        <CategoryTransactionsModal
          category={openCategory}
          month={summary.month}
          onClose={() => setOpenCategory(null)}
          onRecategorized={() => load(month)}
        />
      )}
    </div>
  )
}
