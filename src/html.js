// Escaping for text that ends up in HTML (emails, invoice documents, tooltips) or CSV.

// Text for HTML element content or a quoted attribute.
export const escHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// One quoted CSV cell. A leading = + - @ (or tab / carriage return) makes spreadsheets run the
// cell as a formula, so such text gets a leading apostrophe. Numbers are left as numbers.
export const csvCell = v => {
  if (typeof v === "number") return String(v);
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
};
