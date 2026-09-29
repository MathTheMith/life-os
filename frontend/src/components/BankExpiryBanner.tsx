import { useEffect, useState } from 'react'
import { fetchBankConnections, type BankConnection } from '../api'

const DISMISS_KEY = 'life-os-bank-expiry-dismissed-date'
const WARNING_DAYS = 5

function daysUntil(iso: string): number {
  const target = new Date(iso).getTime()
  const now = Date.now()
  return Math.ceil((target - now) / (24 * 60 * 60 * 1000))
}

export function BankExpiryBanner({ onGoToImport }: { onGoToImport: () => void }) {
  const [connections, setConnections] = useState<BankConnection[] | null>(null)
  const [dismissedToday, setDismissedToday] = useState(false)

  useEffect(() => {
    fetchBankConnections().then(setConnections).catch(() => setConnections([]))
    const today = new Date().toISOString().slice(0, 10)
    setDismissedToday(localStorage.getItem(DISMISS_KEY) === today)
  }, [])

  if (!connections || dismissedToday) return null

  const expiring = connections.filter((c) => c.valid_until && daysUntil(c.valid_until) <= WARNING_DAYS)
  if (expiring.length === 0) return null

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, new Date().toISOString().slice(0, 10))
    setDismissedToday(true)
  }

  return (
    <div className="expiry-banner">
      <div className="expiry-banner-text">
        {expiring.map((c) => {
          const days = daysUntil(c.valid_until as string)
          const when = days <= 0 ? "a expiré" : `expire dans ${days} jour${days > 1 ? 's' : ''}`
          return (
            <span key={c.id}>
              Accès à <strong>{c.aspsp_name}</strong> {when} — reconnecte-la.
            </span>
          )
        })}
      </div>
      <div className="expiry-banner-actions">
        <button className="text-button" onClick={onGoToImport}>
          Y aller
        </button>
        <button className="icon-button expiry-banner-close" onClick={dismiss} aria-label="Fermer pour aujourd'hui">
          ×
        </button>
      </div>
    </div>
  )
}
