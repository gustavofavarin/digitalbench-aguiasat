import { readJson, writeJson, hasStore } from './store.js';

const BASE_URL = 'https://api-gateway.dotelematics.com';
const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
// Com que frequência uma instância quente relê o Redis pra adotar o snapshot
// que o cron acabou de gravar. Tem que ser BEM menor que o intervalo do cron.
const STORE_REVALIDATE_MS = 20 * 1000;
const STORE_KEY = 'snapshot:dotelematics';
const STORE_TTL_SECONDS = 30 * 60;

let tokenCache = null; // { accessToken, refreshToken, expiresAt }
// Guarda registros já normalizados (formato getrak-like), não os docs crus —
// os docs do realtime são grandes demais para 10k+ rastreadores no Redis.
let snapshot = { veiculos: [], updatedAt: 0 };
let lastStoreCheck = 0; // quando lemos o Redis pela última vez (throttle)
let refreshPromise = null;

function getEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente ${name} não definida`);
  return v;
}

export function hasCredentials() {
  return Boolean(
    process.env.DOTELEMATICS_APIKEY &&
      process.env.DOTELEMATICS_USERNAME &&
      process.env.DOTELEMATICS_PASSWORD,
  );
}

function decodeJwtExp(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function loginFresh() {
  const apikey = getEnv('DOTELEMATICS_APIKEY');
  const email = getEnv('DOTELEMATICS_USERNAME');
  const password = getEnv('DOTELEMATICS_PASSWORD');

  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: {
      apikey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Falha no login DO Telematics (${res.status}): ${text}`);
  }
  const json = await res.json();
  const accessToken = json?.data?.access_token;
  const refreshToken = json?.data?.refresh_token;
  if (!accessToken) throw new Error('Resposta de login DO sem access_token');

  const exp = decodeJwtExp(accessToken);
  const expiresAt = exp ?? Date.now() + 6 * 24 * 60 * 60 * 1000;
  tokenCache = { accessToken, refreshToken, expiresAt: expiresAt - 60_000 };
  return tokenCache.accessToken;
}

async function refreshAccessToken() {
  if (!tokenCache?.refreshToken) return loginFresh();
  const apikey = getEnv('DOTELEMATICS_APIKEY');
  const res = await fetch(`${BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: {
      apikey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ refresh_token: tokenCache.refreshToken }),
  });
  if (!res.ok) {
    tokenCache = null;
    return loginFresh();
  }
  const json = await res.json();
  const accessToken = json?.data?.access_token;
  const refreshToken = json?.data?.refresh_token ?? tokenCache.refreshToken;
  if (!accessToken) {
    tokenCache = null;
    return loginFresh();
  }
  const exp = decodeJwtExp(accessToken);
  const expiresAt = exp ?? Date.now() + 6 * 24 * 60 * 60 * 1000;
  tokenCache = { accessToken, refreshToken, expiresAt: expiresAt - 60_000 };
  return tokenCache.accessToken;
}

async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.accessToken;
  if (tokenCache?.refreshToken) {
    try {
      return await refreshAccessToken();
    } catch {
      // fall through to fresh login
    }
  }
  return loginFresh();
}

async function authedGet(path, { retried = false } = {}) {
  const apikey = getEnv('DOTELEMATICS_APIKEY');
  const token = await getAccessToken();
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { apikey, Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (res.status === 401 && !retried) {
    tokenCache = null;
    return authedGet(path, { retried: true });
  }
  return res;
}

async function fetchRealtime() {
  const res = await authedGet('/tracking/realtime/v2');
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Falha no realtime DO (${res.status}): ${text}`);
  }
  const json = await res.json();
  return Array.isArray(json) ? json : [];
}

// Reconstrói a partir do provedor (operação cara) e grava no Redis. É o que o
// cron roda em background — nunca o usuário.
async function rebuildSnapshot() {
  const docs = await fetchRealtime();
  const veiculos = docs.map(mapDocToGetrakLike);
  snapshot = { veiculos, updatedAt: Date.now() };
  await writeJson(STORE_KEY, snapshot, { ttlSeconds: STORE_TTL_SECONDS });
  console.log(`[dotelematics snapshot] ${veiculos.length} trackers carregados em ${new Date().toISOString()}`);
  return snapshot;
}

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
      .catch((err) => console.error('[dotelematics bg refresh] erro:', err.message))
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

  // Revalida a partir do Redis no máx. uma vez a cada STORE_REVALIDATE_MS, em
  // vez de servir a cópia da memória por 5 min. Marca o horário ANTES do await
  // pra não martelar o Redis a cada busca.
  if (hasStore() && Date.now() - lastStoreCheck > STORE_REVALIDATE_MS) {
    lastStoreCheck = Date.now();
    await loadFromStore();
  }

  const stale = Date.now() - snapshot.updatedAt > SNAPSHOT_TTL_MS;
  const hasData = snapshot.veiculos.length > 0;

  if (!stale && hasData) return snapshot;

  if (stale && hasData) {
    startBackgroundRebuild(waitUntil);
    return snapshot;
  }

  if (refreshPromise) return refreshPromise;
  refreshPromise = rebuildSnapshot().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

// Usado pelo cron.
export async function rebuildAndStore() {
  if (!hasCredentials()) return null;
  return rebuildSnapshot();
}

function normalizeDigits(s) {
  return String(s ?? '').replace(/\D/g, '');
}

function mapDocToGetrakLike(doc) {
  const packet = doc?.packet ?? null;
  const did = String(doc?.did ?? '');
  const voltagem = packet?.VEHICLE_VOLTAGE != null ? Number(packet.VEHICLE_VOLTAGE) / 1000 : null;
  const lat = typeof packet?.LATITUDE === 'number' ? packet.LATITUDE : null;
  const lon = typeof packet?.LONGITUDE === 'number' ? packet.LONGITUDE : null;
  return {
    modulo: did,
    placa: doc?.vehicle?.plate?.trim() || null,
    id_veiculo: doc?.vehicle?._id ?? null,
    datastatus: packet?.GPS_TIME ?? packet?.SERVER_TIME ?? null,
    data: null,
    lat,
    lon,
    tensao_bateria: voltagem,
  };
}

export async function searchVehicles(query, { force = false, waitUntil } = {}) {
  if (!hasCredentials()) {
    throw new Error('Credenciais DO Telematics ausentes');
  }
  await ensureSnapshot({ force, waitUntil });
  const raw = String(query ?? '').trim();
  if (!raw) return { results: [], updatedAt: snapshot.updatedAt };

  const digits = normalizeDigits(raw);
  const lowered = raw.toLowerCase();

  const results = snapshot.veiculos.filter((v) => {
    const mod = normalizeDigits(v.modulo);
    if (digits) return Boolean(mod && mod.includes(digits));
    return String(v.placa ?? '').toLowerCase().includes(lowered);
  });

  return { results, updatedAt: snapshot.updatedAt };
}

export function getSnapshotInfo() {
  return { total: snapshot.veiculos.length, updatedAt: snapshot.updatedAt };
}

export async function preloadSnapshot() {
  if (!hasCredentials()) {
    console.log('[dotelematics] credenciais ausentes — fonte desativada');
    return;
  }
  try {
    await ensureSnapshot({ force: true });
  } catch (err) {
    console.error('[dotelematics preloadSnapshot] erro:', err.message);
  }
}
