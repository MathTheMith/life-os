import { useEffect, useState } from 'react'
import {
  fetchEnvelopes,
  fetchGoals,
  fetchRaces,
  updateGoal,
  deleteGoal,
  checkInGoal,
  uncheckInGoal,
  deleteRace,
  updateEnvelope,
  type Envelope,
  type Goal,
  type RaceLog,
} from '../api'
import { AddGoalModal } from './AddGoalModal'
import { AddRaceModal } from './AddRaceModal'
import { PlusIcon, EditIcon, TrashIcon } from '../icons'

const DAY_FORMAT = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' })
const formatDay = (iso: string) => DAY_FORMAT.format(new Date(`${iso}T00:00:00`))
const today = () => new Date().toISOString().slice(0, 10)

export function Motorsport() {
  const [envelopes, setEnvelopes] = useState<Envelope[] | null>(null)
  const [goals, setGoals] = useState<Goal[] | null>(null)
  const [races, setRaces] = useState<RaceLog[] | null>(null)
  const [showAddGoal, setShowAddGoal] = useState(false)
  const [showAddRace, setShowAddRace] = useState(false)
  const [editingRace, setEditingRace] = useState<RaceLog | null>(null)
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function loadAll() {
    try {
      const [e, g, r] = await Promise.all([fetchEnvelopes(), fetchGoals(), fetchRaces()])
      setEnvelopes(e)
      setGoals(g)
      setRaces(r)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  useEffect(() => {
    loadAll()
  }, [])

  async function toggleGoalDone(goal: Goal) {
    await updateGoal(goal.id, { status: goal.status === 'fait' ? 'a_faire' : 'fait' })
    loadAll()
  }

  async function handleDeleteGoal(id: number) {
    await deleteGoal(id)
    loadAll()
  }

  async function toggleHabitToday(goal: Goal) {
    if (goal.checkedInToday) {
      await uncheckInGoal(goal.id, today())
    } else {
      await checkInGoal(goal.id)
    }
    loadAll()
  }

  async function handleDeleteRace(id: number) {
    await deleteRace(id)
    loadAll()
  }

  async function handleEditEnvelope(env: Envelope) {
    const amountStr = prompt('Montant total du budget (€) :', String(env.total_amount))
    if (!amountStr) return
    const totalAmount = Number.parseFloat(amountStr.replace(',', '.'))
    if (Number.isNaN(totalAmount)) return

    const periodStart = prompt('Date de début de période (AAAA-MM-JJ) :', env.period_start)
    if (!periodStart) return

    const periodEnd = prompt('Date de fin de période (AAAA-MM-JJ) :', env.period_end)
    if (!periodEnd) return

    await updateEnvelope(env.id, { totalAmount, periodStart, periodEnd })
    loadAll()
  }

  if (error) return <div className="error">{error}</div>
  if (!envelopes || !goals || !races) return <div className="loading">Chargement…</div>

  const uniqueGoals = goals.filter((g) => g.kind === 'unique')
  const habits = goals.filter((g) => g.kind === 'recurrent')

  return (
    <div className="motorsport">
      {envelopes.map((env) => (
        <div key={env.id} className="glass-card envelope-card">
          <div className="envelope-header">
            <span className="section-title" style={{ marginBottom: 0 }}>
              Enveloppe {env.name}
            </span>
            <span className={env.onTrack ? 'envelope-status envelope-status--ok' : 'envelope-status envelope-status--warn'}>
              {env.onTrack ? 'Dans les clous' : 'Rythme trop élevé'}
            </span>
          </div>

          <div className="envelope-figures">
            <span className="envelope-spent">{env.spent.toFixed(0)} €</span>
            <span className="envelope-total">sur {env.total_amount.toFixed(0)} €</span>
          </div>

          <div className="progress-track progress-track--lg">
            <div
              className={env.percentUsed > 100 ? 'progress-fill progress-fill--over' : 'progress-fill'}
              style={{
                width: `${Math.min(100, env.percentUsed)}%`,
                background: env.percentUsed > 100 ? undefined : 'var(--accent)',
              }}
            />
          </div>

          <div className="envelope-meta">
            <span>{env.remaining.toFixed(0)} € restants</span>
            <span>{env.daysRemaining} j restants</span>
            <span>Projection : {env.projectedTotal.toFixed(0)} €</span>
          </div>

          <div className="envelope-footer">
            <span className="envelope-period">
              {env.period_start} → {env.period_end}
            </span>
            <button className="icon-action-button" onClick={() => handleEditEnvelope(env)} aria-label="Modifier l'enveloppe">
              <EditIcon size={16} />
            </button>
          </div>
        </div>
      ))}

      <div className="glass-card">
        <div className="section-header-row">
          <h2 className="section-title" style={{ marginBottom: 0 }}>
            Habitudes du jour
          </h2>
          <button className="icon-button" onClick={() => setShowAddGoal(true)} aria-label="Ajouter une habitude ou un objectif">
            <PlusIcon size={16} />
          </button>
        </div>

        {habits.length === 0 && (
          <p className="pie-empty">Aucune habitude pour l'instant — ex. "Faire du simu", "Lire".</p>
        )}

        {habits.length > 0 && (
          <div className="habit-summary">
            <span className="habit-summary-label">
              {habits.filter((h) => h.checkedInToday).length}/{habits.length} faites aujourd'hui
            </span>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{
                  width: `${(habits.filter((h) => h.checkedInToday).length / habits.length) * 100}%`,
                  background: 'var(--accent)',
                }}
              />
            </div>
          </div>
        )}

        <ul className="habit-list">
          {habits.map((g) => (
            <li key={g.id} className="habit-row">
              <button
                className={g.checkedInToday ? 'habit-check habit-check--done' : 'habit-check'}
                onClick={() => toggleHabitToday(g)}
                aria-label={g.checkedInToday ? 'Décocher pour aujourd’hui' : 'Marquer fait aujourd’hui'}
              />
              <div className="goal-main">
                <span className="goal-title">{g.title}</span>
                <div className="habit-week-row">
                  <div className="habit-week">
                    {g.last7Days.map((done, i) => (
                      <span key={i} className={done ? 'habit-week-dot habit-week-dot--done' : 'habit-week-dot'} />
                    ))}
                  </div>
                  {g.streak > 0 && <span className="habit-week-streak">🔥{g.streak}</span>}
                </div>
              </div>
              <div className="race-row-actions">
                <button className="icon-action-button" onClick={() => setEditingGoal(g)} aria-label="Modifier l'habitude">
                  <EditIcon size={16} />
                </button>
                <button className="icon-action-button icon-action-button--danger" onClick={() => handleDeleteGoal(g.id)} aria-label="Supprimer l'habitude">
                  <TrashIcon size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="glass-card">
        <h2 className="section-title">Objectifs</h2>

        {uniqueGoals.length === 0 && <p className="pie-empty">Aucun objectif ponctuel pour l'instant.</p>}

        <ul className="goal-list">
          {uniqueGoals.map((g) => (
            <li key={g.id} className={g.status === 'fait' ? 'goal-row goal-row--done' : 'goal-row'}>
              <button
                className={g.status === 'fait' ? 'goal-check goal-check--done' : 'goal-check'}
                onClick={() => toggleGoalDone(g)}
                aria-label="Marquer comme fait"
              />
              <div className="goal-main">
                <span className="goal-title">{g.title}</span>
                {g.target_date && <span className="goal-meta">échéance {formatDay(g.target_date)}</span>}
              </div>
              <div className="race-row-actions">
                <button className="icon-action-button" onClick={() => setEditingGoal(g)} aria-label="Modifier l'objectif">
                  <EditIcon size={16} />
                </button>
                <button className="icon-action-button icon-action-button--danger" onClick={() => handleDeleteGoal(g.id)} aria-label="Supprimer l'objectif">
                  <TrashIcon size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="glass-card">
        <div className="section-header-row">
          <h2 className="section-title" style={{ marginBottom: 0 }}>
            Carnet de performance
          </h2>
          <button className="icon-button" onClick={() => setShowAddRace(true)} aria-label="Ajouter une course">
            <PlusIcon size={16} />
          </button>
        </div>

        {races.length === 0 && <p className="pie-empty">Aucune course enregistrée pour l'instant.</p>}

        <ul className="race-list">
          {races.map((r) => (
            <li key={r.id} className="race-row">
              <div className="race-row-top">
                <span className="race-row-event">{r.event}</span>
                <span className="race-row-date">{formatDay(r.date)}</span>
              </div>
              <div className="race-row-stats">
                {r.quali_position != null && <span>Quali P{r.quali_position}</span>}
                {r.position_finale != null && <span>Arrivée P{r.position_finale}</span>}
                {r.course_chrono != null && <span>{r.course_chrono}s</span>}
                {r.ecart_leader != null && <span>écart {r.ecart_leader}s</span>}
              </div>
              {r.notes && <p className="race-row-notes">{r.notes}</p>}
              <div className="race-row-actions">
                <button className="icon-action-button" onClick={() => setEditingRace(r)} aria-label="Modifier la course">
                  <EditIcon size={16} />
                </button>
                <button className="icon-action-button icon-action-button--danger" onClick={() => handleDeleteRace(r.id)} aria-label="Supprimer la course">
                  <TrashIcon size={16} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {showAddGoal && <AddGoalModal onClose={() => setShowAddGoal(false)} onCreated={loadAll} />}
      {showAddRace && <AddRaceModal onClose={() => setShowAddRace(false)} onCreated={loadAll} />}
      {editingRace && (
        <AddRaceModal race={editingRace} onClose={() => setEditingRace(null)} onCreated={loadAll} />
      )}
      {editingGoal && (
        <AddGoalModal goal={editingGoal} onClose={() => setEditingGoal(null)} onCreated={loadAll} />
      )}
    </div>
  )
}
