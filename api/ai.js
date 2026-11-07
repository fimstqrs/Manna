// Manna's AI endpoint. The browser sends a prompt (and optionally a photo);
// this function adds the secret API key, asks the model, and returns JSON.
//
// Set ONE of these in Vercel > Project > Settings > Environment Variables:
//   GEMINI_API_KEY     Google Gemini (aistudio.google.com)
//   ANTHROPIC_API_KEY  Anthropic Claude (console.anthropic.com)
// Optional: AI_MODEL to choose a specific model name for that provider.
//
// Signed-in people: uses are counted here in the database (5 a day free, 100 paid),
// so clearing the browser can't reset them. Signed-out people: the app counts 5 a
// day on the device. Set AI_REQUIRE_LOGIN=1 to make AI need an account.

import { supaEnv, bearer, getUser, rpc } from './_supa.js';

const MAX_PROMPT = 8000;          // characters
const MAX_IMAGE = 1_600_000;      // characters of base64 (about 1.2 MB)
const PER_IP_DAY = 40;
const MAX_FOODS = 8;            // most foods one food lookup can return
const TIMEOUT_MS = 15_000;      // per model call; then the next model is tried            // safety net per server instance, not the user-facing limit
const hits = new Map();
// Pro accounts: no daily AI limit. Add more emails in Vercel as PRO_EMAILS (comma separated).
const PRO = new Set(['themorningfallcorp@gmail.com', ...String(process.env.PRO_EMAILS || '').split(',')]
  .map(e => e.trim().toLowerCase()).filter(Boolean));
const isPro = u => !!(u && u.email && PRO.has(String(u.email).toLowerCase()));
const PRO_USAGE = { allowed: true, used: 0, limit: null, plan: 'pro' };

const SYSTEM = 'You are the assistant inside Manna, a food, workout and faith app. ' +
  'Answer with one JSON object only: no markdown, no code fences, no text before or after it. ' +
  'Never give medical diagnoses or medicine doses.';

function allowedOrigin(req) {
  const o = req.headers.origin;
  if (!o) return true; // same-origin requests from some browsers omit it
  try {
    const h = new URL(o).hostname;
    return h === req.headers.host?.split(':')[0] || h.endsWith('.vercel.app') && h.startsWith('manna') || h === 'localhost' || h === '127.0.0.1';
  } catch { return false; }
}

function overLimit(ip) {
  const day = new Date().toISOString().slice(0, 10);
  const k = ip + '|' + day;
  const n = (hits.get(k) || 0) + 1;
  hits.set(k, n);
  if (hits.size > 5000) hits.clear();
  return n > PER_IP_DAY;
}

function parseJson(text) {
  if (!text) throw new Error('empty reply');
  const t = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a > -1 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('reply was not JSON');
}

function splitImage(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  return m ? { type: m[1], data: m[2] } : null;
}

// Fastest reliable first. If a model is retired, rejects the settings, is overloaded or times out, the next one is tried.
const GEMINI_MODELS = ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-lite'];

async function askGemini(key, prompt, img) {
  const parts = [{ text: prompt }];
  if (img) parts.push({ inline_data: { mime_type: img.type, data: img.data } });
  const models = process.env.AI_MODEL ? [process.env.AI_MODEL] : GEMINI_MODELS;
  let last;
  for (const model of models) {
    const t0 = Date.now();
    let r;
    try { r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts }],
        // Low thinking keeps replies fast; the output budget includes thinking tokens.
        generationConfig: { responseMimeType: 'application/json', temperature: 0.4, maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'low' } },
      }),
    }); } catch (e) { last = e; console.error('ai skip', model, e.name); continue; }
    const j = await r.json().catch(() => ({}));
    if (r.ok) { console.log('ai ok', model, (Date.now() - t0) + 'ms'); return (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join(''); }
    last = Object.assign(new Error(model + ': ' + (j.error?.message || 'Gemini error ' + r.status)), { status: r.status });
    if (![400, 404, 500, 503].includes(r.status)) throw last;
    console.error('ai skip', model, r.status);
  }
  throw last;
}

async function askClaude(key, prompt, img) {
  const model = process.env.AI_MODEL || 'claude-haiku-5-5';
  const content = [];
  if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.type, data: img.data } });
  content.push({ type: 'text', text: prompt });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 2000, system: SYSTEM, messages: [{ role: 'user', content }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error?.message || 'Claude error ' + r.status), { status: r.status });
  return (j.content || []).map(c => c.text || '').join('');
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  const env = supaEnv();
  const token = bearer(req);
  const user = env.ready && token ? await getUser(env, token).catch(() => null) : null;
  if (req.method === 'GET') {
    // Whether AI is switched on, and for a signed-in person, today's uses.
    let usage = null;
    if (user) usage = isPro(user) ? PRO_USAGE : await rpc(env, 'ai_today', { p_user: user.id }).catch(() => null);
    return res.status(200).json({ ok: true, ready: !!(process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY), usage });
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, code: 'method' });
  if (!allowedOrigin(req)) return res.status(403).json({ ok: false, code: 'origin' });

  const gem = process.env.GEMINI_API_KEY, ant = process.env.ANTHROPIC_API_KEY;
  if (!gem && !ant) return res.status(503).json({ ok: false, code: 'nokey' });

  if (process.env.AI_REQUIRE_LOGIN === '1' && env.ready && !user) return res.status(401).json({ ok: false, code: 'login' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const pro = isPro(user);
  if (!pro && overLimit(ip)) return res.status(429).json({ ok: false, code: 'rate_limited' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const prompt = String(body?.prompt || '').slice(0, MAX_PROMPT);
  if (!prompt.trim()) return res.status(400).json({ ok: false, code: 'empty' });
  let img = null;
  if (body?.image) {
    if (String(body.image).length > MAX_IMAGE) return res.status(413).json({ ok: false, code: 'too_big' });
    img = splitImage(String(body.image));
    if (!img) return res.status(400).json({ ok: false, code: 'bad_image' });
  }

  // Count this use against the person's account before calling the AI.
  let usage = null;
  if (pro) usage = PRO_USAGE;
  else if (user) {
    try { usage = await rpc(env, 'use_ai', { p_user: user.id }); }
    catch (e) { console.error('ai usage counter unavailable (run supabase/schema.sql?)', e.status || '', e.message); return res.status(503).json({ ok: false, code: 'failed' }); }
    if (!usage || !usage.allowed) return res.status(429).json({ ok: false, code: 'limit', usage });
  }

  try {
    const text = ant ? await askClaude(ant, prompt, img) : await askGemini(gem, prompt, img);
    const data = parseJson(text);
    // Food lookups that find several foods cost one AI use per food. The first was
    // counted above; charge the rest now, and keep only as many foods as were paid for.
    if (body?.per === 'food' && data && Array.isArray(data.foods)) {
      const found = Math.min(data.foods.length, MAX_FOODS);
      let paid = 1;
      if (pro) paid = found;
      else if (user) {
        while (paid < found) {
          const u = await rpc(env, 'use_ai', { p_user: user.id }).catch(() => null);
          if (!u || !u.allowed) { if (u) usage = u; break; }
          usage = u; paid++;
        }
      } else paid = found; // signed out: the device counts its own uses
      data.found = found;
      data.foods = data.foods.slice(0, paid);
      data.charged = user ? paid : undefined;
    }
    return res.status(200).json({ ok: true, data, usage });
  } catch (e) {
    if (user && !pro) await rpc(env, 'refund_ai', { p_user: user.id }).catch(() => {});
    const code = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : e.status === 429 || e.status === 503 ? 'rate_limited' : e.status === 401 || e.status === 403 ? 'badkey' : 'failed';
    console.error('ai error', e.status || '', e.message);
    return res.status(code === 'rate_limited' ? 429 : 502).json({ ok: false, code });
  }
}
