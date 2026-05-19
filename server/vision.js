const VISION_URL = 'https://vision.googleapis.com/v1/images:annotate';

export function hasVisionKey() {
  return Boolean(process.env.GOOGLE_VISION_API_KEY);
}

/**
 * Chama a Google Cloud Vision API (TEXT_DETECTION) com a imagem em base64
 * e devolve o texto detectado (ou string vazia se nada foi reconhecido).
 *
 * @param {string} base64 - imagem JPEG/PNG codificada em base64 (sem prefixo data:)
 * @returns {Promise<string>}
 */
export async function detectText(base64) {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_VISION_API_KEY não configurada no servidor');

  const resp = await fetch(`${VISION_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        {
          image: { content: base64 },
          features: [{ type: 'TEXT_DETECTION' }],
        },
      ],
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Vision API HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }

  const json = await resp.json();
  const apiError = json?.responses?.[0]?.error;
  if (apiError) {
    throw new Error(`Vision API erro: ${apiError.message ?? JSON.stringify(apiError)}`);
  }
  return json?.responses?.[0]?.fullTextAnnotation?.text ?? '';
}
