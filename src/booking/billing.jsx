import { useState, useMemo, Fragment } from "react";
import { downloadDriveFile, DRIVE_ROOT_FOLDER, testDriveConnection, disconnectDrive } from "../drive-client.js";
import { AMUA_INFO, CopyableTable, Modal, PROVIDERS, S, VENDOR_GTEC, amuaContactLine, deriveRecipientCode, fmtCost, fmtDate, fmtDateShortDow, genBankRef, todayKey } from "./core.jsx";
// Invoice modal sub-components defined at module level so their references
// are stable across SummaryTab re-renders — prevents focus loss on the Name input.
export function InvoiceOptionRow({label, children}) {
  return (
    <div style={{display:"flex",alignItems:"flex-start",gap:10,flexWrap:"wrap"}}>
      <span style={{fontSize:12,fontWeight:600,color:"#64748b",minWidth:90,paddingTop:5}}>{label}</span>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",flex:1}}>{children}</div>
    </div>
  );
}
export function InvoicePill({active, onClick, children}) {
  return (
    <button onClick={onClick} style={{padding:"4px 12px",borderRadius:8,border:active?"1.5px solid #0f172a":"1.5px solid #e2e8f0",background:active?"#0f172a":"#f8fafc",color:active?"#fff":"#475569",fontWeight:600,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>
      {children}
    </button>
  );
}

export const PIPELINE_STATES = [
  { key:"draft",         label:"Draft",           color:"#94a3b8", description:"Invoice created, not yet submitted" },
  { key:"submitted",     label:"Submitted",        color:"#f59e0b", description:"Sent to Grammar TEC" },
  { key:"gtec_invoiced", label:"GTEC Invoice Rcvd",color:"#3b82f6", description:"Received invoice from Grammar TEC" },
  { key:"club_invoiced", label:"Invoiced to Club", color:"#8b5cf6", description:"Invoice sent to club for payment" },
  { key:"complete",      label:"Complete",         color:"#22c55e", description:"All payments settled" },
];
export const PIPELINE_KEYS = PIPELINE_STATES.map(s=>s.key);

// ─── Billing document rendering (module scope — shared by BillingTab download
// and the Drive sync in App) ──────────────────────────────────────────────────
// ─── Shared invoice/PO/receipt document renderer ─────────────────────────────
// One layout for every billing document — the draft invoice from the summary tab,
// the emailed preview, and the official records filed to Drive — so they can't drift
// apart. Line items are explicitly paginated into sheets: each sheet carries a subtotal
// for its own rows only, with brought/carried-forward figures, and the grand total
// appears once on the final sheet. (Totals must never live in a <tfoot>: browsers repeat
// a tfoot on every printed page, which stamps the whole-invoice total onto every sheet.)
//
// How many single-line rows fit one printed A4 sheet. Measured, not guessed: at 12mm
// margins an A4 page gives 1031 CSS px, a row is 23px, and fixed overhead is 258px on
// page 1 (letterhead + Bill To) against 78px on later pages (one-line header strip).
// That allows 33 and 41 rows; these leave room for the carry/subtotal rows plus slack so
// a sheet never spills onto a second physical page and strands its subtotal there.
export const INV_ROWS_PAGE_1 = 28, INV_ROWS_PAGE_N = 34, INV_ROWS_FOR_TOTALS = 2;
// A page-1 banner (receipt "PAID", preview notice) costs roughly this many rows of height.
export const INV_ROWS_PER_BANNER = 2;

// A shared line also prints a footnote on its sheet, so it costs a second row.
export const invLineRows = l => l.sharedNote ? 2 : 1;

export function paginateInvoiceLines(lines, { bannerRows = 0 } = {}) {
  if (!lines.length) return [[]];
  const firstCap = Math.max(1, INV_ROWS_PAGE_1 - bannerRows);
  const pages = [[]];
  let used = 0;
  for (const l of lines) {
    const cap = pages.length === 1 ? firstCap : INV_ROWS_PAGE_N;
    if (used + invLineRows(l) > cap && pages[pages.length - 1].length) { pages.push([]); used = 0; }
    pages[pages.length - 1].push(l);
    used += invLineRows(l);
  }
  // If the last sheet is nearly full the totals block would spill; give it its own sheet.
  const lastCap = pages.length === 1 ? firstCap : INV_ROWS_PAGE_N;
  if (used > lastCap - INV_ROWS_FOR_TOTALS) pages.push([]);
  return pages;
}

// A line's date (its own column on documents) plus description, for single-column uses.
// Lines saved before the date was split out already carry it inside desc.
export function invLineLabel(l) {
  const desc = l.desc || l.description || l.label || "";
  return l.date ? `${fmtDate(l.date)} · ${desc}` : desc;
}

// Rate and Duration cells for a document line. Shared lines show the rate after their
// share is applied, marked with an asterisk that points at the sheet's footnote.
export function invLineRate(l) {
  if (l.fixedPrice) return `Fixed${l.sharedNote ? "*" : ""}`;
  if (l.rate == null) return "—";
  return `${fmtCost(l.rate)}/hr${l.sharedNote ? "*" : ""}`;
}
export function invLineDuration(l) {
  if (l.hours == null) return "—";
  const mins = Math.round(Math.abs(l.hours) * 60), h = Math.floor(mins / 60), m = mins % 60;
  return (l.hours < 0 ? "−" : "") + [h ? `${h}h` : "", m ? `${m}m` : ""].filter(Boolean).join(" ") || "0h";
}

// Lines saved before date/hours/rate were stored carry them only as text: the date and
// time range inside desc ("Mon, 14 Sept 2026 · Field #1 · 6:30 PM–8:30 PM"), and the
// hours/rate or sharing inside detail ("6h 30m @ $60.00/hr", "· shared field, 50% of …").
// Recover the structured fields from that text so old records fill the new columns.
export const INV_MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
export function normaliseInvLine(l) {
  if (l.hours != null || l.rate != null || l.fixedPrice) return l;
  const out = { ...l };
  let desc = l.desc || l.description || l.label || "";
  const detail = l.detail || "";
  const dm = desc.match(/(?:\b[A-Z][a-z]{2},?\s+)?\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})/);
  if (dm && !l.date) {
    out.date = `${dm[3]}-${String(INV_MONTHS[dm[2].toLowerCase()]).padStart(2,"0")}-${dm[1].padStart(2,"0")}`;
    desc = desc.replace(dm[0], "").replace(/\s*·\s*·\s*/, " · ").replace(/^\s*·\s*|\s*·\s*$/g, "").replace(/\]\s*·\s*/, "] ").trim();
    out.desc = desc;
  }
  const g = detail.match(/(?:(\d+)h)?\s*(?:(\d+)m)?\s*@\s*\$([\d,]+(?:\.\d+)?)\/hr/);
  if (g && (g[1] || g[2])) {
    out.hours = (+g[1] || 0) + (+g[2] || 0) / 60;
    out.rate = +g[3].replace(/,/g, "");
    return out;
  }
  const tm = desc.match(/(\d{1,2}):(\d{2})\s*([AP]M)\s*[–-]\s*(\d{1,2}):(\d{2})\s*([AP]M)/i);
  if (tm) {
    const to24 = (h, m, ap) => (+h % 12) + (ap.toUpperCase() === "PM" ? 12 : 0) + (+m) / 60;
    let hrs = to24(tm[4], tm[5], tm[6]) - to24(tm[1], tm[2], tm[3]);
    if (hrs <= 0) hrs += 24;
    out.hours = hrs;
    if (/fixed price/i.test(detail)) out.fixedPrice = true;
    else if (!l.isAdj && !l.isCreditAdj) out.rate = (l.cost || 0) / hrs;
  }
  const shareBits = detail.split("·").map(x => x.trim()).filter(x => /shared field|^split \d/i.test(x))
    .map(x => x.replace(/^split (\d+%)/i, "cost split, $1 share"));
  if (shareBits.length) out.sharedNote = shareBits.join("; ");
  return out;
}

export function renderInvoiceDocHtml({
  title, docLabel, docId, bankRef, dateStr, orderName = "",
  billToName, billToEmail, billToExtra = "", periodStr,
  lines = [], pre, gst, total, gstMode,
  banner = "", previewNotice = false, footNote = "", paginate = true, fragment = false,
}) {
  // Styling is inline because this same HTML is emailed to bookers and mail clients
  // routinely drop <style> blocks; layout uses tables for the same reason. The <style>
  // block carries only print rules (page size, sheet breaks), which email ignores.
  // Rows are a fixed height and clipped to one line, so the per-sheet row counts hold
  // instead of breaking on one long description.
  // Rate, Duration and Amount are sized to their content and never cut off; Description
  // has max-width:0 so it takes whatever room is left and is the column that truncates.
  const clip = "white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
  // Emailed copies (paginate=false) have no sheets to fit, so rows may wrap and cells carry
  // only padding and a rule, inheriting type from the table. That keeps each row ~1/3 the
  // size: the email service rejects messages over 50KB.
  const compact = !paginate;
  const cellBase = compact
    ? "padding:3px 8px;border-bottom:1px solid #f1f5f9"
    : `box-sizing:border-box;padding:3px 8px;border-bottom:1px solid #f1f5f9;font-size:11.5px;line-height:16px;height:22px;${clip}`;
  const edgeL = ";padding-left:28px", edgeR = ";padding-right:28px";
  const tdAmt = compact ? `${cellBase};text-align:right;white-space:nowrap` : `${cellBase};text-align:right;color:#0f172a`;
  const tdLbl = `${tdAmt};color:#64748b`;
  const tdDate = compact ? `${cellBase}${edgeL};white-space:nowrap` : `${cellBase}${edgeL};color:#0f172a`;
  const tdDesc = compact ? cellBase : `${cellBase};width:100%;max-width:0;color:#0f172a`;
  const th    = "padding:4px 8px;white-space:nowrap;text-align:left;font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;background:#f8fafc;border-bottom:1.5px solid #e2e8f0";
  const cap   = "font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em";
  const money = (v, extra = "") => `<td style="${tdAmt}${edgeR}${extra}">${fmtCost(v)}</td>`;
  const amuaLines = [AMUA_INFO.address, AMUA_INFO.gstNumber ? `GST No: ${AMUA_INFO.gstNumber}` : "", AMUA_INFO.bank,
      amuaContactLine() ? `Contact: ${amuaContactLine()}` : ""]
    .filter(Boolean).map(l => `<div>${l}</div>`).join("");
  const gstLabel = gstMode === "note" ? "" : gstMode === "exclusive" ? "excl. GST" : "incl. GST";

  const totalsRows = gstMode === "note"
    ? `<tr><td colspan="4" style="${tdLbl}${edgeL};background:#f0fdf4">GST inclusive</td>${money(total, ";background:#f0fdf4;font-size:15px;font-weight:800;color:#15803d")}</tr>`
    : `<tr><td colspan="4" style="${tdLbl}${edgeL};background:#f8fafc">Subtotal (${gstLabel})</td>${money(pre, ";background:#f8fafc")}</tr>
       <tr><td colspan="4" style="${tdLbl}${edgeL};background:#f8fafc">GST (15%)</td>${money(gst, ";background:#f8fafc")}</tr>
       <tr><td colspan="4" style="${tdLbl}${edgeL};background:#f0fdf4;font-size:13px;font-weight:700;color:#0f172a">Total</td>${money(total, ";background:#f0fdf4;font-size:15px;font-weight:800;color:#15803d")}</tr>`;

  lines = lines.map(normaliseInvLine);
  const bannerRows = (banner ? INV_ROWS_PER_BANNER : 0) + (previewNotice ? 1 : 0);
  // Emails have no pages, so the emailed copy stays one continuous sheet.
  const pages = paginate ? paginateInvoiceLines(lines, { bannerRows }) : [lines];
  const multi = pages.length > 1;

  let running = 0;
  const sheets = pages.map((pageLines, pi) => {
    const brought = running;
    const pageSum = pageLines.reduce((s, l) => s + (l.cost || 0), 0);
    running += pageSum;
    const carried = running;
    const isLast = pi === pages.length - 1;

    // Records saved before lines carried rate/hours fall back to their free-text detail.
    const rows = pageLines.map(l => `
      <tr>
        <td style="${tdDate}">${l.date ? fmtDateShortDow(l.date) : ""}</td>
        <td style="${tdDesc}">${l.desc || l.description || l.label || "—"}</td>
        ${l.hours == null && l.rate == null && !l.fixedPrice && l.detail
          ? `<td colspan="2" style="${cellBase};color:#64748b;font-size:10.5px"><div style="${clip};max-width:200px">${l.detail}</div></td>`
          : `<td style="${tdAmt};color:#475569">${invLineRate(l)}</td><td style="${tdAmt};color:#475569">${invLineDuration(l)}</td>`}
        ${money(l.cost || 0)}
      </tr>`).join("");
    // Footnotes wrap rather than clip: a nowrap line here would set the table's minimum
    // width and push Rate/Duration/Amount off the sheet.
    const shared = pageLines.filter(l => l.sharedNote);
    const footnotes = shared.length ? `
      <tr><td colspan="5" style="padding:6px 28px 2px;font-size:10px;line-height:14px;color:#64748b">
        ${shared.map(l => `<div>* ${l.date ? `${fmtDateShortDow(l.date)} — ` : ""}${l.sharedNote} · ${l.desc || l.description || l.label || ""}</div>`).join("")}
      </td></tr>` : "";

    // Per-sheet figures cover only the rows printed above them. The whole-invoice figure
    // appears once, in the totals block on the final sheet.
    const carryRows = multi ? [
      pi > 0 ? `<tr><td colspan="4" style="${tdLbl}${edgeL};background:#f8fafc;font-style:italic;color:#94a3b8">Brought forward from page ${pi}</td>${money(brought, ";background:#f8fafc;font-style:italic;color:#94a3b8")}</tr>` : "",
      `<tr><td colspan="4" style="${tdLbl}${edgeL};background:#f8fafc">Subtotal — this page (${pageLines.length} item${pageLines.length !== 1 ? "s" : ""})</td>${money(pageSum, ";background:#f8fafc")}</tr>`,
      !isLast ? `<tr><td colspan="4" style="${tdLbl}${edgeL};background:#f8fafc;font-style:italic;color:#94a3b8">Carried forward to page ${pi + 2}</td>${money(carried, ";background:#f8fafc;font-style:italic;color:#94a3b8")}</tr>` : "",
    ].join("") : "";

    const head = pi === 0 ? `
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#0f172a">
        <tr>
          <td style="padding:20px 28px;vertical-align:top">
            <div style="font-size:19px;font-weight:800;color:#fff;letter-spacing:-0.02em">${AMUA_INFO.name}</div>
            <div style="font-size:11px;color:#94a3b8;margin-top:2px;line-height:1.45">${amuaLines || "<span style='color:#64748b'>Add AMUA's address and contact under User menu → AMUA details</span>"}</div>
          </td>
          <td style="padding:20px 28px;vertical-align:top;text-align:right;white-space:nowrap">
            <div style="font-size:21px;font-weight:800;color:#fff;line-height:1.1">${docLabel}</div>
            <div style="font-size:11px;color:#94a3b8;margin-top:2px">#${docId}</div>
            ${bankRef ? `<div style="font-size:11px;color:#cbd5e1;margin-top:1px">Bank reference: <strong style="color:#fff;font-family:monospace;letter-spacing:0.04em">${bankRef}</strong></div>` : ""}
            <div style="font-size:11px;color:#94a3b8">Date: ${dateStr}</div>
            ${orderName ? `<div style="font-size:11px;color:#94a3b8">Order: ${orderName}</div>` : ""}
          </td>
        </tr>
      </table>
      ${previewNotice ? `<div style="background:#fffbeb;border-bottom:1px solid #fde68a;color:#92400e;font-size:11px;font-weight:700;padding:7px 28px;text-align:center">Unofficial preview — for review only. Not a tax invoice, and no payment is due on this document.</div>` : ""}
      ${banner}
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-bottom:1px solid #f1f5f9">
        <tr>
          <td style="padding:14px 28px;vertical-align:top">
            <div style="${cap}">Bill To</div>
            <div style="font-size:14px;font-weight:700;margin-top:2px;color:#0f172a">${billToName || "(see email)"}</div>
            <div style="font-size:11px;color:#475569">${billToEmail || ""}</div>
            ${billToExtra}
          </td>
          <td style="padding:14px 28px;vertical-align:top;text-align:right">
            <div style="${cap}">Period</div>
            <div style="font-size:12px;font-weight:600;margin-top:2px;color:#0f172a">${periodStr}</div>
          </td>
        </tr>
      </table>` : `
      <div style="background:#0f172a;color:#cbd5e1;padding:8px 28px;font-size:11px">
        <strong style="color:#fff">${docLabel} #${docId}</strong> · ${billToName || billToEmail || ""} · ${periodStr}
      </div>`;

    return `<section class="sheet" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);margin:0 auto 20px;max-width:720px">
      ${head}
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:11.5px;line-height:16px;color:#0f172a">
        <thead><tr>
          <th style="${th}${edgeL}">Date</th>
          <th style="${th}">Description</th>
          <th style="${th};text-align:right">Rate</th>
          <th style="${th};text-align:right">Duration</th>
          <th style="${th}${edgeR};text-align:right">Amount</th>
        </tr></thead>
        <tbody>
          ${rows || `<tr><td colspan="5" style="${cellBase}${edgeL}${edgeR};text-align:center;color:#94a3b8;font-style:italic">No items on this page.</td></tr>`}
          ${footnotes}
          ${carryRows}
          ${isLast ? totalsRows : ""}
        </tbody>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
        <tr>
          <td style="padding:8px 28px 12px;font-size:10px;color:#94a3b8">${isLast ? footNote : ""}</td>
          <td style="padding:8px 28px 12px;font-size:10px;color:#94a3b8;text-align:right;white-space:nowrap">${multi ? `Page ${pi + 1} of ${pages.length}` : ""}</td>
        </tr>
      </table>
    </section>`;
  }).join("");

  // Bundled emails stitch several documents into one page, so they take the sheets alone.
  if (fragment) return sheets;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${title}</title><style>
    @page { size:A4; margin:12mm }
    body{font-family:'Segoe UI',Arial,sans-serif;background:#f1f5f9;margin:0;padding:24px 12px;color:#0f172a}
    @media print {
      body{background:#fff;padding:0}
      .sheet{box-shadow:none !important;border-radius:0 !important;margin:0 !important;max-width:none !important;
             break-after:page;page-break-after:always}
      .sheet:last-child{break-after:auto;page-break-after:auto}
    }
  </style></head><body>${sheets}</body></html>`;
}

// Builds invoice/PO HTML from the snapshot stored on the record. Falls back
// to "draft" formatting (no GST extraction) when fields are missing.
export function billingDocFields(rec, docType, lines) {
  const fmtD = d => d ? new Date(d+"T00:00:00").toLocaleDateString("en-NZ",{day:"numeric",month:"short",year:"numeric"}) : "—";
  const docLabel = docType === "purchase_order" ? "Purchase Order" : docType === "receipt" ? "Receipt" : "Invoice";
  const docId = docType==="purchase_order" ? (rec.poId||rec.id) : rec.id;
  const pre   = rec.subtotal!=null ? rec.subtotal : (lines||[]).reduce((s,l)=>s+(l.cost||0),0);
  const gst   = rec.gst!=null ? rec.gst : 0;
  const total = rec.total!=null ? rec.total : pre + gst;
  // Receipts carry a paid acknowledgement and a back-reference to the source invoice.
  const banner = docType==="receipt" ? `<div style="margin:12px 28px 0;padding:10px 14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px">
      <div style="font-size:13px;font-weight:800;color:#15803d">✓ PAID — payment received with thanks</div>
      <div style="font-size:11px;color:#475569;margin-top:2px">
        ${rec.sourceInvoiceId?`For invoice <strong style="font-family:monospace">${rec.sourceInvoiceId}</strong>`:""}${rec.sourceInvoiceId&&rec.paidOn?" · ":""}${rec.paidOn?`Paid on ${fmtD(rec.paidOn)}`:""}
      </div>
    </div>` : "";
  return {
    title: `${docLabel} ${docId}`,
    docLabel: docLabel.toUpperCase(), docId, bankRef: docId,
    dateStr: (rec.createdAt||"").slice(0,10) || new Date().toISOString().slice(0,10),
    orderName: rec.orderName||"",
    billToName: rec.bookerName, billToEmail: rec.bookerEmail,
    billToExtra: [
      rec.bookerAddress?`<div style="font-size:11px;color:#475569;margin-top:3px;white-space:pre-line">${rec.bookerAddress}</div>`:"",
      rec.bookerGst?`<div style="font-size:11px;color:#94a3b8">GST: ${rec.bookerGst}</div>`:"",
    ].join(""),
    periodStr: rec.dateFrom&&rec.dateTo ? `${fmtD(rec.dateFrom)} – ${fmtD(rec.dateTo)}` : "All periods",
    lines: lines||[], pre, gst, total, gstMode: rec.gstMode,
    banner,
    footNote: `${docType==="receipt"?"This receipt confirms payment has been received in full. · ":AMUA_INFO.bank?`Bank: ${AMUA_INFO.bank} · `:""}Generated by FacilityBook${rec.status==="draft"?" · DRAFT":""}`,
  };
}
export function buildBillingDocHtml(rec, docType, lines) {
  return renderInvoiceDocHtml(billingDocFields(rec, docType, lines));
}

// One email carrying several official documents for the same recipient — a booker who
// has three invoices outstanding gets one email listing all three, not three emails.
// Each document keeps its own letterhead, reference and totals; a summary card up top
// reconciles them. Documents are unpaginated here: email has no pages.
// The email service (EmailJS) rejects a message whose variables exceed 50KB. Bundles are
// kept under this, leaving room for the subject and addresses.
export const INV_EMAIL_MAX_BYTES = 45 * 1024;
export const htmlBytes = html => new TextEncoder().encode(html).length;

export function buildInvoiceBundleHtml({ recipientName, recipientEmail, docs, note = "", preview = false }) {
  const combined = docs.reduce((s, d) => s + (d.rec.total || 0), 0);
  const summaryRows = docs.map(d => {
    const f = billingDocFields(d.rec, d.docType, d.lines);
    return `<tr>
      <td style="padding:5px 0;font-size:12px;font-family:monospace;color:#0f172a">${f.docId}</td>
      <td style="padding:5px 10px;font-size:12px;color:#64748b">${f.docLabel}</td>
      <td style="padding:5px 10px;font-size:12px;color:#64748b">${f.periodStr}</td>
      <td style="padding:5px 0;font-size:12px;color:#0f172a;text-align:right;white-space:nowrap">${fmtCost(d.rec.total || 0)}</td>
    </tr>`;
  }).join("");
  const body = docs.map(d => renderInvoiceDocHtml({
    ...billingDocFields(d.rec, d.docType, d.lines), paginate: false, fragment: true, previewNotice: preview,
  })).join("");
  // Indentation is stripped: emails are size-limited (see INV_EMAIL_MAX_BYTES).
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${docs.length} document${docs.length!==1?"s":""} for ${recipientName||recipientEmail}</title><style>
    @page { size:A4; margin:12mm }
    body{font-family:'Segoe UI',Arial,sans-serif;background:#f1f5f9;margin:0;padding:24px 12px;color:#0f172a}
    @media print {
      body{background:#fff;padding:0}
      .sheet{box-shadow:none !important;border-radius:0 !important;margin:0 !important;max-width:none !important;
             break-after:page;page-break-after:always}
      .sheet:last-child{break-after:auto;page-break-after:auto}
    }
  </style></head><body>
    <div style="background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.08);margin:0 auto 20px;max-width:720px;overflow:hidden">
      <div style="background:#0f172a;padding:18px 28px">
        <div style="font-size:17px;font-weight:800;color:#fff">${AMUA_INFO.name}</div>
        <div style="font-size:12px;color:#94a3b8;margin-top:2px">${docs.length} document${docs.length!==1?"s":""} for ${recipientName||recipientEmail}</div>
      </div>
      ${preview?`<div style="background:#fffbeb;border-bottom:1px solid #fde68a;color:#92400e;font-size:11px;font-weight:700;padding:7px 28px;text-align:center">Unofficial preview — for review only. These are not tax invoices, and no payment is due.</div>`:""}
      <div style="padding:16px 28px">
        ${note?`<div style="font-size:12px;color:#475569;margin-bottom:12px;white-space:pre-line">${note}</div>`:""}
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
          <thead><tr>
            <th style="text-align:left;font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;padding-bottom:4px;border-bottom:1.5px solid #e2e8f0">Reference</th>
            <th style="text-align:left;font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;padding:0 10px 4px;border-bottom:1.5px solid #e2e8f0">Document</th>
            <th style="text-align:left;font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;padding:0 10px 4px;border-bottom:1.5px solid #e2e8f0">Period</th>
            <th style="text-align:right;font-size:9px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;padding-bottom:4px;border-bottom:1.5px solid #e2e8f0">Amount</th>
          </tr></thead>
          <tbody>${summaryRows}</tbody>
          <tfoot><tr>
            <td colspan="3" style="padding-top:8px;border-top:1.5px solid #e2e8f0;font-size:13px;font-weight:700;text-align:right">Combined total${preview?" (indicative)":""}</td>
            <td style="padding-top:8px;border-top:1.5px solid #e2e8f0;font-size:15px;font-weight:800;color:#15803d;text-align:right;white-space:nowrap">${fmtCost(combined)}</td>
          </tr></tfoot>
        </table>
        <div style="font-size:11px;color:#94a3b8;margin-top:10px">${preview?"Each document is reproduced in full below for review. Nothing here is payable yet.":"Each document is reproduced in full below. Pay each against its own bank reference."}</div>
      </div>
    </div>
    ${body}
  </body></html>`.replace(/\n\s+/g, "\n");
}

// Drive file/folder naming for billing documents. Names are deterministic so
// re-syncs find-or-update the same files even across browsers/devices.
export const sanitizeDriveName = s => String(s||"").replace(/[/\\]+/g,"-").replace(/\s+/g," ").trim();
export function billingDocBaseName(rec) {
  const isPO = rec.type === "purchase_order";
  const docTag = isPO ? "PO" : rec.type === "receipt" ? "Receipt" : "Invoice";
  const orderTag = rec.orderName ? ` - ${sanitizeDriveName(rec.orderName)}` : "";
  // Invoices add the booker so multiple invoices in one batch don't collide.
  const whoTag = isPO ? "" : ` - ${sanitizeDriveName(rec.bookerName || (rec.bookerEmail||"").split("@")[0])}`;
  return `AMUA ${docTag}${orderTag}${whoTag} - ${(rec.dateFrom||"").replace(/-/g,"")}-${(rec.dateTo||"").replace(/-/g,"")}`;
}
export function driveBatchFolderName(records) {
  const po = records.find(r=>r.type==="purchase_order") || records[0];
  const range = `${(po.dateFrom||"").replace(/-/g,"")}-${(po.dateTo||"").replace(/-/g,"")}`;
  const order = sanitizeDriveName(po.orderName);
  return order ? `${range} — ${order}` : `${range} — ${po.batchId||po.id}`;
}
export const DRIVE_SUBFOLDERS = { po:"PO (to GTEC)", fromGtec:"Invoice (from GTEC)", toClubs:"Invoice (to Clubs)" };
// Each provider's PO files under its own folder; GTEC keeps the original name.
export const drivePoFolderName = rec => `PO (to ${(PROVIDERS[rec.provider||"gtec"]||PROVIDERS.gtec).short})`;

export function BillingTab({ billingRecords=[], onUpdateRecord, onDeleteRecord, onCreateReceipt, onLoadToSummary, isAdmin=false, loggedInEmail="", emailAliases={}, aliasNames={}, driveEnabled=false, onDriveSync, onRenameBatch, onDriveAttach, onEmailOfficial, onQueueInvoiceEmails, silentMode=false, onToggleSilent }) {
  const [filterStatus, setFilterStatus] = useState("all");
  const [expandedId, setExpandedId] = useState(null);
  const [expandedBatchId, setExpandedBatchId] = useState(null);
  const [expandedSubId, setExpandedSubId] = useState(null);
  const [exportMode, setExportMode] = useState("grouped"); // "grouped" | "individual"
  const [viewMode, setViewMode] = useState("grouped"); // "grouped" = batch cards | "individual" = flat rows
  const [driveTest, setDriveTest] = useState(null); // { ok, msg } from Connect & test
  const [driveBusy, setDriveBusy] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailMode, setEmailMode] = useState("official"); // "preview" | "official"
  const [emailSendMode, setEmailSendMode] = useState("grouped"); // "grouped" = one email per booker | "individual" = one per invoice
  const [emailExportMode, setEmailExportMode] = useState("grouped"); // "grouped" = summary lines | "individual" = itemised — mirrors the Billing list's Export
  const [emailSelIds, setEmailSelIds] = useState(new Set()); // record ids staged to send
  const [emailNote, setEmailNote] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);

  const SHORT_STATUS = { draft:"Draft", submitted:"Sent", gtec_invoiced:"GTEC", club_invoiced:"Club", complete:"Done" };

  const canonEmail = em => (emailAliases[(em||"").toLowerCase()] || em || "").toLowerCase();
  const displayName = em => {
    if (!em || em === "combined") return em || "—";
    const k = canonEmail(em);
    return aliasNames[k] || k.split("@")[0];
  };

  const visibleRecords = isAdmin
    ? billingRecords
    : billingRecords.filter(r => canonEmail(r.bookerEmail) === canonEmail(loggedInEmail));

  const filtered = filterStatus === "all" ? visibleRecords : visibleRecords.filter(r => r.status === filterStatus);
  const sorted = [...filtered].sort((a,b) => (b.createdAt||"").localeCompare(a.createdAt||""));

  // Group records that share a batchId (created together as one Official invoice run)
  const { batches, ungrouped } = useMemo(() => {
    const batchMap = {};
    const ung = [];
    for (const rec of sorted) {
      if (rec.batchId) {
        if (!batchMap[rec.batchId]) batchMap[rec.batchId] = [];
        batchMap[rec.batchId].push(rec);
      } else {
        ung.push(rec);
      }
    }
    const bs = Object.entries(batchMap).map(([batchId, recs]) => {
      const invRecs = recs.filter(r => r.type !== "purchase_order");
      const poRecs = recs.filter(r => r.type === "purchase_order");
      const poRec = poRecs[0];
      // Display order: POs → grouped INVs (future: GTEC receipt → club receipts)
      const ordered = [...poRecs, ...invRecs];
      const worstStatus = recs.reduce((worst, r) => {
        const wi = PIPELINE_KEYS.indexOf(worst);
        const ri = PIPELINE_KEYS.indexOf(r.status || "draft");
        return ri < wi ? (r.status || "draft") : worst;
      }, "complete");
      return {
        batchId, records: ordered, invRecs, poRec, poRecs,
        orderName: recs[0].orderName || "",
        createdAt: recs[0].createdAt || "",
        dateFrom: recs[0].dateFrom || "",
        dateTo: recs[0].dateTo || "",
        total: invRecs.reduce((s, r) => s + (r.total || 0), 0),
        status: worstStatus,
        allDraft: recs.every(r => (r.status || "draft") === "draft"),
      };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { batches: bs, ungrouped: ung };
  }, [sorted]);

  const fmtDate = d => d ? new Date(d+"T00:00:00").toLocaleDateString("en-NZ",{day:"numeric",month:"short",year:"numeric"}) : "—";
  const fmtMoney = n => n!=null ? `$${Number(n).toFixed(2)}` : "—";

  // ─── Document download from stored billing record ──────────────────────────
  function downloadRecord(rec, format, docType, detail) {
    const lines = detail==="individual" ? (rec.individualLines||rec.lines||[]) : (rec.lines||[]);
    const docTag = docType==="purchase_order" ? "PO" : docType==="receipt" ? "Receipt" : "Invoice";
    const orderTag = rec.orderName ? ` - ${rec.orderName.replace(/[^\w- ]+/g,"")}` : "";
    const baseName = `AMUA ${docTag}${orderTag} - ${(rec.dateFrom||"").replace(/-/g,"")}-${(rec.dateTo||"").replace(/-/g,"")}${detail==="individual"?" - itemised":""}`;
    if (format==="csv") {
      const esc = v => `"${String(v||"").replace(/"/g,'""')}"`;
      const rowsCsv = lines.map(l=>[(docType==="purchase_order"?rec.poId:rec.id)||"", rec.bookerName||"", rec.bookerEmail||"", invLineLabel(l), l.detail||"", Number(l.cost||0).toFixed(2)].map(esc).join(","));
      rowsCsv.push(["","","","","Subtotal",Number(rec.subtotal||0).toFixed(2)].map(esc).join(","));
      rowsCsv.push(["","","","","GST (15%)",Number(rec.gst||0).toFixed(2)].map(esc).join(","));
      rowsCsv.push(["","","","","Total",Number(rec.total||0).toFixed(2)].map(esc).join(","));
      const csv = [[docType==="purchase_order"?"Purchase Order":docType==="receipt"?"Receipt":"Invoice","Name","Email","Description","Detail","Amount"].map(esc).join(","), ...rowsCsv].join("\n");
      const blob = new Blob([csv],{type:"text/csv"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href=url; a.download=`${baseName}.csv`; a.click();
      URL.revokeObjectURL(url);
      return;
    }
    const html = buildBillingDocHtml(rec, docType, lines);
    const win = window.open("","_blank");
    if (win) {
      win.document.write(html); win.document.close();
      if (format==="print") { win.focus(); win.print(); }
    }
  }

  const stateInfo = key => PIPELINE_STATES.find(s=>s.key===key) || (key==="issued" ? { label:"Receipt Issued", color:"#15803d" } : { label: key, color:"#94a3b8" });

  function StatusPill({ status }) {
    const s = stateInfo(status);
    return <span style={{display:"inline-block",padding:"2px 8px",borderRadius:999,fontSize:11,fontWeight:700,background:s.color+"22",color:s.color,border:`1px solid ${s.color}55`}}>{s.label}</span>;
  }

  function ProgressTrack({ status }) {
    const idx = PIPELINE_KEYS.indexOf(status);
    return (
      <div style={{display:"flex",alignItems:"center",gap:0,marginBottom:10}}>
        {PIPELINE_STATES.map((s,i)=>{
          const done = i < idx, active = i === idx;
          return (
            <Fragment key={s.key}>
              {i>0&&<div style={{flex:1,height:2,background:done?"#22c55e":"#e2e8f0"}}/>}
              <div title={s.description} style={{width:14,height:14,borderRadius:"50%",background:done?"#22c55e":active?s.color:"#e2e8f0",border:`2px solid ${done?"#22c55e":active?s.color:"#cbd5e1"}`,flexShrink:0}}/>
            </Fragment>
          );
        })}
      </div>
    );
  }

  // Build a receipt record from a paid invoice (mirrors its amounts; new R-type ref).
  function makeReceipt(inv) {
    const recipientCode = inv.recipientCode || deriveRecipientCode(inv.bookerName || (inv.bookerEmail||"").split("@")[0]);
    const rid = genBankRef({ type:"R", dateFrom: inv.dateFrom, dateTo: inv.dateTo, recipientCode, existingRefs: billingRecords.map(r=>r.id) });
    return {
      ...inv,
      id: rid, bankRef: rid, recipientCode, type:"receipt",
      sourceInvoiceId: inv.id, sourceBankRef: inv.bankRef||inv.id,
      paidOn: todayKey(), createdAt: new Date().toISOString(),
      status: "issued", gtecInvoiceNumber: "", notes: "", drive: undefined,
      batchId: undefined, // receipts render as standalone records, not inside invoice batches
    };
  }
  // Reusable expanded detail panel for any billing record
  function renderRecordExpanded(rec) {
    const isPO = rec.type==="purchase_order" || rec.bookerEmail==="gtec";
    const isReceipt = rec.type==="receipt";
    const isInv = !isPO && !isReceipt;
    const existingReceipt = billingRecords.find(r=>r.type==="receipt" && r.sourceInvoiceId===rec.id);
    return (
      <div style={{borderTop:"1px solid #f1f5f9",padding:"14px 16px",background:"#fafafa"}}>
        {!isReceipt && <ProgressTrack status={rec.status||"draft"}/>}
        {isReceipt && (
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,fontSize:12,color:"#15803d",fontWeight:700}}>
            🧾 Receipt — payment received{rec.paidOn?` · ${fmtDate(rec.paidOn)}`:""}
            {rec.sourceInvoiceId&&<span style={{color:"#64748b",fontWeight:400}}>for invoice <span style={{fontFamily:"monospace"}}>{rec.sourceInvoiceId}</span></span>}
          </div>
        )}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:"10px 20px",marginBottom:14}}>
          {[
            ["Booker", isPO ? (rec.bookerName||VENDOR_GTEC.name) : displayName(rec.bookerEmail)],
            ["Booker Address", rec.bookerAddress||"—"],
            ["Booker GST", rec.bookerGst||"—"],
            ["Created", rec.createdAt?new Date(rec.createdAt).toLocaleDateString("en-NZ",{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"}):"—"],
            ["Subtotal", fmtMoney(rec.subtotal)],
            ["GST", fmtMoney(rec.gst)],
            ["Total", fmtMoney(rec.total)],
          ].map(([k,v])=>(
            <div key={k}>
              <div style={{fontSize:10,fontWeight:600,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.05em"}}>{k}</div>
              <div style={{fontSize:12,color:"#0f172a",whiteSpace:"pre-wrap"}}>{v}</div>
            </div>
          ))}
        </div>
        {isAdmin&&!isReceipt&&(
          <div style={{display:"flex",flexDirection:"column",gap:8,padding:"10px 0",borderTop:"1px solid #e2e8f0"}}>
            <div style={{fontSize:11,fontWeight:700,color:"#475569",marginBottom:2}}>Pipeline Actions</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
              {PIPELINE_KEYS.indexOf(rec.status||"draft") < PIPELINE_KEYS.length-1&&(
                <button onClick={()=>{
                  const next = PIPELINE_KEYS[PIPELINE_KEYS.indexOf(rec.status||"draft")+1];
                  onUpdateRecord({id:rec.id,status:next});
                }} style={{padding:"5px 12px",borderRadius:8,border:"none",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit",background:"#0f172a",color:"#fff"}}>
                  → Mark as {stateInfo(PIPELINE_KEYS[PIPELINE_KEYS.indexOf(rec.status||"draft")+1]).label}
                  {(rec.status||"draft")==="draft"&&isInv&&<span style={{fontWeight:400,marginLeft:4,opacity:0.7}}>(marks {(rec.bookingIds||[]).length} bookings invoiced)</span>}
                </button>
              )}
              {PIPELINE_KEYS.indexOf(rec.status||"draft") > 0&&(
                <button onClick={()=>{
                  const prev = PIPELINE_KEYS[PIPELINE_KEYS.indexOf(rec.status||"draft")-1];
                  onUpdateRecord({id:rec.id,status:prev});
                }} style={{padding:"5px 12px",borderRadius:8,border:"1px solid #e2e8f0",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit",background:"#fff",color:"#64748b"}}>
                  ← Revert to {stateInfo(PIPELINE_KEYS[PIPELINE_KEYS.indexOf(rec.status||"draft")-1]).label}
                </button>
              )}
              {(rec.status||"draft")==="draft" && onDeleteRecord && (
                <button onClick={()=>{
                  if(window.confirm(`Delete draft record ${rec.id}? This cannot be undone.`)) onDeleteRecord(rec.id);
                }} style={{padding:"5px 12px",borderRadius:8,border:"1px solid #fecaca",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit",background:"#fef2f2",color:"#b91c1c",marginLeft:"auto"}}>
                  🗑 Delete draft
                </button>
              )}
            </div>
            {["gtec_invoiced","club_invoiced","complete"].includes(rec.status)&&(
              <div style={{display:"flex",alignItems:"center",gap:8,marginTop:4}}>
                <span style={{fontSize:11,color:"#475569",flexShrink:0}}>GTEC Invoice #:</span>
                <input value={rec.gtecInvoiceNumber||""} onChange={e=>onUpdateRecord({id:rec.id,gtecInvoiceNumber:e.target.value})}
                  placeholder="e.g. GTEC-2026-001"
                  style={{padding:"4px 8px",borderRadius:6,border:"1px solid #e2e8f0",fontSize:11,fontFamily:"inherit",width:160}}/>
              </div>
            )}
            <div style={{display:"flex",alignItems:"flex-start",gap:8,marginTop:4}}>
              <span style={{fontSize:11,color:"#475569",flexShrink:0,paddingTop:4}}>Notes:</span>
              <textarea value={rec.notes||""} onChange={e=>onUpdateRecord({id:rec.id,notes:e.target.value})}
                rows={2} placeholder="Internal notes…"
                style={{padding:"4px 8px",borderRadius:6,border:"1px solid #e2e8f0",fontSize:11,fontFamily:"inherit",flex:1,resize:"vertical"}}/>
            </div>
          </div>
        )}
        {/* Receipt issuance — for paid invoices (not POs/receipts) */}
        {isAdmin&&isInv&&onCreateReceipt&&(
          <div style={{display:"flex",flexDirection:"column",gap:6,padding:"10px 0",borderTop:"1px solid #e2e8f0"}}>
            <div style={{fontSize:11,fontWeight:700,color:"#475569"}}>🧾 Receipt</div>
            {existingReceipt
              ? <div style={{fontSize:11,color:"#15803d",fontWeight:600}}>✓ Receipt issued: <span style={{fontFamily:"monospace"}}>{existingReceipt.id}</span></div>
              : rec.status==="complete"
                ? <button onClick={()=>onCreateReceipt(makeReceipt(rec))}
                    style={{alignSelf:"flex-start",padding:"5px 12px",borderRadius:8,border:"none",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit",background:"#15803d",color:"#fff"}}>
                    🧾 Generate receipt
                  </button>
                : <div style={{fontSize:11,color:"#94a3b8"}}>Advance to <strong>Complete</strong> (payment settled) to issue a receipt.</div>}
          </div>
        )}
        {isAdmin&&isReceipt&&onDeleteRecord&&(
          <div style={{display:"flex",gap:8,padding:"10px 0",borderTop:"1px solid #e2e8f0"}}>
            <button onClick={()=>{ if(window.confirm(`Delete receipt ${rec.id}? This cannot be undone.`)) onDeleteRecord(rec.id); }}
              style={{padding:"5px 12px",borderRadius:8,border:"1px solid #fecaca",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit",background:"#fef2f2",color:"#b91c1c"}}>
              🗑 Delete receipt
            </button>
          </div>
        )}
        <div style={{display:"flex",flexDirection:"column",gap:6,padding:"10px 0",borderTop:"1px solid #e2e8f0"}}>
          <div style={{fontSize:11,fontWeight:700,color:"#475569"}}>📥 Download Documents</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
            {[
              {dt:"invoice", id:rec.id, show:isInv},
              {dt:"purchase_order", id:rec.id, show:isPO},
              {dt:"receipt", id:rec.id, show:isReceipt},
            ].filter(x=>x.show).map(({dt,id})=>(
              <div key={dt} style={{display:"flex",gap:0,border:"1px solid #e2e8f0",borderRadius:8,overflow:"hidden",alignItems:"stretch"}}>
                <span style={{padding:"5px 10px",fontSize:11,fontWeight:700,color:"#475569",background:"#f8fafc",borderRight:"1px solid #e2e8f0",display:"flex",alignItems:"center",gap:4}}>
                  {dt==="purchase_order"?"📋 PO":dt==="receipt"?"✅ Receipt":"🧾 Invoice"} <span style={{fontFamily:"monospace",fontSize:10,color:"#94a3b8"}}>{id}</span>
                </span>
                {[{fmt:"html",label:"HTML",icon:"🌐"},{fmt:"print",label:"PDF",icon:"🖨"},{fmt:"csv",label:"CSV",icon:"📊"}].map(({fmt,label,icon})=>(
                  <button key={fmt} onClick={()=>downloadRecord(rec,fmt,dt,exportMode)}
                    title={`${exportMode==="individual"?"Itemised":"Grouped"} ${label}`}
                    style={{padding:"5px 9px",border:"none",borderLeft:"1px solid #f1f5f9",background:"#fff",cursor:"pointer",fontSize:11,fontWeight:600,color:"#0f172a",fontFamily:"inherit"}}>
                    {icon} {label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
        {driveEnabled&&isAdmin&&(()=>{
          const d = rec.drive||null;
          const chipBtn = (col,bg,bd)=>({padding:"4px 10px",borderRadius:6,border:`1.5px solid ${bd}`,background:bg,color:col,cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"});
          return (
            <div style={{display:"flex",flexDirection:"column",gap:6,padding:"10px 0",borderTop:"1px solid #e2e8f0"}}>
              <div style={{fontSize:11,fontWeight:700,color:"#475569"}}>📁 Google Drive</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",fontSize:11}}>
                {d?.webViewLink
                  ? <>
                      <a href={d.webViewLink} target="_blank" rel="noreferrer" style={{...chipBtn("#0369a1","#f0f9ff","#bae6fd"),textDecoration:"none"}}>↗ Open in Drive</a>
                      <span style={{color:"#94a3b8"}}>synced {d.uploadedAt?new Date(d.uploadedAt).toLocaleString("en-NZ",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):""}</span>
                    </>
                  : <span style={{color:"#94a3b8",fontStyle:"italic"}}>Not synced to Drive yet.</span>}
                {onDriveSync&&(
                  <button onClick={()=>onDriveSync([rec.id])} style={chipBtn("#047857","#ecfdf5","#6ee7b7")}>
                    {d?.webViewLink?"⟳ Re-sync":"⬆ Sync to Drive"}
                  </button>
                )}
                {d?.error&&<span style={{color:"#b91c1c",background:"#fef2f2",border:"1px solid #fecaca",borderRadius:6,padding:"3px 8px",maxWidth:420,wordBreak:"break-word"}}>⚠ {d.error}</span>}
              </div>
              {isPO&&(()=>{
                const gtecList = d?.gtecInvoices || (d?.gtecInvoice ? [d.gtecInvoice] : []);
                return (
                <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",fontSize:11}}>
                  <span style={{color:"#64748b",fontWeight:600}}>GTEC invoices received{gtecList.length?` (${gtecList.length})`:""}:</span>
                  {gtecList.length
                    ? gtecList.map((gi,i)=>(
                        <span key={gi.id||i} style={{display:"inline-flex",alignItems:"center",gap:0,border:"1px solid #bfdbfe",borderRadius:6,overflow:"hidden"}}>
                          <button onClick={()=>downloadDriveFile(gi.id, gi.name).catch(e=>window.alert("Download failed: "+(e.message||e)))} title="Download" style={{...chipBtn("#1d4ed8","#dbeafe","#bfdbfe"),border:"none",borderRadius:0}}>⬇ {gi.name}</button>
                          {gi.webViewLink&&<a href={gi.webViewLink} target="_blank" rel="noreferrer" title="Open in Drive" style={{...chipBtn("#0369a1","#f0f9ff","#bae6fd"),textDecoration:"none",border:"none",borderLeft:"1px solid #bfdbfe",borderRadius:0}}>↗</a>}
                        </span>
                      ))
                    : <span style={{color:"#94a3b8",fontStyle:"italic"}}>none attached</span>}
                  {onDriveAttach&&(
                    <label style={{...chipBtn("#7c3aed","#f5f3ff","#ddd6fe"),display:"inline-flex",alignItems:"center",gap:4}}>
                      📎 {gtecList.length?"Add file(s)":"Attach file(s)"}
                      <input type="file" multiple style={{display:"none"}} onChange={e=>{const fs=e.target.files; if(fs&&fs.length) onDriveAttach(rec, fs); e.target.value="";}}/>
                    </label>
                  )}
                </div>
                );
              })()}
            </div>
          );
        })()}
        {((exportMode==="individual"?(rec.individualLines||rec.lines):rec.lines)||[]).length>0&&(
          <div style={{marginTop:10}}>
            <div style={{fontSize:11,fontWeight:700,color:"#475569",marginBottom:4}}>Invoice Lines ({exportMode==="individual"?"Itemised — per booking":"Summary — grouped"})</div>
            <CopyableTable>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
              <thead>
                <tr style={{background:"#f8fafc"}}>
                  {["Description","Detail","Amount"].map(h=>(
                    <th key={h} style={{padding:"4px 8px",textAlign:h==="Amount"?"right":"left",fontWeight:700,color:"#64748b",borderBottom:"1px solid #e2e8f0"}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(exportMode==="individual"?(rec.individualLines||rec.lines):rec.lines).map((l,i)=>(
                  <tr key={i} style={{borderBottom:"1px solid #f1f5f9"}}>
                    <td style={{padding:"4px 8px",color:"#0f172a"}}>{invLineLabel(l)||"—"}</td>
                    <td style={{padding:"4px 8px",color:"#64748b"}}>{l.detail||"—"}</td>
                    <td style={{padding:"4px 8px",textAlign:"right",fontWeight:600,color:"#0f172a"}}>{l.cost!=null?`$${Number(l.cost).toFixed(2)}`:"—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </CopyableTable>
          </div>
        )}
      </div>
    );
  }

  // Render a single ungrouped billing record row
  function renderSingleRecord(rec) {
    const isExpanded = expandedId === rec.id;
    const isReceipt = rec.type==="receipt";
    const isPO = !isReceipt && (rec.type==="purchase_order" || rec.bookerEmail==="gtec");
    const isInv = !isPO && !isReceipt;
    const typeTag = isPO
      ? <span style={{fontFamily:"monospace",fontSize:10,background:"#dbeafe",padding:"1px 6px",borderRadius:4,color:"#1d4ed8",fontWeight:700}}>PO</span>
      : isReceipt
      ? <span style={{fontFamily:"monospace",fontSize:10,background:"#dcfce7",padding:"1px 6px",borderRadius:4,color:"#15803d",fontWeight:700}}>RCT</span>
      : <span style={{fontFamily:"monospace",fontSize:10,background:"#e0f2fe",padding:"1px 6px",borderRadius:4,color:"#0369a1",fontWeight:700}}>INV</span>;
    return (
      <div key={rec.id} style={{background:"#fff",border:`1px solid ${isPO?"#bfdbfe":isReceipt?"#bbf7d0":"#e2e8f0"}`,borderRadius:12,overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
        <div onClick={()=>setExpandedId(isExpanded?null:rec.id)}
          style={{display:"flex",alignItems:"center",gap:10,padding:"12px 16px",cursor:"pointer",userSelect:"none",flexWrap:"wrap"}}>
          <div style={{minWidth:0,flex:1}}>
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
              {typeTag}
              <span style={{fontSize:12,fontWeight:800,color:"#0f172a",fontFamily:"monospace"}}>{rec.id}</span>
              {rec.orderName&&<span style={{fontSize:11,color:"#475569",fontWeight:600}}>{rec.orderName}</span>}
            </div>
            <div style={{fontSize:11,color:"#64748b",marginTop:2}}>
              {isPO ? <strong style={{color:"#1d4ed8"}}>{rec.bookerName||VENDOR_GTEC.name}</strong> : displayName(rec.bookerEmail)}
              {" · "}{fmtDate(rec.dateFrom)}{rec.dateTo&&rec.dateTo!==rec.dateFrom?` – ${fmtDate(rec.dateTo)}`:""}
              {" · "}{(rec.bookingIds||[]).length} booking{(rec.bookingIds||[]).length!==1?"s":""}
              {(rec.status||"draft")==="draft"&&isInv&&<span style={{marginLeft:6,fontSize:10,color:"#94a3b8",fontStyle:"italic"}}>bookings marked invoiced on advance</span>}
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
            <span style={{fontSize:13,fontWeight:700,color:"#0f172a"}}>{fmtMoney(rec.total)}</span>
            <StatusPill status={rec.status||"draft"}/>
            {onLoadToSummary&&(
              <button onClick={e=>{e.stopPropagation();onLoadToSummary(rec);}}
                title="Load this record's date range + booker into the Summary view"
                style={{padding:"3px 9px",borderRadius:6,border:"1.5px solid #c7d2fe",background:"#eef2ff",color:"#4338ca",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"}}>
                ↗ Summary
              </button>
            )}
            <span style={{fontSize:10,color:"#94a3b8"}}>{isExpanded?"▲":"▼"}</span>
          </div>
        </div>
        {isExpanded&&renderRecordExpanded(rec)}
      </div>
    );
  }

  // Render a batch group card (INV×N + PO×1 created together)
  function renderBatchGroup(batch) {
    const isGroupExpanded = expandedBatchId === batch.batchId;
    const activeSubRec = isGroupExpanded
      ? (batch.records.find(r=>r.id===expandedSubId) || batch.records[0])
      : null;
    return (
      <div key={batch.batchId} style={{background:"#fff",border:"2px solid #e0e7ff",borderRadius:14,overflow:"hidden",boxShadow:"0 2px 8px rgba(99,102,241,0.08)"}}>
        {/* Batch header */}
        <div onClick={()=>{ setExpandedBatchId(isGroupExpanded?null:batch.batchId); if(!isGroupExpanded) setExpandedSubId(batch.records[0]?.id||null); }}
          style={{display:"flex",alignItems:"center",gap:10,padding:"12px 16px",cursor:"pointer",userSelect:"none",flexWrap:"wrap",background:"#f5f3ff"}}>
          <div style={{minWidth:0,flex:1}}>
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
              <span style={{fontFamily:"monospace",fontSize:10,background:"#6366f1",padding:"2px 7px",borderRadius:4,color:"#fff",fontWeight:700,letterSpacing:"0.04em"}}>BATCH</span>
              {batch.orderName&&<span style={{fontSize:12,fontWeight:800,color:"#312e81"}}>{batch.orderName}</span>}
              <span style={{fontSize:11,color:"#6366f1",fontWeight:600}}>{batch.invRecs.length} invoice{batch.invRecs.length!==1?"s":""} + {batch.poRecs.length?`${batch.poRecs.length} PO${batch.poRecs.length!==1?"s":""}`:"no PO"}</span>
            </div>
            <div style={{fontSize:11,color:"#6b7280",marginTop:3,display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
              <span>{fmtDate(batch.dateFrom)}{batch.dateTo&&batch.dateTo!==batch.dateFrom?` – ${fmtDate(batch.dateTo)}`:""}</span>
              <span style={{color:"#c4b5fd"}}>·</span>
              <span style={{color:"#475569"}}>{new Date(batch.createdAt).toLocaleDateString("en-NZ",{day:"numeric",month:"short",year:"numeric"})}</span>
            </div>
            {/* Sub-record chips — display order: PO → INVs. Click name expands; ↓ icon downloads */}
            <div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:6}}>
              {batch.records.map(r=>{
                const isPOChip = r.type==="purchase_order";
                const active = activeSubRec?.id===r.id;
                const tone = isPOChip
                  ? { borderActive:"#1d4ed8", borderIdle:"#bfdbfe", bgActive:"#1d4ed8", bgIdle:"#dbeafe", fgActive:"#fff", fgIdle:"#1d4ed8" }
                  : { borderActive:"#4f46e5", borderIdle:"#c7d2fe", bgActive:"#4f46e5", bgIdle:"#eef2ff", fgActive:"#fff", fgIdle:"#4338ca" };
                const dt = isPOChip ? "purchase_order" : "invoice";
                const label = isPOChip ? `PO · ${(PROVIDERS[r.provider||"gtec"]||PROVIDERS.gtec).short}` : `INV · ${displayName(r.bookerEmail)}`;
                return (
                  <div key={r.id} style={{display:"inline-flex",borderRadius:6,overflow:"hidden",border:`1.5px solid ${active?tone.borderActive:tone.borderIdle}`}}>
                    <button onClick={e=>{e.stopPropagation();setExpandedBatchId(batch.batchId);setExpandedSubId(r.id);}}
                      style={{padding:"3px 8px",border:"none",background:active?tone.bgActive:tone.bgIdle,color:active?tone.fgActive:tone.fgIdle,
                        cursor:"pointer",fontSize:10,fontWeight:700,fontFamily:"monospace"}}>
                      {label} <span style={{opacity:0.7,fontWeight:400}}>{r.id}</span>
                    </button>
                    <button onClick={e=>{e.stopPropagation();downloadRecord(r,"html",dt,exportMode);}}
                      title={`Download ${exportMode} HTML`}
                      style={{padding:"3px 7px",border:"none",borderLeft:`1px solid ${active?tone.borderActive:tone.borderIdle}`,
                        background:active?tone.bgActive:tone.bgIdle,color:active?tone.fgActive:tone.fgIdle,cursor:"pointer",fontSize:11}}>
                      ↓
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
            <span style={{fontSize:13,fontWeight:700,color:"#312e81"}}>{fmtMoney(batch.total)}</span>
            <StatusPill status={batch.status}/>
            <button onClick={e=>{e.stopPropagation();
              batch.records.forEach(r=>{
                const dt = r.type==="purchase_order"?"purchase_order":"invoice";
                downloadRecord(r,"html",dt,exportMode);
              });
            }} title={`Open HTML for all ${batch.records.length} records (${exportMode})`}
              style={{padding:"3px 9px",borderRadius:6,border:"1.5px solid #c4b5fd",background:"#ede9fe",color:"#6d28d9",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"}}>
              📥 Download all
            </button>
            {isAdmin&&onRenameBatch&&(
              <button onClick={e=>{e.stopPropagation();
                const next = window.prompt("Rename this batch (leave blank to clear the name):", batch.orderName);
                if (next!==null && next.trim()!==batch.orderName) onRenameBatch(batch.batchId, next);
              }} title={batch.records.some(r=>r.drive?.pdfId)?"Rename this batch — its Drive folder and documents are updated to match":"Rename this batch"}
                style={{padding:"3px 9px",borderRadius:6,border:"1.5px solid #c7d2fe",background:"#fff",color:"#4338ca",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"}}>
                ✏️ Rename
              </button>
            )}
            {driveEnabled&&isAdmin&&onDriveSync&&(
              <button onClick={e=>{e.stopPropagation();onDriveSync(batch.records.map(r=>r.id));}}
                title="Sync all documents in this batch to Google Drive"
                style={{padding:"3px 9px",borderRadius:6,border:"1.5px solid #6ee7b7",background:"#ecfdf5",color:"#047857",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"}}>
                📁 {batch.records.some(r=>r.drive?.webViewLink)?"Re-sync Drive":"Sync to Drive"}
              </button>
            )}
            {onLoadToSummary&&(
              <button onClick={e=>{e.stopPropagation();onLoadToSummary({
                dateFrom: batch.dateFrom, dateTo: batch.dateTo,
                emails: batch.invRecs.map(r=>r.bookerEmail).filter(Boolean),
              });}}
                title={`Load date range + all ${batch.invRecs.length} bookers into Summary`}
                style={{padding:"3px 9px",borderRadius:6,border:"1.5px solid #c7d2fe",background:"#eef2ff",color:"#4338ca",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"}}>
                ↗ Summary
              </button>
            )}
            {isAdmin&&batch.allDraft&&onDeleteRecord&&(
              <button onClick={e=>{e.stopPropagation();if(window.confirm(`Delete all ${batch.records.length} draft records in this batch? This cannot be undone.`)) batch.records.forEach(r=>onDeleteRecord(r.id));}}
                style={{padding:"3px 9px",borderRadius:6,border:"1.5px solid #fecaca",background:"#fef2f2",color:"#b91c1c",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"}}>
                🗑 Delete batch
              </button>
            )}
            <span style={{fontSize:10,color:"#94a3b8"}}>{isGroupExpanded?"▲":"▼"}</span>
          </div>
        </div>
        {/* Expanded: sub-record detail */}
        {isGroupExpanded&&activeSubRec&&(
          <div>
            <div style={{padding:"6px 16px 0",background:"#faf5ff",borderTop:"1px solid #e0e7ff",display:"flex",gap:5,flexWrap:"wrap"}}>
              {batch.records.map(r=>(
                <button key={r.id} onClick={()=>setExpandedSubId(r.id)}
                  style={{padding:"4px 10px",borderRadius:"6px 6px 0 0",border:"1px solid",borderBottom:"none",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"monospace",
                    borderColor:expandedSubId===r.id?"#6366f1":"#c4b5fd",
                    background:expandedSubId===r.id?"#fff":"#ede9fe",
                    color:expandedSubId===r.id?"#4f46e5":"#7c3aed"}}>
                  {r.type==="purchase_order"?"PO":"INV"} {r.id}
                  <StatusPill status={r.status||"draft"}/>
                </button>
              ))}
            </div>
            {renderRecordExpanded(activeSubRec)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{fontFamily:"'DM Sans','Segoe UI',system-ui,sans-serif"}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,flexWrap:"wrap"}}>
        <span style={{fontSize:15,fontWeight:800,color:"#0f172a",whiteSpace:"nowrap"}}>🧾 Billing Records</span>
        <div style={{marginLeft:"auto",display:"flex",gap:4,flexWrap:"nowrap",overflowX:"auto",scrollbarWidth:"none",maxWidth:"100%"}}>
          {[{k:"all",l:"All"}, ...PIPELINE_STATES].map(s=>{
            const key = s.k||s.key;
            const label = s.l || SHORT_STATUS[s.key] || s.label;
            const active = filterStatus===key;
            return (
              <button key={key} onClick={()=>setFilterStatus(key)} title={s.description||s.label||s.l}
                style={{padding:"3px 9px",borderRadius:14,border:"1px solid",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit",whiteSpace:"nowrap",flexShrink:0,
                  borderColor:active?"#0f172a":"#e2e8f0",background:active?"#0f172a":"#fff",color:active?"#fff":"#64748b"}}>
                {label}
              </button>
            );
          })}
        </div>
      </div>
      {/* Google Drive connection panel — config-gated */}
      {isAdmin&&driveEnabled&&(
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:12,padding:"8px 12px",background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,fontSize:12}}>
          <span style={{fontWeight:700,color:"#15803d"}}>📁 Google Drive</span>
          <span style={{color:"#64748b"}}>Official invoices & POs are filed to <strong>{DRIVE_ROOT_FOLDER}</strong> on creation.</span>
          <button disabled={driveBusy} onClick={async()=>{
            setDriveBusy(true); setDriveTest(null);
            try { const r = await testDriveConnection(); setDriveTest({ok:true,msg:`Connected as ${r.email} — folder create/delete OK.`}); }
            catch(e) { setDriveTest({ok:false,msg:String(e.message||e)}); }
            finally { setDriveBusy(false); }
          }} style={{marginLeft:"auto",padding:"4px 12px",borderRadius:6,border:"1.5px solid #6ee7b7",background:"#ecfdf5",color:"#047857",cursor:driveBusy?"wait":"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"}}>
            {driveBusy?"Testing…":"🔌 Connect & test"}
          </button>
          <button onClick={()=>{disconnectDrive(); setDriveTest({ok:true,msg:"Disconnected — the next sync will ask for Google consent again."});}}
            style={{padding:"4px 10px",borderRadius:6,border:"1px solid #e2e8f0",background:"#fff",color:"#94a3b8",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit"}}>Disconnect</button>
          {driveTest&&<div style={{flexBasis:"100%",color:driveTest.ok?"#15803d":"#b91c1c",fontSize:11,fontWeight:600}}>{driveTest.ok?"✓ ":"⚠ "}{driveTest.msg}</div>}
        </div>
      )}
      {/* View mode + export mode */}
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12,padding:"6px 10px",background:"#f8fafc",borderRadius:8,fontSize:11,flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{color:"#64748b",fontWeight:600,whiteSpace:"nowrap"}}>View:</span>
          {[{k:"grouped",l:"Grouped"},{k:"individual",l:"Individual"}].map(opt=>(
            <button key={opt.k} onClick={()=>setViewMode(opt.k)}
              title={opt.k==="grouped"?"Batch INV+PO sets shown as one card":"Every record shown as its own row"}
              style={{padding:"3px 10px",borderRadius:6,border:"1px solid",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit",
                borderColor:viewMode===opt.k?"#0f172a":"#e2e8f0",background:viewMode===opt.k?"#0f172a":"#fff",color:viewMode===opt.k?"#fff":"#475569"}}>
              {opt.l}
            </button>
          ))}
        </div>
        <div style={{width:1,height:18,background:"#e2e8f0",flexShrink:0}}/>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{color:"#64748b",fontWeight:600,whiteSpace:"nowrap"}}>Export:</span>
          {[{k:"grouped",l:"Summary"},{k:"individual",l:"Itemised"}].map(opt=>(
            <button key={opt.k} onClick={()=>setExportMode(opt.k)}
              title={opt.k==="grouped"?"One line per booking pattern":"One line per individual booking"}
              style={{padding:"3px 10px",borderRadius:6,border:"1px solid",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit",
                borderColor:exportMode===opt.k?"#4338ca":"#e2e8f0",background:exportMode===opt.k?"#4338ca":"#fff",color:exportMode===opt.k?"#fff":"#475569"}}>
              {opt.l}
            </button>
          ))}
        </div>
        {isAdmin&&onEmailOfficial&&(<>
          <div style={{width:1,height:18,background:"#e2e8f0",flexShrink:0}}/>
          <span style={{color:"#64748b",fontWeight:600,whiteSpace:"nowrap"}}>Email:</span>
          <button onClick={()=>{ setEmailMode("preview"); setEmailExportMode(exportMode); setEmailSelIds(new Set()); setEmailNote(""); setShowEmailModal(true); }}
            title="Email unofficial previews. Drafts and issued invoices can both be queued; several for one booker bundle into a single email."
            style={{padding:"3px 10px",borderRadius:6,border:"1px solid #b45309",background:"#b45309",color:"#fff",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"}}>
            ✉ Draft / preview
          </button>
          <button onClick={()=>{ setEmailMode("official"); setEmailExportMode(exportMode); setEmailSelIds(new Set()); setEmailNote(""); setShowEmailModal(true); }}
            title="Email official payable invoices. Several invoices for one booker bundle into a single email."
            style={{padding:"3px 10px",borderRadius:6,border:"1px solid #0369a1",background:"#0369a1",color:"#fff",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"}}>
            ✉ Official invoices
          </button>
        </>)}
      </div>

      {showEmailModal&&isAdmin&&onEmailOfficial&&(()=>{
        const preview = emailMode === "preview";
        const perInvoice = emailSendMode === "individual";
        // Previews may cover anything, including drafts — the point is "does this look
        // right before I issue it". Official sends are restricted to issued invoices: a
        // draft has no reference a booker could pay against. Purchase orders are excluded
        // either way, since they go to GTEC rather than to a booker.
        const eligible = r => r.type !== "purchase_order" && r.bookerEmail &&
          r.bookerEmail !== "combined" && r.bookerEmail !== "gtec" &&
          (preview || (r.status||"draft") !== "draft");
        const isDraft = r => (r.status||"draft") === "draft";

        // Organised exactly like the Billing list behind it: batch cards first, then
        // standalone records, honouring the same status filter — so what you see here
        // lines up with what you were just looking at.
        const emailBatches = batches
          .map(b => ({ ...b, recs: b.invRecs.filter(eligible) }))
          .filter(b => b.recs.length);
        const emailSingles = ungrouped.filter(eligible);
        // One pool either way — View only changes how it is presented, never what can be
        // picked — so a selection survives flipping between Grouped and Individual.
        const allSendable = sorted.filter(eligible);
        const selectedRecs = allSendable.filter(r => emailSelIds.has(r.id));

        // Bundling unit: one email per booker, or one per invoice.
        const byBooker = {};
        for (const r of selectedRecs) (byBooker[canonEmail(r.bookerEmail)] ||= []).push(r);
        const outgoing = perInvoice ? selectedRecs.map(r=>[r]) : Object.values(byBooker);

        const setIds = ids => setEmailSelIds(new Set(ids));
        const toggle = id => setEmailSelIds(prev => { const n=new Set(prev); n.has(id)?n.delete(id):n.add(id); return n; });
        const toggleMany = recs => setEmailSelIds(prev => {
          const n=new Set(prev); const all=recs.every(r=>n.has(r.id));
          recs.forEach(r => all ? n.delete(r.id) : n.add(r.id));
          return n;
        });
        const quick = (label, recs, title) => (
          <button key={label} onClick={()=>setIds(recs.map(r=>r.id))} disabled={!recs.length} title={title}
            style={{padding:"3px 9px",borderRadius:6,border:"1px solid #cbd5e1",background:recs.length?"#fff":"#f8fafc",
              color:recs.length?"#475569":"#cbd5e1",cursor:recs.length?"pointer":"not-allowed",fontSize:11,fontWeight:600,fontFamily:"inherit"}}>
            {label} ({recs.length})
          </button>
        );
        const accent = preview ? "#b45309" : "#0369a1";

        const invoiceRow = (r, indent) => (
          <label key={r.id} style={{display:"flex",alignItems:"center",gap:8,padding:`5px 12px 5px ${indent}px`,borderTop:"1px solid #f1f5f9",cursor:"pointer",fontSize:12}}>
            <input type="checkbox" checked={emailSelIds.has(r.id)} onChange={()=>toggle(r.id)} style={{accentColor:accent}}/>
            <span style={{fontFamily:"monospace",color:"#0f172a"}}>{r.id}</span>
            <span style={{color:"#475569",fontWeight:600}}>{displayName(r.bookerEmail)}</span>
            <span style={{color:"#94a3b8"}}>{r.dateFrom?fmtDate(r.dateFrom):""}{r.dateTo&&r.dateTo!==r.dateFrom?` – ${fmtDate(r.dateTo)}`:""}</span>
            <StatusPill status={r.status}/>
            <span style={{marginLeft:"auto",fontWeight:700,color:"#0f172a"}}>{fmtMoney(r.total)}</span>
          </label>
        );

        function buildItem(recs, detail, extraNote = "") {
          const n = recs.length;
          const name = displayName(recs[0].bookerEmail);
          return {
            to: recs[0].bookerEmail, name, count: n,
            total: recs.reduce((s,r)=>s+(r.total||0),0),
            refs: recs.map(r=>r.id),
            subject: preview
              ? (n===1 ? `Draft invoice ${recs[0].id} for review — ${AMUA_INFO.name}` : `Draft invoices for review — ${AMUA_INFO.name}`)
              : (n===1 ? `Invoice ${recs[0].id} from ${AMUA_INFO.name}` : `${n} invoices from ${AMUA_INFO.name}`),
            html: buildInvoiceBundleHtml({
              recipientName: name, recipientEmail: recs[0].bookerEmail,
              note: [emailNote.trim(), extraNote].filter(Boolean).join("\n\n"), preview,
              docs: recs.map(r => ({ rec:r, docType:"invoice",
                lines: detail==="individual" ? (r.individualLines||r.lines||[]) : (r.lines||[]) })),
            }),
          };
        }
        // One email per booker when it fits the email size limit. Otherwise each invoice
        // goes separately, and an itemised invoice that still doesn't fit is sent as its
        // summary version instead.
        function buildItems() {
          return outgoing.flatMap(recs => {
            const all = buildItem(recs, emailExportMode);
            if (htmlBytes(all.html) <= INV_EMAIL_MAX_BYTES || recs.length === 1 && emailExportMode !== "individual") return [all];
            return recs.map(r => {
              const one = buildItem([r], emailExportMode);
              if (htmlBytes(one.html) <= INV_EMAIL_MAX_BYTES || emailExportMode !== "individual") return one;
              return buildItem([r], "grouped", "This invoice has too many lines to itemise by email, so it is shown as a summary. Reply to this email if you would like the itemised copy.");
            });
          });
        }
        async function send() {
          setEmailBusy(true);
          try {
            const ok = await onEmailOfficial(buildItems(), { preview });
            if (ok !== false) { setShowEmailModal(false); setEmailSelIds(new Set()); }
          } finally { setEmailBusy(false); }
        }
        function queue() {
          const ok = onQueueInvoiceEmails(buildItems(), { preview });
          if (ok !== false) { setShowEmailModal(false); setEmailSelIds(new Set()); }
        }

        return (
          <Modal title={preview ? "✉ Email draft / preview invoices" : "✉ Email official invoices"} onClose={()=>setShowEmailModal(false)} width={780}>
            {/* minHeight:0 + flex:1 lets the record list below be the scrolling region while
                the mode switches and the send bar stay put. */}
            <div style={{display:"flex",flexDirection:"column",gap:10,minHeight:0,flex:1}}>
              <div style={{display:"flex",borderRadius:10,overflow:"hidden",border:"1.5px solid #e2e8f0",flexShrink:0}}>
                {[{k:"preview",l:"Preview (unofficial)"},{k:"official",l:"Official (payable)"}].map(o=>(
                  <button key={o.k} onClick={()=>{ setEmailMode(o.k); setEmailSelIds(new Set()); }}
                    style={{flex:1,padding:"9px 14px",border:"none",cursor:"pointer",fontFamily:"inherit",fontWeight:700,fontSize:12,
                      background:emailMode===o.k?(o.k==="preview"?"#b45309":"#0369a1"):"#f8fafc",
                      color:emailMode===o.k?"#fff":"#64748b"}}>
                    {o.l}
                  </button>
                ))}
              </div>
              <div style={{fontSize:11.5,color:"#475569",background:preview?"#fffbeb":"#f0f9ff",border:`1px solid ${preview?"#fde68a":"#bae6fd"}`,borderRadius:8,padding:"8px 11px",flexShrink:0}}>
                {preview
                  ? <>Copies marked <strong>unofficial — not a tax invoice</strong>, nothing payable. Drafts <em>and</em> issued invoices can be queued.</>
                  : <>Real <strong>payable invoices</strong>. Drafts are hidden here — switch to Preview to send one for review.</>}
                {" "}Same grouping and status filter as the list behind.
              </div>

              <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",flexShrink:0}}>
                <span style={{fontSize:11,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.05em"}}>Export</span>
                {[{k:"grouped",l:"Summary",t:"One line per booking pattern — as in the Billing list"},
                  {k:"individual",l:"Itemised",t:"One line per individual booking — as in the Billing list"}].map(o=>(
                  <button key={o.k} onClick={()=>setEmailExportMode(o.k)} title={o.t}
                    style={{padding:"3px 10px",borderRadius:6,border:"1px solid",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit",
                      borderColor:emailExportMode===o.k?"#4338ca":"#e2e8f0",background:emailExportMode===o.k?"#4338ca":"#fff",color:emailExportMode===o.k?"#fff":"#475569"}}>
                    {o.l}
                  </button>
                ))}
                <div style={{width:1,height:16,background:"#e2e8f0",flexShrink:0}}/>
                <span style={{fontSize:11,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.05em"}}>Send as</span>
                {[{k:"grouped",l:"Grouped per booker",t:"One email per booker containing all their selected invoices"},
                  {k:"individual",l:"One email per invoice",t:"A separate email for every selected invoice"}].map(o=>(
                  <button key={o.k} onClick={()=>setEmailSendMode(o.k)} title={o.t}
                    style={{padding:"3px 10px",borderRadius:6,border:"1px solid",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit",
                      borderColor:emailSendMode===o.k?accent:"#e2e8f0",background:emailSendMode===o.k?accent:"#fff",color:emailSendMode===o.k?"#fff":"#475569"}}>
                    {o.l}
                  </button>
                ))}
              </div>

              {allSendable.length===0
                ? <div style={{textAlign:"center",padding:28,color:"#94a3b8",fontSize:13}}>
                    {preview ? "No invoices to preview under the current status filter." : "No issued invoices to send. Create an official invoice, or use Preview for drafts."}
                  </div>
                : (<>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center",flexShrink:0}}>
                    <span style={{fontSize:11,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.05em"}}>Quick select</span>
                    {quick("All", allSendable, "Select every listed invoice")}
                    {preview && quick("Drafts", allSendable.filter(isDraft), "Select only draft invoices")}
                    {preview && quick("Issued", allSendable.filter(r=>!isDraft(r)), "Select only already-issued invoices")}
                    <button onClick={()=>setIds([])} style={{padding:"3px 9px",borderRadius:6,border:"1px solid #e2e8f0",background:"#fff",color:"#94a3b8",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit"}}>Clear</button>
                  </div>
                  {/* The one scrolling region — flex:1 with a vh cap so it scrolls even if
                      the flex chain can't resolve a height. */}
                  <div style={{flex:1,minHeight:120,maxHeight:"46vh",overflowY:"auto",display:"flex",flexDirection:"column",gap:8,paddingRight:2}}>
                    {emailBatches.map(b=>{
                      const all = b.recs.every(r=>emailSelIds.has(r.id));
                      const some = !all && b.recs.some(r=>emailSelIds.has(r.id));
                      return (
                        <div key={b.batchId} style={{border:"2px solid #e0e7ff",borderRadius:12,overflow:"hidden"}}>
                          <label style={{display:"flex",alignItems:"center",gap:9,padding:"8px 12px",background:"#f5f3ff",cursor:"pointer"}}>
                            <input type="checkbox" checked={all} ref={el=>{ if(el) el.indeterminate = some; }}
                              onChange={()=>toggleMany(b.recs)} style={{accentColor:accent,width:15,height:15}}/>
                            <span style={{fontWeight:800,fontSize:12,color:"#312e81"}}>{b.orderName||"Batch"}</span>
                            <span style={{fontSize:11,color:"#6366f1",fontWeight:600}}>{b.recs.length} invoice{b.recs.length!==1?"s":""}</span>
                            <span style={{fontSize:11,color:"#94a3b8"}}>{b.dateFrom?fmtDate(b.dateFrom):""}{b.dateTo&&b.dateTo!==b.dateFrom?` – ${fmtDate(b.dateTo)}`:""}</span>
                            <span style={{marginLeft:"auto",fontSize:12,fontWeight:700,color:"#312e81"}}>{fmtMoney(b.recs.reduce((s,r)=>s+(r.total||0),0))}</span>
                          </label>
                          {b.recs.map(r=>invoiceRow(r,34))}
                        </div>
                      );
                    })}
                    {emailSingles.length>0&&(
                      <div style={{border:"1.5px solid #e2e8f0",borderRadius:12,overflow:"hidden"}}>
                        <label style={{display:"flex",alignItems:"center",gap:9,padding:"8px 12px",background:"#f8fafc",cursor:"pointer"}}>
                          <input type="checkbox"
                            checked={emailSingles.every(r=>emailSelIds.has(r.id))}
                            ref={el=>{ if(el) el.indeterminate = !emailSingles.every(r=>emailSelIds.has(r.id)) && emailSingles.some(r=>emailSelIds.has(r.id)); }}
                            onChange={()=>toggleMany(emailSingles)} style={{accentColor:accent,width:15,height:15}}/>
                          <span style={{fontWeight:800,fontSize:12,color:"#0f172a"}}>Standalone</span>
                          <span style={{fontSize:11,color:"#64748b"}}>{emailSingles.length} invoice{emailSingles.length!==1?"s":""}</span>
                          <span style={{marginLeft:"auto",fontSize:12,fontWeight:700,color:"#0f172a"}}>{fmtMoney(emailSingles.reduce((s,r)=>s+(r.total||0),0))}</span>
                        </label>
                        {emailSingles.map(r=>invoiceRow(r,34))}
                      </div>
                    )}
                  </div>
                </>)}

              <div style={{flexShrink:0}}>
                <label style={{...S.lbl}}>Note to include (optional)</label>
                <textarea value={emailNote} onChange={e=>setEmailNote(e.target.value)} rows={2}
                  placeholder={preview?"e.g. Please check these before we issue them.":"e.g. Payment due by the 20th. Please use the bank reference on each invoice."}
                  style={{...S.inp,resize:"vertical",fontFamily:"inherit"}}/>
              </div>
              {/* Silent mode blocks every send, so surface it here rather than letting the
                  send fail with a toast telling you to go and find another menu. */}
              {onToggleSilent&&(
                <div style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:10,flexShrink:0,
                  background:silentMode?"#fffbeb":"#ecfdf5",border:`1.5px solid ${silentMode?"#fde68a":"#6ee7b7"}`}}>
                  <span style={{fontSize:18}}>{silentMode?"🔇":"🔔"}</span>
                  <div style={{flex:1,fontSize:12,color:silentMode?"#92400e":"#047857"}}>
                    <div style={{fontWeight:700}}>{silentMode?"Silent mode ON — nothing will send":"Emails will be sent"}</div>
                    <div>{silentMode?"All outgoing email is suppressed. Disable it to send from here.":`${preview?"Previews":"Invoices"} go out to the bookers listed below.`}</div>
                  </div>
                  <button onClick={()=>onToggleSilent(!silentMode)}
                    style={S.btn({background:silentMode?"#f59e0b":"#10b981",color:"#fff",fontSize:12,fontWeight:700,whiteSpace:"nowrap"})}>
                    {silentMode?"Disable silent mode":"Mute emails"}
                  </button>
                </div>
              )}
              <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",borderTop:"1px solid #f1f5f9",paddingTop:10,flexShrink:0}}>
                <span style={{fontSize:12,color:selectedRecs.length?"#0f172a":"#94a3b8",fontWeight:selectedRecs.length?700:400}}>
                  {selectedRecs.length
                    ? `Queue: ${selectedRecs.length} invoice${selectedRecs.length!==1?"s":""} → ${outgoing.length} email${outgoing.length!==1?"s":""}${perInvoice?"":` (${[...new Set(selectedRecs.map(r=>displayName(r.bookerEmail)))].join(", ")})`}`
                    : "Nothing selected"}
                </span>
                <div style={{marginLeft:"auto",display:"flex",gap:8}}>
                  <button onClick={()=>setShowEmailModal(false)} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569",fontSize:12})}>Cancel</button>
                  {/* Queueing stages the email for the cart, so it can sit alongside the
                      rest of a submission and go out with everything else. Silent mode
                      doesn't block it — nothing sends until the cart is submitted. */}
                  {onQueueInvoiceEmails&&(
                    <button disabled={!selectedRecs.length||emailBusy} onClick={queue}
                      title="Stage these emails in the cart to review and send with everything else"
                      style={S.btn({border:`1.5px solid ${selectedRecs.length?accent:"#e2e8f0"}`,background:"#fff",
                        color:selectedRecs.length?accent:"#cbd5e1",fontWeight:700,fontSize:12,
                        cursor:selectedRecs.length&&!emailBusy?"pointer":"not-allowed"})}>
                      🛒 Add {outgoing.length||""} to cart
                    </button>
                  )}
                  {(()=>{
                    const blocked = silentMode || !selectedRecs.length || emailBusy;
                    return (
                      <button disabled={blocked} onClick={send}
                        title={silentMode?"Silent mode is on — disable it above, or add to cart instead":undefined}
                        style={S.btn({background:blocked?"#cbd5e1":accent,color:"#fff",fontWeight:700,fontSize:12,cursor:blocked?"not-allowed":"pointer"})}>
                        {emailBusy?"Sending…":silentMode?"🔇 Silent mode on":`✉ Send ${outgoing.length||""} now`}
                      </button>
                    );
                  })()}
                </div>
              </div>
            </div>
          </Modal>
        );
      })()}

      {batches.length===0&&ungrouped.length===0&&(
        <div style={{textAlign:"center",padding:48,color:"#94a3b8",fontSize:14}}>No billing records{filterStatus!=="all"?` with status "${stateInfo(filterStatus).label}"`:""}.</div>
      )}

      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {viewMode==="grouped"
          ? <>{batches.map(batch=>renderBatchGroup(batch))}{ungrouped.map(rec=>renderSingleRecord(rec))}</>
          : sorted.map(rec=>renderSingleRecord(rec))
        }
      </div>
    </div>
  );
}