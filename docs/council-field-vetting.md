# Vetting council fields — lights, fit for ultimate, and quality tiers

Part of the multi-provider work (see [`HANDOFF_MULTI_PROVIDER.md`](../HANDOFF_MULTI_PROVIDER.md)).
Extends [design §7](multi-provider-design.md#7-council-park-catalogue) and
[plan phase 4](multi-provider-plan.md#phase-4--council-reference-data).

## Problem

The council catalogue has **254 parks** (`docs/data/council-sports-parks.json`), each
with several fields. For example, Devonport Domain lists 8: Cricket 1–4, Cricket Nets 1,
General Sport 3, Rugby 1–2. That's probably 800–1,200 bookable fields. Most are no use
to AMUA:

- **Size and shape:** ultimate needs about 100 × 37 m, including end zones. That rules
  out nets, diamonds, courts and small junior grounds.
- **Lights:** evening play from autumn to spring needs them. The council doesn't
  publish which fields have lights: the map PDFs are images, and the only hint in the
  application form is key-holders for "gates, doors or training lights".
- **Quality:** surface, drainage, flatness and amenities vary widely.
- **Getting a yes:** some parks are fully allocated to rugby or football every season,
  so applying there wastes a round. (The sample decline: "already allocated to another
  club for winter season training".)

We need a way to **triage the catalogue once, vet the shortlist properly, keep the
results current, and use them** when choosing where to apply and when booking.

## Model: a funnel, not a list

```
254 parks / ~1,000 fields
   │  1. auto-triage from field names (no human effort)
   ▼
candidates  (Rugby / Football / League / Touch / General Sport fields, …)
   │  2. desk vetting: maps, satellite view, club knowledge
   ▼
shortlist   (plausible size, reachable, lights status known or suspected)
   │  3. site visit or first-use report
   ▼
vetted      → Tier A / B / C          or      unsuitable (with reason)
   │  4. results from applications and play feed back automatically
   ▼
ranked recommendations when applying and booking
```

Each field carries a **vetting status**:

| Status | Meaning |
|---|---|
| `unreviewed` | Only its name is known |
| `candidate` | Auto-triage says it might suit |
| `shortlisted` | Desk-checked and worth a look |
| `vetted` | Someone has seen or played on it; has a tier |
| `unsuitable` | Ruled out, with a reason |
| `retired` | Gone from the council list |

Only `vetted` fields appear as first choices. `shortlisted` fields appear as "untested".

## What we record per field

Park-level facts (location, parking, toilets) live on the park. Everything else is per
field, because lights and quality differ between fields at the same park.

| Attribute | Values | Source |
|---|---|---|
| `sport_codes` | parsed from the council label: rugby, football, league, cricket, touch, general… | auto (§Triage) |
| `ultimate_fit` | `full` (fits 100×37) · `reduced` (small-sided or training only) · `no` · `unknown` | auto guess, then human |
| `surface` | grass · sand-carpet · artificial · unknown | human |
| `lights` | `none` · `training` (partial, key or code) · `full` (match-standard) · `unknown` | human; **verified** flag + date |
| `lights_access` | how lights are switched on: key holder, code, council-timed | human |
| `quality` | 1–5 for surface, drainage, flatness, line markings | human, averaged over reports |
| `amenities` | toilets, changing rooms, parking, water | human (park level) |
| `season_notes` | e.g. "cricket block in summer", "wet until Oct" | human |
| `reliability` | share of applications for this field that were confirmed, per season | **computed** (§Reliability) |
| `tier` | A · B · C | derived (§Tiers), with an admin override |
| `vetting_status`, `vetted_by`, `vetted_at` | as above | workflow |
| `notes`, photo links | free text; photos in the Drive folder | human |

Lights generalise what the app does today for Cornwall Park, where `FLOODLIT_FIELD_ID`
marks `f3` as the only lit field and `DAY_EVENING_CUTOFF` is 5:30 pm. In the provider
model this becomes the per-facility `external_ref.floodlit` flag from plan 1.2, fed by
the vetting record's `lights` value.

## 1. Auto-triage from names

Council field labels follow `<Park> <Code> <n>`, e.g. "Devonport Domain Rugby 1". A
keyword pass sets `sport_codes` and an initial `ultimate_fit`:

| Label contains | `ultimate_fit` guess | Status |
|---|---|---|
| Rugby, Football, League, Touch, Gaelic, Australian Rules, Lacrosse, General Sport, Training Area | `full` | `candidate` |
| Cricket (outfield; usable only when no match is on, mostly winter) | `reduced` | `candidate`, with a season note |
| Summer Football, Junior, Mini, Small | `reduced` | `candidate` |
| Nets, Wickets, Diamond, Softball, T-ball, Baseball, Netball, Tennis, Bocce, Pétanque, Skate, Car Park, Pond, Bridle, Amphitheatre, Perimeter | `no` | `unsuitable` (auto, reversible) |

This is pure and testable: `scripts/triage-council-fields.mjs` produces a proposed
status for every field. We expect it to cut the ~1,000 fields to a few hundred
candidates with no human effort.

Field lists are loaded per park, so they have to be harvested first, by the extension's
catalogue refresh in plan 2.5.

## 2. Prioritising what to vet

Vetting a few hundred fields by hand is still too much. Vet in order of usefulness:

1. **Where AMUA plays:** within about 20 minutes of where most members and teams are.
   Suburb or region is enough; exact geocoding is optional.
2. **Where lights are likely:** parks with multiple senior rugby, football or league
   fields and a clubroom. Clubs train at night, so lights are common there.
3. **Where others already know:** crowd-source from captains and club members (§4).

Admins pick a region and work through its candidates in a **vetting queue**: one field
at a time, with its label, a map link and a satellite link. Marking each one takes a
few clicks.

## 3. Tiers

Tiers turn many attributes into one decision: **where do we ask first?**

| Tier | Meaning | Rule of thumb |
|---|---|---|
| **A — go-to** | Full-size, good surface; applications here usually succeed | `ultimate_fit = full` · `quality ≥ 4` · `reliability ≥ 70%` (or untested) |
| **B — solid backup** | Playable, with some compromise | `full` or good `reduced` · `quality ≥ 3` · reliability unknown or ≥ 40% |
| **C — last resort** | Usable in a pinch | anything else that isn't `unsuitable` |

**Lights are not part of the tier** (decided 30 Sep 2026). They only matter for evening
slots, so each field also shows **Evening OK** (lights are `training` or `full`), and
evening bookings and applications filter on it separately from the tier.

The tier is **computed** from the attributes and shown with the reason ("B: quality 3,
reliability 45%"). An admin can **override** it with a note, e.g. "A: great in summer,
C in winter". Tiers can differ by season: store a winter and a summer tier when
`season_notes` warrant it.

## 4. Crowd-sourced field reports

Captains and members play on these fields, so they're the cheapest source of truth.
- **Only admins edit field records** (decided 30 Sep 2026). Everyone else feeds in
  through reports that an admin accepts.
- After a council booking has been played, the app asks the booker for a **30-second
  report**: surface 1–5, lights (worked / weren't on / none), fit (full / tight /
  unusable), a free-text note, and an optional photo.
- Admins can also file a report after a site visit.
- Reports go into a `field_reports` table. Accepted reports update the field's
  `quality` (running average), `lights` (with a verified date) and `ultimate_fit`. An
  admin accepts or dismisses each one, so one bad night doesn't downgrade a good field.
- A field with no report for about 18 months, or reported since a spring renovation,
  shows as *stale* and goes back into the vetting queue.

## 5. Reliability, computed from applications

Once the council sync (plan 2.2–2.3b) records each application's parks and fields and
their outcomes:

```
reliability(field, season) = confirmed / (confirmed + declined)
```

It counts applications that asked for that field in that season (winter or summer), and
is shown with its sample size ("3/4 confirmed, winter"). Emailed outcomes (plan 3.2)
count too. Fewer than 2 applications shows "untested", not 0% or 100%. The decline
reason text in coordinators' emails ("already allocated…") is kept as a note on the
park.

## 6. Where the vetting shows up

- **Choosing where to apply (plan 2.4 pre-fill):** the side panel suggests fields from
  Tier A first, filtered by the series' region, weekday, and times after sunset (which
  need lights). One click adds a lower-tier backup field to the same application.
- **Booking form and admin review:**
  - A warning if an evening booking is on a field with `lights = none` or `unknown`.
    This replaces the fixed 5:30 pm cutoff with the actual sunset time for the date,
    computed from Auckland's latitude, so no API is needed.
  - The tier badge and lights icon are shown next to council facilities.
- **"Council fields" admin screen:**
  - filters by region, status, tier, lights, fit and stale;
  - bulk edit;
  - **Promote to facility** creates the `facilities` row (plan 1.3) with
    `external_ref.council_park/field` filled, when AMUA first wants to book there.
- **Reports and exports:** a CSV of vetted fields by region and tier, for sharing with
  the committee.

## Data model additions

These extend the plan 4.1 tables:

```sql
alter table council_parks
  add column suburb text, add column lat numeric, add column lng numeric,
  add column amenities jsonb not null default '{}',   -- {toilets, changing, parking, water}
  add column notes text;

alter table council_fields
  add column sport_codes   text[] not null default '{}',
  add column ultimate_fit  text   not null default 'unknown'  check (ultimate_fit in ('full','reduced','no','unknown')),
  add column surface       text   not null default 'unknown',
  add column lights        text   not null default 'unknown'  check (lights in ('none','training','full','unknown')),
  add column lights_access text, add column lights_verified_at date,
  add column quality       numeric,                              -- 1–5 running average
  add column tier_override text check (tier_override in ('A','B','C')), add column tier_note text,
  add column season_notes  text,
  add column vetting_status text not null default 'unreviewed'
            check (vetting_status in ('unreviewed','candidate','shortlisted','vetted','unsuitable','retired')),
  add column unsuitable_reason text,
  add column vetted_by text, add column vetted_at timestamptz,
  add column notes text;

create table field_reports (
  id bigserial primary key,
  field_id bigint not null references council_fields(id),
  booking_id text,                        -- the booking it came from, if any
  reporter_email text not null,
  surface smallint check (surface between 1 and 5),
  lights text check (lights in ('worked','off','none')),
  fit text check (fit in ('full','tight','unusable')),
  note text, photo_url text,
  status text not null default 'pending' check (status in ('pending','accepted','dismissed')),
  created_at timestamptz not null default now()
);

-- Reliability per field and season, from external_requests.detail (plan 2.3b).
create view field_reliability as … ;  -- confirmed / (confirmed + declined), with sample size
```

The computed tier is a SQL view or app function over these columns; `tier_override`
wins when set.

**RLS:**
- `council_parks`, `council_fields`: readable by signed-in users, writable by admins.
- `field_reports`: any signed-in user can insert their own; only admins can read all
  reports or change their status.

## Work items

These slot into plan phase 4 as 4.4–4.8, after 4.1 (catalogue) and 2.5 (field-list
harvest):

| # | Item | Size |
|---|---|---|
| 4.4 | Migration: vetting columns, `field_reports`, `field_reliability` view | S |
| 4.5 | `scripts/triage-council-fields.mjs` + tests; apply the proposed statuses | S |
| 4.6 | "Council fields" admin screen: filters, vetting queue, bulk edit, promote to facility | M |
| 4.7 | Field reports: post-booking prompt, admin accept/dismiss, rolling up into field attributes | M |
| 4.8 | Use it: tier/lights badges, sunset-based lights warning, tier-ordered suggestions in the pre-fill | M |

## Vetting tool (live)

**Admin menu → Council fields** opens `vetting.html` on the booking site. Its source is
`vetting.html` and `src/vetting/`; the maps and park data are in `public/council-maps/`.
The page always fits one screen: nothing scrolls except the map, where the wheel zooms.
- **Auckland view** (C toggles it). It opens framed from North Harbour Stadium to Opaheke
  Sports Park. Every park is plotted across the city and coloured by its overall
  suitability: excellent, good, fair, poor, rejected, or not rated. Top picks
  have a gold ring. The legend folds away (collapsed by default on phones). Zoom in to see each park's council fields shaded in the same colour.
  Click a park to open and rate it. Deciding returns you to the Auckland map. **Rate next**
  jumps to the next unrated park in the queue.
  - Suitability starts from quality (x/5).
  - Fit adjusts it: +0.2 for 2+ fields, +0.1 for 1 full field, −0.15 for reduced size.
  - Lights add 0.1, and a top pick adds 0.15.
  - A rejected park scores 0.
- **Park view.** One park per card. Swipe the title bar, or use ← → ↑: reject, shortlist or
  top pick. **Later** (S) moves the park to the back of the queue, and **Undo** (Z) takes
  back the last decision.
- **Live satellite map.** The map is Esri World Imagery (no key needed; attribution
  shown). The council's field map is laid over it at its true position: every council
  map page is a GeoPDF (EPSG:2193), and its corner coordinates give the bounds. Zooming
  two or three wheel clicks in or out from the fitted map drops the council map to show
  the satellite, and **⤢** zooms back to it. The council's field outlines are traced from
  the PDF vectors and their names read by OCR (`maps[].fields` in `parks.json`), so they
  stay visible as dashed outlines over the satellite.
- **Ultimate field to scale.** The field is WFDF standard: 100 × 37 m, 18 m end zones,
  brick marks 20 m in. It's editable under ⚙. It stays centred in the frame and scales
  with zoom, so you pan the map underneath it to test a spot.
  1. **Unlock** the centre button (Enter). Move the mouse to turn the field (on a phone, drag
     out from the button) and drag the map to move it.
  2. **Lock** it by clicking the map or the button. The field is pinned to that spot, so
     panning afterwards moves the map under it. The bar at the bottom previews the nearest
     council field.
  3. **Rate the fit**: reduced size, 1 full field or 2+ fields. Rating confirms the pinned
     spot. It records the centre and angle, and fills **Fields** with the nearest traced
     council field (with 2+ fields, every field within about 120 m).
  Unlocking recentres on the field so you can move or turn it again. Relocking somewhere
  else shows "Moved" until you rate again. Only the confirmed spot is ever saved, and a
  saved spot is pinned when you reopen the park.
- **Privately managed grounds (◆).** Some council grounds are run by a club, trust or
  CCO, e.g. Grammar TEC at Orakei Domain B. They show as purple diamonds, and hollow
  diamonds mark private grounds that aren't in the council maps. Their card shows the
  operator to contact.
  The data is in `public/council-maps/private-managed.json`; see multi-provider design §7.1.
  The card shows only who to contact. The request steps belong to booking, not vetting.
- **Lights.** Drag a 💡 bulb from the dispenser at the top right of the map onto each light
  pole. Drag a placed bulb to move it, or drag it back onto the dispenser (or click it) to
  remove it. Any bulb marks the park as lit. **No lights** records that you checked and
  there aren't any. Lights only matter for evening slots.
- **Saving the position.** Once a spot is confirmed and at least three of quality, fit,
  lights and fields are set, a decision asks whether to save the confirmed spot. The position is the centre
  lat/lon, the angle and the dimensions. Saved positions are restored next time and
  place the park on the Auckland map.
- **Saving.** Decisions go to Supabase `field_reviews`, admin-only
  (`supabase-migration-field-reviews.sql`; re-run it for the "2+ fields" option).
  `placement` holds the field position and the light poles. Until the migration is run,
  decisions stay in the browser. **Download CSV** exports them.

## Manual data entry, until the app screens exist

Use [`docs/data/council-field-vetting.xlsx`](data/council-field-vetting.xlsx). Yellow
cells are inputs and grey cells are calculated.
- **Parks:** all 254 parks, with priority, status, amenities and notes. Rollups show
  fields entered and vetted, the count per tier, and the best tier.
- **Fields:** one row per council field, with an auto fit guess from its name, and
  dropdowns for fit, surface, lights, season, status and tier override. It calculates
  reliability, Evening OK, the computed tier and the final tier. Pre-filled with
  Devonport Domain's 8 fields.
- **Summary:** counts by region.
- **Settings:** the tier thresholds, editable.

The columns mirror the `council_parks` / `council_fields` tables above, so the sheet can
be imported when 4.4 lands.

## Decisions

- **Who vets:** admins only. Others contribute through field reports.
- **Lights:** needed for evening slots only, and not part of the tier.

## Open questions

1. **Home base:** which areas count as "where AMUA plays", to prioritise vetting (list
   suburbs or regions)?
2. **Tier thresholds:** are the rule-of-thumb numbers right? They're editable on the
   spreadsheet's Settings sheet.
3. **Existing knowledge:** is there an existing list, spreadsheet or group chat of known
   good council fields? Importing it would seed Tier A immediately.
