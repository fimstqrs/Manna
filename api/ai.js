// Manna's AI endpoint. The browser sends a prompt (and optionally a photo);
// this function adds the secret API key, asks the model, and returns JSON.
//
// Set ONE of these in Vercel > Project > Settings > Environment Variables:
//   GEMINI_API_KEY     Google Gemini (aistudio.google.com)
//   ANTHROPIC_API_KEY  Anthropic Claude (console.anthropic.com)
// Optional: AI_MODEL to choose a specific model name for that provider.
//
// The daily limit of 5 uses is counted on each device for now. Accounts will
// move that count here later so it can't be reset by clearing the browser.

const MAX_PROMPT = 8000;          // characters
const MAX_IMAGE = 1_600_000;      // characters of base64 (about 1.2 MB)
const PER_IP_DAY = 40;            // safety net per server instance, not the user-facing limit
const hits = new Map();

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

async function askGemini(key, prompt, img) {
  const model = process.env.AI_MODEL || 'gemini-2.5-flash';
  const parts = [{ text: prompt }];
  if (img) parts.push({ inline_data: { mime_type: img.type, data: img.data } });
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.4, maxOutputTokens: 2000 },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error?.message || 'Gemini error ' + r.status), { status: r.status });
  return (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
}

async function askClaude(key, prompt, img) {
  const model = process.env.AI_MODEL || 'claude-haiku-5-5';
  const content = [];
  if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.type, data: img.data } });
  content.push({ type: 'text', text: prompt });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 2000, system: SYSTEM, messages: [{ role: 'user', content }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error?.message || 'Claude error ' + r.status), { status: r.status });
  return (j.content || []).map(c => c.text || '').join('');
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'GET') {
    // Lets the app know whether AI is switched on, without revealing anything else.
    return res.status(200).json({ ok: true, ready: !!(process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY) });
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, code: 'method' });
  if (!allowedOrigin(req)) return res.status(403).json({ ok: false, code: 'origin' });

  const gem = process.env.GEMINI_API_KEY, ant = process.env.ANTHROPIC_API_KEY;
  if (!gem && !ant) return res.status(503).json({ ok: false, code: 'nokey' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (overLimit(ip)) return res.status(429).json({ ok: false, code: 'rate_limited' });

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

  try {
    const text = ant ? await askClaude(ant, prompt, img) : await askGemini(gem, prompt, img);
    return res.status(200).json({ ok: true, data: parseJson(text) });
  } catch (e) {
    const code = e.status === 429 ? 'rate_limited' : e.status === 401 || e.status === 403 ? 'badkey' : 'failed';
    console.error('ai error', e.status || '', e.message);
    return res.status(code === 'rate_limited' ? 429 : 502).json({ ok: false, code });
  }
}
