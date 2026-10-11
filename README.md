# FacilityBook (AMUA)

Auckland Mixed Ultimate Association's booking system. Two pages on GitHub Pages
(`/facility-booking/`), one Supabase project:

- **Bookings** (`index.html`): book AMUA's facilities (GTEC/CPSA at Cornwall Park, St
  Cuthbert's, council parks, community facilities). Admins approve requests, sync with
  GTEC's schedule, apply to the council, and invoice.
- **Council fields** (`vetting.html`): a map of Auckland's council sports parks for rating
  fields for ultimate. Bookers save the good ones to **My fields**; a field marked bookable
  becomes bookable on the booking site.

Stack: **React 19 + Vite** (booking site), vanilla JS + **Leaflet** (Council fields),
**Supabase** (Postgres, Google sign-in, row-level security), **EmailJS** behind a Supabase Edge
Function, deployed by GitHub Actions.

**Start here:** [`docs/HANDOVER.md`](docs/HANDOVER.md). It covers the architecture map, the
features by module, the data model and `system_notes` markers, external services and
operations. The project rules are in [`CLAUDE.md`](CLAUDE.md), the review checklist is in
[`REVIEW.md`](REVIEW.md), and the latest review and backlog are in
[`docs/REVIEW-2026-10.md`](docs/REVIEW-2026-10.md).

## Develop

```bash
npm ci
cp .env.example .env.local   # fill in the values below
npm run dev                  # http://localhost:5173/facility-booking/
npm run check                # lint (0 errors) + unit tests + build — CI runs the same
```

| Variable | Required | Purpose |
|---|---|---|
| `VITE_SUPABASE_URL` | ✅ | Supabase project URL |
| `VITE_SUPABASE_ANON` | ✅ | Supabase anon key (public; row-level security protects the data) |
| `VITE_GOOGLE_CLIENT_ID` | for Drive | Google OAuth client for the billing documents and backups on Drive |

These are build-time values embedded in the bundle, so treat them as public. Email keys are
never in the client: they are Supabase secrets used by the `send-email` function.

## Database

Run **`supabase-setup.sql`** in the Supabase SQL editor, the whole file. It is safe to re-run
and sets up every table, policy and function. Re-run it after any change to it;
`select version from schema_version` shows which version ran. Making someone an admin is at
the end of the file.

## Deploy

- **Web app:** pushing to `main` runs `.github/workflows/deploy.yml`. It lints, tests, builds
  and publishes `dist/` to the `gh-pages` branch (GitHub Pages source: *Deploy from branch →
  `gh-pages`*).
- **Repo secrets:** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON`, `VITE_GOOGLE_CLIENT_ID`.
- **Deploy only through CI:** the workflow keeps earlier bundles so cached pages keep working.
- **Email function:** deploy `supabase/functions/send-email` and set its EmailJS secrets; see
  [its README](supabase/functions/send-email/README.md). Re-deploy it after changing it.

## Hard rule: the app only emails bookers

Mail meant for vendors, operators or the council is never sent from the app. It becomes a
draft to AMUA's inbox (`[DRAFT for <recipients>] …`, with the intended recipients listed
above it), and AMUA sends it from Gmail. This is enforced in `sendEmail()`
(`src/booking/core.jsx`) and again in the edge function.
