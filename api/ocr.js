import { detectText } from '../server/vision.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST.' });
    return;
  }

  const { image } = req.body ?? {};
  if (!image || typeof image !== 'string') {
    res.status(400).json({ error: 'Campo "image" (base64) é obrigatório.' });
    return;
  }

  try {
    const text = await detectText(image);
    res.status(200).json({ text });
  } catch (err) {
    console.error('[/api/ocr] falhou:', err);
    res.status(502).json({ error: err.message ?? 'Falha no OCR.' });
  }
}
