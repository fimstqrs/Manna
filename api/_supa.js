// Shared Supabase helpers for the server functions. Files starting with _ are not
// routes, so this is never reachable from the web on its own.
//
// Reads the names Vercel's Supabase integration sets, or the ones you add by hand.

// Lets the copy of Manna on GitHub Pages (fimstqrs.github.io) call these functions.
// Returns true when the request was a preflight check that has now been answered.
const PAGES_ORIGIN = /^https:\/\/fimstqrs\.github\.io$/i;
export function cors(req, res) {
  const o = req.headers.origin || '';
  if (PAGES_ORIGIN.test(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}

export function supaEnv() {
  const url = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
  const anon = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || '';
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
  return { url, anon, service, ready: !!(url && anon && service) };
}

// Older keys are JWTs and also go in Authorization; newer sb_ keys go in apikey only.
function keyHeaders(key, bearer) {
  const h = { apikey: key };
  if (bearer) h.authorization = 'Bearer ' + bearer;
  else if (key.startsWith('eyJ')) h.authorization = 'Bearer ' + key;
  return h;
}

export function bearer(req) {
  const a = String(req.headers.authorization || '');
  return a.startsWith('Bearer ') ? a.slice(7).trim() : '';
}

// Who is this token? Returns { id, email } or null.
export async function getUser(env, token) {
  if (!token || !env.ready) return null;
  const r = await fetch(env.url + '/auth/v1/user', { headers: keyHeaders(env.anon, token), signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const u = await r.json().catch(() => null);
  return u && u.id ? { id: u.id, email: u.email || '' } : null;
}

// Call a database function with the server's key.
export async function rpc(env, name, args) {
  const r = await fetch(env.url + '/rest/v1/rpc/' + name, {
    method: 'POST',
    headers: { ...keyHeaders(env.service), 'content-type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw Object.assign(new Error('rpc ' + name + ' ' + r.status), { status: r.status });
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

export async function deleteUser(env, id) {
  const r = await fetch(env.url + '/auth/v1/admin/users/' + encodeURIComponent(id), {
    method: 'DELETE', headers: keyHeaders(env.service), signal: AbortSignal.timeout(8000),
  });
  return r.ok;
}

// Make a new email-and-password account that is already confirmed. Returns { ok } or { ok:false, code }.
export async function createUser(env, email, password) {
  const r = await fetch(env.url + '/auth/v1/admin/users', {
    method: 'POST', headers: { ...keyHeaders(env.service), 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }), signal: AbortSignal.timeout(8000),
  });
  if (r.ok) return { ok: true };
  const j = await r.json().catch(() => ({}));
  const c = String(j.error_code || j.code || '') + ' ' + String(j.msg || j.message || '');
  if (r.status === 422 && /exist|registered/i.test(c)) return { ok: false, code: 'exists' };
  if (/weak|password/i.test(c)) return { ok: false, code: 'weak' };
  return { ok: false, code: 'failed' };
}

// A person's Manna username (or ''), looked up with the server key.
export async function usernameOf(env, id) {
  if (!env.ready || !id) return '';
  const r = await fetch(env.url + '/rest/v1/handles?select=username&id=eq.' + encodeURIComponent(id), {
    headers: keyHeaders(env.service), signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) return '';
  const j = await r.json().catch(() => []);
  return (Array.isArray(j) && j[0] && j[0].username) || '';
}
