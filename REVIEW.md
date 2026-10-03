# Code review checklist

Blocking — a PR that breaks one of these doesn't merge:

- [ ] **Email rule:** nothing emails a vendor, the council or a non-booker directly; vendor mail
      goes through `sendEmail` (→ AMUA draft). New email paths respect silent mode.
- [ ] **Privacy:** names shown or stored as first name + last initial.
- [ ] **SQL:** schema changes only in `supabase-setup.sql`, re-runnable, `schema_version` bumped;
      new RLS policies are no wider than needed (admins write; users write only their own rows).
- [ ] **Degrades gracefully** before the SQL has been run (missing column/table → clear message,
      no crash, nothing lost).
- [ ] **No lost updates:** shared settings use `settings_merge`; cart/queue actions apply on submit.
- [ ] **Status changes** still happen in silent mode (only emails are suppressed).
- [ ] **Both widths:** works at 390 px and desktop, no horizontal page overflow.
- [ ] `npm run check` passes (lint 0 errors, tests, build); CI green.

Also look for:

- Filters applied in one view but not its sibling (e.g. Grouped vs Itemised, table vs map pins).
- Components defined inside render (remount on every keystroke) and state set inside effects.
- New `let` module state written outside `core.jsx` without `setModuleState`.
- Interface wording: "vendor", not "provider"; vendor stages named via `statusLabelFor`.
