# Daypath

A projects-first task manager: tasks live under projects, dated tasks group into an Upcoming timeline, undated tasks sit in Someday, and there's a lightweight expense tracker for things you need to claim back.

Built with React + Vite, backed by [Supabase](https://supabase.com) (Postgres + Auth) with row-level security scoping every table to its owning user.

## Local setup

```bash
npm install
cp .env.example .env   # fill in your Supabase project URL + anon key
npm run dev
```

## Environment variables

| Variable | Where to find it |
|---|---|
| `VITE_SUPABASE_URL` | Supabase dashboard → Project Settings → API |
| `VITE_SUPABASE_ANON_KEY` | Same page — the `anon` / `publishable` key, **not** the secret key |

## Database

Tables: `projects`, `tasks`, `bin`, `expenses` — all with RLS policies restricting rows to `auth.uid() = user_id`. Two scheduled Postgres functions (via `pg_cron`) handle cleanup:

- `archive_stale_done_tasks` — moves completed one-off tasks into the bin 7 days after completion
- `purge_expired_bin` — permanently deletes bin entries past their 7-day expiry

## Deployment

Deploys to [Vercel](https://vercel.com) on every push to `main`. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as environment variables in the Vercel project settings — the build won't work without them.
