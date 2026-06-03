# Facility Booking — Data & Process Flow

An executive view of how a booking moves from request to invoice, and the data captured along the way.
Node **colour = who owns that step**: 🧑 Booker · 🏛 AMUA (admin) · 🏟 Vendor / CPSA. Grey = shared data/system. ✉ = a notification, coloured by who receives it. Superscripts ¹–⁵ point to the [Notes](#notes).

## Colour key

| Colour | Actor | Role |
|---|---|---|
| 🟦 Blue | **Booker** | A club member requesting a facility; receives notifications and invoices. |
| 🟪 Purple | **AMUA** | Auckland Mixed Ultimate (the club/admin) — reviews, submits, syncs, resolves, bills. Also runs the automated sync. |
| 🟦 Teal | **Vendor / CPSA** | The external facility authority that owns the official schedule (managed on "Sporty"). |
| ⬜ Grey | **Data / system** | Shared records: bookings DB, sync results, audit markers. |

## Flow

```mermaid
flowchart TD
    %% ---------- LEGEND ----------
    subgraph KEY["Colour key"]
        direction LR
        LB["🧑 Booker"]:::booker
        LA["🏛 AMUA admin"]:::amua
        LV["🏟 Vendor / CPSA"]:::vendor
        LD[("🗄 Shared data / system")]:::data
    end

    %% ---------- 1. REQUEST ----------
    subgraph P1["1 · Request"]
        B1["🧑 Booker submits request<br/>date · field · time · purpose"]:::booker
    end
    B1 --> DB[("🗄 Bookings database<br/>status = Pending AMUA Review 1/4")]:::data

    %% ---------- 2. AMUA REVIEW ----------
    subgraph P2["2 · AMUA review"]
        A1{"AMUA reviews request"}:::amua
        AR["Rejected"]:::amua
        AP["Approved 4/4<br/>meeting / function room¹"]:::amua
        AQ["Queued for CPSA 2/4<br/>sports field¹"]:::amua
    end
    DB --> A1
    A1 -->|Reject| AR
    A1 -->|"Approve · room¹"| AP
    A1 -->|"Approve · field¹"| AQ
    AR --> EBR["✉ Booker: rejected⁵"]:::booker
    AP --> EBA["✉ Booker: approved⁵"]:::booker
    AQ --> EBQ["✉ Booker: queued for CPSA⁵"]:::booker

    %% ---------- 3. CPSA SUBMISSION ----------
    subgraph P3["3 · CPSA submission"]
        A2["AMUA submits to CPSA on Sporty<br/>saves CPSA ref + link³"]:::amua
        PC["Pending CPSA Review 3/4"]:::amua
        V1["🏟 Vendor / CPSA records booking<br/>on official schedule"]:::vendor
    end
    AQ --> A2
    A2 --> PC
    PC --> V1

    %% ---------- 4. SYNC ----------
    subgraph P4["4 · Sync"]
        A3["AMUA syncs CPSA schedule<br/>automatic ~4h or manual²"]:::amua
        M{"CPSA record matches<br/>our booking?"}:::amua
        CC["🌐 CPSA Confirmed"]:::amua
        RN["⚠ CPSA Mismatch — AMUA Review<br/>discrepancy recorded³"]:::amua
        CL["⚠ Clash flagged²"]:::amua
    end
    V1 --> A3
    A3 --> M
    A3 -.-> CL
    A3 --> SR[("🗄 Sync results<br/>+ timestamp")]:::data
    M -->|Match| CC
    M -->|Differs| RN
    CC --> EBC["✉ Booker: confirmed⁵"]:::booker
    RN --> EBM["✉ Booker: mismatch, being clarified⁵"]:::booker

    %% ---------- 5. MISMATCH RESOLUTION ----------
    subgraph P5["5 · Mismatch resolution (AMUA)"]
        A4{"AMUA resolves<br/>per field"}:::amua
        RAM["Amend to CPSA values<br/>→ 🌐 Confirmed · log date+time³"]:::amua
        RCF["CPSA verbally confirmed ours<br/>→ keep our values"]:::amua
        RIC["Inform CPSA"]:::amua
    end
    RN --> A4
    A4 -->|"Adopt CPSA"| RAM
    A4 -->|"Ours is right"| RCF
    A4 -->|"Ask CPSA to fix"| RIC
    RIC --> EV["✉ Vendor: correction request + link⁵"]:::vendor
    EV --> V2["🏟 Vendor / CPSA corrects schedule"]:::vendor
    V2 -.->|re-sync| A3

    %% ---------- 6. BILLING ----------
    subgraph P6["6 · Billing & invoicing (AMUA)"]
        A5{"Reconcile kept booking<br/>vs amount billed⁴"}:::amua
        BCR["💚 Credit<br/>deduct from next invoice"]:::amua
        BDF["📨 Deficit<br/>add to next invoice"]:::amua
        BNA["✓ No adjustment<br/>field change only"]:::amua
        INV["AMUA issues invoice<br/>credits / deficits applied"]:::amua
    end
    RAM --> A5
    RCF --> INV
    A5 -->|"Kept cheaper"| BCR
    A5 -->|"Kept dearer"| BDF
    A5 -->|"Same price"| BNA
    BCR --> INV
    BDF --> INV
    BNA --> INV
    INV --> EBI["✉ Booker: invoice⁵"]:::booker

    classDef booker fill:#dbeafe,stroke:#2563eb,color:#1e3a8a;
    classDef amua fill:#ede9fe,stroke:#7c3aed,color:#4c1d95;
    classDef vendor fill:#cffafe,stroke:#0891b2,color:#155e75;
    classDef data fill:#f1f5f9,stroke:#94a3b8,color:#334155,stroke-dasharray:4 3;
    style KEY fill:#ffffff,stroke:#cbd5e1,color:#475569
    style P1 fill:#fafafa,stroke:#e2e8f0,color:#64748b
    style P2 fill:#fafafa,stroke:#e2e8f0,color:#64748b
    style P3 fill:#fafafa,stroke:#e2e8f0,color:#64748b
    style P4 fill:#fafafa,stroke:#e2e8f0,color:#64748b
    style P5 fill:#fafafa,stroke:#e2e8f0,color:#64748b
    style P6 fill:#fafafa,stroke:#e2e8f0,color:#64748b
```

## Data captured

| Store | Holds |
|---|---|
| **Bookings DB** (Supabase) | the booking, its workflow status, and `system_notes` audit markers³ |
| **`system_notes` markers** | CPSA submission ref + Sporty link; original pre-amendment values; resolution outcome + billing state + **logged date & time**; the billed-amount snapshot |
| **Activity log** (Supabase) | every action (sign-in, email sent, settle, etc.), timestamped |
| **Sync results** (local) | per-month sync outcome with a `syncedAt` timestamp |
| **AMUA cart** (outbox) | all queued emails — sent only on submit⁵ |

## Notes

1. **Which bookings touch CPSA.** Only sports fields route through CPSA. Meeting/function rooms are approved directly by AMUA (status → *Approved 4/4*) and skip the CPSA submission, sync and confirmation steps.
2. **Sync & clashes.** AMUA's app re-syncs CPSA's official schedule automatically (roughly every 4 hours) or on demand. The same pass flags overlaps between AMUA/admin bookings and member bookings as *clashes* for AMUA to triage.
3. **Audit trail.** Each booking's `system_notes` carries the CPSA submission reference and Sporty link, the original values before any amendment, and the resolution marker — outcome, billing state, and the **date *and time*** it was logged. The amount billed is snapshotted so later drift can be reconciled.
4. **Billing reconciliation.** Adjustments are measured on the values AMUA **keeps** versus the amount already billed: kept booking cheaper ⇒ a **credit** to the booker; dearer ⇒ a **deficit** added; identical price ⇒ **no adjustment** (e.g. a swap to a same-rate field). Credits and deficits flow into the booker's next invoice.
5. **Notifications.** Every email is queued into AMUA's single "cart" outbox and sent only when AMUA submits; a *silent mode* switch can mute sending. Delivery is via a Supabase Edge Function → EmailJS, so no email credentials ship in the browser. Emails to the **booker** cover approval/queue/confirm/reject, mismatch notices and invoices; the one email to a **vendor** is the *Inform CPSA* correction request.

---
*Definitions —* **Booker:** a club member requesting a facility. **AMUA:** Auckland Mixed Ultimate, the club/admin running the system. **Vendor / CPSA:** the external facility authority whose official schedule lives on "Sporty"; *Inform CPSA* emails a specific vendor contact to correct it.
