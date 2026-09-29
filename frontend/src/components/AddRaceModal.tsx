import { useState } from 'react'
import { createRace, updateRace, type RaceLog } from '../api'
import { CloseIcon } from '../icons'

const TYPES = [
  { value: 'karting', label: 'Karting' },
  { value: 'circuit', label: 'Circuit' },
  { value: 'simu', label: 'Simu' },
]

function toNumber(v: string): number | undefined {
  if (!v.trim()) return undefined
  const n = Number.parseFloat(v.replace(',', '.'))
  return Number.isNaN(n) ? undefined : n
}

const numToStr = (n: number | null) => (n == null ? '' : String(n))

export function AddRaceModal({
  race,
  onClose,
  onCreated,
}: {
  race?: RaceLog
  onClose: () => void
  onCreated: () => void
}) {
  const isEdit = !!race
  const [date, setDate] = useState(() => race?.date ?? new Date().toISOString().slice(0, 10))
  const [event, setEvent] = useState(race?.event ?? '')
  const [type, setType] = useState(race?.type ?? 'karting')
  const [qualiPosition, setQualiPosition] = useState(numToStr(race?.quali_position ?? null))
  const [qualiChrono, setQualiChrono] = useState(numToStr(race?.quali_chrono ?? null))
  const [courseChrono, setCourseChrono] = useState(numToStr(race?.course_chrono ?? null))
  const [positionFinale, setPositionFinale] = useState(numToStr(race?.position_finale ?? null))
  const [chronoVainqueur, setChronoVainqueur] = useState(numToStr(race?.chrono_vainqueur ?? null))
  const [ecartLeader, setEcartLeader] = useState(numToStr(race?.ecart_leader ?? null))
  const [notes, setNotes] = useState(race?.notes ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!event.trim()) {
      setError("Indique l'événement ou le lieu.")
      return
    }
    setSaving(true)
    setError(null)
    const payload = {
      date,
      event: event.trim(),
      type,
      qualiPosition: toNumber(qualiPosition),
      qualiChrono: toNumber(qualiChrono),
      courseChrono: toNumber(courseChrono),
      positionFinale: toNumber(positionFinale),
      chronoVainqueur: toNumber(chronoVainqueur),
      ecartLeader: toNumber(ecartLeader),
      notes: notes.trim() || undefined,
    }
    try {
      if (isEdit) {
        await updateRace(race.id, payload)
      } else {
        await createRace(payload)
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
      <div className="modal-panel glass-card modal-panel--scroll" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{isEdit ? 'Modifier la course' : 'Nouvelle course / session'}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Fermer">
            <CloseIcon size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-form">
          <div className="segmented">
            {TYPES.map((t) => (
              <button
                key={t.value}
                type="button"
                className={type === t.value ? 'segmented-option segmented-option--active' : 'segmented-option'}
                onClick={() => setType(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="field-row">
            <label className="field">
              <span>Date</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="field">
              <span>Événement / lieu</span>
              <input value={event} onChange={(e) => setEvent(e.target.value)} placeholder="Park Events Lyon" autoFocus />
            </label>
          </div>

          <span className="modal-section-label">Chronos & positions (optionnel)</span>

          <div className="field-row">
            <label className="field">
              <span>Position quali</span>
              <input inputMode="numeric" value={qualiPosition} onChange={(e) => setQualiPosition(e.target.value)} placeholder="1" />
            </label>
            <label className="field">
              <span>Chrono quali (s)</span>
              <input inputMode="decimal" value={qualiChrono} onChange={(e) => setQualiChrono(e.target.value)} placeholder="48.3" />
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              <span>Meilleur chrono course (s)</span>
              <input inputMode="decimal" value={courseChrono} onChange={(e) => setCourseChrono(e.target.value)} placeholder="47.8" />
            </label>
            <label className="field">
              <span>Position finale</span>
              <input inputMode="numeric" value={positionFinale} onChange={(e) => setPositionFinale(e.target.value)} placeholder="1" />
            </label>
          </div>

          <div className="field-row">
            <label className="field">
              <span>Chrono du vainqueur (s)</span>
              <input inputMode="decimal" value={chronoVainqueur} onChange={(e) => setChronoVainqueur(e.target.value)} placeholder="46.8" />
            </label>
            <label className="field">
              <span>Écart au leader (s)</span>
              <input inputMode="decimal" value={ecartLeader} onChange={(e) => setEcartLeader(e.target.value)} placeholder="0.5" />
            </label>
          </div>

          <label className="field">
            <span>Notes — erreurs, contacts, dépassements, défense, pression, rythme…</span>
            <textarea
              className="textarea"
              rows={4}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Départ raté, remonté sur le leader en 7 tours, divebomb raté puis dépassement propre à l'avant-dernier tour…"
            />
          </label>

          {error && <div className="error">{error}</div>}

          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? 'Enregistrement…' : isEdit ? 'Enregistrer les modifications' : 'Enregistrer'}
          </button>
        </form>
      </div>
    </div>
  )
}
