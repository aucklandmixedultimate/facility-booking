# `gtec-feed` Edge Function

Reads one month of GTEC's calendar server-side for the booking site's **🔄 Sync**. GTEC's
calendar API sends no CORS headers, so the browser can't read it directly. Before this
function the site used free public CORS relays, which fail often. The site still falls back
to them when this function isn't deployed or can't reach GTEC.

- **Admins only.** The caller's Supabase token must have `app_metadata.role = "admin"`.
- `POST { "year": 2026, "month": 10 }` (month 1–12) returns GTEC's events for that month,
  exactly as GTEC's `MonthCalendarEvents` API sends them.
- No secrets are needed. `SUPABASE_URL` and `SUPABASE_ANON_KEY` are injected automatically.

## Deploy

```bash
supabase functions deploy gtec-feed --project-ref bowfbamsjgozigcaygqq
```

Keep JWT verification on (don't pass `--no-verify-jwt`). Re-deploy after changing
`index.ts`. The GTEC URL here must match `cjrMonthUrl()` in `src/gtecFeed.js`.
