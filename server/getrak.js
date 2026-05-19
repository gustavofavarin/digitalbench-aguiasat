const TOKEN_URL = 'https://api.getrak.com/newkoauth/oauth/token';
const LOCATIONS_URL = 'https://api.getrak.com/v0.1/localizacoes';
const PER_PAGE = 500;
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;

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

async function refreshSnapshot() {
  const first = await fetchLocationsPage(1);
  const totalPages = Math.max(1, Math.ceil(first.total / PER_PAGE));

  const veiculos = [...first.veiculos];

  if (totalPages > 1) {
    const concurrency = 5;
    const remaining = [];
    for (let p = 2; p <= totalPages; p++) remaining.push(p);

    while (remaining.length) {
      const batch = remaining.splice(0, concurrency);
      const results = await Promise.all(batch.map((p) => fetchLocationsPage(p)));
      for (const r of results) veiculos.push(...r.veiculos);
    }
  }

  snapshot = { veiculos, updatedAt: Date.now() };
  console.log(`[snapshot] ${veiculos.length} veículos carregados em ${new Date().toISOString()}`);
  return snapshot;
}

async function ensureSnapshot({ force = false } = {}) {
  const stale = Date.now() - snapshot.updatedAt > SNAPSHOT_TTL_MS;
  if (!force && !stale && snapshot.veiculos.length) return snapshot;
  if (refreshPromise) return refreshPromise;
  refreshPromise = refreshSnapshot().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

function normalizeDigits(s) {
  return String(s ?? '').replace(/\D/g, '');
}

export async function searchVehicles(query, { force = false } = {}) {
  await ensureSnapshot({ force });
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
