import { useEffect, useRef, useState } from 'react'
import {
  importCsv,
  fetchAspsps,
  connectBank,
  fetchBankConnections,
  disconnectBank,
  importBankTransactions,
  type Aspsp,
  type BankConnection,
} from '../api'
import { UploadIcon } from '../icons'

export function Import({ onImported }: { onImported?: () => void }) {
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File | undefined) {
    if (!file) return
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const result = await importCsv(file)
      setStatus(`${result.imported} transactions importées.`)
      onImported?.()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="import">
      <BankSyncCard onImported={onImported} />

      <div className="glass-card">
        <h2 className="section-title">Importer un relevé bancaire (CSV)</h2>
        <p className="import-hint">
          Exporte le relevé de ta banque au format CSV, puis dépose-le ici. Les colonnes date,
          libellé et montant (ou débit/crédit) sont détectées automatiquement.
        </p>

        <div
          className={dragOver ? 'dropzone dropzone--active' : 'dropzone'}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            handleFile(e.dataTransfer.files?.[0])
          }}
        >
          <UploadIcon size={28} />
          <span>{busy ? 'Import en cours…' : 'Clique ou dépose ton fichier CSV ici'}</span>
          <input
            ref={inputRef}
            type="file"
            accept=".csv"
            hidden
            onChange={(e) => {
              handleFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </div>

        {status && <div className="success">{status}</div>}
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  )
}

function BankSyncCard({ onImported }: { onImported?: () => void }) {
  const [connections, setConnections] = useState<BankConnection[] | null>(null)
  const [aspsps, setAspsps] = useState<Aspsp[] | null>(null)
  const [search, setSearch] = useState('')
  const [showPicker, setShowPicker] = useState(false)
  const [busyId, setBusyId] = useState<number | 'connect' | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchBankConnections().then(setConnections).catch((err) => setError((err as Error).message))

    const params = new URLSearchParams(window.location.search)
    const bankStatus = params.get('bank')
    if (bankStatus === 'connected') setNotice('Banque connectée avec succès.')
    else if (bankStatus === 'error') setError("La connexion à la banque a échoué. Réessaie.")
    if (bankStatus) {
      params.delete('bank')
      const rest = params.toString()
      window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''))
    }
  }, [])

  async function openPicker() {
    setShowPicker(true)
    setError(null)
    if (!aspsps) {
      try {
        setAspsps(await fetchAspsps('FR'))
      } catch (err) {
        setError((err as Error).message)
      }
    }
  }

  async function handleConnect(aspsp: Aspsp) {
    setBusyId('connect')
    setError(null)
    try {
      const { url } = await connectBank(aspsp.name, aspsp.country)
      window.location.href = url
    } catch (err) {
      setError((err as Error).message)
      setBusyId(null)
    }
  }

  async function handleImport(connectionId: number) {
    setBusyId(connectionId)
    setError(null)
    setNotice(null)
    try {
      const result = await importBankTransactions(connectionId)
      setNotice(`${result.imported} nouvelle(s) transaction(s) importée(s).`)
      onImported?.()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  async function handleDisconnect(connectionId: number) {
    setBusyId(connectionId)
    try {
      await disconnectBank(connectionId)
      setConnections((prev) => prev?.filter((c) => c.id !== connectionId) ?? null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusyId(null)
    }
  }

  const filteredAspsps = aspsps?.filter((a) => a.name.toLowerCase().includes(search.toLowerCase()))

  return (
    <div className="glass-card">
      <h2 className="section-title">Synchronisation bancaire automatique</h2>
      <p className="import-hint">
        Connecte ta banque une fois (accès lecture seule via Enable Banking, standard Open
        Banking/PSD2) pour récupérer tes transactions sans exporter de CSV.
      </p>

      {connections === null && <p className="pie-empty">Chargement…</p>}

      {connections && connections.length > 0 && (
        <ul className="habit-list">
          {connections.map((c) => (
            <li key={c.id} className="habit-row">
              <div className="goal-main">
                <span className="goal-title">{c.aspsp_name}</span>
                <span className="goal-meta">
                  {c.accounts.length} compte{c.accounts.length > 1 ? 's' : ''}
                  {c.valid_until ? ` · accès valide jusqu'au ${c.valid_until.slice(0, 10)}` : ''}
                </span>
              </div>
              <div className="race-row-actions">
                <button className="text-button" disabled={busyId === c.id} onClick={() => handleImport(c.id)}>
                  {busyId === c.id ? '…' : 'Importer'}
                </button>
                <button
                  className="text-button text-button--danger"
                  disabled={busyId === c.id}
                  onClick={() => handleDisconnect(c.id)}
                >
                  Déconnecter
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!showPicker && (
        <button className="primary-button" onClick={openPicker} style={{ marginTop: 12 }}>
          Connecter ma banque
        </button>
      )}

      {showPicker && (
        <div style={{ marginTop: 12 }}>
          <label className="field">
            <span>Rechercher ta banque (France)</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Ex : BNP, Revolut, Crédit Agricole…" autoFocus />
          </label>

          {!aspsps && !error && <p className="pie-empty">Chargement des banques…</p>}

          {filteredAspsps && (
            <ul className="habit-list" style={{ maxHeight: 260, overflowY: 'auto' }}>
              {filteredAspsps.slice(0, 30).map((a) => (
                <li key={`${a.name}-${a.country}`} className="habit-row">
                  <div className="goal-main">
                    <span className="goal-title">{a.name}</span>
                  </div>
                  <div className="race-row-actions">
                    <button className="text-button" disabled={busyId === 'connect'} onClick={() => handleConnect(a)}>
                      Connecter
                    </button>
                  </div>
                </li>
              ))}
              {filteredAspsps.length === 0 && <p className="pie-empty">Aucune banque trouvée.</p>}
            </ul>
          )}
        </div>
      )}

      {notice && <div className="success">{notice}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  )
}
