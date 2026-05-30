# Facility Booking (AMUA)

Single-page React app for booking AMUA facilities, with an admin workflow for
approvals, CPSA sync reconciliation, and billing/invoicing. The entire app lives
in one file: [`src/booking-system.jsx`](src/booking-system.jsx).

Stack: **React 19 + Vite**, **Supabase** (Postgres + Google OAuth + Row Level
Security) for data/auth, **EmailJS** for notification emails (sent server-side
via a Supabase Edge Function), deployed to **GitHub Pages** via GitHub Actions.

> Auth & data-contract details (RLS policies, the `system_notes` marker
> catalogue, the CPSA browser extension) live in
> [`HANDOFF_SUPABASE_AUTH.md`](HANDOFF_SUPABASE_AUTH.md). Read it before changing
> anything that writes to Supabase.

---

## Configuration (environment variables)

The client reads two `VITE_*` env vars, injected at build time — nothing is
hardcoded in source. Copy [`.env.example`](.env.example) to `.env.local` for
local dev:

```bash
cp .env.example .env.local   # then fill in the values
```

| Variable | Required | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | ✅ | Supabase project URL |
| `VITE_SUPABASE_ANON` | ✅ | Supabase publishable anon key (safe to expose; protected by RLS) |

Both values are embedded in the shipped JS bundle, so treat them as
**publishable, not secret** — Supabase **RLS** is what protects the data.

**Email has no client-side keys.** It is sent server-side by the `send-email`
Supabase Edge Function (see
[`supabase/functions/send-email/README.md`](supabase/functions/send-email/README.md)),
which holds the EmailJS credentials as Supabase secrets and only accepts calls
from a signed-in user. If the function isn't deployed, the app simply skips
sending email (no crash).

---

## Local development

```bash
npm install
npm run dev      # http://localhost:5173
npm run lint     # ESLint
npm run build    # production build into dist/
```

---

## Database (Supabase)

Run the SQL files in the Supabase **SQL Editor**, in order:

1. `supabase-schema.sql` — base schema
2. `supabase-migration-auth.sql` — OAuth + RLS + `is_admin()` helper
3. `supabase-migration-invoiced-flag.sql` — `invoiced` boolean column
4. `supabase-migration-system-notes.sql` — `system_notes` column + marker migration
5. `supabase-migration-activity-log.sql` — append-only audit log + RLS
6. `supabase-migration-mismatch-log.sql` — mismatch-resolution audit table

Admin is granted via `app_metadata.role = 'admin'` (see `HANDOFF_SUPABASE_AUTH.md`
for the exact SQL). There is no client-side admin password.

---

## Deployment

### Web app → GitHub Pages

Pushing to `main` triggers [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml),
which builds the app and publishes `dist/` to the `gh-pages` branch.

**Required one-time setup** — add these as repo secrets under
**Settings → Secrets and variables → Actions**:

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON` (the build fails fast without them)

GitHub Pages source: **Deploy from branch → `gh-pages`**. Vite `base` is
`/facility-booking/` (see `vite.config.js`) to match the repo-pages URL.

Manual deploy fallback (uses your local `.env.local`): `npm run deploy`.

### Email → Supabase Edge Function

One-time: deploy the `send-email` function and set its EmailJS secrets — full
steps in [`supabase/functions/send-email/README.md`](supabase/functions/send-email/README.md).

---

## Booking rules

| Situation | Behaviour |
|---|---|
| Same facility, same time | ⚠️ Warning shown — user can proceed (shared use allowed) |
| Different facility, same time | ⚠️ Warning shown — user can proceed |
| New booking | Status starts **Pending** until an admin approves |
| Past booking (non-admin) | 🔒 Read-only — cannot be edited or cancelled |
| Edit / cancel | Only on your own bookings |

CPSA-confirmed bookings, mismatch review, and invoicing are admin-only flows;
see the in-app Admin tab and `HANDOFF_SUPABASE_AUTH.md`.
