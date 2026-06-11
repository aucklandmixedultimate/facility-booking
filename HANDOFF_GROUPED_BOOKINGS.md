# Handoff: Grouped bookings in one form submission

Status: **LIVE.** The booking request form now creates several bookings (multi-day,
multi-facility, multi-slot, and/or a weekly repeat) from a single submission, and
those bookings stay grouped through the cart and the summary. All code is in
`src/booking-system.jsx`.

## TL;DR

- One form submission can produce **many bookings**. Shared **purpose, notes and
  repetition** are entered once; each **slot** (facility · date · start · duration) is
  staged separately.
- Co-created bookings (anything beyond a single slot) are tagged with a shared
  **`[GRP] <id>`** marker in `booking.system_notes` so the cart and summary present them
  as one group — the same treatment weekly recurrences already get.
- A single slot's weekly recurrence is **not** tagged; it keeps the existing
  weekday-pattern grouping. So nothing about plain recurrences changed.

## Form model (`BookingForm`)

Form-level state (shared across the whole submission):
- `name`, `email`, `purpose`, `notes`, `status` (admin/edit only)
- repetition: `recurMode` (`none` | `weeks` | `until`), `recurWeeks`, `recurUntil`
- `slots: [{ facility_id, date, start_hour, duration, id? }]`

Ways to add slots (new bookings only):
- **📅 Pick on day grid** → `InlineDayPicker` in `multi` mode. Drag a slot, or **drag
  across facility columns** to stage the same time in several fields at once; confirm
  to add them. Each release is one staged pick.
- **✏ Add manually** → appends a slot inheriting the previous slot's
  facility/time/duration (detail propagation).
- Calendar/week **drag across days** → opens the form pre-seeded with one slot per day
  (`prefill.dates` → `booking._dates`).

`SlotRow` renders each slot compactly with an inline availability check. Editing an
existing booking is a single, untagged slot (+ admin status) — no repetition / add-slot
controls.

## Group contract

Markers live in `system_notes` (NOT the user-facing `notes`), next to the other
markers (`[SPLIT]`, `[FNCOST]`, `[CPSA-*]`, `[BILLED]`):

```
[GRP] G<base36-timestamp><rand>
```

Helpers (module scope, near the other system_notes parsers):
- `parseGroupRef(system_notes) -> id | null`
- `setGroupRef(system_notes, id) -> system_notes`
- `newGroupRef() -> "G…"`

Tagging happens in `BookingForm.expandRows()` **only when `slots.length > 1`**:

```js
if (!isEditing && slots.length > 1) {
  const gid = newGroupRef();
  drafts.forEach(d => { d.system_notes = setGroupRef(d.system_notes, gid); });
}
```

`expandRows()` merges shared purpose/notes/status onto every draft and expands each
slot by the repetition rule, then tags. The whole batch is one cart item
(`onAddToCart(drafts, name, email)`).

## Data flow

```
BookingForm (slots + shared fields)
  → expandRows()  → drafts[]  (each has [GRP] gid when slots.length>1)
  → onAddToCart   → ONE cart item { drafts }
  → handleCartSubmit → handleSave → Supabase insert (system_notes persisted, [GRP] kept)
  → summary reads persisted bookings and regroups by [GRP]
```

`handleSave`'s `toDb` only strips `recur`; `system_notes` is a real column, so the
marker persists on insert.

## Where grouping is honored

- **Cart** (`CartModal.groupDrafts`): groups consecutive drafts by `[GRP]` id first,
  then falls back to the legacy weekly heuristic (consecutive weekly, same
  facility/time) for untagged drafts. Render shows a **🔗 N grouped** / **🔁 N× repeat**
  card with the date/field range and a per-slot list.
- **Summary** (`buildOverlapPatternMap`): a booking with a `[GRP]` id goes into a single
  pattern keyed `grp:<id>` regardless of weekday; everything else uses the existing
  facility/weekday/overlap heuristic. The schedule-summary chips (`renderChips`), the
  `SummaryTab` chips, and `PatternModal` special-case `pk.startsWith("grp:")` to render a
  grouped booking (date range · fields · count) instead of parsing a `facility_dn_hour`
  key.

## Gotchas / notes

- The `[GRP]` marker is ignored by every other marker parser and never appears in the
  user-facing notes field (that strips `[CPSA-*]` / `[BILLED]` from `notes`, and the id
  lives in `system_notes`).
- No DB migration: it reuses the existing `system_notes` column.
- A group's members can have **different** facility/time/date. Code that summarises a
  group must not assume uniformity — `PatternModal` and the cart card both compute a
  `uniform` flag and degrade to a date/field range + per-slot list when mixed.
- Bulk edits from `PatternModal` change time/dur/facility but leave `system_notes`
  untouched, so the group id (and grouping) survives.
- Editing a single booking does not tag/untag it; a booking keeps whatever `[GRP]` it
  was created with.
