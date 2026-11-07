// DELETE /api/account with the person's sign-in token: permanently deletes their
// account and, through the database's cascade, their saved data and AI usage.
import { supaEnv, bearer, getUser, deleteUser } from './_supa.js';

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'DELETE') return res.status(405).json({ ok: false, code: 'method' });
  const env = supaEnv();
  if (!env.ready) return res.status(503).json({ ok: false, code: 'noaccounts' });
  const user = await getUser(env, bearer(req)).catch(() => null);
  if (!user) return res.status(401).json({ ok: false, code: 'login' });
  const ok = await deleteUser(env, user.id).catch(() => false);
  return ok ? res.status(200).json({ ok: true }) : res.status(502).json({ ok: false, code: 'failed' });
}
