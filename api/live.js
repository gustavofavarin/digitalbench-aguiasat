import { runLive } from '../server/shared.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Método não permitido.' });
    return;
  }

  const devices = req.body?.devices;
  const result = await runLive({ devices });
  res.status(200).json(result.payload);
}
