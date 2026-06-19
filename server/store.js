import { gzipSync, gunzipSync } from 'node:zlib';

// Armazenamento externo (Upstash Redis / Vercel KV) para persistir os snapshots
// FORA da memória do processo. Na Vercel, a instância serverless é reciclada
// após alguns minutos de ociosidade e toda variável de módulo é apagada — por
// isso o cache em memória "esfriava" e a primeira busca voltava a demorar 15s.
//
// Aceita tanto as variáveis do Upstash direto quanto as que a integração
// Vercel KV injeta (KV_REST_API_*). Se nenhuma estiver presente (ex.: dev
// local sem Redis), getStore() devolve null e os callers caem no fluxo antigo
// em memória — nada quebra.

const URL =
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || null;
const TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || null;

let clientPromise = null;

async function getStore() {
  if (!URL || !TOKEN) return null;
  if (!clientPromise) {
    clientPromise = import('@upstash/redis')
      .then(({ Redis }) => new Redis({ url: URL, token: TOKEN, automaticDeserialization: false }))
      .catch((err) => {
        console.error('[store] falha ao iniciar Upstash Redis:', err.message);
        clientPromise = null;
        return null;
      });
  }
  return clientPromise;
}

export function hasStore() {
  return Boolean(URL && TOKEN);
}

// Comprime o JSON antes de gravar. Snapshots de 10k+ veículos viram vários MB
// em texto puro (acima do limite de payload do REST); gzip+base64 reduz para
// algumas centenas de KB porque os registros são muito repetitivos.
function encode(value) {
  return gzipSync(Buffer.from(JSON.stringify(value), 'utf8')).toString('base64');
}

function decode(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(gunzipSync(Buffer.from(raw, 'base64')).toString('utf8'));
  } catch (err) {
    console.error('[store] falha ao decodificar valor:', err.message);
    return null;
  }
}

export async function readJson(key) {
  const store = await getStore();
  if (!store) return null;
  try {
    const raw = await store.get(key);
    return decode(raw);
  } catch (err) {
    console.error(`[store] falha ao ler "${key}":`, err.message);
    return null;
  }
}

export async function writeJson(key, value, { ttlSeconds } = {}) {
  const store = await getStore();
  if (!store) return false;
  try {
    const encoded = encode(value);
    if (ttlSeconds) await store.set(key, encoded, { ex: ttlSeconds });
    else await store.set(key, encoded);
    return true;
  } catch (err) {
    console.error(`[store] falha ao gravar "${key}":`, err.message);
    return false;
  }
}
