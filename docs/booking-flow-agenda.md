# Booking workflow — at a glance

**One line:** Booker request → AMUA review → submit to CPSA (Sporty) → sync vs CPSA → resolve any mismatch → bill & invoice.
**Owners:** 🟦 Booker · 🟪 AMUA (admin) · 🟦 Vendor / CPSA &nbsp;|&nbsp; ✉ = notification

```mermaid
flowchart LR
    B["🧑 1 · Booker<br/>submits request"]:::booker
    R{"🏛 2 · AMUA<br/>review"}:::amua
    S["🏛 3 · Submit to CPSA<br/>on Sporty"]:::amua
    Y{"🏛 4 · Sync<br/>vs CPSA"}:::amua
    M["🏛 5 · Resolve mismatch<br/>adopt CPSA · keep ours · inform vendor"]:::amua
    I["🏛 6 · Bill &amp; invoice<br/>credit · deficit · none"]:::amua
    V["🏟 Vendor / CPSA<br/>confirms / corrects"]:::vendor
    OK["Approved / Confirmed"]:::booker
    DONE["Invoiced"]:::booker

    B --> R
    R -->|"field ✉"| S
    R -->|"room ✉"| OK
    S --> V --> Y
    Y -->|"match ✉"| OK
    Y -->|"differs ✉"| M
    M -->|"inform ✉"| V
    M --> I -->|"✉"| DONE

    classDef booker fill:#dbeafe,stroke:#2563eb,color:#1e3a8a;
    classDef amua fill:#ede9fe,stroke:#7c3aed,color:#4c1d95;
    classDef vendor fill:#cffafe,stroke:#0891b2,color:#155e75;
```

**Talking points**
- Only **sports fields** go through CPSA; meeting/function rooms are approved directly.
- Sync runs **automatically (~4h)** or on demand, and also flags booking **clashes**.
- Mismatches are resolved **per field** — adopt CPSA's value, keep ours, or ask the vendor to correct CPSA.
- Billing adjusts on the **booking we keep** vs the amount billed: cheaper → **credit**, dearer → **deficit**, same → **no change**.
- All emails route through AMUA's single outbox (sendable/mutable) → booker (status, mismatch, invoice) and vendor (correction request).

> Full detail: see [`booking-data-flow.md`](./booking-data-flow.md).
