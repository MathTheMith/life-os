import { useEffect, useState, type ReactNode } from 'react'
import { fetchJournal, type JournalEntry } from '../api'
import { ProfilePage } from './Profile'
import { Budget } from './Budget'
import { Motorsport } from './Motorsport'
import { NotificationsCard } from './Planning'
import { SourcesCard } from './Watch'

export type MeSection = 'profile' | 'journal' | 'budget' | 'driving' | 'settings'

// Everything that's set up or looked at now and then, behind the header's
// profile icon: profile, journal history, budget, driving goals, settings.
export function MePage({
  initialSection,
  budgetKey,
  onImport,
}: {
  initialSection: MeSection | null
  budgetKey: number
  onImport: () => void
}) {
  const [open, setOpen] = useState<MeSection | null>(initialSection)
  const toggle = (s: MeSection) => setOpen((prev) => (prev === s ? null : s))

  return (
    <div className="planning-page">
      <Section id="profile" title="👤 Mon profil" open={open} onToggle={toggle}>
        <ProfilePage />
      </Section>
      <Section id="journal" title="📓 Mon journal" open={open} onToggle={toggle}>
        <JournalList />
      </Section>
      <Section id="budget" title="💶 Budget" open={open} onToggle={toggle}>
        <button className="primary-button" onClick={onImport}>
          Importer un relevé
        </button>
        <Budget key={budgetKey} />
      </Section>
      <Section id="driving" title="🏁 Pilotage : enveloppe, habitudes, objectifs, chronos" open={open} onToggle={toggle}>
        <Motorsport />
      </Section>
      <Section id="settings" title="⚙️ Réglages" open={open} onToggle={toggle}>
        <NotificationsCard />
        <SourcesCard />
      </Section>
    </div>
  )
}

function Section({
  id,
  title,
  open,
  onToggle,
  children,
}: {
  id: MeSection
  title: string
  open: MeSection | null
  onToggle: (id: MeSection) => void
  children: ReactNode
}) {
  const isOpen = open === id
  return (
    <div className="me-section">
      <button className="glass-card me-section-header" onClick={() => onToggle(id)} aria-expanded={isOpen}>
        <span>{title}</span>
        <span className="me-section-chevron">{isOpen ? '−' : '+'}</span>
      </button>
      {isOpen && <div className="me-section-body">{children}</div>}
    </div>
  )
}

const DAY = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })

function JournalList() {
  const [entries, setEntries] = useState<JournalEntry[] | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)

  useEffect(() => {
    fetchJournal()
      .then(setEntries)
      .catch(() => setEntries([]))
  }, [])

  if (!entries) return <div className="loading">Chargement…</div>
  if (entries.length === 0) {
    return (
      <div className="glass-card">
        <p className="pie-empty">Pas encore d'entrée. Fais ton premier chat du soir avec 🌙 dans le chat.</p>
      </div>
    )
  }

  return (
    <div className="glass-card">
      {entries.map((e) => (
        <button key={e.id} className="journal-row" onClick={() => setExpanded((v) => (v === e.id ? null : e.id))}>
          <div className="journal-row-head">
            <span className="journal-row-date">{DAY.format(new Date(`${e.date}T12:00:00Z`))}</span>
            <span className="journal-row-scores">
              {e.mood ? `humeur ${e.mood}/5` : ''}
              {e.mood && e.energy ? ' · ' : ''}
              {e.energy ? `énergie ${e.energy}/5` : ''}
            </span>
          </div>
          <span className="journal-row-summary">{e.ai_summary ?? 'Analyse en cours…'}</span>
          {expanded === e.id && (
            <div className="journal-row-detail">
              {e.ai_feedback && <p>{e.ai_feedback}</p>}
              {e.ai_facts.length > 0 && (
                <ul>
                  {e.ai_facts.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </button>
      ))}
    </div>
  )
}
