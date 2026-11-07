# Switching on Manna accounts

Accounts stay hidden until these steps are done. About 5 minutes.

1. **Create the database.** In Vercel, open the manna project, go to **Storage** (or **Integrations**), choose **Supabase** and create a free database connected to this project. This adds the Supabase settings to the project automatically.
   *Or* create a project at supabase.com and add these in Vercel > Settings > Environment Variables:
   `SUPABASE_URL`, `SUPABASE_ANON_KEY` (or publishable key) and `SUPABASE_SERVICE_ROLE_KEY` (or secret key), from Supabase > Project Settings > API.
2. **Set up the tables.** In Supabase, open **SQL Editor > New query**, paste everything from `supabase/schema.sql`, and press **Run**.
3. **Tell Supabase where Manna lives.** In Supabase, **Authentication > URL Configuration**: set **Site URL** to `https://manna-beta-five.vercel.app`. Email confirmation and password-reset links then open Manna.
3b. **Turn on Friends.** In **SQL Editor > New query**, paste everything from `supabase/friends.sql` and press **Run**. (Run `schema.sql` first if you have not.)
4. **Redeploy** the site in Vercel (or ask Claude to) so it picks up the new settings.

## Optional

- `AI_REQUIRE_LOGIN=1` in Vercel makes AI features need an account.
- Give someone the paid plan (100 AI uses a day) until payments exist:
  `update public.profiles set plan = 'paid' where id = '<their user id>';`
- Never share the service role / secret key. It stays in Vercel only.
