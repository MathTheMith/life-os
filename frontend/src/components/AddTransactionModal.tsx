import { useState } from 'react'
import { createTransaction } from '../api'
import { CloseIcon } from '../icons'

const CATEGORY_OPTIONS = [
  'alimentation',
  'transport',
  'motorsport',
  'loisirs',
  'abonnements',
  'logement',
  'autre',
]

export function AddTransactionModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [label, setLabel] = useState('')
  const [amount, setAmount] = useState('')
  const [isExpense, setIsExpense] = useState(true)
  const [category, setCategory] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const value = Number.parseFloat(amount.replace(',', '.'))
    if (!label.trim() || Number.isNaN(value) || value === 0) {
      setError('Renseigne un libellé et un montant valide.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await createTransaction({
        date,
        label: label.trim(),
        amount: isExpense ? -Math.abs(value) : Math.abs(value),
        category: category || undefined,
      })
      onCreated()
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel glass-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Ajouter une dépense</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Fermer">
            <CloseIcon size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-form">
          <div className="segmented">
            <button
              type="button"
              className={isExpense ? 'segmented-option segmented-option--active' : 'segmented-option'}
              onClick={() => setIsExpense(true)}
            >
              Dépense
            </button>
            <button
              type="button"
              className={!isExpense ? 'segmented-option segmented-option--active' : 'segmented-option'}
              onClick={() => setIsExpense(false)}
            >
              Revenu
            </button>
          </div>

          <label className="field">
            <span>Description</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Ex : Karting en espèces"
              autoFocus
            />
          </label>

          <div className="field-row">
            <label className="field">
              <span>Montant (€)</span>
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="35,00"
              />
            </label>
            <label className="field">
              <span>Date</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
          </div>

          <label className="field">
            <span>Catégorie (optionnel)</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">Auto-détectée</option>
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>

          {error && <div className="error">{error}</div>}

          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? 'Ajout…' : 'Ajouter'}
          </button>
        </form>
      </div>
    </div>
  )
}
