// Reminders (web push). Version 159.
//   GET  /api/push                -> { ready, key } the public key phones subscribe with
//   POST /api/push   {sub, morning, evening, tz}  -> saves this phone's subscription
//   DELETE /api/push {endpoint}   -> stops reminders for this phone
//   GET  /api/push?run=morning|evening  -> called by Vercel Cron; sends today's reminders once
//
// No extra packages: the VAPID signature and the message encryption (RFC 8291, aes128gcm)
// are done with Node's own crypto. The signing key is derived from a server secret, so no
// new secret has to be added. Set VAPID_SECRET to use a dedicated one instead.
import crypto from 'node:crypto';
import { supaEnv, bearer, getUser, cors } from './_supa.js';

const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function vapid() {
  const env = supaEnv();
  const secret = process.env.VAPID_SECRET || env.service;
  if (!secret) return null;
  const d = crypto.createHmac('sha256', secret).update('manna-vapid-v1').digest();
  const ec = crypto.createECDH('prime256v1');
  ec.setPrivateKey(d);
  const pub = ec.getPublicKey(); // 65 bytes, uncompressed
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
  return { pub, key };
}

// Only the real push services, so this can never be used to make the server call other sites.
const PUSH_HOST = /(^|\.)(fcm\.googleapis\.com|push\.apple\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.api\.chromium\.org)$/i;
function goodSub(s) {
  try {
    const u = new URL(s.endpoint);
    if (u.protocol !== 'https:' || !PUSH_HOST.test(u.hostname)) return false;
    return unb64u(s.keys.p256dh).length === 65 && unb64u(s.keys.auth).length === 16;
  } catch { return false; }
}

function encrypt(sub, payload) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = crypto.createECDH('prime256v1'); as.generateKeys();
  const asPub = as.getPublicKey();
  const shared = as.computeSecret(uaPub);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head, 0); head.writeUInt32BE(4096, 16); head.writeUInt8(65, 20);
  return Buffer.concat([head, asPub, body]);
}

async function send(v, sub, msg) {
  const aud = new URL(sub.endpoint).origin;
  const jh = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const jc = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:themorningfallcorp@gmail.com' }));
  const sig = crypto.sign('sha256', Buffer.from(jh + '.' + jc), { key: v.key, dsaEncoding: 'ieee-p1363' });
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { authorization: 'vapid t=' + jh + '.' + jc + '.' + b64u(sig) + ', k=' + b64u(v.pub), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '21600', urgency: 'normal' },
    body: encrypt(sub, JSON.stringify(msg)),
    signal: AbortSignal.timeout(8000),
  });
  return r.status;
}

function rest(env, path, opt = {}) {
  const k = env.service, h = { apikey: k, 'content-type': 'application/json', ...(opt.headers || {}) };
  if (k.startsWith('eyJ')) h.authorization = 'Bearer ' + k;
  return fetch(env.url + '/rest/v1/' + path, { ...opt, headers: h, signal: AbortSignal.timeout(8000) });
}

const MSG = {
  morning: { title: 'Good morning ☀️', body: 'Your verse for today is ready. Take a minute with it before the day starts.', url: '/#scripture', tag: 'manna-morning' },
  evening: { title: 'How did today go?', body: 'Log what you ate and any workout, so your streak and targets stay right.', url: '/#eat', tag: 'manna-evening' },
};

async function run(env, v, slot, res) {
  // Send each slot once a day, even if this address is called more than once.
  const day = new Date().toISOString().slice(0, 10);
  const claim = await rest(env, 'push_runs', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ day, slot }) });
  if (claim.status === 409) return res.status(200).json({ ok: true, skipped: 'already sent today' });
  if (!claim.ok) return res.status(503).json({ ok: false, code: 'db' });
  const r = await rest(env, 'push_subs?select=endpoint,sub&' + slot + '=eq.true&limit=5000');
  const rows = r.ok ? await r.json() : [];
  let sent = 0, gone = [];
  for (let i = 0; i < rows.length; i += 20) {
    await Promise.all(rows.slice(i, i + 20).map(async row => {
      try {
        const st = await send(v, row.sub, MSG[slot]);
        if (st === 404 || st === 410 || st === 403) gone.push(row.endpoint); else if (st < 300) sent++;
      } catch {}
    }));
  }
  for (const ep of gone) await rest(env, 'push_subs?endpoint=eq.' + encodeURIComponent(ep), { method: 'DELETE' }).catch(() => {});
  return res.status(200).json({ ok: true, sent, removed: gone.length });
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader('cache-control', 'no-store');
  const env = supaEnv(), v = vapid();
  const ready = !!(env.ready && v);
  if (req.method === 'GET') {
    const slot = String(req.query?.run || '');
    if (slot) {
      if (!MSG[slot]) return res.status(400).json({ ok: false });
      const cs = process.env.CRON_SECRET;
      if (cs && bearer(req) !== cs) return res.status(401).json({ ok: false });
      if (!ready) return res.status(503).json({ ok: false, code: 'off' });
      return run(env, v, slot, res);
    }
    return res.status(200).json({ ok: true, ready, key: ready ? b64u(v.pub) : null });
  }
  if (!ready) return res.status(503).json({ ok: false, code: 'off' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (req.method === 'DELETE') {
    const ep = String(body?.endpoint || '');
    if (!ep) return res.status(400).json({ ok: false });
    await rest(env, 'push_subs?endpoint=eq.' + encodeURIComponent(ep), { method: 'DELETE' }).catch(() => {});
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  const s = body?.sub;
  if (!s || !goodSub(s)) return res.status(400).json({ ok: false, code: 'bad_sub' });
  const token = bearer(req);
  const user = token ? await getUser(env, token).catch(() => null) : null;
  const row = {
    endpoint: s.endpoint, user_id: user ? user.id : null,
    sub: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
    morning: body.morning !== false, evening: body.evening !== false,
    tz: String(body.tz || '').slice(0, 60) || 'UTC',
  };
  const r = await rest(env, 'push_subs?on_conflict=endpoint', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
  if (!r.ok) return res.status(503).json({ ok: false, code: 'db' });
  // A welcome notification, so people can see it works straight away.
  if (body.hello) { try { await send(v, row.sub, { title: 'Reminders are on ✓', body: 'Manna will nudge you in the morning and the evening.', url: '/#settings', tag: 'manna-hello' }); } catch {} }
  return res.status(200).json({ ok: true });
}
