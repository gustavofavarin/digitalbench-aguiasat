import type { ImeiReadResult } from '../lib/imeiReader'

interface Props {
  previewUrl: string | null
  reading: boolean
  result: ImeiReadResult | null
  onClear: () => void
}

export function ImeiCapture({ previewUrl, reading, result, onClear }: Props) {
  if (!previewUrl) return null

  return (
    <div className="imei-capture">
      <img src={previewUrl} alt="Etiqueta" className="imei-thumb" />
      <div className="imei-info">
        {reading && <div className="imei-status">Lendo etiqueta…</div>}

        {!reading && result?.ok && (
          <>
            <div className="imei-source">Leitura concluída.</div>
            {result.warning && <div className="imei-warning">⚠ {result.warning}</div>}
          </>
        )}

        {!reading && result && !result.ok && (
          <div className="imei-error">{result.error}</div>
        )}

        <button type="button" className="imei-clear" onClick={onClear}>
          Remover imagem
        </button>
      </div>
    </div>
  )
}
