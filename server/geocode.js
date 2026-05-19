import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
const MIN_INTERVAL_MS = 1100;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'geocode.json');

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
      return new Map(Object.entries(JSON.parse(raw)));
    }
  } catch (err) {
    console.error('[geocode] falha ao ler cache em disco:', err.message);
  }
  return new Map();
}

const cache = loadCache();
let saveTimer = null;

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const obj = Object.fromEntries(cache);
      fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
    } catch (err) {
      console.error('[geocode] falha ao salvar cache:', err.message);
    }
  }, 2000);
}

function cacheKey(lat, lon) {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

let lastRequestAt = 0;
let queue = Promise.resolve();

function throttledFetch(url, opts) {
  const run = async () => {
    const wait = Math.max(0, lastRequestAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    return fetch(url, opts);
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

export async function reverseGeocode(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;

  const key = cacheKey(lat, lon);
  if (cache.has(key)) return cache.get(key);

  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('format', 'json');
  url.searchParams.set('accept-language', 'pt-BR');
  url.searchParams.set('zoom', '18');

  const contact = process.env.NOMINATIM_CONTACT;
  if (!contact) {
    console.warn('[geocode] NOMINATIM_CONTACT não definido no .env — Nominatim pode bloquear o pedido');
  }
  const userAgent = `teste-rastreador/1.0 (${contact || 'contato@example.com'})`;

  try {
    const res = await throttledFetch(url.toString(), {
      headers: {
        'User-Agent': userAgent,
      },
    });
    if (!res.ok) {
      if (res.status === 429) {
        console.warn('[geocode] Nominatim 429 (rate limit) — aumente o intervalo ou troque o provedor');
      }
      return null;
    }
    const data = await res.json();
    const address = formatAddress(data);
    cache.set(key, address);
    scheduleSave();
    return address;
  } catch {
    return null;
  }
}

function formatAddress(data) {
  if (!data) return null;
  if (data.display_name) {
    const a = data.address || {};
    const street = a.road || a.pedestrian || a.cycleway || a.footway || '';
    const number = a.house_number ? `, ${a.house_number}` : '';
    const city = a.city || a.town || a.village || a.municipality || '';
    const state = a.state_code || a.state || '';
    const postcode = a.postcode || '';
    const country = a.country || '';

    const parts = [];
    if (street) parts.push(`${street}${number}`);
    if (city) parts.push(state ? `${city} - ${state}` : city);
    else if (state) parts.push(state);
    if (postcode) parts.push(postcode);
    if (country) parts.push(country);

    return parts.length ? parts.join(', ') : data.display_name;
  }
  return null;
}
