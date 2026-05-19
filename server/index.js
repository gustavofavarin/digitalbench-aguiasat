import 'dotenv/config';
import express from 'express';
import {
  searchVehicles as searchGetrak,
  getSnapshotInfo as getGetrakSnapshotInfo,
  preloadSnapshot as preloadGetrak,
} from './getrak.js';
import {
  searchVehicles as searchDoTelematics,
  getSnapshotInfo as getDoSnapshotInfo,
  preloadSnapshot as preloadDoTelematics,
  hasCredentials as hasDoCredentials,
} from './dotelematics.js';
import { reverseGeocode } from './geocode.js';
import { detectText } from './vision.js';

const app = express();
const PORT = Number(process.env.PORT) || 3001;
const GEOCODE_CONCURRENCY = 1;

// 10MB cobre imagens base64 (resize no cliente já limita a ~1.5MB).
app.use(express.json({ limit: '10mb' }));

function parseTimestamp(raw) {
  if (!raw) return null;
  const dateStr = typeof raw === 'string' ? raw : raw.date;
  if (!dateStr) return null;
  let iso = dateStr.replace(' ', 'T');
  // Getrak devolve "YYYY-MM-DD HH:mm:ss" sem fuso; é horário de Brasília.
  // Sem isso, `new Date` interpreta no TZ do servidor — em UTC (Vercel) dava 3h a menos.
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso)) iso += '-03:00';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function stripIdPrefix(modulo) {
  if (!modulo) return null;
  return String(modulo).replace(/^ID/i, '');
}

async function mapLimit(items, limit, mapper) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await mapper(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function normalizeRaw(v, fonte) {
  const lat = typeof v.lat === 'number' ? v.lat : Number(v.lat);
  const lon = typeof v.lon === 'number' ? v.lon : Number(v.lon);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);
  return {
    id: stripIdPrefix(v.modulo),
    modulo: v.modulo ?? null,
    placa: v.placa ?? null,
    apelido: v.apelido ?? null,
    idVeiculo: v.id_veiculo ?? null,
    ultimaAtualizacao: parseTimestamp(v.datastatus) ?? parseTimestamp(v.data),
    voltagem: v.tensao_bateria ?? null,
    lat: hasCoords ? lat : null,
    lon: hasCoords ? lon : null,
    statusOnline: v.status_online ?? null,
    fonte,
  };
}

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

  const sources = [
    { fonte: 'Getrak', run: () => searchGetrak(q, { force }) },
  ];
  if (hasDoCredentials()) {
    sources.push({ fonte: 'DO Telematics', run: () => searchDoTelematics(q, { force }) });
  }

  const settled = await Promise.allSettled(sources.map((s) => s.run()));

  const warnings = [];
  const snapshotTimestamps = [];
  let merged = [];

  settled.forEach((r, i) => {
    const { fonte } = sources[i];
    if (r.status === 'fulfilled') {
      const { results, updatedAt } = r.value;
      if (updatedAt) snapshotTimestamps.push(updatedAt);
      for (const v of results) merged.push(normalizeRaw(v, fonte));
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.error(`[/api/search] ${fonte} falhou:`, msg);
      warnings.push(`Fonte ${fonte} indisponível: ${msg}`);
    }
  });

  if (settled.every((r) => r.status === 'rejected')) {
    return res
      .status(502)
      .json({ error: 'Todas as fontes falharam.', warnings });
  }

  merged.sort((a, b) => {
    const ta = a.ultimaAtualizacao ? new Date(a.ultimaAtualizacao).getTime() : 0;
    const tb = b.ultimaAtualizacao ? new Date(b.ultimaAtualizacao).getTime() : 0;
    return tb - ta;
  });

  const sliced = merged.slice(0, 50);

  const results = await mapLimit(sliced, GEOCODE_CONCURRENCY, async (item) => {
    const localizacao =
      item.lat != null && item.lon != null
        ? await reverseGeocode(item.lat, item.lon)
        : null;
    return { ...item, localizacao };
  });

  const snapshotUpdatedAt = snapshotTimestamps.length
    ? new Date(Math.max(...snapshotTimestamps)).toISOString()
    : null;

  res.json({
    results,
    total: merged.length,
    truncated: merged.length > results.length,
    snapshotUpdatedAt,
    warnings,
  });
});

app.listen(PORT, () => {
  console.log(`Backend rodando em http://localhost:${PORT}`);
  preloadGetrak();
  preloadDoTelematics();
});
