import { useEffect, useRef, useState } from 'react'
import {
  fetchWatchItems,
  setWatchItemStatus,
  markWatchSeen,
  fetchWatchSources,
  addWatchSource,
  deleteWatchSource,
  fetchWatchStatus,
  runWatchNow,
  type WatchItem,
  type WatchSource,
  type WatchStatus,
} from '../api'
import { TrashIcon } from '../icons'

type Filter = 'jobs' | 'plans' | 'news' | 'all'

const FILTERS: { id: Filter; label: string; match: (i: WatchItem) => boolean }[] = [
  { id: 'jobs', label: 'Stages & jobs', match: (i) => ['stage', 'alternance', 'emploi'].includes(i.category) },
  { id: 'plans', label: 'Bons plans', match: (i) => ['bon_plan', 'evenement'].includes(i.category) },
  { id: 'news', label: 'Actus', match: (i) => i.category === 'actu' },
  { id: 'all', label: 'Tout', match: () => true },
]

const CATEGORY_LABEL: Record<string, string> = {
  stage: 'Stage',
  alternance: 'Alternance',
  emploi: 'Emploi',
  bon_plan: 'Bon plan',
  evenement: 'Événement',
  actu: 'Actu',
}

const DATE_TIME = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export function WatchPage() {
  const [items, setItems] = useState<WatchItem[] | null>(null)
  // Ids that were "new" when the page opened: they keep their badge while
  // the page is open even though they get marked seen on the server.
  const [freshIds, setFreshIds] = useState<Set<number>>(new Set())
  const [filter, setFilter] = useState<Filter>('jobs')
  const [status, setStatus] = useState<{ running: boolean; lastRun: string | null } | null>(null)
  const [showSources, setShowSources] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)

  async function loadItems() {
    const data = await fetchWatchItems()
    setItems(data)
    return data
  }

  async function pollStatus() {
    const s = await fetchWatchStatus()
    setStatus(s)
    if (s.running) {
      pollRef.current = window.setTimeout(pollStatus, 4000)
    } else {
      await loadItems()
    }
  }

  useEffect(() => {
    loadItems()
      .then((data) => {
        setFreshIds(new Set(data.filter((i) => i.status === 'new').map((i) => i.id)))
        return markWatchSeen()
      })
      .catch((err) => setError((err as Error).message))
    pollStatus().catch(() => {})
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current)
    }
  }, [])

  async function handleRun() {
    setError(null)
    try {
      await runWatchNow()
      setStatus((prev) => ({ lastRun: prev?.lastRun ?? null, running: true }))
      pollRef.current = window.setTimeout(pollStatus, 4000)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function setItemStatus(item: WatchItem, next: WatchStatus) {
    const value = item.status === next ? 'seen' : next
    setItems((prev) => prev?.map((i) => (i.id === item.id ? { ...i, status: value } : i)) ?? null)
    await setWatchItemStatus(item.id, value).catch((err) => setError((err as Error).message))
  }

  if (error && !items) return <div className="error">{error}</div>
  if (!items) return <div className="loading">Chargement…</div>

  const activeFilter = FILTERS.find((f) => f.id === filter)!
  const visible = items.filter((i) => i.status !== 'dismissed' && activeFilter.match(i))

  return (
    <div className="watch-page">
      <div className="glass-card">
        <h2 className="section-title">Veille</h2>
        <p className="watch-meta">
          {status?.running
            ? 'Recherche en cours, ça prend quelques minutes…'
            : status?.lastRun
              ? `Dernier passage : ${DATE_TIME.format(new Date(status.lastRun))}. Passage automatique chaque matin à 7h.`
              : 'Pas encore de passage. Automatique chaque matin à 7h.'}
        </p>
        <button className="primary-button" onClick={handleRun} disabled={status?.running}>
          {status?.running ? 'Recherche en cours…' : 'Lancer maintenant'}
        </button>
        <button className="text-button watch-sources-toggle" onClick={() => setShowSources((v) => !v)}>
          {showSources ? 'Masquer les sources' : 'Gérer les sources surveillées'}
        </button>
        {error && <div className="error">{error}</div>}
      </div>

      {showSources && <SourcesCard />}

      <div className="segmented segmented--compact watch-filters">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={filter === f.id ? 'segmented-option segmented-option--active' : 'segmented-option'}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {visible.length === 0 && (
        <div className="glass-card">
          <p className="pie-empty">Rien pour l'instant dans cette catégorie.</p>
        </div>
      )}

      {visible.map((item) => (
        <div key={item.id} className="glass-card watch-item">
          <div className="watch-item-head">
            <span className="watch-badge">{CATEGORY_LABEL[item.category] ?? item.category}</span>
            {freshIds.has(item.id) && <span className="watch-badge watch-badge--new">Nouveau</span>}
            <span className={item.score >= 70 ? 'watch-score watch-score--high' : 'watch-score'}>{item.score}/100</span>
          </div>
          {item.url ? (
            <a className="watch-item-title" href={item.url} target="_blank" rel="noopener noreferrer">
              {item.title}
            </a>
          ) : (
            <span className="watch-item-title">{item.title}</span>
          )}
          <div className="watch-item-sub">
            {[item.company, item.location, item.source_name && `via ${item.source_name}`].filter(Boolean).join(' · ')}
          </div>
          {item.reason && <p className="watch-item-reason">{item.reason}</p>}
          <div className="watch-item-actions">
            <button
              className={item.status === 'interested' ? 'text-button watch-action watch-action--on' : 'text-button watch-action'}
              onClick={() => setItemStatus(item, 'interested')}
            >
              ⭐ M'intéresse
            </button>
            <button className="text-button watch-action" onClick={() => setItemStatus(item, 'dismissed')}>
              ✕ Pas pour moi
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

function SourcesCard() {
  const [sources, setSources] = useState<WatchSource[] | null>(null)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = () => fetchWatchSources().then(setSources).catch((err) => setError((err as Error).message))

  useEffect(() => {
    load()
  }, [])

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      await addWatchSource(name.trim(), url.trim())
      setName('')
      setUrl('')
      load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function handleDelete(id: number) {
    await deleteWatchSource(id)
    load()
  }

  return (
    <div className="glass-card">
      <h2 className="section-title">Sources</h2>
      <ul className="watch-sources">
        {sources?.map((s) => (
          <li key={s.id} className="watch-source-row">
            <div className="watch-source-main">
              <a href={s.url} target="_blank" rel="noopener noreferrer">
                {s.name}
              </a>
              {s.last_error && <span className="watch-source-error">{s.last_error}</span>}
            </div>
            <button
              className="icon-action-button icon-action-button--danger"
              onClick={() => handleDelete(s.id)}
              aria-label="Retirer la source"
            >
              <TrashIcon size={16} />
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={handleAdd} className="modal-form">
        <label className="field">
          <span>Nom</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex : Ligier carrières" />
        </label>
        <label className="field">
          <span>Adresse de la page</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" inputMode="url" />
        </label>
        {error && <div className="error">{error}</div>}
        <button type="submit" className="primary-button" disabled={!name.trim() || !url.trim()}>
          Ajouter la source
        </button>
      </form>
    </div>
  )
}
