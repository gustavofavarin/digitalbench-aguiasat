import 'dotenv/config';
import express from 'express';
import {
  getSnapshotInfo as getGetrakSnapshotInfo,
  preloadSnapshot as preloadGetrak,
} from './getrak.js';
import {
  getSnapshotInfo as getDoSnapshotInfo,
  preloadSnapshot as preloadDoTelematics,
} from './dotelematics.js';
import { detectText } from './vision.js';
import { runSearch, runLive } from './shared.js';

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// 10MB cobre imagens base64 (resize no cliente já limita a ~1.5MB).
app.use(express.json({ limit: '10mb' }));

app.post('/api/ocr', async (req, res) => {
  const { image } = req.body ?? {};
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ error: 'Campo "image" (base64) é obrigatório.' });
  }
  try {
    const text = await detectText(image);
    res.json({ text });
  } catch (err) {
    console.error('[/api/ocr] falhou:', err);
    res.status(502).json({ error: err.message ?? 'Falha no OCR.' });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    snapshots: {
      getrak: getGetrakSnapshotInfo(),
      dotelematics: getDoSnapshotInfo(),
    },
  });
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const force = req.query.force === '1' || req.query.force === 'true';

  if (!q) {
    return res.status(400).json({ error: 'Parâmetro "q" é obrigatório.' });
  }

  const result = await runSearch({ q, force });
  if (!result.ok) {
    return res.status(502).json({ error: 'Todas as fontes falharam.', warnings: result.warnings });
  }
  res.json(result.payload);
});

app.post('/api/live', async (req, res) => {
  const devices = req.body?.devices;
  const result = await runLive({ devices });
  res.json(result.payload);
});

app.listen(PORT, () => {
  console.log(`Backend rodando em http://localhost:${PORT}`);
  preloadGetrak();
  preloadDoTelematics();
});
