import { useEffect, useState } from 'react'
import { fetchAgenda, addAgendaEvent, deleteAgendaEvent, type AgendaEvent } from '../api'
import { PlusIcon, TrashIcon } from '../icons'
import { TodoPage } from './Todo'

const SOURCE_LABEL: Record<AgendaEvent['source'], string | null> = {
  user: null,
  chat: 'ajouté par l’IA',
  journal: 'depuis ton chat du soir',
  mail: 'depuis un mail',
}

const DAY_FORMAT = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })

function parisToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())
}

function dayLabel(date: string, today: string): string {
  const diff = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000)
  if (diff === 0) return "Aujourd'hui"
  if (diff === 1) return 'Demain'
  if (diff === -1) return 'Hier'
  const label = DAY_FORMAT.format(new Date(`${date}T12:00:00Z`))
  return label.charAt(0).toUpperCase() + label.slice(1)
}

export function PlanningPage() {
  return (
    <div className="planning-page">
      <AgendaCard />
      <TodoPage />
    </div>
  )
}

function AgendaCard() {
  const [events, setEvents] = useState<AgendaEvent[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = () =>
    fetchAgenda()
      .then(setEvents)
      .catch((err) => setError((err as Error).message))

  useEffect(() => {
    load()
  }, [])

  async function remove(id: number) {
    await deleteAgendaEvent(id)
    load()
  }

  const today = parisToday()
  const groups = new Map<string, AgendaEvent[]>()
  for (const e of events ?? []) {
    const day = e.start_at.slice(0, 10)
    groups.set(day, [...(groups.get(day) ?? []), e])
  }

  return (
    <div className="glass-card">
      <div className="agenda-header">
        <h2 className="section-title">Agenda</h2>
        <button className="icon-button" onClick={() => setAdding((v) => !v)} aria-label="Ajouter un événement">
          <PlusIcon size={16} />
        </button>
      </div>

      {adding && (
        <AddEventForm
          defaultDate={today}
          onAdded={() => {
            setAdding(false)
            load()
          }}
        />
      )}

      {error && <div className="error">{error}</div>}
      {events && events.length === 0 && (
        <p className="pie-empty">Rien de prévu. Dis à l'IA dans le chat « rappelle-moi de… » et elle l'ajoutera ici.</p>
      )}

      {[...groups.entries()].map(([day, dayEvents]) => (
        <div key={day} className={day < today ? 'agenda-day agenda-day--past' : 'agenda-day'}>
          <div className="agenda-day-label">{dayLabel(day, today)}</div>
          {dayEvents.map((e) => (
            <div key={e.id} className="agenda-event">
              <span className="agenda-event-time">{e.all_day ? 'Journée' : e.start_at.slice(11, 16)}</span>
              <div className="agenda-event-main">
                <span className="agenda-event-title">{e.title}</span>
                {e.notes && <span className="agenda-event-notes">{e.notes}</span>}
                {SOURCE_LABEL[e.source] && <span className="agenda-event-source">{SOURCE_LABEL[e.source]}</span>}
              </div>
              <button
                className="icon-action-button icon-action-button--danger"
                onClick={() => remove(e.id)}
                aria-label="Supprimer l'événement"
              >
                <TrashIcon size={16} />
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function AddEventForm({ defaultDate, onAdded }: { defaultDate: string; onAdded: () => void }) {
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(defaultDate)
  const [time, setTime] = useState('')
  const [remind, setRemind] = useState('60')
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || !date) return
    setError(null)
    try {
      await addAgendaEvent({
        title: title.trim(),
        start: time ? `${date}T${time}` : date,
        remind_before_min: remind === 'none' ? null : Number(remind),
      })
      onAdded()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="modal-form agenda-form">
      <label className="field">
        <span>Quoi</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex : Relancer WRT" autoFocus />
      </label>
      <div className="field-row">
        <label className="field">
          <span>Jour</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span>Heure (optionnel)</span>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
      </div>
      {time && (
        <label className="field">
          <span>Rappel</span>
          <select value={remind} onChange={(e) => setRemind(e.target.value)}>
            <option value="15">15 min avant</option>
            <option value="60">1 h avant</option>
            <option value="180">3 h avant</option>
            <option value="1440">La veille</option>
            <option value="none">Pas de rappel</option>
          </select>
        </label>
      )}
      {error && <div className="error">{error}</div>}
      <button type="submit" className="primary-button">
        Ajouter
      </button>
    </form>
  )
}
