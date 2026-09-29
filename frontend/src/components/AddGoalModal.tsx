import { useState } from 'react'
import { createGoal, updateGoal, type Goal, type GoalKind } from '../api'
import { CloseIcon } from '../icons'

export function AddGoalModal({
  goal,
  onClose,
  onCreated,
}: {
  goal?: Goal
  onClose: () => void
  onCreated: () => void
}) {
  const isEdit = !!goal
  const [title, setTitle] = useState(goal?.title ?? '')
  const [description, setDescription] = useState(goal?.description ?? '')
  const [kind, setKind] = useState<GoalKind>(goal?.kind ?? 'unique')
  const [targetDate, setTargetDate] = useState(goal?.target_date ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) {
      setError('Donne un titre à ton objectif.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      if (isEdit) {
        await updateGoal(goal.id, {
          title: title.trim(),
          description: description.trim() || undefined,
          targetDate: targetDate || undefined,
        })
      } else {
        await createGoal({
          title: title.trim(),
          description: description.trim() || undefined,
          kind,
          targetDate: targetDate || undefined,
        })
      }
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
          <h2>{isEdit ? "Modifier l'objectif" : 'Nouvel objectif'}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Fermer">
            <CloseIcon size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-form">
          {!isEdit && <ModeSwitch kind={kind} onChange={setKind} />}

          <label className="field">
            <span>Titre</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={kind === 'unique' ? 'Ex : Aller au Circuit du Laquais' : 'Ex : Faire du simu de manière précise'}
              autoFocus
            />
          </label>

          <label className="field">
            <span>Notes (optionnel)</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Détails, contexte…"
            />
          </label>

          <label className="field">
            <span>{kind === 'recurrent' ? 'Échéance / rythme visé (optionnel)' : 'Date visée (optionnel)'}</span>
            <input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} />
          </label>

          {error && <div className="error">{error}</div>}

          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? 'Enregistrement…' : isEdit ? 'Enregistrer les modifications' : 'Ajouter'}
          </button>
        </form>
      </div>
    </div>
  )
}

// Kept as its own component so the create-mode segmented control's markup
// (and the ability to switch it) lives in one place — kind can't change
// once a goal exists (check-ins only make sense for recurrent goals), so
// edit mode never renders this at all.
function ModeSwitch({ kind, onChange }: { kind: GoalKind; onChange: (k: GoalKind) => void }) {
  return (
    <div className="segmented">
      <button
        type="button"
        className={kind === 'unique' ? 'segmented-option segmented-option--active' : 'segmented-option'}
        onClick={() => onChange('unique')}
      >
        Ponctuel
      </button>
      <button
        type="button"
        className={kind === 'recurrent' ? 'segmented-option segmented-option--active' : 'segmented-option'}
        onClick={() => onChange('recurrent')}
      >
        Récurrent
      </button>
    </div>
  )
}
