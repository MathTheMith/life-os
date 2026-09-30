import { useEffect, useState, type ComponentType } from 'react'
import { Chat } from './components/Chat'
import { Budget } from './components/Budget'
import { Import } from './components/Import'
import { Motorsport } from './components/Motorsport'
import { PlanningPage } from './components/Planning'
import { ProfilePage } from './components/Profile'
import { WatchPage } from './components/Watch'
import { MailsPage } from './components/Mails'
import { BankExpiryBanner } from './components/BankExpiryBanner'
import { Login } from './components/Login'
import { fetchAuthStatus, UNAUTHORIZED_EVENT } from './api'
import { GaugeIcon, CalendarIcon, ChatIcon, FlagIcon, UploadIcon, ArrowLeftIcon, UserIcon, RadarIcon } from './icons'
import './App.css'

type Tab = 'profile' | 'chat' | 'budget' | 'todo' | 'motorsport'

const TABS: { id: Tab; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { id: 'budget', label: 'Budget', icon: GaugeIcon },
  { id: 'motorsport', label: 'Motorsport', icon: FlagIcon },
  { id: 'todo', label: 'Planning', icon: CalendarIcon },
  { id: 'chat', label: 'Chat', icon: ChatIcon },
  { id: 'profile', label: 'Moi', icon: UserIcon },
]

const TAB_STORAGE_KEY = 'life-os-active-tab'

function loadInitialTab(): Tab {
  const stored = localStorage.getItem(TAB_STORAGE_KEY)
  return TABS.some((t) => t.id === stored) ? (stored as Tab) : 'budget'
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

function MainApp() {
  const [tab, setTab] = useState<Tab>(loadInitialTab)
  const [budgetKey, setBudgetKey] = useState(0)
  // Full-screen pages opened from the header, outside the dock tabs.
  const [overlay, setOverlay] = useState<'import' | 'watch' | null>(null)

  function selectTab(next: Tab) {
    setTab(next)
    localStorage.setItem(TAB_STORAGE_KEY, next)
  }

  if (overlay) {
    return (
      <div className="app-shell">
        <div className="ambient-glow ambient-glow--1" />
        <div className="ambient-glow ambient-glow--2" />

        <div className="app">
          <header className="app-header">
            <button className="icon-button" onClick={() => setOverlay(null)} aria-label="Retour">
              <ArrowLeftIcon size={18} />
            </button>
            <span className="app-header-title">{overlay === 'import' ? 'Importer' : 'Veille'}</span>
            <span className="app-header-spacer" />
          </header>

          <main className="app-content">
            <div className="app-scroll">
              {overlay === 'import' && <Import onImported={() => setBudgetKey((k) => k + 1)} />}
              {overlay === 'watch' && <RadarPage />}
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
          <button className="icon-button" onClick={() => setOverlay('watch')} aria-label="Veille">
            <RadarIcon size={18} />
          </button>
          <span className="app-header-title">Life OS</span>
          <button className="icon-button" onClick={() => setOverlay('import')} aria-label="Importer">
            <UploadIcon size={18} />
          </button>
        </header>

        <BankExpiryBanner onGoToImport={() => setOverlay('import')} />

        <main className="app-content">
          {/* Keying by tab gives each one its own fresh scroll container —
              no leftover scroll position from whatever was open before. */}
          <div className="app-scroll" key={tab}>
            {tab === 'chat' && <Chat />}
            {tab === 'budget' && <Budget key={budgetKey} />}
            {tab === 'motorsport' && <Motorsport />}
            {tab === 'todo' && <PlanningPage />}
            {tab === 'profile' && <ProfilePage />}
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
            </button>
          ))}
        </nav>
      </div>
    </div>
  )
}

// The header's radar page: what the watch found on the web, and the mails.
function RadarPage() {
  const [view, setView] = useState<'web' | 'mails'>('web')
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
