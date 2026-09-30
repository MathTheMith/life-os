import { useState } from 'react'
import { login } from '../api'

export function Login({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!password) return
    setSaving(true)
    setError(null)
    try {
      await login(password)
      onLoggedIn()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="app-shell">
      <div className="ambient-glow ambient-glow--1" />
      <div className="ambient-glow ambient-glow--2" />

      <div className="app">
        <header className="app-header">
          <span className="app-header-spacer" />
          <span className="app-header-title">Life OS</span>
          <span className="app-header-spacer" />
        </header>

        <main className="app-content">
          <div className="app-scroll">
            <div className="glass-card">
              <h2 className="section-title">Connexion</h2>
              <form onSubmit={handleSubmit} className="modal-form">
                <label className="field">
                  <span>Mot de passe</span>
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoFocus
                  />
                </label>

                {error && <div className="error">{error}</div>}

                <button type="submit" className="primary-button" disabled={saving}>
                  {saving ? 'Connexion…' : 'Se connecter'}
                </button>
              </form>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
