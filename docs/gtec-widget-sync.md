# "Sync from GTEC" in the Booking Autofill extension

The booking site's **🔄 Sync** reads GTEC's calendar (`MonthCalendarEvents` on
carltonjuniorsrugby.co.nz). That API sends no CORS headers, so the site can't read it directly:
it tries the `gtec-feed` edge function first, then free public relays. Either can fail. The
FacilityBook widget (the Booking Autofill browser extension)
can read the feed itself, because an extension with host permission isn't bound by CORS. Its
**🔄 Sync from GTEC** button reads the months and pushes them to FacilityBook. The booking site
then syncs them exactly as if it had fetched them.

## Contract

The widget writes one row per month to the `gtec_feed` table (`supabase-setup.sql` v10):

| column | value |
|---|---|
| `month` | `"YYYY-MM"`, primary key (upsert on it) |
| `events` | GTEC's event list for that month, **exactly as the API returned it** (a JSON array) |
| `fetched_at` | when the widget read GTEC (ISO time) |
| `source` | `"widget"` |
| `pushed_by` | who pressed the button, as first name + last initial (`"Rory H."`), or null |

- **Admins only.** RLS allows only admins (`app_metadata.role = "admin"`) to read or write. Use
  the widget's existing Supabase sign-in.
- **Which months:** this month through at least three months ahead, the same as the site's sync.
  Push only months the API answered with a list. Never push a failed read as `[]`.
- **What the site does:** when an admin opens the booking site or switches back to its tab, it
  syncs every pushed month (this month onward) whose `fetched_at` is newer than that month's
  last good sync. It also uses a pushed month as a fallback when its own read fails. Saved GTEC
  blocks are never removed on a failed or doubtful read.
- **URL:** the same as `cjrMonthUrl()` in `src/gtecFeed.js`. If one changes, change both.

## Where it's implemented

In [amua-booking-extension](https://github.com/aucklandmixedultimate/amua-booking-extension)
(the Booking Autofill extension):

- `src/shared/gtecFeed.ts`: reads the months, pushes the rows (`syncFromGtec`).
- Side panel (`src/sidepanel/App.tsx`): the **🔄 Sync from GTEC** bar, highlighted while the
  active tab is GTEC's calendar.
- Content script (`src/content/bookingInjector.ts`): a floating **🔄 Sync to FacilityBook**
  button on GTEC's calendar pages. It asks the side panel through the background worker,
  because the side panel holds the Supabase sign-in.
