import { useEffect, useState, type ComponentType } from 'react'
import { Chat } from './components/Chat'
import { Import } from './components/Import'
import { AgendaPage } from './components/Planning'
import { TodayPage } from './components/Today'
import { MePage, type MeSection } from './components/Me'
import { WatchPage } from './components/Watch'
import { MailsPage } from './components/Mails'
import { BankExpiryBanner } from './components/BankExpiryBanner'
import { Login } from './components/Login'
import { fetchAuthStatus, fetchWatchItems, fetchMails, UNAUTHORIZED_EVENT } from './api'
import { SunIcon, CalendarIcon, ChatIcon, ArrowLeftIcon, UserIcon, RadarIcon } from './icons'
import './App.css'

type Tab = 'today' | 'agenda' | 'radar' | 'chat'

const TABS: { id: Tab; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { id: 'today', label: "Aujourd'hui", icon: SunIcon },
  { id: 'agenda', label: 'Agenda', icon: CalendarIcon },
  { id: 'radar', label: 'Radar', icon: RadarIcon },
  { id: 'chat', label: 'Chat', icon: ChatIcon },
]

// Links from older notifications, and tabs that moved.
const TAB_ALIASES: Record<string, Tab> = { todo: 'today', planning: 'today', budget: 'today', motorsport: 'today', profile: 'today' }

const TAB_STORAGE_KEY = 'life-os-active-tab'

// Notifications open the app with ?tab=..., ?evening=1 (evening chat) or
// ?view=mails. Read once at startup, then cleared so a reload doesn't
// replay it.
const LAUNCH_PARAMS = new URLSearchParams(window.location.search)
if (window.location.search) window.history.replaceState(null, '', window.location.pathname)

function toTab(value: string | null): Tab | null {
  if (!value) return null
  if (TABS.some((t) => t.id === value)) return value as Tab
  return TAB_ALIASES[value] ?? null
}

function loadInitialTab(): Tab {
  if (LAUNCH_PARAMS.has('evening')) return 'chat'
  if (LAUNCH_PARAMS.get('view') === 'mails') return 'radar'
  return toTab(LAUNCH_PARAMS.get('tab')) ?? toTab(localStorage.getItem(TAB_STORAGE_KEY)) ?? 'today'
}

function App() {
  // null while the first /api/auth/me check is in flight.
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)

  useEffect(() => {
    fetchAuthStatus()
      .then(setAuthenticated)
      .catch(() => setAuthenticated(false))
    const onUnauthorized = () => setAuthenticated(false)
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])

  if (authenticated === null) return null
  if (!authenticated) return <Login onLoggedIn={() => setAuthenticated(true)} />
  return <MainApp />
}

type Overlay = { page: 'me'; section: MeSection | null } | { page: 'import' }

function MainApp() {
  const [tab, setTab] = useState<Tab>(loadInitialTab)
  const [budgetKey, setBudgetKey] = useState(0)
  // Pages outside the dock: the profile icon's page, and the import.
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  // A conversation to open when switching to the chat (question of the day).
  const [chatConversationId, setChatConversationId] = useState<number | undefined>(undefined)
  const [radarCount, setRadarCount] = useState(0)

  function selectTab(next: Tab) {
    setTab(next)
    localStorage.setItem(TAB_STORAGE_KEY, next)
  }

  // Badge on the Radar tab: offers and mails still to swipe.
  useEffect(() => {
    Promise.all([fetchWatchItems().catch(() => []), fetchMails().catch(() => [])]).then(([items, mails]) =>
      setRadarCount(
        items.filter((i) => i.status === 'new' || i.status === 'seen').length +
          mails.filter((m) => m.ai_status === 'done' && !m.user_rating).length,
      ),
    )
  }, [tab])

  if (overlay) {
    const back = () => setOverlay(overlay.page === 'import' ? { page: 'me', section: 'budget' } : null)
    return (
      <div className="app-shell">
        <div className="ambient-glow ambient-glow--1" />
        <div className="ambient-glow ambient-glow--2" />

        <div className="app">
          <header className="app-header">
            <button className="icon-button" onClick={back} aria-label="Retour">
              <ArrowLeftIcon size={18} />
            </button>
            <span className="app-header-title">{overlay.page === 'import' ? 'Importer' : 'Moi'}</span>
            <span className="app-header-spacer" />
          </header>

          <main className="app-content">
            <div className="app-scroll">
              {overlay.page === 'import' && <Import onImported={() => setBudgetKey((k) => k + 1)} />}
              {overlay.page === 'me' && (
                <MePage initialSection={overlay.section} budgetKey={budgetKey} onImport={() => setOverlay({ page: 'import' })} />
              )}
            </div>
          </main>
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <div className="ambient-glow ambient-glow--1" />
      <div className="ambient-glow ambient-glow--2" />

      <div className={tab === 'chat' ? 'app app--wide' : 'app'}>
        <header className="app-header">
          <span className="app-header-spacer" />
          <span className="app-header-title">Life OS</span>
          <button className="icon-button" onClick={() => setOverlay({ page: 'me', section: null })} aria-label="Moi">
            <UserIcon size={18} />
          </button>
        </header>

        <BankExpiryBanner onGoToImport={() => setOverlay({ page: 'import' })} />

        <main className="app-content">
          {/* Keying by tab gives each one its own fresh scroll container —
              no leftover scroll position from whatever was open before. */}
          <div className="app-scroll" key={tab}>
            {tab === 'today' && (
              <TodayPage
                onOpenAgenda={() => selectTab('agenda')}
                onOpenBudget={() => setOverlay({ page: 'me', section: 'budget' })}
                onAnswer={(id) => {
                  setChatConversationId(id)
                  selectTab('chat')
                }}
              />
            )}
            {tab === 'agenda' && <AgendaPage />}
            {tab === 'radar' && <RadarPage initialView={LAUNCH_PARAMS.get('view') === 'mails' ? 'mails' : 'web'} />}
            {tab === 'chat' && <Chat openEvening={LAUNCH_PARAMS.has('evening')} openConversationId={chatConversationId} />}
          </div>
        </main>

        <nav className="dock">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={tab === id ? 'dock-item dock-item--active' : 'dock-item'}
              onClick={() => selectTab(id)}
            >
              <Icon size={20} />
              <span>{label}</span>
              {id === 'radar' && radarCount > 0 && <span className="dock-badge">{radarCount > 99 ? '99+' : radarCount}</span>}
            </button>
          ))}
        </nav>
      </div>
    </div>
  )
}

// The Radar tab: what the watch found on the web, and the mails.
function RadarPage({ initialView }: { initialView: 'web' | 'mails' }) {
  const [view, setView] = useState<'web' | 'mails'>(initialView)
  return (
    <div className="radar-page">
      <div className="segmented radar-switch">
        <button
          className={view === 'web' ? 'segmented-option segmented-option--active' : 'segmented-option'}
          onClick={() => setView('web')}
        >
          Internet
        </button>
        <button
          className={view === 'mails' ? 'segmented-option segmented-option--active' : 'segmented-option'}
          onClick={() => setView('mails')}
        >
          Mails
        </button>
      </div>
      {view === 'web' ? <WatchPage /> : <MailsPage />}
    </div>
  )
}

export default App
