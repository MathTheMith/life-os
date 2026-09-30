import { useEffect, useRef, useState } from 'react'
import { fetchMails, fetchMailStatus, runMailNow, rateMail, type MailItem } from '../api'
import { SwipeDeck } from './SwipeDeck'

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
  const [view, setView] = useState<'deck' | 'list'>('deck')
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

  async function rate(mail: MailItem, rating: MailItem['user_rating']) {
    setMails((prev) => prev?.map((m) => (m.id === mail.id ? { ...m, user_rating: rating } : m)) ?? null)
    await rateMail(mail.id, rating).catch((err) => setError((err as Error).message))
  }

  const toRate = mails.filter((m) => m.ai_status === 'done' && !m.user_rating).sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
  const important = mails.filter((m) => (m.user_rating ? m.user_rating === 'important' : (m.importance ?? 0) >= 50))
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
        {view === 'list' && (
          <button className="text-button watch-sources-toggle" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Seulement les importants' : `Voir tous les mails (${mails.length})`}
          </button>
        )}
      </div>

      <div className="segmented segmented--compact watch-filters">
        <button
          className={view === 'deck' ? 'segmented-option segmented-option--active' : 'segmented-option'}
          onClick={() => setView('deck')}
        >
          À trier ({toRate.length})
        </button>
        <button
          className={view === 'list' ? 'segmented-option segmented-option--active' : 'segmented-option'}
          onClick={() => setView('list')}
        >
          Liste
        </button>
      </div>

      {view === 'deck' && (
        <>
          <p className="swipe-help">→ important pour moi · ← sans intérêt. L'IA apprend de tes choix.</p>
          <SwipeDeck
            items={toRate}
            getKey={(m) => m.id}
            render={(m) => <MailCard mail={m} />}
            onSwipe={(m, dir) => rate(m, dir === 'right' ? 'important' : 'not')}
            labels={{ left: 'SANS INTÉRÊT', right: 'IMPORTANT' }}
            empty={
              <div className="glass-card">
                <p className="pie-empty">Tous tes mails sont triés.</p>
              </div>
            }
          />
        </>
      )}

      {view === 'list' && visible.length === 0 && (
        <div className="glass-card">
          <p className="pie-empty">Aucun mail important ces 14 derniers jours.</p>
        </div>
      )}

      {view === 'list' &&
        visible.map((m) => (
          <div key={m.id} className="glass-card watch-item">
            <MailCard mail={m} />
            <div className="watch-item-actions">
              <span className="watch-status">
                {m.user_rating === 'important' ? '♥ Important' : m.user_rating === 'not' ? '✕ Sans intérêt' : 'Pas trié'}
              </span>
              {m.user_rating !== 'important' && (
                <button className="text-button watch-action" onClick={() => rate(m, 'important')}>
                  ♥ Important
                </button>
              )}
              {m.user_rating !== 'not' && (
                <button className="text-button watch-action" onClick={() => rate(m, 'not')}>
                  ✕ Sans intérêt
                </button>
              )}
            </div>
          </div>
        ))}
    </div>
  )
}

function MailCard({ mail }: { mail: MailItem }) {
  return (
    <>
      <div className="watch-item-head">
        <span className="watch-badge">
          {CATEGORY_LABEL[mail.category ?? ''] ?? (mail.ai_status === 'pending' ? 'À trier' : 'Exclu')}
        </span>
        {mail.importance !== null && (
          <span className={mail.importance >= 70 ? 'watch-score watch-score--high' : 'watch-score'}>{mail.importance}/100</span>
        )}
      </div>
      <span className="watch-item-title">{mail.subject}</span>
      <div className="watch-item-sub">
        {[mail.from_name || mail.from_addr, DATE_TIME.format(new Date(mail.date))].filter(Boolean).join(' · ')}
      </div>
      {mail.summary && <p className="watch-item-reason">{mail.summary}</p>}
      {mail.action && <p className="mail-action">👉 {mail.action}</p>}
    </>
  )
}
