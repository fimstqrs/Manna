// Tells the app whether accounts are switched on, and the public Supabase details
// it needs to sign people in. The anon/publishable key is meant to be public:
// the database's row-level security rules are what protect people's data.
import { supaEnv } from './_supa.js';

export default function handler(req, res) {
  const env = supaEnv();
  res.setHeader('cache-control', 'public, max-age=60');
  res.status(200).json({
    accounts: env.ready,
    url: env.ready ? env.url : null,
    anonKey: env.ready ? env.anon : null,
    aiNeedsLogin: process.env.AI_REQUIRE_LOGIN === '1',
  });
}
