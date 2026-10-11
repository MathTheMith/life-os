import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  fetchTodayBrief,
  regenerateBrief,
  openQuestionConversation,
  fetchBudgetSummary,
  fetchEnvelopes,
  fetchGoals,
  checkInGoal,
  uncheckInGoal,
  fetchTodos,
  createTodo,
  updateTodo,
  deleteTodo,
  fetchAgenda,
  fetchCoach,
  fetchSystemHealth,
  type CoachMood,
  type Brief,
  type Goal,
  type Todo,
  type AgendaEvent,
  type SystemHealth,
} from '../api'
import { NotificationsCard } from './Planning'
import { ActionsCard } from './Actions'
import { PlusIcon, EditIcon, TrashIcon } from '../icons'

// The home page: what matters today, readable in half a minute. Anything
// with nothing to show is left out instead of saying "nothing yet".
export function TodayPage({
  onOpenAgenda,
  onOpenBudget,
  onAnswer,
}: {
  onOpenAgenda: () => void
  onOpenBudget: () => void
  onAnswer: (conversationId: number) => void
}) {
  const [brief, setBrief] = useState<Brief | null | undefined>(undefined)

  useEffect(() => {
    fetchTodayBrief()
      .then(setBrief)
      .catch(() => setBrief(null))
  }, [])

  return (
    <div className="planning-page">
      <NotificationsCard hideWhenEnabled />
      <HealthWarning />
      <CoachLine />
      <BriefCard brief={brief} onChange={setBrief} />
      {brief?.question && <QuestionCard question={brief.question} onAnswer={onAnswer} />}
      <BudgetLine onOpen={onOpenBudget} />
      <ActionsCard hideWhenEmpty />
      <DayList />
      <UpcomingCard onOpenAgenda={onOpenAgenda} />
    </div>
  )
}

function BriefCard({ brief, onChange }: { brief: Brief | null | undefined; onChange: (b: Brief) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function generate() {
    setBusy(true)
    setError(null)
    try {
      onChange(await regenerateBrief())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (brief === undefined) return null

  return (
    <div className="glass-card brief-card">
      <h2 className="section-title">☀️ Brief du jour</h2>
      {brief ? (
        <>
          <div className={expanded ? 'brief-content' : 'brief-content brief-content--clamped'}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{brief.content}</ReactMarkdown>
          </div>
          <div className="brief-actions">
            <button className="text-button brief-regenerate" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'Réduire' : 'Lire la suite'}
            </button>
            <button className="text-button brief-regenerate" onClick={generate} disabled={busy}>
              {busy ? 'Régénération…' : 'Régénérer'}
            </button>
          </div>
          {brief.commitments && brief.commitments.length > 0 && (
            <div className="commitments">
              <span className="question-card-label">🎯 Tes engagements du jour</span>
              <ul>
                {brief.commitments.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
              <span className="commitments-note">Je vérifie ce soir.</span>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="watch-meta">Ton brief arrive chaque matin à 9h.</p>
          <button className="text-button brief-regenerate" onClick={generate} disabled={busy}>
            {busy ? 'Rédaction en cours…' : 'Le générer maintenant'}
          </button>
        </>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  )
}

const JOB_LABEL: Record<'brief' | 'watch' | 'mail', string> = {
  brief: 'Le brief du matin',
  watch: 'La veille',
  mail: 'Le tri des mails',
}

// Scheduled jobs (brief, veille, tri des mails) run unattended and used to
// fail silently (a console.error nobody sees) — this surfaces it instead,
// but only when something's actually stale, same as every other card here.
function HealthWarning() {
  const [health, setHealth] = useState<SystemHealth | null>(null)

  useEffect(() => {
    fetchSystemHealth()
      .then(setHealth)
      .catch(() => setHealth(null))
  }, [])

  if (!health) return null
  const staleJobs = (['brief', 'watch', 'mail'] as const).filter((job) => health[job].stale)
  if (staleJobs.length === 0 && health.mailErrors.length === 0) return null

  return (
    <div className="health-warning">
      {staleJobs.map((job) => (
        <p key={job}>
          ⚠️ {JOB_LABEL[job]} n'a pas tourné depuis {health[job].lastAt ? formatDate(health[job].lastAt!) : "jamais"}.
        </p>
      ))}
      {health.mailErrors.map((e) => (
        <p key={e.account}>⚠️ Mail {e.account} : {e.message}</p>
      ))}
    </div>
  )
}

const HEALTH_DATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
function formatDate(iso: string): string {
  return HEALTH_DATE.format(new Date(iso))
}

// How happy the coach is with you, moved by the evening reviews.
function CoachLine() {
  const [coach, setCoach] = useState<CoachMood | null>(null)

  useEffect(() => {
    fetchCoach()
      .then(setCoach)
      .catch(() => setCoach(null))
  }, [])

  if (!coach) return null
  const tone = coach.satisfaction >= 1 ? 'coach-line--good' : coach.satisfaction <= -1 ? 'coach-line--bad' : ''
  return (
    <div className={`coach-line ${tone}`}>
      <span className="coach-line-emoji">{coach.emoji}</span>
      <div className="coach-line-main">
        <span className="coach-line-label">
          Ton coach est {coach.label} ({coach.satisfaction > 0 ? '+' : ''}
          {coach.satisfaction}/5)
        </span>
        {coach.comment && <span className="coach-line-comment">{coach.comment}</span>}
      </div>
    </div>
  )
}

// The AI's question of the day: answering opens a chat it has started.
function QuestionCard({ question, onAnswer }: { question: string; onAnswer: (conversationId: number) => void }) {
  const [busy, setBusy] = useState(false)

  async function answer() {
    setBusy(true)
    try {
      const { id } = await openQuestionConversation(question)
      onAnswer(id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button className="glass-card question-card" onClick={answer} disabled={busy}>
      <span className="question-card-label">❓ L'IA aimerait savoir</span>
      <span className="question-card-text">{question}</span>
      <span className="question-card-cta">{busy ? '…' : 'Répondre ›'}</span>
    </button>
  )
}

const MONTH = new Intl.DateTimeFormat('fr-FR', { month: 'long' })
const euros = (n: number) => `${Math.round(n).toLocaleString('fr-FR')} €`

function BudgetLine({ onOpen }: { onOpen: () => void }) {
  const [text, setText] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([fetchBudgetSummary(), fetchEnvelopes().catch(() => [])])
      .then(([summary, envelopes]) => {
        const month = MONTH.format(new Date())
        const parts = [`${month.charAt(0).toUpperCase()}${month.slice(1)} : ${summary.balance >= 0 ? '+' : ''}${euros(summary.balance)}`]
        for (const env of envelopes) parts.push(`${env.name} : ${euros(env.remaining)} restants`)
        setText(parts.join(' · '))
      })
      .catch(() => setText(null))
  }, [])

  if (!text) return null
  return (
    <button className="budget-line" onClick={onOpen}>
      <span>💶 {text}</span>
      <span className="budget-line-arrow">›</span>
    </button>
  )
}

function parisToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())
}

// Today's habits and open tasks in one checklist.
// "Lire :" / "Voir :" entries are reading reminders, not real tasks — they
// sink to the bottom of the list instead of competing with actual to-dos.
const READ_PREFIX = /^(Lire|Voir) :/
function byReadLast(a: Todo, b: Todo) {
  const aRead = READ_PREFIX.test(a.title)
  const bRead = READ_PREFIX.test(b.title)
  return aRead === bRead ? 0 : aRead ? 1 : -1
}

function DayList() {
  const [habits, setHabits] = useState<Goal[] | null>(null)
  const [todos, setTodos] = useState<Todo[] | null>(null)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)

  const load = () => {
    fetchGoals()
      .then((goals) => setHabits(goals.filter((g) => g.kind === 'recurrent')))
      .catch(() => setHabits([]))
    fetchTodos()
      .then((list) => setTodos(list.filter((t) => !t.done).sort(byReadLast)))
      .catch(() => setTodos([]))
  }

  useEffect(load, [])

  async function toggleHabit(goal: Goal) {
    if (goal.checkedInToday) await uncheckInGoal(goal.id, parisToday())
    else await checkInGoal(goal.id)
    load()
  }

  async function completeTodo(todo: Todo) {
    setTodos((prev) => prev?.filter((t) => t.id !== todo.id) ?? null)
    await updateTodo(todo.id, { done: true })
  }

  async function renameTodo(todo: Todo, title: string) {
    setTodos((prev) => prev?.map((t) => (t.id === todo.id ? { ...t, title } : t)) ?? null)
    if (title.trim() && title !== todo.title) await updateTodo(todo.id, { title: title.trim() })
  }

  async function removeTodo(todo: Todo) {
    setTodos((prev) => prev?.filter((t) => t.id !== todo.id) ?? null)
    await deleteTodo(todo.id)
  }

  async function addTodo(e: React.FormEvent) {
    e.preventDefault()
    if (!draft.trim()) return
    await createTodo(draft.trim())
    setDraft('')
    load()
  }

  if (!habits || !todos) return null

  return (
    <div className="glass-card">
      <div className="agenda-header">
        <h2 className="section-title">À faire</h2>
        <button
          className={editing ? 'icon-button icon-button--active' : 'icon-button'}
          onClick={() => setEditing((v) => !v)}
          aria-label={editing ? 'Terminer la modification' : 'Modifier les tâches'}
        >
          <EditIcon size={16} />
        </button>
      </div>
      <ul className="todo-list">
        {habits.map((h) => (
          <li key={`h${h.id}`} className={h.checkedInToday ? 'todo-row todo-row--done' : 'todo-row'}>
            <button
              className={h.checkedInToday ? 'habit-check habit-check--done' : 'habit-check'}
              onClick={() => toggleHabit(h)}
              aria-label={h.checkedInToday ? 'Décocher' : 'Fait aujourd’hui'}
            />
            <span className="todo-title">{h.title}</span>
            {h.streak > 0 && <span className="habit-week-streak">🔥{h.streak}</span>}
          </li>
        ))}
        {todos.map((t) =>
          editing ? (
            <li key={`t${t.id}`} className="todo-row todo-row--editing">
              <input
                className="todo-edit-input"
                value={t.title}
                onChange={(e) => renameTodo(t, e.target.value)}
              />
              <button
                className="icon-action-button icon-action-button--danger"
                onClick={() => removeTodo(t)}
                aria-label="Supprimer la tâche"
              >
                <TrashIcon size={16} />
              </button>
            </li>
          ) : (
            <li key={`t${t.id}`} className="todo-row">
              <button className="habit-check" onClick={() => completeTodo(t)} aria-label="Marquer comme fait" />
              <span className="todo-title">{t.title}</span>
            </li>
          )
        )}
      </ul>
      <form onSubmit={addTodo} className="todo-add-row">
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ajouter une tâche…" />
        <button type="submit" className="icon-button" aria-label="Ajouter">
          <PlusIcon size={16} />
        </button>
      </form>
    </div>
  )
}

const UPCOMING = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

function UpcomingCard({ onOpenAgenda }: { onOpenAgenda: () => void }) {
  const [events, setEvents] = useState<AgendaEvent[] | null>(null)

  useEffect(() => {
    const now = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Paris',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .format(new Date())
      .replace(' ', 'T')
    fetchAgenda()
      .then((list) => setEvents(list.filter((e) => (e.all_day ? e.start_at >= now.slice(0, 10) : e.start_at >= now)).slice(0, 3)))
      .catch(() => setEvents([]))
  }, [])

  if (!events) return null

  return (
    <div className="glass-card">
      <div className="agenda-header">
        <h2 className="section-title">Prochains rendez-vous</h2>
        <button className="text-button" onClick={onOpenAgenda}>
          Tout l'agenda ›
        </button>
      </div>
      {events.length === 0 && <p className="pie-empty">Rien de prévu.</p>}
      {events.map((e) => (
        <div key={e.id} className="agenda-event">
          <span className="agenda-event-time">{e.all_day ? 'Journée' : e.start_at.slice(11, 16)}</span>
          <div className="agenda-event-main">
            <span className="agenda-event-title">{e.title}</span>
            <span className="agenda-event-notes">{UPCOMING.format(new Date(`${e.start_at.slice(0, 10)}T12:00:00Z`))}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
