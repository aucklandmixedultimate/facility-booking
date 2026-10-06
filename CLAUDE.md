# FacilityBook — project notes for contributors and AI agents

Two apps on GitHub Pages (`/facility-booking/`), one Supabase project:

- **Booking site** — `index.html` → `src/main.jsx` → `src/booking-system.jsx` (`App`) plus
  `src/booking/*.jsx`:
  - `core.jsx` constants, facilities and vendors, venues, formatting, system-note markers,
    email builders, shared UI (`Modal`, `Badge`, `ProviderMenu`, `TableViewToggle`…)
  - `modals.jsx`, `forms.jsx`, `calendar.jsx`, `schedule.jsx` (Grouped view / schedule
    summary, pricing rules), `billingDocs.jsx` (invoice/PO rendering), `councilData.jsx`,
    `facilityStrip.jsx` (the Week / Month / List facility chips, 📍 Fields menu and Reset),
    `gtec.jsx` (GTEC calendar sync helpers)
  - lazily loaded tabs: `summary.jsx`, `billing.jsx`, `admin.jsx`, `about.jsx`
- **Council fields** — `vetting.html` → `src/vetting/main.js` (Leaflet, vanilla JS).
- Shared: `src/actor.js` (who's using a shared login), `src/people.js`, `src/seasons.js`,
  `src/councilSeasons.js`, `src/drive-client.js`, `src/councilMail.js`, `src/statuses.js` (the status model),
  `src/holidays.js` (NZ public holidays from date.nager.at, Mondayised, cached a week on the device),
  `src/appnav.js` (the Bookings / Council fields switcher in both headers — add a page there).

## Commands

- `npm run check` — lint (0 errors), unit tests (`tests/*.test.mjs`), build. CI runs the same
  on every PR (`.github/workflows/ci.yml`) and before every deploy.
- `npm run dev` / `npm run build` / `npm test`.

## Hard rules

1. **Email: only bookers are emailed.** Mail meant for vendors, the council or anyone else is
   never sent from the app. `sendEmail` / `toAmuaDraft` turn it into a draft addressed to
   `aucklandmixedultimate@gmail.com` with the intended recipients listed above the draft;
   AMUA sends it from Gmail. Never bypass `sendEmail`.
2. **Privacy:** people are shown and stored as first name + last initial only ("Rory H.") —
   use `shortName` / `personFromEmail` (`src/people.js`).
3. **Database changes** go in `supabase-setup.sql` only. It must stay safe to re-run
   (`create … if not exists`, `drop policy if exists` before `create policy`, `add column if
   not exists`) and bump the `schema_version` stamp. The app must keep working (degrade
   gracefully) until the script has been run.
4. **Shared settings writes** use `settings_merge` (`mergeSetting` in the Council fields page)
   for partial updates, never a blind read-modify-write of a whole value.
5. **Module state** in `core.jsx` (`_activeVenue`, `_currentUser`, …) is changed only through
   `setModuleState({...})` — imports are read-only.
6. Say **vendor** (not provider) in the interface. Vendor stages name the facility's vendor
   (`statusLabelFor`, `<Badge fid={…}/>`): GTEC for Cornwall Park fields, CPSA for the rooms.
7. **Statuses** live in `src/statuses.js` (stages, workflow order, groups such as `isClosed`,
   `isLive`, `reachedVendorQueue`). Use its helpers rather than hand-written status lists.
   The legacy keys `pending` / `amua_submit` are migrated by the SQL (v3) and normalised on load.
8. **Colours, radii, spacing** come from the design tokens in `src/theme.css` (CSS `var(--c-…)`,
   or `T.…` from `core.jsx` in inline styles). Emails keep literal colours (no CSS variables in mail).
   Only pages with `<html data-dark-ok>` get dark mode; the booking site isn't on tokens enough yet.
9. No model identifiers in commits, PRs or code.

## Testing

Unit tests cover pure modules. UI changes are checked with Playwright against the dev server
with a stubbed Supabase (`VITE_SUPABASE_URL=http://127.0.0.1:59999 VITE_SUPABASE_ANON=x`) and a
fake admin session in `localStorage` (`sb-127-auth-token`). Check phone (390 px) and desktop
widths, and that the page has no errors.
