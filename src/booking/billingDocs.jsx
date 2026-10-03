import { AMUA_INFO, PROVIDERS, amuaContactLine, fmtCost, fmtDate, fmtDateShortDow } from "./core.jsx";
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