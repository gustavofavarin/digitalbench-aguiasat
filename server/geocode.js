const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';

const cache = new Map();
const MAX_CACHE = 500;

function cacheKey(lat, lon) {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
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

  try {
    const res = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'teste-rastreador-getrak/1.0 (suporte@aguiasatsistemas.com.br)',
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const address = formatAddress(data);
    if (cache.size >= MAX_CACHE) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    cache.set(key, address);
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
