import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  fetchTodayBrief,
  regenerateBrief,
  createConversation,
  fetchBudgetSummary,
  fetchEnvelopes,
  fetchGoals,
  checkInGoal,
  uncheckInGoal,
  fetchTodos,
  createTodo,
  updateTodo,
  fetchAgenda,
  type Brief,
  type Goal,
  type Todo,
  type AgendaEvent,
} from '../api'
import { NotificationsCard } from './Planning'
import { ActionsCard } from './Actions'
import { PlusIcon } from '../icons'

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
          <button className="text-button brief-regenerate" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Réduire' : 'Lire la suite'}
          </button>
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

// The AI's question of the day: answering opens a chat it has started.
function QuestionCard({ question, onAnswer }: { question: string; onAnswer: (conversationId: number) => void }) {
  const [busy, setBusy] = useState(false)

  async function answer() {
    setBusy(true)
    try {
      const { id } = await createConversation({ title: 'Question du jour', assistantMessage: question })
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
function DayList() {
  const [habits, setHabits] = useState<Goal[] | null>(null)
  const [todos, setTodos] = useState<Todo[] | null>(null)
  const [draft, setDraft] = useState('')

  const load = () => {
    fetchGoals()
      .then((goals) => setHabits(goals.filter((g) => g.kind === 'recurrent')))
      .catch(() => setHabits([]))
    fetchTodos()
      .then((list) => setTodos(list.filter((t) => !t.done)))
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
      <h2 className="section-title">À faire</h2>
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
        {todos.map((t) => (
          <li key={`t${t.id}`} className="todo-row">
            <button className="habit-check" onClick={() => completeTodo(t)} aria-label="Marquer comme fait" />
            <span className="todo-title">{t.title}</span>
          </li>
        ))}
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
