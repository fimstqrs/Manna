// Reminders (web push). Version 159.
//   GET  /api/push                -> { ready, key } the public key phones subscribe with
//   POST /api/push   {sub, prefs, tz}  -> saves this phone's subscription and its reminder times
//        prefs = { verse, breakfast, lunch, dinner, log }: each "HH:MM" in the person's own time, or null for off
//   DELETE /api/push {endpoint}   -> stops reminders for this phone
//   GET  /api/push?run=tick       -> called every 5 minutes by Supabase (pg_cron); sends what is due
//   POST /api/push   {notify}     -> friend request, accepted request or cheer: tells the other person's phones (Version 175)
//   prefs also holds water and workout times, plan (7 workout names, Monday first) and friends (true or false)
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

// One signed token per push service, reused for up to 11 hours (Apple asks not to make a new one more than once an hour).
const JWTS = new Map();
function jwt(v, aud) {
  const now = Math.floor(Date.now() / 1000), c = JWTS.get(aud);
  if (c && c.exp - now > 3600) return c.t;
  const exp = now + 12 * 3600;
  const jh = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const jc = b64u(JSON.stringify({ aud, exp, sub: 'mailto:themorningfallcorp@gmail.com' }));
  const sig = crypto.sign('sha256', Buffer.from(jh + '.' + jc), { key: v.key, dsaEncoding: 'ieee-p1363' });
  const t = jh + '.' + jc + '.' + b64u(sig);
  JWTS.set(aud, { t, exp });
  return t;
}
async function send(v, sub, msg) {
  const aud = new URL(sub.endpoint).origin;
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: { authorization: 'vapid t=' + jwt(v, aud) + ', k=' + b64u(v.pub), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', TTL: '21600', urgency: 'high' },
    body: encrypt(sub, JSON.stringify(msg)),
    signal: AbortSignal.timeout(8000),
  });
  // Log failures (no keys or personal data), so problems with a push service show up in Vercel's logs.
  if (r.status >= 300) { let why = ''; try { why = (await r.text()).slice(0, 160); } catch {} console.error('push fail', new URL(sub.endpoint).hostname, r.status, why); }
  return r.status;
}

function rest(env, path, opt = {}) {
  const k = env.service, h = { apikey: k, 'content-type': 'application/json', ...(opt.headers || {}) };
  if (k.startsWith('eyJ')) h.authorization = 'Bearer ' + k;
  return fetch(env.url + '/rest/v1/' + path, { ...opt, headers: h, signal: AbortSignal.timeout(8000) });
}

// Five messages for each kind of reminder. One is picked at random each time.
const MSGS = {
  verse: { url: '/#scripture', list: [
    ['Good morning ☀️', 'Your verse for today is ready. Take a minute with it before the day starts.'],
    ['A word for today 📖', 'Start the day with God’s Word. Today’s verse is waiting for you in Manna.'],
    ['Rise and shine 🌅', '“This is the day the Lord has made.” Open today’s verse and carry it with you.'],
    ['Before the rush begins 🙏', 'One verse, one minute, one quiet breath. Your verse of the day is here.'],
    ['Fresh manna this morning 🍞', 'His mercies are new every morning. Come read today’s verse.'],
  ] },
  breakfast: { url: '/#eat', list: [
    ['Breakfast time 🍳', 'Fuel up for the day, then log it in Manna so your targets stay on track.'],
    ['Good morning, hungry? 🥣', 'What’s for breakfast? Type it, say it or snap it and Manna does the rest.'],
    ['Start strong 💪', 'A good breakfast sets up the whole day. Don’t forget to log it.'],
    ['First meal of the day ☕', 'Eating now? Add it to today’s log in a few seconds.'],
    ['Breakfast check-in 🍓', 'Give thanks, eat well, and log your breakfast in Manna.'],
  ] },
  lunch: { url: '/#eat', list: [
    ['Lunch time 🥗', 'Take a proper break and refuel. Log your lunch when you’re done.'],
    ['Midday refuel 🍽️', 'Halfway through the day. What’s for lunch? Add it to Manna.'],
    ['Time to eat 🥪', 'Your body has been working hard. Grab lunch and log it in a tap.'],
    ['Lunch break 🌯', 'Step away for a minute, eat something good, and keep your log up to date.'],
    ['Don’t skip lunch 🍲', 'Steady energy for the afternoon starts now. Log what you eat.'],
  ] },
  dinner: { url: '/#eat', list: [
    ['Dinner time 🍝', 'Sit down, slow down and enjoy it. Log your dinner in Manna after.'],
    ['What’s for dinner? 🍛', 'Type it, say it or snap a photo, and your day’s totals update straight away.'],
    ['Evening meal 🥘', 'See how much protein you still need today before you plate up.'],
    ['Time to refuel 🍗', 'Dinner is a great chance to hit your targets. Check Manna, then eat well.'],
    ['Dinner check-in 🌙', 'Give thanks for the meal, then add it to today’s log.'],
  ] },
  log: { url: '/#eat', list: [
    ['How did today go? ✍️', 'Log what you ate and any workout, so your streak and targets stay right.'],
    ['Wrap up your day 🌙', 'A quick check: is everything you ate and did today in Manna?'],
    ['Day’s almost done ✨', 'Add anything you missed today. It only takes a minute.'],
    ['Keep your streak going 🔥', 'Did you train today? Log it before bed so it counts.'],
    ['End the day well 🙏', 'Finish your log, then rest. Tomorrow is a fresh start.'],
  ] },
  water: { url: '/#drink', list: [
    ['Water break 💧', 'Have a glass of water and tap it into Manna.'],
    ['Stay topped up 🥤', 'A few sips now keeps the afternoon slump away. Log your water.'],
    ['Thirsty? 💦', 'Your water bottle in Manna is waiting to be filled.'],
    ['Hydration check 🫗', 'How much water so far today? Add a glass in a tap.'],
    ['Drink up 🌊', 'Your body is mostly water. Top it up and log it.'],
  ] },
  workout: { url: '/#workouts', list: [] },
};
const SLOTS = Object.keys(MSGS);
// Workout reminder: says what today's workout is. On a rest day it sends nothing.
const WORK = [
  ['Workout day 💪', 'Today: {w}. Your workout is ready in Manna when you are.'],
  ['Time to train 🏋️', '{w} is on your schedule today. Let’s get it done.'],
  ['You’ve got this 🔥', 'Today’s plan is {w}. Open Manna and start when you’re ready.'],
  ['Move today 🏃', '{w} is waiting for you. Even a short session counts.'],
  ['Strong body, strong spirit 🙏', 'It’s {w} today. Show up and give it your best.'],
];
function cleanPrefs(p) {
  const o = {};
  for (const k of SLOTS) { const t = p && p[k]; o[k] = hhmm(t) === null ? null : t; }
  // Today's workouts, Monday first: a name, or null on a rest day.
  o.plan = Array.isArray(p && p.plan) ? p.plan.slice(0, 7).map(x => (typeof x === 'string' && x.trim() ? x.trim().slice(0, 40) : null)) : null;
  o.friends = !(p && p.friends === false);
  return o;
}
const rnd = a => a[Math.floor(Math.random() * a.length)];
function pick(slot, pr, now) {
  if (slot === 'workout') {
    const w = pr && Array.isArray(pr.plan) ? pr.plan[now.dow] : null;
    if (!w) return null;
    const x = rnd(WORK);
    return { title: x[0], body: x[1].replace('{w}', w), url: '/#workouts', tag: 'manna-workout' };
  }
  const m = MSGS[slot], x = rnd(m.list); return { title: x[0], body: x[1], url: m.url, tag: 'manna-' + slot };
}

// The time and date where this person is.
function localNow(tz) {
  let p;
  try { p = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()); }
  catch { p = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()); }
  const g = t => (p.find(x => x.type === t) || {}).value;
  const day = g('year') + '-' + g('month') + '-' + g('day');
  const dow = (new Date(day + 'T12:00:00Z').getUTCDay() + 6) % 7;
  return { day, dow, mins: (+g('hour') % 24) * 60 + +g('minute') };
}
const hhmm = t => { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(t || '')); return m ? +m[1] * 60 + +m[2] : null; };

// Called every few minutes. Sends each reminder that is due for each phone, once a day.
// Safe to call any number of times: each reminder is claimed in the database before it is sent.
async function tick(env, v, res) {
  const r = await rest(env, 'push_subs?select=endpoint,sub,prefs,last,tz&limit=5000');
  if (!r.ok) return res.status(503).json({ ok: false, code: 'db' });
  const rows = await r.json();
  const jobs = [];
  for (const row of rows) {
    const pr = row.prefs || {}, last = row.last || {}, now = localNow(row.tz);
    for (const slot of SLOTS) {
      const t = hhmm(pr[slot]);
      if (t === null || last[slot] === now.day) continue;
      const late = now.mins - t;
      if (late >= 0 && late <= 25) { const msg = pick(slot, pr, now); if (msg) jobs.push({ row, slot, day: now.day, msg }); }
    }
  }
  let sent = 0;
  const gone = new Set();
  for (let i = 0; i < jobs.length; i += 20) {
    await Promise.all(jobs.slice(i, i + 20).map(async ({ row, slot, day, msg }) => {
      if (gone.has(row.endpoint)) return;
      // Claim it: only one call can move last[slot] to today.
      const f = 'push_subs?endpoint=eq.' + encodeURIComponent(row.endpoint) + '&or=(last->>' + slot + '.is.null,last->>' + slot + '.neq.' + day + ')';
      const cur = { ...(row.last || {}) };
      cur[slot] = day; row.last = cur;
      const c = await rest(env, f, { method: 'PATCH', headers: { prefer: 'return=representation' }, body: JSON.stringify({ last: cur }) }).catch(() => null);
      const got = c && c.ok ? await c.json().catch(() => []) : [];
      if (!got.length) return;
      try {
        const st = await send(v, row.sub, msg);
        if (st === 404 || st === 410 || st === 403) gone.add(row.endpoint); else if (st < 300) sent++;
      } catch {}
    }));
  }
  for (const ep of gone) await rest(env, 'push_subs?endpoint=eq.' + encodeURIComponent(ep), { method: 'DELETE' }).catch(() => {});
  return res.status(200).json({ ok: true, due: jobs.length, sent, removed: gone.size });
}


// Friend activity: sent the moment it happens, to the other person's phones.
//   POST /api/push {notify: {kind: 'request' | 'accept' | 'cheer', to: username, cheer: 'pray' | 'strong' | 'fire'}}
// The server checks in the database that it really happened before sending, so it cannot be used to spam.
const CHEERS = { pray: ['🙏', 'is praying for you'], strong: ['💪', 'says stay strong'], fire: ['🔥', 'says you’re on fire'] };
async function one(env, path) { const r = await rest(env, path); if (!r.ok) return null; const j = await r.json().catch(() => []); return j[0] || null; }
async function notify(env, v, req, body, res) {
  const token = bearer(req);
  const user = token ? await getUser(env, token).catch(() => null) : null;
  if (!user) return res.status(401).json({ ok: false, code: 'signin' });
  const n = body.notify || {}, kind = String(n.kind || ''), to = String(n.to || '').toLowerCase().replace(/^@/, '');
  if (!/^[a-z0-9_]{3,20}$/.test(to) || !['request', 'accept', 'cheer'].includes(kind)) return res.status(400).json({ ok: false });
  const me = await one(env, 'handles?select=id,username,display&id=eq.' + user.id);
  const them = await one(env, 'handles?select=id,username&username=eq.' + to);
  if (!me || !them || me.id === them.id) return res.status(200).json({ ok: true, sent: 0 });
  const pair = 'friendships?select=a,b,status&or=(and(a.eq.' + me.id + ',b.eq.' + them.id + '),and(a.eq.' + them.id + ',b.eq.' + me.id + '))';
  const f = await one(env, pair);
  const who = (me.display && me.display.trim()) ? me.display.trim().slice(0, 30) + ' (@' + me.username + ')' : '@' + me.username;
  let msg = null;
  if (kind === 'request' && f && f.status === 'pending' && f.a === me.id) msg = { title: 'New friend request 👋', body: who + ' wants to be friends on Manna.', url: '/#friends', tag: 'manna-fr-' + me.username };
  else if (kind === 'accept' && f && f.status === 'accepted') msg = { title: 'You have a new friend 🤝', body: who + ' accepted your friend request.', url: '/#friends', tag: 'manna-fr-' + me.username };
  else if (kind === 'cheer' && f && f.status === 'accepted' && CHEERS[n.cheer]) {
    const c = await one(env, 'cheers?select=id,created_at&from_id=eq.' + me.id + '&to_id=eq.' + them.id + '&kind=eq.' + n.cheer + '&order=created_at.desc&limit=1');
    if (c && Date.now() - new Date(c.created_at).getTime() < 10 * 60 * 1000) msg = { title: CHEERS[n.cheer][0] + ' ' + who, body: who + ' ' + CHEERS[n.cheer][1] + '.', url: '/#friends', tag: 'manna-cheer-' + me.username + '-' + n.cheer };
  }
  if (!msg) return res.status(200).json({ ok: true, sent: 0 });
  const r = await rest(env, 'push_subs?select=endpoint,sub,prefs&user_id=eq.' + them.id);
  const subs = r.ok ? await r.json().catch(() => []) : [];
  let sent = 0;
  await Promise.all(subs.filter(x => !(x.prefs && x.prefs.friends === false)).map(async x => {
    try { const st = await send(v, x.sub, msg); if (st < 300) sent++; else if (st === 404 || st === 410) await rest(env, 'push_subs?endpoint=eq.' + encodeURIComponent(x.endpoint), { method: 'DELETE' }).catch(() => {}); } catch {}
  }));
  return res.status(200).json({ ok: true, sent });
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  res.setHeader('cache-control', 'no-store');
  const env = supaEnv(), v = vapid();
  const ready = !!(env.ready && v);
  if (req.method === 'GET') {
    const slot = String(req.query?.run || '');
    if (slot) {
      if (slot !== 'tick') return res.status(400).json({ ok: false });
      if (!ready) return res.status(503).json({ ok: false, code: 'off' });
      return tick(env, v, res);
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
  if (body?.notify) return notify(env, v, req, body, res);
  const s = body?.sub;
  if (!s || !goodSub(s)) return res.status(400).json({ ok: false, code: 'bad_sub' });
  const token = bearer(req);
  const user = token ? await getUser(env, token).catch(() => null) : null;
  const row = {
    endpoint: s.endpoint, user_id: user ? user.id : null,
    sub: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
    prefs: cleanPrefs(body.prefs),
    tz: String(body.tz || '').slice(0, 60) || 'UTC',
  };
  const r = await rest(env, 'push_subs?on_conflict=endpoint', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
  if (!r.ok) return res.status(503).json({ ok: false, code: 'db' });
  // A welcome notification, so people can see it works straight away.
  let hello = 0;
  if (body.hello) { try { hello = await send(v, row.sub, { title: 'Reminders are on ✓', body: 'This is how Manna’s reminders will look. Change the times any time in Settings.', url: '/#settings', tag: 'manna-hello' }); } catch { hello = 599; } }
  return res.status(200).json({ ok: true, hello });
}
