import { searchVehicles as searchGetrak } from './getrak.js';
import {
  searchVehicles as searchDoTelematics,
  hasCredentials as hasDoCredentials,
} from './dotelematics.js';
import { reverseGeocode } from './geocode.js';

const GEOCODE_CONCURRENCY = 1;
const MAX_RESULTS = 50;

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
    idVeiculo: v.id_veiculo ?? null,
    ultimaAtualizacao: parseTimestamp(v.datastatus) ?? parseTimestamp(v.data),
    voltagem: v.tensao_bateria ?? null,
    lat: hasCoords ? lat : null,
    lon: hasCoords ? lon : null,
    fonte,
  };
}

export async function runSearch({ q, force, waitUntil }) {
  const sources = [
    { fonte: 'Getrak', run: () => searchGetrak(q, { force, waitUntil }) },
  ];
  if (hasDoCredentials()) {
    sources.push({ fonte: 'DO Telematics', run: () => searchDoTelematics(q, { force, waitUntil }) });
  }

  const settled = await Promise.allSettled(sources.map((s) => s.run()));

  const warnings = [];
  const merged = [];
  let total = 0;

  settled.forEach((r, i) => {
    const { fonte } = sources[i];
    if (r.status === 'fulfilled') {
      const { results, total: fonteTotal } = r.value;
      total += fonteTotal ?? results.length;
      for (const v of results) merged.push(normalizeRaw(v, fonte));
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.error(`[search] ${fonte} falhou:`, msg);
      warnings.push(`Fonte ${fonte} indisponível: ${msg}`);
    }
  });

  if (settled.every((r) => r.status === 'rejected')) {
    return { ok: false, warnings };
  }

  merged.sort((a, b) => {
    const ta = a.ultimaAtualizacao ? new Date(a.ultimaAtualizacao).getTime() : 0;
    const tb = b.ultimaAtualizacao ? new Date(b.ultimaAtualizacao).getTime() : 0;
    return tb - ta;
  });

  const sliced = merged.slice(0, MAX_RESULTS);

  const results = await mapLimit(sliced, GEOCODE_CONCURRENCY, async (item) => {
    const localizacao =
      item.lat != null && item.lon != null
        ? await reverseGeocode(item.lat, item.lon)
        : null;
    return { ...item, localizacao };
  });

  return {
    ok: true,
    payload: {
      results,
      total,
      truncated: total > results.length,
      // Os dados vêm direto do provedor (ao vivo), então o instante da busca é
      // o momento da atualização exibido no topo.
      snapshotUpdatedAt: new Date().toISOString(),
      warnings,
    },
  };
}
