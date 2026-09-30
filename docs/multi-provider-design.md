# Multi-provider facilities, council bookings and email intake — design

Status: **proposal** (phase 0 shipped; later phases need sign-off).
Start at [`HANDOFF_MULTI_PROVIDER.md`](../HANDOFF_MULTI_PROVIDER.md) for what's live, what's decided and where to resume.
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
3. **Scale.** The council catalogue alone lists 254 parks across four regions (see §7).
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
| `GET /councilonline/orbeon/fr/booking/SportApplicationForm/pdf/{documentId}` | "Export to PDF" of the full form (park, field, dates, times). Same Orbeon document as the application form in §5.3. |

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

### 5.3 The application form (second and third HARs)

`GET /councilonline/application/sportapplication?bookingApplicationType=SEASONAL_ALL_SPORTS_PARKS&productCode=SSPPERMITBK`
opens an **Orbeon Forms** wizard (`SportApplicationForm`). There is no form POST.
- **Protocol:** every field change is an Ajax event
  (`POST /councilonline/orbeon/xforms-server?namespace=<uuid>`) carrying `<xxf:event>`
  XML: `xxforms-value` with the control id and new value, `DOMActivate` for buttons, and
  `fr-search` for the address lookup.
- **Server replies:** control values, validation state and **dropdown itemsets** (JSON
  in `<xxf:itemset>`).
- **Page navigation:** each "Next" first runs
  `validateBookingApplicationForm('next', <documentId>)`.
- **Fee:** `GET /councilonline/yform/rest/getproductpricebycode?productCode=SSPPERMITBK`
  → **$10.00, pay later**. That is the portal's listed product price, but AMUA
  reports that council sports-field bookings are free in practice (see §8).

The wizard has 8 pages. Control names are the stable part of the ids:

| # | Page | Controls |
|---|---|---|
| 1 | Booking | `booking-application-number` (auto), `sportsOrActivity` (35 options — **no "Ultimate"**: use *Other* or *General Sport*), `rso` yes/no + `rsoText`, `sport-booking-type` (casual / seasonal) |
| 2 | Contact details | `booking-activity-name`, `orgName`, `orgType` (Club/Team, Regional sports organisation, School, Social, Other), `postalAddress` (address search → opaque id), primary `pContactPerson` / `pPreferredContactNumber` / `pAdditionalContactNumber` / email / `pPosition`, secondary `s…` equivalents |
| 3 | Key and access code holders | `councilResponsibility` yes/no, `contactName`, `contactNumber`, `emailAddress`, `keyOrAccessCode` |
| 4 | Participant numbers | `junior` + `jNoOfTeam` / `jNoOfPlayer`, `senior` + `sNoOfTeam` / `sNoOfPlayer` |
| 5 | Booking request | `training` / `competition`, then a **repeating "Park details"** section: `firstTrainingDate1` (first date), `control-7` (last date), `region` → `parkName` → repeating field picker `control-1` ("Select preferred fields or wickets"), per weekday `dayOfTheWeek{Mon…Sun}` + `{mon…sun}StartTime` / `EndTime`, `totalPerWeekHour`, `participantNumberAndGrade`; "add another" / "remove" park |
| 6 | Health and safety | `healthAndSafety` confirmation |
| 7 | Standard conditions | `standardConditionsCheck` |
| 8 | Agreement | `agreementCheckOne` / `Two` / `Three`, `fullName`, `positionInOrganization`, `isPayLater` |

Dates are posted as `{"value":"YYYY-MM-DD","format":"[D01]-[M01]-[Y]","excludedDates":[]}`.

**Park catalogue.** Choosing a region loads that region's park list, and choosing a park
loads its fields. For example, *Devonport Domain* → Cricket 1–4, Cricket Nets 1,
General Sport 3, Rugby 1–2. The captured lists are in
[`docs/data/council-sports-parks.json`](data/council-sports-parks.json):

| Region | Parks |
|---|---|
| Central | 62 |
| North | 62 |
| South | 93 |
| West | 37 |
| **Total** | **254** |

The form's list, not the map PDFs, is authoritative: it includes school grounds such as
Aorere College that the maps omit. Dropdown `value`s are list positions, not ids, so
match on labels.

**Reading a lodged application.** A submitted application is the same Orbeon document,
by `documentId`. Opening it read-only exposes the same control names, so the sync can
read `region`, `parkName`, `control-1` fields, dates, weekdays and times into
`external_requests.detail` without any extra reverse-engineering. Still to capture once:
the URL the portal uses to view a lodged document, which is probably the "Export to PDF"
link's `/view/` sibling.

### 5.4 Submitting to the council: a pre-fill assistant, not a bot

Replaying the Orbeon event protocol from a server is fragile: session-scoped UUIDs,
sequence numbers, address-lookup ids, and a payment step. Instead, the extension offers
**"Fill council application"** on the form page, driven by a booking series from the
app. It sets values through the page's own inputs and fires change events, so Orbeon
sends its usual Ajax, and walks pages 1–5:
- sport *Other*;
- organisation and contacts from the **AMUA details** setting (`amua_org`, User menu →
  AMUA details);
- one Park details block per park, with its fields, dates, weekdays and times.

The admin then reviews pages 6–8, ticks the agreements and submits. Nothing is paid:
the bookings are free (§8). The extension reads back the new application number and code into
`external_requests` and links the booking series to it.

**Catalogue refresh.** Park and field lists change. The extension can also harvest them
by iterating region → park in the form and upserting into `council_parks` /
`council_fields` (§7). Each park selection loads its field list, so that is about 254
cheap Ajax calls, run only on demand.

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

The application form's own dropdowns (§5.3) give the authoritative list: **254 parks**
(Central 62, North 62, South 93, West 37), saved in `docs/data/council-sports-parks.json`.
The regional *Sports Fields Maps* PDFs (updated January 2025) are the visual reference
for field layouts. Counts from their tables of contents:

| Region | Summer | Winter |
|---|---|---|
| North | 64 | — |
| Central & Gulf Islands | 66 | — |
| South | 89 | — |
| West | 40 | 39 |

Field numbers and layouts appear only in the map images.

**Don't create 254 facilities.** Instead:
- Seed an admin-only reference list `council_parks(name, region)` and
  `council_fields(park, name)` from `docs/data/council-sports-parks.json`, for
  autocomplete and for routing to the right regional coordinator. The extension keeps
  the lists fresh (§5.4).
- Create a `facilities` row, e.g. "Thompson Park – Field 2", only when AMUA books or
  applies for that park. Record the park and field in `external_ref.council_park` /
  `external_ref.council_field` so the portal sync (§5.3) can match it.

## 8. Billing across providers

- **Purchase orders:** one PO per provider per official run (phase 0). PO vendor
  details come from `providers` (phase 1).
- **Invoices from providers:** generalise the Drive "Invoice (from GTEC)" drop folder to
  `Invoice (from <provider>)`. Generalise `gtecInvoiceNumber` to `providerInvoiceNumber`,
  keeping the old field as an alias.
- **Council fields are free.** Seasonal and casual sports-park bookings cost nothing,
  so council facilities have a $0 rate. They appear on bookers' invoices at $0 (or are
  left off), and they produce **no PO to the council**. `buildProviderPoRecords` should
  skip a provider whose lines total $0.
- **Big-event hire needs an event permit, which is invoiced.** Hiring a council park for
  a large event, such as a tournament, goes through a separate **event permit**, not
  the sports-park application. The permit is charged. Reference invoice: Auckland Council
  tax invoice 234000005905, 28 Aug 2025, for the NZ Tertiary Ultimate Championship at
  Lloyd Elsmore Park: $101.00 GST inclusive, "Event Permit Other Community – Low"
  (product `SBFH_ACEOCL`), service type *Facility hire*, payment due immediately. It
  quotes a contract number and an invoice number, the latter used as the payment
  reference.
  - **Handling:** record the council's invoice against the event, using the provider
    invoice fields and the Drive "Invoice (from Council)" folder, and recharge it to
    the event's organiser or clubs as a one-off invoice line if AMUA wants to recover
    it. No hourly rate is involved.
  - **Addressee:** that permit invoice was addressed to an individual. Future permits
    should be applied for under the AMUA account so the invoice names AMUA.
- **Council vendor details** for the `akl_council` provider row, from that invoice:
  Auckland Council, Private Bag 92300, Auckland 1142, GST 104-736-998. Payment is to
  account 12-3113-0131289-00 ("Auckland Counc"), quoting the invoice number, with
  remittances to direct.credit@aucklandcouncil.govt.nz.

## 9. Phases

The work items, files, acceptance criteria and dependencies are in
[`multi-provider-plan.md`](multi-provider-plan.md).

| Phase | Scope | Size |
|---|---|---|
| 0 ✅ | St Cuthberts facility; provider on facilities; PO per provider; direct approval for non-GTEC | shipped |
| 1 | `providers` / `facilities` tables + migration seeding today's constants; load at start-up with code fallback; admin CRUD; provider-labelled statuses | medium |
| 2 | Extension: council portal sync → `external_requests` (list JSON + Orbeon document detail); status mapping onto linked bookings | medium |
| 2b | Extension: "Fill council application" pre-fill assistant + park/field catalogue harvest | medium |
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
4. **Council profile:** fill in User menu → AMUA details (operations, secondary and
   key-holder contacts, postal address, address-search text).
5. **Mailboxes for the intake:** which ones besides AMUA's Gmail? Each owner needs to
   set up a forwarding filter (option C).
6. **Event permit costs:** council fields are free, so this is the only council charge.
   For big events, should a permit's cost be recharged to the organiser or clubs, or
   absorbed by AMUA?
