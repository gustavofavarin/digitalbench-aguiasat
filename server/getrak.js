import { readJson, writeJson, hasStore } from './store.js';

const TOKEN_URL = 'https://api.getrak.com/newkoauth/oauth/token';
const LOCATIONS_URL = 'https://api.getrak.com/v0.1/localizacoes';
const PER_PAGE = 500;
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const STORE_KEY = 'snapshot:getrak';
// O snapshot fica no Redis com TTL maior que o do cron; assim, se o cron
// falhar por um ciclo, a busca ainda encontra dados (stale) em vez de ter
// que reconstruir do provedor no caminho do usuário.
const STORE_TTL_SECONDS = 30 * 60;

let tokenCache = null;
let snapshot = { veiculos: [], updatedAt: 0 };
let refreshPromise = null;


function getEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente ${name} não definida`);
  return v;
}

async function fetchNewToken() {
  const apiKey = getEnv('GETRAK_API_KEY');
  const username = getEnv('GETRAK_USERNAME');
  const password = getEnv('GETRAK_PASSWORD');

  const form = new FormData();
  form.append('grant_type', 'password');
  form.append('username', username);
  form.append('password', password);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Falha ao obter token Getrak (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Resposta da Getrak sem access_token');
  }

  const expiresInMs = (Number(data.expires_in) || 3600) * 1000;
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + expiresInMs - 60_000,
  };
  return tokenCache.token;
}

async function getToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;
  return fetchNewToken();
}

async function authedFetch(url, { retried = false } = {}) {
  const token = await getToken();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (res.status === 401 && !retried) {
    tokenCache = null;
    return authedFetch(url, { retried: true });
  }
  return res;
}

async function fetchLocationsPage(page) {
  const url = new URL(LOCATIONS_URL);
  url.searchParams.set('per_page', String(PER_PAGE));
  url.searchParams.set('page', String(page));

  const res = await authedFetch(url.toString());
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Falha ao listar localizações página ${page} (${res.status}): ${text}`);
  }
  const data = await res.json();
  return {
    veiculos: Array.isArray(data?.veiculos) ? data.veiculos : [],
    total: Number(data?.total) || 0,
    pages: Number(data?.pages) || 0,
  };
}

// Mantém só os campos usados pela busca e pela normalização (shared.js).
// O payload cru do Getrak é grande demais para guardar 10k+ registros no Redis.
function trimVeiculo(v) {
  return {
    modulo: v.modulo ?? null,
    placa: v.placa ?? null,
    id_veiculo: v.id_veiculo ?? null,
    datastatus: v.datastatus ?? null,
    data: v.data ?? null,
    tensao_bateria: v.tensao_bateria ?? null,
    lat: v.lat ?? null,
    lon: v.lon ?? null,
  };
}

// Reconstrói o snapshot a partir do provedor (operação cara: pagina toda a
// base). É isso que o cron roda em background — nunca o usuário.
async function rebuildSnapshot() {
  const first = await fetchLocationsPage(1);
  const totalPages = Math.max(1, Math.ceil(first.total / PER_PAGE));

  const veiculos = first.veiculos.map(trimVeiculo);

  if (totalPages > 1) {
    const concurrency = 5;
    const remaining = [];
    for (let p = 2; p <= totalPages; p++) remaining.push(p);

    while (remaining.length) {
      const batch = remaining.splice(0, concurrency);
      const results = await Promise.all(batch.map((p) => fetchLocationsPage(p)));
      for (const r of results) for (const v of r.veiculos) veiculos.push(trimVeiculo(v));
    }
  }

  snapshot = { veiculos, updatedAt: Date.now() };
  await writeJson(STORE_KEY, snapshot, { ttlSeconds: STORE_TTL_SECONDS });
  console.log(`[snapshot] ${veiculos.length} veículos carregados em ${new Date().toISOString()}`);
  return snapshot;
}

// Adota no processo o snapshot que está no Redis, se for mais novo que o
// que temos em memória. Leitura rápida (~ms) — é o que substitui a
// reconstrução de 15s quando a instância acorda fria.
async function loadFromStore() {
  const stored = await readJson(STORE_KEY);
  if (stored && Array.isArray(stored.veiculos) && stored.updatedAt > snapshot.updatedAt) {
    snapshot = stored;
  }
  return snapshot;
}

function startBackgroundRebuild(waitUntil) {
  if (!refreshPromise) {
    refreshPromise = rebuildSnapshot()
      .catch((err) => console.error('[snapshot bg refresh] erro:', err.message))
      .finally(() => {
        refreshPromise = null;
      });
  }
  if (typeof waitUntil === 'function') waitUntil(refreshPromise);
  return refreshPromise;
}

async function ensureSnapshot({ force = false, waitUntil } = {}) {
  if (force) {
    if (refreshPromise) return refreshPromise;
    refreshPromise = rebuildSnapshot().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  // Memória fria/velha? Tenta o Redis primeiro (leitura barata).
  if (hasStore() && Date.now() - snapshot.updatedAt > SNAPSHOT_TTL_MS) {
    await loadFromStore();
  }

  const stale = Date.now() - snapshot.updatedAt > SNAPSHOT_TTL_MS;
  const hasData = snapshot.veiculos.length > 0;

  // Cache fresco — devolve direto.
  if (!stale && hasData) return snapshot;

  // Stale-while-revalidate: tem dados (velhos) — devolve já e atualiza em
  // background. O cron é o caminho principal de atualização; isto é só uma
  // rede de segurança caso o cron falhe.
  if (stale && hasData) {
    startBackgroundRebuild(waitUntil);
    return snapshot;
  }

  // Não há nada em lugar nenhum (bootstrap) — precisa esperar a 1ª carga.
  if (refreshPromise) return refreshPromise;
  refreshPromise = rebuildSnapshot().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

// Usado pelo cron: força a reconstrução a partir do provedor e grava no Redis.
export async function rebuildAndStore() {
  return rebuildSnapshot();
}

function normalizeDigits(s) {
  return String(s ?? '').replace(/\D/g, '');
}

export async function searchVehicles(query, { force = false, waitUntil } = {}) {
  await ensureSnapshot({ force, waitUntil });
  const raw = String(query ?? '').trim();
  if (!raw) return { results: [], updatedAt: snapshot.updatedAt };

  const digits = normalizeDigits(raw);
  const lowered = raw.toLowerCase();

  const results = snapshot.veiculos.filter((v) => {
    const mod = normalizeDigits(v.modulo);
    if (digits && mod.includes(digits)) return true;
    if (!digits && String(v.placa ?? '').toLowerCase().includes(lowered)) return true;
    return false;
  });

  return { results, updatedAt: snapshot.updatedAt };
}

export function getSnapshotInfo() {
  return { total: snapshot.veiculos.length, updatedAt: snapshot.updatedAt };
}

export async function preloadSnapshot() {
  try {
    await ensureSnapshot({ force: true });
  } catch (err) {
    console.error('[preloadSnapshot] erro:', err.message);
  }
}
