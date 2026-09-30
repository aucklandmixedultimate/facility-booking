# Multi-provider facilities, council bookings and email intake — design

Status: **proposal** (phase 0 shipped; later phases need sign-off).
Scope: move from "one facility authority (GTEC), hard-coded" to "any number of
providers, defined in Supabase", with automated intake from the Auckland Council
booking portal and from booking-related email.

---

## 1. Why

The app was built around a single provider, GTEC. Its Cornwall Park fields go through
GTEC's Sporty booking system and are read back from the Carlton Juniors calendar. Three
things have changed:

1. **St Cuthberts Field #1** — a ground hired directly from St Cuthbert's College, with
   no GTEC or CPSA involvement.
2. **Auckland Council sports parks.** AMUA applies through the council's online portal
   (myAUCKLAND), and council parks booking coordinators reply by email.
3. **Scale.** The council catalogue alone lists ~260 parks across four regions (see §7).
   Every new ground that needs a code change is a bottleneck.

## 2. Where GTEC is hard-coded today

| Area | Hard-coding | Effect for a non-GTEC ground |
|---|---|---|
| `FACILITIES` constant (JSX) | ids, names, colours, `site`, `adminOnly` | adding a ground needs a deploy |
| `FACILITY_TINT` | per-id tint map | same |
| `VENDOR_GTEC`, `RECIPIENT_CODE_GTEC` | PO recipient | ~~every booking billed on one GTEC PO~~ **fixed in phase 0** |
| Status keys `queued_cpsa`, `pending_cpsa`, `cpsa_confirmed`, `cpsa_review_needed`; labels "(2/4) Queued for GTEC" … | workflow | non-GTEC bookings had no approve path from the AMUA stage — **fixed in phase 0** |
| `CPSA_FIELD_IDS`, `mapCJRFacility`, `GTEC_CALENDAR_URL`, `GTEC_FORM_URL` | sync and submission | fine: these are GTEC's channel, which is the right place for them |
| `system_notes` markers `[CPSA …]`, `[CPSA-MISMATCH]`, … | contract with the browser extension | must stay stable; see §4.3 |
| Drive folders "PO (to GTEC)", "Invoice (from GTEC)" | filing | PO folder now per provider (phase 0) |

## 3. Phase 0 — shipped with this change

The goal was to make St Cuthberts usable and correctly billed without committing to the
full schema.

- **`provider` on every facility.** The existing grounds are `gtec`. A new facility
  `s1` "St Cuthberts – Field #1" (site *St Cuthberts*) is `stcuthberts`. It is
  **admin-only** until AMUA opens it to bookers, and has **no default rate**; set it in
  Pricing.
- **Interim `PROVIDERS` registry in code:** name, short name, address, GST number and
  recipient code for each provider. St Cuthbert's College uses recipient code `STC`,
  with blank address and GST for now.
- **One purchase order per provider.** `buildProviderPoRecords` replaces
  `buildGtecPoRecord`:
  - Invoice lines now carry `facilityId`, so each PO takes only its provider's lines.
  - Totals reconcile per booker.
  - A GTEC-only run produces exactly the same PO as before.
- **Billing list:**
  - A batch shows *N POs*.
  - PO chips name their provider (`PO · St Cuthberts`).
  - Each PO files to Drive under `PO (to <provider>)`.
- **Workflow:**
  - Bookings on non-GTEC facilities don't offer "Queue for GTEC".
  - Admins can approve them directly from *Pending AMUA Review*.

## 4. Target model — providers defined in Supabase

### 4.1 Tables

```sql
-- Who AMUA hires from / applies to.
create table providers (
  id              text primary key,             -- 'gtec', 'stcuthberts', 'akl_council'
  name            text not null,                -- legal / PO name
  short_name      text not null,                -- UI + Drive folder label
  kind            text not null check (kind in ('club','school','council','internal')),
  recipient_code  char(3) not null unique,      -- bank-reference recipient code
  billing_address text, gst_number text,
  submit_channel  text not null default 'manual'
                  check (submit_channel in ('manual','email','extension_sporty','extension_council')),
  sync_channel    text not null default 'none'
                  check (sync_channel in ('none','public_calendar','extension_council','email')),
  config          jsonb not null default '{}',  -- channel settings (calendar URL, form URL, portal product codes…)
  active          boolean not null default true,
  sort            int not null default 0
);

-- A bookable space. Replaces the FACILITIES constant and FACILITY_TINT.
create table facilities (
  id            text primary key,               -- keep 'f1'…'f5','g1'…'g3','s1' for existing bookings
  provider_id   text not null references providers(id),
  name          text not null,
  site          text,                           -- ground / park name
  kind          text not null check (kind in ('field','social')),
  capacity      int,
  color         text not null, tint text,
  admin_only    boolean not null default false,
  floodlit      boolean not null default false,
  default_rate  numeric,                        -- $/hr until a rate is set
  external_ref  jsonb not null default '{}',    -- provider-side ids: CJR location names, council park/field codes
  active        boolean not null default true,
  sort          int not null default 0
);

-- Provider contacts, e.g. council booking coordinators by region (§6.3).
create table provider_contacts (
  id bigserial primary key, provider_id text references providers(id),
  role text, name text, email text, phone text, region text, notes text
);

-- Booking windows, e.g. council summer/winter seasons (§6.3).
create table provider_seasons (
  id bigserial primary key, provider_id text references providers(id),
  label text, kind text,                        -- 'seasonal_applications','allocation','casual_applications','season','renovation'
  starts_on date, ends_on date, notes text
);

-- An application/booking request as the provider sees it (one per council
-- application, one per Sporty request). Bookings link to it.
create table external_requests (
  id                 bigserial primary key,
  provider_id        text not null references providers(id),
  external_code      text not null,             -- council "code" (0002983560) / Sporty ref
  application_number text,                      -- council 8-hex number used in email subjects (fef887de)
  name               text, sub_type text,       -- 'CASUAL' | 'SEASONAL…'
  status             text,                      -- provider's status code, verbatim
  lodged_at timestamptz, provider_updated_at timestamptz,
  detail             jsonb,                     -- park/field/dates once captured (§5.3)
  booking_ids        text[] not null default '{}',
  last_seen_at       timestamptz not null default now(),
  unique (provider_id, external_code)
);

-- Booking-related email seen by the intake (§6). Minimal fields only.
create table inbound_messages (
  id bigserial primary key,
  provider_id text references providers(id),
  mailbox text not null,                        -- which inbox it came from
  message_id text not null unique,              -- RFC Message-ID, for idempotency
  from_addr text, subject text, received_at timestamptz,
  application_number text,                      -- parsed from subject
  parsed jsonb,                                 -- {org, park, detail, subType, outcome}
  applied_at timestamptz                        -- when it updated an external_request
);
```

**RLS:**
- `providers`, `facilities`, `provider_seasons`: readable by any signed-in user,
  writable by `admin`.
- `provider_contacts`, `external_requests`, `inbound_messages`: `admin` only.
- The email intake writes through an edge function using the service role, not via RLS.

### 4.2 App changes

- **Loading facilities:** load `providers` and `facilities` at start-up and fill the
  module-level `FACILITIES`/`PROVIDERS` in place. The hard-coded arrays stay as the
  offline/demo fallback. The ~80 `FACILITIES` references keep working unchanged,
  because they read the array.
- **Admin screen:** a "Providers & facilities" section with add/edit/disable. Use
  disable, not delete, because bookings reference facility ids.
- **Rates:** move per-facility rates from the `facility_rates` settings blob into
  `facilities.default_rate`, or leave them in settings keyed by facility id. Either
  works, so this can wait.
- **Billing:** read PO vendor details from `providers`. The phase-0 PO split is already
  provider-driven.

### 4.3 Workflow statuses

Keep the stored keys (`queued_cpsa`, `pending_cpsa`, `cpsa_confirmed`,
`cpsa_review_needed`). The extension contract and every existing row depend on them.
Treat them as **provider-neutral stages**:

| stored key | stage | label |
|---|---|---|
| `pending_amua` | AMUA review | Pending AMUA Review |
| `queued_cpsa` | queued for provider | Queued for **{provider.short_name}** |
| `pending_cpsa` | submitted, awaiting provider | Pending **{provider.short_name}** Review |
| `cpsa_confirmed` | provider confirmed | **{provider.short_name}** Confirmed |
| `cpsa_review_needed` | provider differs | **{provider.short_name}** Mismatch |

Labels come from the booking's facility → provider. A provider whose `submit_channel`
is `manual` skips the queue stages; that is the phase-0 behaviour, generalised. The
extension keeps filtering `queued_cpsa` rows, and should additionally filter on
`facility.provider_id = 'gtec'` once other providers can queue.

## 5. Auckland Council portal — reading applications

### 5.1 What the HAR shows

The capture is of `onlineservices.aucklandcouncil.govt.nz` while signed in as AMUA. It
contains no cookies or tokens.

| Request | Returns |
|---|---|
| `GET /councilonline/my-account/paginated-booking-applications?pageSize=10&currentPage=N` | JSON `data.formData.results[]` + `pagination` |
| `GET /councilonline/my-account/paginated-bookings?pageSize=10` | JSON confirmed bookings (empty in this capture) |
| `GET /councilonline/forms/booking/{code}` | HTML summary: name, type, status, date from/to |
| `GET /councilonline/orbeon/fr/booking/SportApplicationForm/pdf/{documentId}` | "Export to PDF" of the full form (park, field, dates, times). **Not captured.** |

Fields of each application result:
- **Identifiers:** `code` (e.g. `0002983560`), and `applicationNumber` /
  `consentNumber` (8-hex, e.g. `8e4a5f99`). The 8-hex number is the one in
  coordinators' email subjects ("Casual Application # fef887de").
- **Name and type:** `applicationName` ("Training - Auckland Mixed Ultimate
  Association"), `productCode` (`SSPPERMITBK`), `bookingApplicationType.code`
  (`SEASONAL_ALL_SPORTS_PARKS`), `subType.code` (`CASUAL` | seasonal).
- **Status:** `bookingApplicationStatus.code.code` — one of `SUBMITTED`, `PROCESSING`,
  `MORE_INFO`, `CONFIRMED`, `DECLINED`, `WITHDRAWN`, `CANCELLED`.
- **Dates:** `lodgedDate`, `createdOn`, `lastModifiedOn` (epoch ms).
- **Form document:** `documentId`, the Orbeon form document.

The list JSON does **not** include park, field, dates or times. Those live only in the
Orbeon form.

### 5.2 How to scrape: the browser extension, not a server

The portal is a signed-in myAUCKLAND session with no public API. A server-side scraper
would need:
- AMUA's council password stored in Supabase secrets;
- a headless login through the council's identity provider, which may add MFA or
  captcha;
- polling as a robot, which breaks when the login flow changes and is a terms-of-use
  risk.

**Recommendation:** add a council module to the existing `amua-booking-extension`, the
same pattern as Sporty. While an admin is signed in to the portal, a content script on
`onlineservices.aucklandcouncil.govt.nz`:

1. Fetches `paginated-booking-applications` same-origin, paging until
   `currentPage >= numberOfPages`. The browser's session cookies authenticate the
   requests.
2. Upserts each result into `external_requests`, keyed
   `(provider_id='akl_council', external_code=code)`, using the admin's Supabase OAuth
   token as the extension already does. It stores status, `applicationNumber`, the
   dates and `documentId`, and never stores the `user` block (the account's email and
   phone).
3. Maps council status onto linked bookings:
   - `SUBMITTED` / `PROCESSING` → `pending_cpsa`
   - `CONFIRMED` → `cpsa_confirmed`
   - `DECLINED` / `WITHDRAWN` / `CANCELLED` → `rejected` / `cancelled`
   - `MORE_INFO` → `cpsa_review_needed`, with a `[COUNCIL-MORE-INFO]` note
4. Adds a "Sync council applications" button in the popup. Optionally it runs
   automatically when the admin opens *My applications*.

### 5.3 Capturing park, dates and times

To be confirmed with one more HAR: open an application, click **Export to PDF**, and
also open the Orbeon *view* URL, likely
`/councilonline/orbeon/fr/booking/SportApplicationForm/view/{documentId}`. Orbeon forms
usually render all fields in the view HTML (`fr-view` controls), which is easier to
parse than the PDF. Once the field names are known, the extension fills
`external_requests.detail` = `{park, field, dates[], start, end, activity}`. That lets
it:
- match council applications to bookings automatically (park → facility via
  `facilities.external_ref.council_park`);
- create *pending* bookings for applications lodged outside the app.

### 5.4 Submitting to the council (later)

Lodging applications from the app is possible in the same way the extension fills
Sporty. It is lower value: council applications are few and seasonal. Leave it manual,
with the app linking to the portal and recording the application number the admin
pastes back.

## 6. Email intake

### 6.1 Sources

- **AMUA's Gmail:**
  - coordinator replies from `@aucklandcouncil.govt.nz`, e.g. the sample from the
    South/East coordinator: "… Casual Application # fef887de" → declined;
  - `parksbookings@aucklandcouncil.govt.nz`;
  - bulk notices from `parksbookings@news.aucklandcouncil.govt.nz` (season calendars,
    renovation dates).
- **Personal / club inboxes** that applied on AMUA's behalf. The sample was delivered to
  another club's Gmail.

### 6.2 Recommended mechanism

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Apps Script in the mailbox** (recommended for AMUA's Gmail) | A time-driven Google Apps Script (every 15 min) searches `from:(aucklandcouncil.govt.nz) newer_than:2d -label:amua-ingested`, parses, POSTs to a Supabase edge function `ingest-email` with a per-mailbox secret, then labels the thread | no OAuth app review; runs even when nobody has the app open; the mailbox owner controls it | a small script lives outside the repo (keep a copy in `scripts/`) |
| B. Gmail API from an edge function | Store a refresh token for AMUA's Gmail; a scheduled function polls | all code in Supabase | `gmail.readonly` is a *restricted* scope, which needs verification or a Workspace-internal app; a stored token can read the whole mailbox |
| C. Forwarding filter (recommended for personal inboxes) | In the personal Gmail: filter `from:aucklandcouncil.govt.nz` → forward to AMUA's Gmail. Option A then picks it up | nobody grants the app access to a personal mailbox | a forwarding address must be confirmed once per inbox |
| D. In-browser, existing Google sign-in | Add `gmail.readonly` to the Drive OAuth client and read while an admin has the app open | no server | only runs when an admin is online; restricted-scope review |

**Recommendation:** A for AMUA's inbox, and C to funnel personal inboxes into it. There
is then one ingestion path and one secret, and the app never holds anyone's mail
credentials.

`ingest-email` edge function:
- Validates the secret.
- Dedupes on `Message-ID`.
- Parses the message:
  - **Subject:**
    `^(?<org>.+?) - (?<park>.+?)\((?<detail>.+?)\) - (?<subType>Casual|Seasonal) Application # (?<app>[0-9a-f]{8})`
  - **Outcome keywords in the plain-text body:** `declined` → DECLINED;
    `confirmed|approved|allocated` → CONFIRMED;
    `more information|please provide` → MORE_INFO.
- Writes `inbound_messages`.
- If `application_number` matches an `external_requests` row, updates its status. If not,
  creates a stub request, so the email is visible even before the portal sync has run.
- Stores only from, subject, date, application number and outcome. It does **not**
  store bodies or signatures, which contain staff mobile numbers.

Bulk news emails are only flagged for an admin, not parsed. Season dates change each
year, and entering them into `provider_seasons` by hand is more reliable.

### 6.3 Council reference data (seed `provider_contacts` / `provider_seasons`)

**Parks booking contacts** go in `provider_contacts`, admin-only. Only roles and
regions are listed here; names and numbers go in the table, not the repo.

| Role | Region |
|---|---|
| Senior Parks Booking Coordinator | Central |
| Parks Booking Coordinator | West / Upper North |
| Parks Booking Coordinator | South / East |
| Parks Booking Coordinator | North Shore |
| Team Leader Visitor Experience | — |
| Auckland Council general line | — |

Email for all: `parksbookings@aucklandcouncil.govt.nz`.

**Summer 2026/27 calendar** → `provider_seasons`:

| Window | From | To |
|---|---|---|
| Summer seasonal applications open | 2026-07-13 | 2026-08-21 |
| Summer allocation coordination | 2026-08-17 | 2026-09-21 |
| Allocations issued | — | 2026-09-21 |
| Spring renovation (casual only with written approval) | early Sep | 2026-10-23 |
| Summer casual applications open | 2026-09-21 | 2027-02-15 |
| Summer community sport season | 2026-10-24 | 2027-03-21 |
| Winter season 2027 (proposed) | 2027-04-03 | — |

With seasons in the table, the app can warn when a council booking falls outside the
casual window or inside renovation, and show which coordinator to contact for a park's
region.

## 7. Council park catalogue

The regional *Sports Fields Maps* PDFs (updated January 2025) list parks by region.
Counts are from their tables of contents:

| Region | Summer | Winter |
|---|---|---|
| North | 64 | — |
| Central & Gulf Islands | 66 | — |
| South | 89 | — |
| West | 40 | 39 |

Field numbers and layouts appear only in the map images.

**Don't create ~260 facilities.** Instead:
- Seed an admin-only reference list `council_parks(name, region, season)` from these
  tables of contents, for autocomplete and for routing to the right regional
  coordinator.
- Create a `facilities` row, e.g. "Thompson Park – Field 2", only when AMUA books or
  applies for that park. Record the park and field in `external_ref.council_park` /
  `external_ref.council_field` so the portal sync (§5.3) can match it.

## 8. Billing across providers

- **Purchase orders:** one PO per provider per official run (phase 0). PO vendor
  details come from `providers` (phase 1).
- **Invoices from providers:** generalise the Drive "Invoice (from GTEC)" drop folder to
  `Invoice (from <provider>)`. Generalise `gtecInvoiceNumber` to `providerInvoiceNumber`,
  keeping the old field as an alias.
- **Council fees:** council casual bookings are charged to the applicant. When AMUA is
  the applicant, the council is a provider like any other (PO → council, invoice →
  clubs). When a club applies directly, AMUA only tracks the booking, and the facility
  has no rate, so nothing is invoiced.

## 9. Phases

| Phase | Scope | Size |
|---|---|---|
| 0 ✅ | St Cuthberts facility; provider on facilities; PO per provider; direct approval for non-GTEC | shipped |
| 1 | `providers` / `facilities` tables + migration seeding today's constants; load at start-up with code fallback; admin CRUD; provider-labelled statuses | medium |
| 2 | Extension: council portal sync → `external_requests`; status mapping onto linked bookings | medium (needs the Orbeon HAR for detail) |
| 3 | `ingest-email` edge function + Apps Script for AMUA's Gmail + forwarding guide for personal inboxes | small–medium |
| 4 | Council reference data: contacts, seasons, park catalogue, season/renovation warnings | small |
| 5 | Provider invoices generalised; council as a billing provider | small |

## 10. Open questions

1. **St Cuthbert's College as a vendor:**
   - What legal name, address and GST number go on the PO?
   - What is the hourly rate?
   - How do you book it: an email to a contact, or a form?
2. **Opening St Cuthberts to bookers:** should it stay admin-only for now?
3. **Council portal access:** who holds the portal login, and can the extension run in
   that person's browser?
4. **Mailboxes for the intake:** which ones besides AMUA's Gmail? Each owner needs to
   set up a forwarding filter (option C).
5. **Council fees:** when AMUA applies to the council, are the council's fees passed on
   to clubs through invoices?
