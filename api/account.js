// POST /api/account { email, password }: creates an account that is ready to use
// straight away (no confirmation email), so the app can sign the person in at once.
// DELETE /api/account with the person's sign-in token: permanently deletes their
// account and, through the database's cascade, their saved data and AI usage.
import { supaEnv, bearer, getUser, deleteUser, createUser, cors } from './_supa.js';

// A few new accounts per network per hour, so this can't be used to make accounts in bulk.
const MADE = new Map();
function tooMany(ip) {
  const now = Date.now(), L = (MADE.get(ip) || []).filter(t => now - t < 3600e3);
  if (L.length >= 5) { MADE.set(ip, L); return true; }
  L.push(now); MADE.set(ip, L);
  if (MADE.size > 5000) MADE.clear();
  return false;
}
function allowedOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try {
    const h = new URL(o).hostname;
    return h === req.headers.host?.split(':')[0] || h.endsWith('.vercel.app') && h.startsWith('manna') || h === 'fimstqrs.github.io' || h === 'localhost' || h === '127.0.0.1';
  } catch { return false; }
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader('cache-control', 'no-store');
  const env = supaEnv();
  if (req.method === 'POST') {
    if (!allowedOrigin(req)) return res.status(403).json({ ok: false, code: 'origin' });
    if (!env.ready) return res.status(503).json({ ok: false, code: 'noaccounts' });
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    const email = String(body?.email || '').trim().toLowerCase().slice(0, 200), password = String(body?.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, code: 'email' });
    if (password.length < 8 || password.length > 200) return res.status(400).json({ ok: false, code: 'weak' });
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    if (tooMany(ip)) return res.status(429).json({ ok: false, code: 'rate_limited' });
    const r = await createUser(env, email, password).catch(() => ({ ok: false, code: 'failed' }));
    return res.status(r.ok ? 200 : r.code === 'exists' ? 409 : r.code === 'weak' ? 400 : 502).json(r);
  }
  if (req.method !== 'DELETE') return res.status(405).json({ ok: false, code: 'method' });
  if (!env.ready) return res.status(503).json({ ok: false, code: 'noaccounts' });
  const user = await getUser(env, bearer(req)).catch(() => null);
  if (!user) return res.status(401).json({ ok: false, code: 'login' });
  const ok = await deleteUser(env, user.id).catch(() => false);
  return ok ? res.status(200).json({ ok: true }) : res.status(502).json({ ok: false, code: 'failed' });
}
