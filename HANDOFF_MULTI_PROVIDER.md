# Handoff: Multi-provider facilities (GTEC, St Cuthberts, Auckland Council)

Status: **PARTLY LIVE.** The groundwork is shipped: St Cuthberts is bookable and billed
on its own PO, and AMUA's details are editable. Full integration (providers stored in
Supabase, council portal sync, email intake) is **designed and planned, not built**.
This file is the entry point: what exists, what's decided, and where to pick up.

**Read with:**
- [`docs/multi-provider-design.md`](docs/multi-provider-design.md): *why* and *what*.
  Data model, council portal findings, email intake, billing.
- [`docs/multi-provider-plan.md`](docs/multi-provider-plan.md): *how*. Build-ordered
  work items with files, acceptance criteria, sizes and a dependency graph.
- [`docs/data/council-sports-parks.json`](docs/data/council-sports-parks.json): the
  council park catalogue and dropdown lists captured from the portal.

## TL;DR

- AMUA books facilities from several **providers**: **GTEC** (Cornwall Park fields
  and rooms, via Sporty; the only one fully integrated), **St Cuthbert's College** (St
  Cuthberts Field #1; manual), and **Auckland Council** (sports parks via the
  myAUCKLAND portal; designed).
- Every facility now names its `provider`. Official invoicing raises **one PO per
  provider**.
- AMUA's organisation details and contacts are an admin setting (**User menu → AMUA
  details**), not code.
- Next step: move providers and facilities into Supabase (plan phase 1). The council
  sync and email intake build on that.

## What's live

| Area | Where | Notes |
|---|---|---|
| `provider` on every facility; `PROVIDERS` registry; `providerOfFacility()` | `src/booking-system.jsx`, `FACILITIES` / `PROVIDERS` | Interim: in code. Phase 1 moves it to Supabase. |
| **St Cuthberts – Field #1** (`s1`, provider `stcuthberts`, recipient code `STC`) | `FACILITIES` | Admin-only, **no rate yet**; set it in Facility Rates. Vendor address and GST are blank in `PROVIDERS.stcuthberts`. |
| One PO per provider | `buildProviderPoRecords` (Summary tab → official run) | Lines carry `facilityId`. A GTEC-only run is unchanged. Batch cards show *N POs*; chips read `PO · <provider>`. |
| Drive filing per provider | `drivePoFolderName`, `driveSyncRecords` | `PO (to <provider>)`. "Invoice (from GTEC)" is still GTEC-only (plan 1.5). |
| Non-GTEC workflow | Bookings list actions | No "Queue for GTEC"; approve directly from *Pending AMUA Review*. |
| **AMUA details** setting | `amua_org` in `settings`; `AmuaDetailsModal`; `applyAmuaOrg()` → `AMUA_INFO` | Organisation (name, postal address, GST, bank); operations, secondary and key-holder contacts; council answers (RSO, organisation type, address search). Printed on documents; the operations contact goes in the letterhead. |
| Invoices group linked emails under the main email | `invKey()` / `invSplitShare()` in `SummaryTab` | Prerequisite for multi-club billing. |

## What's designed, not built

In order (see the plan for detail):

1. **Providers and facilities in Supabase:**
   - `providers`, `facilities`, `provider_contacts` and `provider_seasons` tables;
   - start-up loader that fills `FACILITIES` / `PROVIDERS` in place, with the code
     constants as fallback;
   - admin editor;
   - provider-labelled statuses ("Queued for Council"), keeping the stored
     `queued_cpsa` keys;
   - the extension's Sporty labels and pickup filter come from Supabase.
2. **Council portal (extension):**
   - list sync into `external_requests`;
   - status mapping onto linked bookings with a `[COUNCIL …]` marker;
   - reading application detail;
   - a **"Fill council application"** pre-fill assistant (admin reviews and submits);
   - optional catalogue harvest.
3. **Email intake:** `ingest-email` edge function, Gmail Apps Script in AMUA's inbox,
   and forwarding filters from other inboxes, which update applications from
   coordinators' replies.
4. **Council reference data:** 254-park catalogue, coordinator contacts, season windows,
   and warnings.
5. **Billing:** free council fields ($0, no council PO), event permits as provider
   invoices, and reconciliation of provider invoices against POs.

## Evidence gathered

The captures themselves are **not in the repo**: they contain session and account data.
What they showed is recorded in the design doc:

| Source | Findings | Design doc |
|---|---|---|
| Council portal HAR — *my applications* | JSON list `paginated-booking-applications`: code, 8-hex application number, name, status (`SUBMITTED` … `CANCELLED`), dates, `documentId`. Session cookie only; no public API. | §5.1–5.2 |
| Council portal HARs — *new application* | Orbeon XForms wizard with 8 pages, Ajax events; control names per page; region → park → field chained dropdowns; the 254-park catalogue. | §5.3–5.4, §7 |
| Council "view application" | **Not yet captured.** "Export to PDF" opens a new tab that DevTools didn't record. | Plan 2.0 |
| Coordinator email (`.eml`) | Subject `"<Org> - <Park>(<detail>) - Casual Application # <8hex>"`; outcome in the body. The number matches the portal's application number. | §6 |
| Field-map PDFs and the season/contacts tables | Regional park maps; the 2026/27 summer calendar; four regional coordinators. Only roles are kept in the repo. | §6.3, §7 |
| Council tax invoice (event permit) | Fields are free. Big-event hire needs a paid **event permit** (e.g. $101 "Community – Low"). Council vendor details: Private Bag 92300, Auckland 1142, GST 104-736-998. | §8 |

## Decisions and known facts

| # | Topic | Status |
|---|---|---|
| 1 | **St Cuthbert's vendor** | Likely legal name *St Cuthbert's College Educational Trust Board* (charity CC21007), 122 Market Road, Epsom, Auckland 1051. Hire through the Collegiate Centre (collegiate@stcuthberts.school.nz). **Open:** GST number (from their invoice), hourly rate, confirm legal name and address. |
| 2 | **Council account** | Portal login is `aucklandmixedultimate@gmail.com`, the same Google account as the app and extension admin. The sync runs in that browser session. No credentials are stored. |
| 3 | **Council pre-fill profile** | Comes from **AMUA details**. **Open:** enter real contacts, key holder, postal address and address-search text. |
| 4 | **Inboxes to connect** | AMUA's Gmail (Apps Script). Other clubs' inboxes forward to it, e.g. `auultimateclub@gmail.com`. **Open:** confirm the list. |
| 5 | **Council charges** | Fields are free. **Open:** are big-event permit costs recharged to organisers or clubs, or absorbed? |
| — | **"Ultimate" isn't a council sport option** | Apply as *Other* (or *General Sport*). |

## Contracts to keep stable

- **Stored status keys:** `queued_cpsa`, `pending_cpsa`, `cpsa_confirmed`,
  `cpsa_review_needed`, and the `[CPSA …]` markers. The extension depends on them (see
  `HANDOFF_SUPABASE_AUTH.md`). Relabel them per provider; don't rename them.
- **Facility ids:** `f1`–`f5`, `g1`–`g3`, `s1` are referenced by existing bookings and
  billing lines. Disable facilities; never delete them.
- **`bookerEmail` on PO records** is the provider id (`gtec`, `stcuthberts`, …). Code
  that detects POs must use `type === "purchase_order"`.

## Where to resume

1. Get decision 1 settled. Enter St Cuthbert's GST and address. After phase 1 this is
   done in the admin editor; until then, in `PROVIDERS.stcuthberts`.
2. Start **plan phase 1.1**: `supabase-migration-providers.sql` with seed data that
   mirrors today's `FACILITIES` / `PROVIDERS` exactly, so the app doesn't change when
   the loader (1.2) lands.
3. Capture the **"view application" HAR** (plan 2.0): open the Export-to-PDF link in a
   tab that DevTools is recording. It's needed before the council sync can read park,
   field and times.
4. Extension work happens in `aucklandmixedultimate/amua-booking-extension`:
   - content scripts under `src/content/`;
   - Supabase access in `src/shared/supabase.ts`;
   - side panel in `src/sidepanel/App.tsx`;
   - the Sporty label map `FACILITY_MAP` in `src/shared/mappings.ts`, to be replaced
     by `facilities.external_ref.sporty_label`.
