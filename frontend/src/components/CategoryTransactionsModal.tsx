import { useEffect, useState } from 'react'
import { fetchTransactions, updateTransactionCategory, type Transaction } from '../api'
import { formatCategoryLabel, colorForCategory, CATEGORY_OPTIONS } from '../categoryStyle'
import { formatMonthLabel } from '../month'
import { CloseIcon, EditIcon } from '../icons'

const DAY_FORMAT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' })

function formatDay(isoDate: string): string {
  return DAY_FORMAT.format(new Date(`${isoDate}T00:00:00`))
}

export function CategoryTransactionsModal({
  category,
  month,
  onClose,
  onRecategorized,
}: {
  category: string
  month: string
  onClose: () => void
  // The hero totals and pie chart live in the parent and aren't refetched
  // just by this modal updating its own local list — without this, moving
  // a transaction out of this category left the summary showing stale
  // numbers until the next unrelated reload.
  onRecategorized?: () => void
}) {
  const [transactions, setTransactions] = useState<Transaction[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    fetchTransactions({ category, month })
      .then(setTransactions)
      .catch((err) => setError((err as Error).message))
  }, [category, month])

  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 4000)
    return () => clearTimeout(t)
  }, [note])

  async function handleRecategorize(tx: Transaction, newCategory: string) {
    setEditingId(null)
    if (newCategory === tx.category) return
    try {
      const { learnedKeyword } = await updateTransactionCategory(tx.id, newCategory)
      // Reassigned out of the category this modal is showing — it no
      // longer belongs in this list.
      setTransactions((prev) => prev?.filter((t) => t.id !== tx.id) ?? null)
      onRecategorized?.()
      setNote(
        learnedKeyword
          ? `Déplacé vers "${formatCategoryLabel(newCategory)}" — les prochaines transactions "${learnedKeyword}" iront directement là.`
          : `Déplacé vers "${formatCategoryLabel(newCategory)}".`
      )
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const total = transactions?.reduce((s, t) => s + t.amount, 0) ?? 0
  const color = colorForCategory(category)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel glass-card transactions-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tx-modal-header">
          <div className="tx-modal-badge" style={{ background: `${color}26`, color }}>
            <span className="dot" style={{ background: color }} />
          </div>
          <div className="tx-modal-heading">
            <h2>{formatCategoryLabel(category)}</h2>
            <span className="tx-modal-subtitle">
              {formatMonthLabel(month)}
              {transactions ? ` · ${transactions.length} transaction${transactions.length > 1 ? 's' : ''}` : ''}
            </span>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Fermer">
            <CloseIcon size={16} />
          </button>
        </div>

        {error && <div className="error">{error}</div>}
        {note && <p className="tx-note">{note}</p>}
        {!error && !transactions && <div className="loading">Chargement…</div>}

        {transactions && transactions.length === 0 && (
          <p className="pie-empty">Aucune transaction dans cette catégorie ce mois-ci.</p>
        )}

        {transactions && transactions.length > 0 && (
          <>
            <ul className="tx-list">
              {transactions.map((t) => (
                <li key={t.id} className="tx-row">
                  <div className="tx-row-day">{formatDay(t.date)}</div>
                  <div className="tx-row-main">
                    <span className="tx-row-label">{t.label}</span>
                  </div>
                  {editingId === t.id ? (
                    <select
                      className="tx-row-category-select"
                      autoFocus
                      defaultValue={t.category}
                      onChange={(e) => handleRecategorize(t, e.target.value)}
                      onBlur={() => setEditingId(null)}
                    >
                      {CATEGORY_OPTIONS.map((c) => (
                        <option key={c} value={c}>
                          {formatCategoryLabel(c)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <>
                      <span className={t.amount < 0 ? 'tx-row-amount tx-row-amount--negative' : 'tx-row-amount tx-row-amount--positive'}>
                        {t.amount > 0 ? '+' : ''}
                        {t.amount.toFixed(2)} €
                      </span>
                      <button
                        type="button"
                        className="tx-row-recategorize"
                        onClick={() => setEditingId(t.id)}
                        aria-label="Changer de catégorie"
                      >
                        <EditIcon size={14} />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
            <div className="tx-total">
              <span>Total</span>
              <span>{total.toFixed(2)} €</span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
