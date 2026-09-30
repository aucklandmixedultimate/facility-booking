# Multi-provider bookings — implementation plan

Companion to [`multi-provider-design.md`](multi-provider-design.md), which explains the
*why* and the data model. This file is the *how*: work items in build order, with the
files they touch, their acceptance criteria and their dependencies.

**Repos:**
- `facility-booking` (this repo): web app, SQL migrations, edge functions.
- `amua-booking-extension`: Chrome MV3 extension with a side panel and content scripts,
  using `supabase-js` with the admin's Google sign-in.

**Conventions this plan follows:**
- **Migrations:** hand-run SQL files at the repo root (`supabase-migration-*.sql`),
  using the `public.is_admin()` helper for RLS (see `supabase-migration-auth.sql`).
- **App data access:** through the `sb` helper in `src/booking-system.jsx`.
- **Edge functions:** in `supabase/functions/*`, using the user-token check pattern of
  `send-email`.
- **Extension releases:** tagged through its `release.yml` workflow.

**Sizes:** S ≈ half a day, M ≈ 1–2 days, L ≈ 3–5 days of focused work.

---

## Phase 1 — Providers and facilities in Supabase

Goal: add or change a facility or provider without a code change. Everything later
builds on this phase.

### 1.1 Migration: provider registry — S
**File:** `supabase-migration-providers.sql`
- **Tables** `providers`, `facilities`, `provider_contacts`, `provider_seasons`, as in
  design §4.1.
- **RLS:**
  - `providers`, `facilities`, `provider_seasons`: select for `authenticated`;
    insert/update/delete only when `is_admin()`.
  - `provider_contacts`: admin only for everything, because it holds staff phone
    numbers.
- **Seed providers:**

  | id | name | short name | recipient code | channels |
  |---|---|---|---|---|
  | `gtec` | Grammar TEC Rugby Club Inc | GTEC | `GTE` | submit `extension_sporty`, sync `public_calendar` |
  | `stcuthberts` | St Cuthbert's College | St Cuthberts | `STC` | `manual` |
  | `akl_council` | Auckland Council | Council | `AKC` | submit `extension_council`, sync `extension_council` |

  The `gtec` row takes its address and GST from `VENDOR_GTEC`. Its `config` holds the
  calendar URL and form URL. The `akl_council` row gets Private Bag 92300, Auckland 1142
  and GST 104-736-998, from its tax invoice.
- **Seed facilities:** `f1`–`f5`, `g1`–`g3` and `s1` with today's names, colours, tints,
  sites and `admin_only` flags. `external_ref` holds:
  - `sporty_label`: today's `FACILITY_MAP` in the extension's
    `src/shared/mappings.ts`;
  - `cjr_field`: 1/2/3 for `f3`–`f5`;
  - `floodlit: true` for `f3`.
- **Acceptance:** rerunning the migration is harmless (`if not exists` and
  `on conflict do nothing`). A non-admin gets a 403 writing to `facilities`.

### 1.2 App: load the registry at start-up — M
**File:** `src/booking-system.jsx`
- **Fallbacks:** keep the `FACILITIES`, `FACILITY_TINT` and `PROVIDERS` constants as
  the offline/demo fallback.
- **Loader:** add `loadRegistry()` next to `loadSettings()`. It uses
  `sb.selectAll("providers")` and `sb.selectAll("facilities")`, maps each row to the
  current object shape (`adminOnly`, `defaultRate`, `site`, `provider`, `kind`,
  `color`), and replaces the module arrays **in place** (`FACILITIES.splice(0, …)`,
  `Object.assign(PROVIDERS, …)`). The ~80 `FACILITIES` references keep working, and a
  state bump re-renders the app.
- **Derived values:**
  - `CPSA_FIELD_IDS` from facilities whose provider has
    `sync_channel = 'public_calendar'`;
  - `FLOODLIT_FIELD_ID` from `external_ref.floodlit`;
  - `mapCJRFacility` / `fieldIdsFromText` from `external_ref.cjr_field`, instead of the
    hard-coded `f3`/`f4`/`f5`.
- **Inactive facilities:** hidden from pickers, but still resolved by id so old
  bookings keep rendering.
- **Acceptance:**
  - With the tables seeded, the app looks exactly as it does today.
  - With the tables missing or unreachable, it falls back to the constants.
  - Adding a row in Supabase shows the facility after a reload.

### 1.3 App: admin "Providers & facilities" screen — M
A new collapsible section in the Admin tab, following the existing panels such as
Pricing Rules. It offers:
- **Providers:** edit name, short name, address, GST number and recipient code (which
  must be unique); pick the submit and sync channels; activate or deactivate.
- **Facilities:** add, edit or disable (no delete); pick the provider; name, site,
  kind, capacity, colour (tint derived automatically), admin-only, default rate, and
  the `external_ref` fields as simple inputs.
- **Contacts and seasons:** table editors for `provider_contacts` and
  `provider_seasons`.

This also closes phase 0's gap: St Cuthbert's address and GST get entered here, not in
code. **Acceptance:** an admin can add "Thompson Park – Field 2" under `akl_council` and
book it straight away.

### 1.4 Provider-neutral workflow — M
- **Status labels:** `STATUS_META` labels become a function of the booking's provider,
  e.g. "(2/4) Queued for {short_name}". The stored keys (`queued_cpsa`, …) don't change.
- **Channel checks:** replace phase 0's `providerOfFacility(...) === "gtec"` checks with
  `provider.submit_channel !== 'manual'`, in the queue and approve buttons, the bulk
  status options (`bulkStatus` options near "Queue for GTEC"), `GTEC_QUEUE_STATUSES`
  uses, and the Schedule "awaiting sync" hint.
- **Email wording:** status emails (`buildApprovalEmailHtml`, subjects in the submit
  flow) name the provider instead of GTEC.
- **Acceptance:**
  - A GTEC booking's labels are unchanged.
  - A St Cuthberts booking never shows GTEC wording.
  - A council booking shows "Queued for Council".

### 1.5 Billing reads providers — S
- **PO vendor details:** PO name, address and GST come from `PROVIDERS` (now loaded).
- **Drive folders:** "Invoice (from {short})" becomes a per-provider drop folder, like
  the PO folder. `handleDriveAttachGtec` becomes a provider-aware attach.
- **Field rename:** `gtecInvoiceNumber` → `providerInvoiceNumber`, reading the old field
  as a fallback, with the label "{short} invoice #".
- **Acceptance:** a batch with GTEC and St Cuthberts POs files and labels each one
  correctly.

### 1.6 Extension: facility labels from Supabase — S
**Repo:** `amua-booking-extension`
- **Facility labels:** `FACILITY_MAP` is replaced by `facilities.external_ref.sporty_label`,
  fetched once per session and cached in `chrome.storage`. The hard-coded map stays as
  a fallback.
- **Pickup filter:** `fetchPendingBookings` also restricts to facilities whose provider
  is `gtec` (`facility_id in (…)`), so council and St Cuthberts rows never reach the
  Sporty autofill.
- **Release:** bump to 2.5.0.

---

## Phase 2 — Auckland Council portal (extension)

Depends on 1.1 (the `akl_council` provider) and 2.1.

### 2.0 Capture the last HAR — user, S
Record **Export to PDF** / view of a lodged application in a tab that DevTools is
recording. See the design doc for the steps. This confirms the view URL and that the
Orbeon document exposes the §5.3 control names read-only. It blocks 2.3b only.

### 2.1 Migration: `external_requests` — S
**File:** `supabase-migration-external-requests.sql`
- The table from design §4.1, with a unique key on `(provider_id, external_code)` and
  an index on `application_number`.
- RLS: admin only.

### 2.2 Extension: council list sync — M
- **New content script** `src/content/councilSync.ts`: a separate
  `content_scripts` entry matching `https://onlineservices.aucklandcouncil.govt.nz/councilonline/*`.
  - It pages through
    `/councilonline/my-account/paginated-booking-applications?pageSize=50&currentPage=N`
    with same-origin `fetch`.
  - It maps each result to
    `{code, applicationNumber, applicationName, subType.code, bookingApplicationStatus.code.code, lodgedDate, lastModifiedOn, documentId}`
    and drops the `user` block.
  - It sends the rows to the background worker, which upserts them into
    `external_requests` with the admin session (`src/shared/supabase.ts`).
- **Side panel:** a new "Council" tab in `src/sidepanel/App.tsx`. It has a "Sync
  applications" button (enabled when the active tab is the portal), the last-sync time,
  and a list of applications with status chips.
- **Acceptance:** after a sync, `external_requests` holds one row per application, with
  the current status. Running it twice creates no duplicates.

### 2.3 App: council applications panel and status mapping — M
- **Admin panel "Council applications":** lists `external_requests` for `akl_council`
  with status, application number, name, lodged date and linked bookings.
- **Linking:** pick bookings, e.g. a recurring series from the Schedule Summary, and
  link them to an application. This writes `booking_ids` and adds
  `[COUNCIL <yyyy-mm-dd>] App <applicationNumber> · <STATUS>` to each booking's
  `system_notes`, following the same conventions as `[CPSA …]`. Document it in
  `HANDOFF_SUPABASE_AUTH.md`.
- **Status mapping,** applied on every sync/load, through the existing
  `updateBookingStatus` / queue flow:

  | Council status | Booking status |
  |---|---|
  | `SUBMITTED`, `PROCESSING` | `pending_cpsa` |
  | `CONFIRMED` | `cpsa_confirmed` |
  | `MORE_INFO` | `cpsa_review_needed` |
  | `DECLINED` | `rejected` |
  | `WITHDRAWN`, `CANCELLED` | `cancelled` |

  Status changes follow the existing notification rules (silent mode respected).
- **Acceptance:** with a booking series linked to an application, a sync that turns the
  application `CONFIRMED` shows every booking in the series as Council Confirmed.

### 2.3b Extension: read application detail — M (after 2.0)
- For applications without `detail`, open the Orbeon view (or fetch its HTML) and read
  the `region`, `parkName`, field picker, first and last date, weekday and start/end
  time controls into `external_requests.detail`.
- In the app, auto-suggest links: match detail → facilities by
  `external_ref.council_park/field` + dates + weekday/time → bookings, and show a
  "Link N suggested bookings" button. Never link silently.

### 2.4 Extension: "Fill council application" assistant — L
- **New content script** `src/content/councilFill.ts`, on
  `…/application/sportapplication*`.
- **Profile:** comes from the **AMUA details** setting (`amua_org`, edited under User
  menu → AMUA details; shipped). It holds the organisation, the operations, secondary and
  key-holder contacts, the regional sports organisation, the organisation type, and the
  address-search text. The extension reads it from `settings`.
- **Filling:** the side panel lists queued council series (`queued_cpsa` on
  `akl_council` facilities, grouped like the Sporty series key). "Fill" walks the
  wizard pages 1–5:
  - It sets values through the page's inputs and dispatches `input`/`change`/`blur`,
    so Orbeon sends its own events.
  - It waits for each Ajax round-trip to settle (no pending `xforms-server` request)
    before the next field, because dropdowns are chained: region → park → field.
  - It selects by **label**, never by the list-position values.
- **Stops before page 6.** The admin reviews, agrees and submits. There is no fee:
  council field bookings are free.
- **Read-back:** after submit, it reads the new application number and code and upserts
  `external_requests`. It links the series' `booking_ids` and moves the bookings to
  `pending_cpsa`.
- **Acceptance:** a two-park, two-weekday series fills correctly, and the admin only
  has to tick the agreements and submit.

### 2.5 Extension: park/field catalogue harvest — S (optional)
A "Refresh council catalogue" action on the form page. It iterates region → park,
collects each park's field list, and upserts `council_parks` / `council_fields` (4.1).
It runs only on demand, never automatically.

---

## Phase 3 — Email intake

Depends on 2.1 (`external_requests`) and 3.1.

### 3.1 Migration: `inbound_messages` — S
**File:** `supabase-migration-inbound-messages.sql`
- The table from design §4.1, unique on `message_id`.
- RLS: admin select; writes only via the service role.

### 3.2 Edge function `ingest-email` — M
**Files:** `supabase/functions/ingest-email/index.ts`, `parse.ts`
- **Auth:** header `x-ingest-key` checked against `INGEST_KEYS`, a JSON secret mapping
  key → mailbox name. There is no user session: the service role writes to the tables.
- **Body:** `{messageId, from, to, subject, date, text}`, where `text` is plain text
  truncated to 8KB by the script.
- **Parser (`parse.ts`, pure):**
  - Subject regex
    `^(?<org>.+?) - (?<park>.+?)\((?<detail>.+?)\) - (?<subType>Casual|Seasonal) Application # (?<app>[0-9a-f]{8})`.
  - Fallback: `Application\s*[-#]\s*([0-9a-f]{8})` anywhere in the subject or text.
  - Outcome: `declined|unable to|cannot be` → DECLINED;
    `confirm(ed|ation)|approved|allocated` → CONFIRMED;
    `more information|please provide` → MORE_INFO; otherwise NOTE.
  - Sender classes: `@aucklandcouncil.govt.nz` coordinator; `parksbookings@news.…` bulk
    notice (flag only).
- **Write:** insert `inbound_messages`, storing parsed fields only, not the body. If
  `application_number` matches `external_requests`, update its status (only forwards:
  never downgrade CONFIRMED to SUBMITTED) and set `applied_at`. Otherwise insert a stub
  request.
- **Tests:** Deno tests for `parse.ts` with fixtures built from the sample `.eml`
  (subject plus a redacted body) and a synthetic confirmation.
- **Acceptance:** replaying the sample email marks application `fef887de` DECLINED.
  Replaying it again changes nothing.

### 3.3 Google Apps Script for AMUA's Gmail — S
**File:** `scripts/gmail-ingest.gs`, plus a setup section in
`supabase/functions/ingest-email/README.md`.
- A 15-minute time trigger searches
  `from:(aucklandcouncil.govt.nz) newer_than:3d -label:amua-ingested`.
- For each message it POSTs the fields from 3.2, then labels the thread
  `amua-ingested`. On a 5xx it leaves the thread unlabelled so the next run retries.
- The key is kept in Script Properties, not in the code.
- **Acceptance:** a council email arriving in AMUA's Gmail shows up in the app within
  15 minutes.

### 3.4 Personal inbox forwarding guide — S
A README section: Gmail filter `from:aucklandcouncil.govt.nz` → forward to AMUA's
Gmail (with the one-time forwarding confirmation), and the Outlook equivalent. No app
change.

### 3.5 App: council inbox view — S
- In the Council applications panel, show each application's message timeline (date,
  sender role, outcome).
- An "Unmatched" list, with "link to application" for emails whose number isn't known
  yet.
- An activity-log entry and toast when an email changes an application's status.

---

## Phase 4 — Council reference data

Depends on 1.1 and 1.3.

### 4.1 Park catalogue — S
- **Migration** `supabase-migration-council-catalogue.sql`: tables `council_parks(id,
  region, name, active)` and `council_fields(id, park_id, name)`; readable by any
  signed-in user, admin write.
- **Generator** `scripts/gen-council-catalogue-sql.mjs`: turns
  `docs/data/council-sports-parks.json` into `insert … on conflict do nothing`.
- **Later refreshes** come from 2.5.

### 4.2 Contacts and seasons — S
- Contacts are entered through the 1.3 editor, not the repo: four regional coordinators
  plus the team leader and the general line.
- Seasons are seeded with the 2026/27 summer calendar (design §6.3).

### 4.3 App: use the reference data — M
- **Adding a council facility (1.3):** pick region → park → field from the catalogue.
  This fills `site`, the name and `external_ref.council_park/field`.
- **Booking modal and admin review,** for a council facility:
  - warn if the date is outside the provider's casual window, or inside a
    `renovation` season ("needs written approval");
  - show the regional coordinator's name and email.
- **Schedule Summary:** a "Council season" badge on patterns that cross a season
  boundary.

---

## Phase 5 — Billing across providers

Depends on 1.5.

- **5.1 Free council fields and event permits — S.**
  - Council facilities have a $0 rate, and `buildProviderPoRecords` skips any provider
    whose lines total $0, so no empty PO goes to the council.
  - A booker's invoice leaves out $0 council lines, or shows them for reference behind a
    setting.
  - For big-event hire, record the council's **event permit** invoice as a provider
    invoice: attach it, enter the number and amount (e.g. 234000005905, $101 incl. GST),
    and optionally add a one-off recharge line to the organiser's invoice.
- **5.2 Provider invoice reconciliation — M.** On each PO, compare the provider's actual
  invoice (attached file + `providerInvoiceNumber` + amount entered) against the PO
  total, and flag differences in the Billing tab.

---

## Cross-cutting

- **Tests:**
  - The app repo has no test runner. Add `vitest` for pure logic only:
    `buildProviderPoRecords`, extracted from the component into
    `src/billing/providers.js`, `normaliseInvLine`, `cleanEmailSubject`, and the
    registry row → facility mapping.
  - The edge function has Deno tests (3.2).
  - The extension parsers get unit tests in the same style.
- **Privacy:**
  - Never store council account profile blocks, email bodies, or staff phone numbers
    outside the admin-only tables.
  - HARs stay out of git.
- **Secrets:**
  - `INGEST_KEYS` is a Supabase secret.
  - The Apps Script key lives in Script Properties.
  - No council credentials are stored anywhere: the extension uses the admin's own
    browser session.
- **Rollout:**
  - Run each migration in the Supabase SQL editor before merging the app change that
    reads it. The app's fallbacks mean the order is not fragile.
  - Deploy edge functions with `supabase functions deploy`.
  - Release the extension through its tag workflow.
- **Docs:** update `HANDOFF_SUPABASE_AUTH.md`, which covers the extension contract and
  the new `[COUNCIL …]` marker, `README.md` (setup), and the design doc's phase table as
  items land.

## Order and estimate

```
1.1 ─┬─ 1.2 ─┬─ 1.3 ─┬─ 4.1 ─ 4.2 ─ 4.3
     │       ├─ 1.4  │
     │       ├─ 1.5 ─┴─ 5.1 ─ 5.2
     │       └─ 1.6
     └─ 2.1 ─┬─ 2.2 ─ 2.3 ─┬─ 2.3b (needs 2.0 HAR)
             │             └─ 2.4 ─ 2.5
             └─ 3.1 ─ 3.2 ─ 3.3 ─ 3.4 ─ 3.5
```

| Phase | Items | Size |
|---|---|---|
| 1 Providers in Supabase | 1.1–1.6 | ~6–8 days |
| 2 Council portal | 2.1–2.5 | ~7–10 days |
| 3 Email intake | 3.1–3.5 | ~3–4 days |
| 4 Reference data | 4.1–4.3 | ~2–3 days |
| 5 Billing | 5.1–5.2 | ~2 days |

**Suggested milestones:**
- **M1 (phase 1):** facilities managed in the app, and St Cuthberts fully set up.
- **M2 (2.1–2.3 + 3.1–3.3):** council applications and email outcomes visible and
  mapped onto bookings. This is the biggest day-to-day win.
- **M3 (2.4, 4.x, 5.x):** automated pre-fill, reference data and billing polish.

## Decisions needed before starting

1. **St Cuthbert's College vendor details** (legal name, address, GST number), its rate,
   and how bookings are made: by email to a contact, or a form. Needed for 1.3 and 1.4.
2. **Council account:** whose browser runs the council sync, meaning who is signed in
   to myAUCKLAND as AMUA. Needed for 2.2.
3. **Council profile** for pre-fill: enter it under User menu → **AMUA details**
   (operations, secondary and key-holder contacts, postal address, address-search
   text). Needed for 2.4.
4. **Mailboxes** that will forward into AMUA's Gmail. Needed for 3.4.
5. **Event permit costs:** council fields are free, so the only council charge is an
   event permit for big-event hire. Recharge it to the organiser or clubs, or absorb it?
   Needed for 5.1.
