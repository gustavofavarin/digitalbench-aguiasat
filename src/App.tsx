import { useEffect, useRef, useState } from 'react'
import './App.css'
import logoUrl from './assets/logo.png'
import { ImeiCapture } from './components/ImeiCapture'
import { readImei, type ImeiReadResult } from './lib/imeiReader'

type Result = {
  id: string | null
  modulo: string | null
  placa: string | null
  apelido: string | null
  idVeiculo: number | string | null
  ultimaAtualizacao: string | null
  localizacao: string | null
  voltagem: number | null
  lat: number | null
  lon: number | null
  statusOnline: number | null
  fonte: string
}

type SearchResponse = {
  results: Result[]
  total: number
  truncated: boolean
  snapshotUpdatedAt: string | null
  warnings?: string[]
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

function buildCardText(r: Result) {
  const localizacao =
    r.localizacao ?? (r.lat != null ? `${r.lat}, ${r.lon}` : '—')
  return [
    `ID: ${r.id ?? '—'}`,
    `Atualização: ${formatDateTime(r.ultimaAtualizacao)}`,
    `Localização: ${localizacao}`,
    `Voltagem: ${formatVoltage(r.voltagem)}`,
  ].join('\n')
}

function App() {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<SearchResponse | null>(null)
  const [searched, setSearched] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [readingImage, setReadingImage] = useState(false)
  const [imeiResult, setImeiResult] = useState<ImeiReadResult | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function clearImage() {
    setImagePreview((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setImeiResult(null)
    setReadingImage(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function handleImageFile(file: File) {
    if (!file.type.startsWith('image/')) return
    if (imagePreview) URL.revokeObjectURL(imagePreview)
    const url = URL.createObjectURL(file)
    setImagePreview(url)
    setImeiResult(null)
    setReadingImage(true)
    try {
      const result = await readImei(file)
      setImeiResult(result)
      if (result.ok) {
        setQuery(result.value)
        // Quando a leitura é completa (15 dígitos + Luhn, sem aviso), busca já.
        // Com aviso, deixa o técnico conferir/completar antes.
        if (!result.warning) {
          void performSearch(result.value)
        } else {
          inputRef.current?.focus()
        }
      }
    } catch (err) {
      setImeiResult({
        ok: false,
        error: (err as Error).message || 'Falha ao processar a imagem.',
      })
    } finally {
      setReadingImage(false)
    }
  }

  function onInputPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const files = e.clipboardData?.files
    if (!files || files.length === 0) return
    const image = Array.from(files).find((f) => f.type.startsWith('image/'))
    if (!image) return
    e.preventDefault()
    void handleImageFile(image)
  }

  function onDragOver(e: React.DragEvent) {
    if (!e.dataTransfer?.types?.includes('Files')) return
    e.preventDefault()
    setDragOver(true)
  }

  function onDragLeave(e: React.DragEvent) {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    setDragOver(false)
  }

  function onDrop(e: React.DragEvent) {
    setDragOver(false)
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return
    const image = Array.from(files).find((f) => f.type.startsWith('image/'))
    if (!image) return
    e.preventDefault()
    void handleImageFile(image)
  }

  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) void handleImageFile(file)
  }

  useEffect(() => {
    return () => {
      if (imagePreview) URL.revokeObjectURL(imagePreview)
    }
  }, [imagePreview])

  async function copyCard(key: string, r: Result) {
    try {
      await navigator.clipboard.writeText(buildCardText(r))
      setCopiedKey(key)
      window.setTimeout(() => {
        setCopiedKey((current) => (current === key ? null : current))
      }, 1500)
    } catch {
      // ignore — clipboard pode estar indisponível
    }
  }

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  async function performSearch(rawQuery: string) {
    const q = rawQuery.trim()
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
        <div className="hero-text">
          <h1>Teste de Rastreador</h1>
          <p>ÁguiaSat Sistemas de Rastreamento.</p>
        </div>
        <img src={logoUrl} alt="ÁguiaSat" className="hero-logo" />
      </header>

      <form
        className={`search${dragOver ? ' drag-over' : ''}`}
        onSubmit={(e) => {
          e.preventDefault()
          void performSearch(query)
        }}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          placeholder="Digite o ID ou cole/arraste uma foto"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onPaste={onInputPaste}
          autoComplete="off"
          disabled={loading}
        />
        <button
          type="button"
          className="camera-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={loading || readingImage}
          aria-label="Ler etiqueta por imagem"
          title="Ler etiqueta por imagem"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#c1373c"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
            <circle cx="12" cy="13" r="3.5" />
            <circle cx="18" cy="9" r="0.5" fill="#c1373c" stroke="none" />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={onFilePicked}
          hidden
        />
        <button type="submit" disabled={loading || !query.trim()}>
          {loading ? 'Buscando…' : 'Buscar'}
        </button>
      </form>

      <ImeiCapture
        previewUrl={imagePreview}
        reading={readingImage}
        result={imeiResult}
        onClear={clearImage}
      />

      {error && <div className="alert error">{error}</div>}

      {!error && data && data.total === 0 && (
        <div className="alert warning">Nenhum rastreador encontrado.</div>
      )}

      {!error && data && (
        <div className="meta">
          {data.total > 0 && (
            <>
              {data.total} equipamento(s) encontrado(s)
              {data.truncated && ` — exibindo os ${data.results.length} primeiros`}
            </>
          )}
          {data.snapshotUpdatedAt && (
            <span className="snapshot">
              {data.total > 0 ? '· ' : ''}
              Dados atualizados em {formatDateTime(data.snapshotUpdatedAt)}
            </span>
          )}
          {data.warnings?.length ? (
            <div className="warnings">
              {data.warnings.map((w, i) => (
                <span key={i} className="warning">⚠ {w}</span>
              ))}
            </div>
          ) : null}
        </div>
      )}

      {!loading && !error && data && data.results.length > 0 && (
        <ul className="results">
          {data.results.map((r) => {
            const key = `${r.fonte}-${r.idVeiculo}-${r.modulo}`
            const isCopied = copiedKey === key
            const sourceClass =
              r.fonte === 'Getrak'
                ? 'badge badge-getrak'
                : r.fonte === 'DO Telematics'
                  ? 'badge badge-do'
                  : 'badge'
            return (
              <li key={key} className="card">
                <span className={sourceClass} title={`Fonte: ${r.fonte}`}>
                  {r.fonte}
                </span>
                <button
                  type="button"
                  className="copy-btn"
                  onClick={() => copyCard(key, r)}
                  aria-label="Copiar dados"
                  title={isCopied ? 'Copiado!' : 'Copiar dados'}
                >
                  {isCopied ? (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  )}
                </button>
                <div className="row">
                  <span className="label">ID</span>
                  <span className="value mono">{r.id ?? '—'}</span>
                </div>
                <div className="row">
                  <span className="label">Atualização</span>
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
            )
          })}
        </ul>
      )}

      {loading && (
        <div className="loading">
          <span className="spinner" aria-hidden="true" />
          Buscando na base de dados...
        </div>
      )}

      {!loading && !error && !data && searched === false && (
        <p className="hint">Digite o ID/IMEI (ou os últimos dígitos) e clique em Buscar.</p>
      )}
    </div>
  )
}

export default App