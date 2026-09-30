import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  fetchActions,
  acceptAction,
  completeAction,
  dismissAction,
  updateActionDraft,
  runActionsNow,
  type LifeAction,
} from '../api'

const KIND_LABEL: Record<LifeAction['kind'], string> = {
  candidature: 'Candidature',
  relance: 'Relance',
  sortie: 'Idée',
  preparation: 'Entretien',
}

const WHEN = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })

function formatStart(start: string): string {
  return start.length > 10 ? WHEN.format(new Date(`${start}:00Z`)) : start
}

// What the AI prepared and waits for a yes on: nothing leaves without one.
// hideWhenEmpty: on the Today page the card only shows up when something waits.
export function ActionsCard({ hideWhenEmpty = false }: { hideWhenEmpty?: boolean }) {
  const [actions, setActions] = useState<LifeAction[] | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = () =>
    fetchActions()
      .then(setActions)
      .catch((err) => setError((err as Error).message))

  useEffect(() => {
    load()
  }, [])

  async function run(id: number, fn: (id: number) => Promise<unknown>) {
    setBusyId(id)
    setError(null)
    try {
      await fn(id)
      await load()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  async function searchNow() {
    setSearching(true)
    await runActionsNow().catch(() => {})
    // The preparation takes a minute or two (one AI call per action).
    window.setTimeout(() => {
      load().finally(() => setSearching(false))
    }, 90_000)
  }

  if (!actions) return null
  const open = actions.filter((a) => a.status === 'proposed' || a.status === 'accepted')
  const closed = actions.filter((a) => a.status === 'done' || a.status === 'dismissed')
  if (hideWhenEmpty && open.length === 0) return null

  return (
    <div className="glass-card">
      <div className="agenda-header">
        <h2 className="section-title">✅ Prêt pour toi</h2>
        <button className="text-button" onClick={searchNow} disabled={searching}>
          {searching ? 'Préparation…' : 'Chercher maintenant'}
        </button>
      </div>
      {open.length === 0 && (
        <p className="pie-empty">
          Rien en attente. Chaque matin, l'IA prépare tes candidatures (offres aimées), relances, idées de sorties et fiches
          d'entretien.
        </p>
      )}
      {error && <div className="error">{error}</div>}
      {open.map((a) => (
        <ActionItem key={a.id} action={a} busy={busyId === a.id} onRun={run} onSaved={load} />
      ))}
      {closed.length > 0 && (
        <div className="actions-closed">
          {closed.map((a) => (
            <div key={a.id} className="actions-closed-row">
              {a.status === 'done' ? '✓' : '✕'} {a.title}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ActionItem({
  action: a,
  busy,
  onRun,
  onSaved,
}: {
  action: LifeAction
  busy: boolean
  onRun: (id: number, fn: (id: number) => Promise<unknown>) => void
  onSaved: () => void
}) {
  const [showMail, setShowMail] = useState(false)
  const [subject, setSubject] = useState(a.mail_subject ?? '')
  const [body, setBody] = useState(a.mail_body ?? '')
  const hasMail = Boolean(a.mail_body)
  const dirty = subject !== (a.mail_subject ?? '') || body !== (a.mail_body ?? '')

  async function save() {
    await updateActionDraft(a.id, { mail_subject: subject, mail_body: body })
    onSaved()
  }

  const acceptLabel = a.kind === 'sortie' ? (a.agenda_start ? "Oui, à l'agenda" : 'Oui') : 'Oui, en brouillon Gmail'

  return (
    <div className="action-item">
      <div className="watch-item-head">
        <span className="watch-badge">{KIND_LABEL[a.kind]}</span>
        {a.status === 'accepted' && <span className="watch-badge watch-badge--new">Brouillon créé</span>}
      </div>
      <span className="watch-item-title">{a.title}</span>
      {a.reason && <p className="watch-item-sub">{a.reason}</p>}
      {a.body_md && a.kind !== 'preparation' && (
        <div className="brief-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{a.body_md}</ReactMarkdown>
        </div>
      )}
      {a.agenda_start && <p className="mail-action">📅 {formatStart(a.agenda_start)}</p>}

      {hasMail && (
        <button className="text-button" onClick={() => setShowMail((v) => !v)}>
          {showMail ? 'Masquer' : a.kind === 'preparation' ? 'Voir la fiche' : 'Voir et modifier le texte'}
        </button>
      )}
      {showMail && a.kind === 'preparation' && (
        <div className="brief-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{a.mail_body ?? ''}</ReactMarkdown>
        </div>
      )}
      {showMail && a.kind !== 'preparation' && (
        <div className="modal-form">
          <p className="watch-item-sub">{a.mail_to ? `À : ${a.mail_to}` : 'Brouillon envoyé à toi-même, pour copier le texte dans le formulaire'}</p>
          <label className="field">
            <span>Objet</span>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <textarea className="textarea action-textarea" value={body} onChange={(e) => setBody(e.target.value)} />
          {dirty && (
            <button className="text-button" onClick={save}>
              Enregistrer mes modifications
            </button>
          )}
        </div>
      )}

      <div className="watch-item-actions">
        {a.status === 'proposed' && (
          <>
            <button className="primary-button action-yes" onClick={() => onRun(a.id, acceptAction)} disabled={busy || dirty}>
              {busy ? '…' : acceptLabel}
            </button>
            <button className="text-button watch-action" onClick={() => onRun(a.id, dismissAction)} disabled={busy}>
              Non
            </button>
          </>
        )}
        {a.status === 'accepted' && (
          <>
            <button className="primary-button action-yes" onClick={() => onRun(a.id, completeAction)} disabled={busy}>
              {a.kind === 'candidature' || a.kind === 'relance' ? "C'est envoyé ✓" : 'Fait ✓'}
            </button>
            <button className="text-button watch-action" onClick={() => onRun(a.id, dismissAction)} disabled={busy}>
              Abandonner
            </button>
          </>
        )}
      </div>
    </div>
  )
}
