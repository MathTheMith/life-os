import { useEffect, useState } from 'react'
import { fetchAgenda, addAgendaEvent, deleteAgendaEvent, fetchPushKey, savePushSubscription, sendTestPush, type AgendaEvent } from '../api'
import { PlusIcon, TrashIcon } from '../icons'

const SOURCE_LABEL: Record<AgendaEvent['source'], string | null> = {
  user: null,
  chat: 'ajouté par l’IA',
  journal: 'depuis ton chat du soir',
  mail: 'depuis un mail',
}

const REMINDER_CHOICES: { min: number; label: string }[] = [
  { min: 10080, label: '1 sem' },
  { min: 4320, label: '3 j' },
  { min: 1440, label: '1 j' },
  { min: 720, label: '12 h' },
  { min: 180, label: '3 h' },
  { min: 60, label: '1 h' },
  { min: 15, label: '15 min' },
]

function reminderLabel(min: number, allDay: boolean): string {
  if (min === 0) return allDay ? 'le matin' : "à l'heure"
  const known = REMINDER_CHOICES.find((c) => c.min === min)
  if (known) return known.label
  if (min % 1440 === 0) return `${min / 1440} j`
  if (min % 60 === 0) return `${min / 60} h`
  return `${min} min`
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

export function AgendaPage() {
  return (
    <div className="planning-page">
      <AgendaCard />
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
                {e.reminders.length > 0 && (
                  <span className="agenda-event-source">🔔 {e.reminders.map((m) => reminderLabel(m, e.all_day === 1)).join(' · ')}</span>
                )}
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
  const [reminders, setReminders] = useState<number[]>([1440, 60])
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || !date) return
    setError(null)
    try {
      await addAgendaEvent({
        title: title.trim(),
        start: time ? `${date}T${time}` : date,
        reminders_min: reminders,
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
      <div className="field">
        <span>Rappels (notifications)</span>
        <div className="reminder-chips">
          {REMINDER_CHOICES.map((c) => (
            <button
              type="button"
              key={c.min}
              className={reminders.includes(c.min) ? 'reminder-chip reminder-chip--on' : 'reminder-chip'}
              onClick={() => setReminders((prev) => (prev.includes(c.min) ? prev.filter((m) => m !== c.min) : [...prev, c.min]))}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <button type="submit" className="primary-button">
        Ajouter
      </button>
    </form>
  )
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

// Push notifications on this device: enable once, then a test button.
// hideWhenEnabled: on the Today page it only shows up while it's needed.
export function NotificationsCard({ hideWhenEnabled = false }: { hideWhenEnabled?: boolean }) {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!supported) return
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setEnabled(Boolean(sub) && Notification.permission === 'granted'))
      .catch(() => setEnabled(false))
  }, [supported])

  async function enable() {
    setBusy(true)
    setMessage(null)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setMessage("Notifications refusées. Autorise-les dans les réglages du navigateur pour ce site, puis réessaie.")
        return
      }
      const reg = await navigator.serviceWorker.ready
      const { publicKey } = await fetchPushKey()
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }))
      await savePushSubscription(sub.toJSON())
      setEnabled(true)
      setMessage('Activées sur ce téléphone.')
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function test() {
    setBusy(true)
    try {
      const { delivered } = await sendTestPush()
      setMessage(delivered ? 'Notification envoyée, regarde ton téléphone.' : "Aucun appareil abonné, réactive les notifications.")
    } catch (err) {
      setMessage((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!supported || enabled === null) return null
  if (enabled && hideWhenEnabled) return null
  if (enabled) {
    return (
      <div className="notif-bar">
        <span>🔔 Notifications activées</span>
        <button className="text-button" onClick={test} disabled={busy}>
          Tester
        </button>
        {message && <span className="notif-bar-message">{message}</span>}
      </div>
    )
  }
  return (
    <div className="glass-card">
      <p className="watch-meta">Active les notifications pour recevoir tes rappels d'agenda sur ce téléphone.</p>
      <button className="primary-button" onClick={enable} disabled={busy}>
        🔔 Activer les notifications
      </button>
      {message && <div className="error">{message}</div>}
    </div>
  )
}
