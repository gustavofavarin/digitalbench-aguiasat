import 'dotenv/config';
import express from 'express';
import { searchVehicles, getSnapshotInfo, preloadSnapshot } from './getrak.js';
import { reverseGeocode } from './geocode.js';

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(express.json());

function parseTimestamp(raw) {
  if (!raw) return null;
  const dateStr = typeof raw === 'string' ? raw : raw.date;
  if (!dateStr) return null;
  const iso = dateStr.replace(' ', 'T');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function stripIdPrefix(modulo) {
  if (!modulo) return null;
  return String(modulo).replace(/^ID/i, '');
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, snapshot: getSnapshotInfo() });
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const force = req.query.force === '1' || req.query.force === 'true';

  if (!q) {
    return res.status(400).json({ error: 'Parâmetro "q" é obrigatório.' });
  }

  try {
    const { results: matches, updatedAt } = await searchVehicles(q, { force });

    const results = await Promise.all(
      matches.slice(0, 50).map(async (v) => {
        const lat = typeof v.lat === 'number' ? v.lat : Number(v.lat);
        const lon = typeof v.lon === 'number' ? v.lon : Number(v.lon);
        const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);

        const localizacao = hasCoords ? await reverseGeocode(lat, lon) : null;

        return {
          id: stripIdPrefix(v.modulo),
          modulo: v.modulo ?? null,
          placa: v.placa ?? null,
          apelido: v.apelido ?? null,
          idVeiculo: v.id_veiculo ?? null,
          ultimaAtualizacao: parseTimestamp(v.datastatus) ?? parseTimestamp(v.data),
          localizacao,
          voltagem: v.tensao_bateria ?? null,
          lat: hasCoords ? lat : null,
          lon: hasCoords ? lon : null,
          statusOnline: v.status_online ?? null,
        };
      })
    );

    res.json({
      results,
      total: matches.length,
      truncated: matches.length > results.length,
      snapshotUpdatedAt: new Date(updatedAt).toISOString(),
    });
  } catch (err) {
    console.error('[/api/search] erro:', err);
    res.status(500).json({ error: err.message || 'Erro interno.' });
  }
});

app.listen(PORT, () => {
  console.log(`Backend Getrak rodando em http://localhost:${PORT}`);
  preloadSnapshot();
});
