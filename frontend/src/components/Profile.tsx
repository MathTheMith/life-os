import { useEffect, useState } from 'react'
import { fetchProfile, saveProfileSection, draftProfile, type ProfileSection } from '../api'

export function ProfilePage() {
  const [sections, setSections] = useState<ProfileSection[] | null>(null)
  // What's in each textarea; differs from sections[].content until saved.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [fromAi, setFromAi] = useState<Set<string>>(new Set())
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      const data = await fetchProfile()
      setSections(data)
      setDrafts(Object.fromEntries(data.map((s) => [s.key, s.content])))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function save(key: string) {
    setSavingKey(key)
    setError(null)
    try {
      await saveProfileSection(key, drafts[key] ?? '')
      setSections((prev) => prev?.map((s) => (s.key === key ? { ...s, content: drafts[key] ?? '' } : s)) ?? null)
      setFromAi((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSavingKey(null)
    }
  }

  // Fills the textareas with the AI's draft without saving anything: each
  // section still needs its own "Enregistrer" once reviewed.
  async function handleDraft() {
    setDrafting(true)
    setError(null)
    try {
      const result = await draftProfile()
      setDrafts((prev) => ({ ...prev, ...result }))
      setFromAi(new Set(Object.keys(result)))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDrafting(false)
    }
  }

  if (!sections) return error ? <div className="error">{error}</div> : <div className="loading">Chargement…</div>

  return (
    <div className="profile-page">
      <div className="glass-card">
        <h2 className="section-title">Moi</h2>
        <p className="profile-intro">
          Ce que tu écris ici, l'IA le lit en premier avant chaque conseil, chaque brief et chaque recherche. Écris-le comme
          tu le penses, tu pourras le modifier quand tu veux.
        </p>
        <button className="primary-button" onClick={handleDraft} disabled={drafting}>
          {drafting ? "L'IA rédige…" : "Pré-remplir avec ce que l'IA sait déjà"}
        </button>
        {error && <div className="error">{error}</div>}
      </div>

      {sections.map((s) => {
        const dirty = (drafts[s.key] ?? '') !== s.content
        return (
          <div className="glass-card" key={s.key}>
            <h2 className="section-title">{s.title}</h2>
            <p className="profile-hint">{s.hint}</p>
            <textarea
              className="textarea profile-textarea"
              value={drafts[s.key] ?? ''}
              onChange={(e) => setDrafts((prev) => ({ ...prev, [s.key]: e.target.value }))}
            />
            {fromAi.has(s.key) && dirty && <div className="profile-draft-badge">Brouillon de l'IA, relis-le avant d'enregistrer</div>}
            {dirty && (
              <button className="primary-button" onClick={() => save(s.key)} disabled={savingKey === s.key}>
                {savingKey === s.key ? 'Enregistrement…' : 'Enregistrer'}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
