import { useEffect, useRef, useState } from 'react'
import { fetchMails, fetchMailStatus, runMailNow, type MailItem } from '../api'

const CATEGORY_LABEL: Record<string, string> = {
  recrutement: 'Recrutement',
  candidature: 'Candidature',
  administratif: 'Administratif',
  banque: 'Banque',
  perso: 'Perso',
  achat: 'Achat',
  pub: 'Pub',
  autre: 'Autre',
}

const DATE_TIME = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export function MailsPage() {
  const [mails, setMails] = useState<MailItem[] | null>(null)
  const [status, setStatus] = useState<Awaited<ReturnType<typeof fetchMailStatus>> | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)

  async function poll() {
    const s = await fetchMailStatus()
    setStatus(s)
    if (s.running) pollRef.current = window.setTimeout(poll, 4000)
    else setMails(await fetchMails())
  }

  useEffect(() => {
    poll().catch((err) => setError((err as Error).message))
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current)
    }
  }, [])

  async function handleRun() {
    await runMailNow().catch((err) => setError((err as Error).message))
    setStatus((prev) => (prev ? { ...prev, running: true } : prev))
    pollRef.current = window.setTimeout(poll, 4000)
  }

  if (error && !mails) return <div className="error">{error}</div>
  if (!mails || !status) return <div className="loading">Chargement…</div>

  if (status.accounts.length === 0) {
    return (
      <div className="glass-card">
        <h2 className="section-title">Mails</h2>
        <p className="watch-meta">
          Aucun compte configuré. Ajoute une ligne MAIL_ACCOUNTS dans le fichier .env du serveur (adresse:mot de passe
          d'application Google), puis redémarre le backend.
        </p>
      </div>
    )
  }

  const important = mails.filter((m) => (m.importance ?? 0) >= 50)
  const visible = showAll ? mails : important

  return (
    <div className="watch-page">
      <div className="glass-card">
        <h2 className="section-title">Mails</h2>
        <p className="watch-meta">
          {status.running
            ? 'Lecture des nouveaux mails…'
            : status.lastRun
              ? `Dernière lecture : ${DATE_TIME.format(new Date(status.lastRun))}. Automatique toutes les 30 minutes.`
              : 'Pas encore lus. Automatique toutes les 30 minutes.'}
        </p>
        {status.accounts
          .filter((a) => a.error)
          .map((a) => (
            <div key={a.address} className="error">
              {a.address} : {a.error}
            </div>
          ))}
        <button className="primary-button" onClick={handleRun} disabled={status.running}>
          {status.running ? 'Lecture en cours…' : 'Lire maintenant'}
        </button>
        <button className="text-button watch-sources-toggle" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Seulement les importants' : `Voir tous les mails (${mails.length})`}
        </button>
      </div>

      {visible.length === 0 && (
        <div className="glass-card">
          <p className="pie-empty">Aucun mail important ces 14 derniers jours.</p>
        </div>
      )}

      {visible.map((m) => (
        <div key={m.id} className="glass-card watch-item">
          <div className="watch-item-head">
            <span className="watch-badge">{CATEGORY_LABEL[m.category ?? ''] ?? (m.ai_status === 'pending' ? 'À trier' : 'Exclu')}</span>
            {m.importance !== null && (
              <span className={m.importance >= 70 ? 'watch-score watch-score--high' : 'watch-score'}>{m.importance}/100</span>
            )}
          </div>
          <span className="watch-item-title">{m.subject}</span>
          <div className="watch-item-sub">
            {[m.from_name || m.from_addr, DATE_TIME.format(new Date(m.date))].filter(Boolean).join(' · ')}
          </div>
          {m.summary && <p className="watch-item-reason">{m.summary}</p>}
          {m.action && <p className="mail-action">👉 {m.action}</p>}
        </div>
      ))}
    </div>
  )
}
