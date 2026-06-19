import { rebuildAndStore as rebuildGetrak } from '../../server/getrak.js';
import {
  rebuildAndStore as rebuildDoTelematics,
  hasCredentials as hasDoCredentials,
} from '../../server/dotelematics.js';

// Alvo do Vercel Cron (ver vercel.json). Roda a cada poucos minutos e
// reconstrói os snapshots no Redis a partir dos provedores. É AQUI que se paga
// o custo pesado da paginação/realtime — assim a busca do usuário nunca paga.
export default async function handler(req, res) {
  // A Vercel envia "Authorization: Bearer ${CRON_SECRET}" quando CRON_SECRET
  // está definido. Bloqueia chamadas externas que não venham do scheduler.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers?.authorization || '';
    if (auth !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Não autorizado.' });
      return;
    }
  }

  const tasks = [{ fonte: 'Getrak', run: rebuildGetrak }];
  if (hasDoCredentials()) {
    tasks.push({ fonte: 'DO Telematics', run: rebuildDoTelematics });
  }

  const settled = await Promise.allSettled(tasks.map((t) => t.run()));

  const sources = {};
  settled.forEach((r, i) => {
    const { fonte } = tasks[i];
    if (r.status === 'fulfilled') {
      const snap = r.value;
      sources[fonte] = { ok: true, total: snap?.veiculos?.length ?? 0, updatedAt: snap?.updatedAt ?? null };
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.error(`[cron refresh] ${fonte} falhou:`, msg);
      sources[fonte] = { ok: false, error: msg };
    }
  });

  const anyOk = Object.values(sources).some((s) => s.ok);
  res.status(anyOk ? 200 : 502).json({ ok: anyOk, sources });
}
