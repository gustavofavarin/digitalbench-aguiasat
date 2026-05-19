import { useEffect, useRef, useState } from 'react'
import './App.css'

type Result = {
  id: string | null
  modulo: string | null
  placa: string | null
  apelido: string | null
  idVeiculo: number | null
  ultimaAtualizacao: string | null
  localizacao: string | null
  voltagem: number | null
  lat: number | null
  lon: number | null
  statusOnline: number | null
}

type SearchResponse = {
  results: Result[]
  total: number
  truncated: boolean
  snapshotUpdatedAt: string
}

function formatDateTime(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatVoltage(v: number | null) {
  if (v == null) return '—'
  return `${Number(v).toFixed(2)} V`
}

function App() {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<SearchResponse | null>(null)
  const [searched, setSearched] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  async function runSearch(e?: React.FormEvent) {
    e?.preventDefault()
    const q = query.trim()
    if (!q) return

    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    setLoading(true)
    setError(null)
    setSearched(true)

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
        signal: ctrl.signal,
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error || `Erro ${res.status}`)
        setData(null)
      } else {
        setData(json as SearchResponse)
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      setError((err as Error).message || 'Erro de rede')
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="app">
      <header className="hero">
        <h1>Teste de Rastreador</h1>
        <p>Busca pelo ID/IMEI do equipamento.</p>
      </header>

      <form className="search" onSubmit={runSearch}>
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          placeholder="Digite o ID"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
          disabled={loading}
        />
        <button type="submit" disabled={loading || !query.trim()}>
          {loading ? 'Buscando…' : 'Buscar'}
        </button>
      </form>

      {error && <div className="alert error">{error}</div>}

      {!error && data && (
        <div className="meta">
          {data.total > 0 ? (
            <>
              {data.total} equipamento(s) encontrado(s)
              {data.truncated && ` — exibindo os ${data.results.length} primeiros`}
            </>
          ) : (
            'Nenhum equipamento encontrado.'
          )}
          {data.snapshotUpdatedAt && (
            <span className="snapshot">
              · Dados atualizados em {formatDateTime(data.snapshotUpdatedAt)}
            </span>
          )}
        </div>
      )}

      {!loading && !error && data && data.results.length > 0 && (
        <ul className="results">
          {data.results.map((r) => (
            <li key={`${r.idVeiculo}-${r.modulo}`} className="card">
              <div className="row">
                <span className="label">ID</span>
                <span className="value mono">{r.id ?? '—'}</span>
              </div>
              <div className="row">
                <span className="label">Última atualização</span>
                <span className="value">{formatDateTime(r.ultimaAtualizacao)}</span>
              </div>
              <div className="row">
                <span className="label">Localização</span>
                <span className="value">
                  {r.localizacao ?? (r.lat != null ? `${r.lat}, ${r.lon}` : '—')}
                </span>
              </div>
              <div className="row">
                <span className="label">Voltagem</span>
                <span className="value">{formatVoltage(r.voltagem)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {loading && <div className="loading">Consultando a Getrak…</div>}

      {!loading && !error && !data && searched === false && (
        <p className="hint">Digite o ID/IMEI (ou os últimos dígitos) e clique em Buscar.</p>
      )}
    </div>
  )
}

export default App