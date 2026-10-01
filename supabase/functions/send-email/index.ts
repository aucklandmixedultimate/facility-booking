// send-email — server-side email proxy (Supabase Edge Function, Deno).
//
// Why: keeps EmailJS credentials out of the browser bundle. The web app calls
// this with the signed-in user's Supabase access token; we validate that it is a
// real *user* session (not the public anon key), then send via EmailJS using
// keys held as Supabase secrets. A leaked public key can no longer be reused
// from another site, and only authenticated app users can trigger email.
//
// Secrets (set with `supabase secrets set ...`, see README.md):
//   EMAILJS_SERVICE, EMAILJS_TEMPLATE_ORDER, EMAILJS_TEMPLATE_APPROVAL,
//   EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY (optional, recommended)
// SUPABASE_URL and SUPABASE_ANON_KEY are injected automatically.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Hard rule: the app emails bookers only. Mail addressed to anyone else (vendors, private
// operators, the council) is rewritten into a draft sent to AMUA's own inbox, with the
// intended recipients listed above it. The web app does the same; this is the backstop.
const AMUA_INBOX = "aucklandmixedultimate@gmail.com";
export function toAmuaDraft(to: string, cc: string | undefined, subject: string, html: string) {
  const esc = (s: string) => s.replace(/</g, "&lt;");
  return { to: AMUA_INBOX, cc: undefined, subject: `[DRAFT for ${[to, cc].filter(Boolean).join(", ")}] ${subject}`,
    html: `<div style="font-family:sans-serif;border:2px dashed #b45309;background:#fffbeb;padding:10px 14px;margin-bottom:14px;border-radius:8px">` +
      `<b>Draft — not sent.</b> AMUA doesn't email vendors, operators or the council from the booking app.<br>` +
      `<b>Intended recipients:</b> ${esc(to)}${cc ? `<br><b>Cc:</b> ${esc(cc)}` : ""}<br>Review it, then send it from Gmail.</div><hr>${html}` };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  // 1) Authenticate: require a real Supabase *user* session. The anon key is a
  //    valid JWT but resolves to no user, so /auth/v1/user rejects it -> 401.
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json(401, { error: "missing_token" });
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
  });
  if (!userRes.ok) return json(401, { error: "unauthorized" });
  const user = await userRes.json();
  if (!user?.id) return json(401, { error: "unauthorized" });

  // 2) Validate payload.
  let body: { to?: string; subject?: string; html?: string; kind?: string; cc?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  let { to, subject, html, kind, cc } = body ?? {};
  if (!to || !subject || !html) return json(400, { error: "missing_fields" });

  // 2b) Bookers only: AMUA's inbox, the caller themselves, or an address with bookings
  //     (looked up with the caller's token, so RLS applies). Anyone else → AMUA draft.
  const isBooker = async (addr: string) => {
    const a = addr.trim().toLowerCase();
    if (a === AMUA_INBOX || a === String(user.email || "").toLowerCase()) return true;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/bookings?select=id&email=ilike.${encodeURIComponent(a)}&limit=1`,
      { headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY } });
    return r.ok && ((await r.json()) as unknown[]).length > 0;
  };
  if (!(await isBooker(to)) || (cc && !(await isBooker(cc)))) {
    ({ to, cc, subject, html } = toAmuaDraft(to, cc, subject, html));
  }

  // 3) Resolve EmailJS config (secrets — never shipped to the client).
  const serviceId = Deno.env.get("EMAILJS_SERVICE");
  const publicKey = Deno.env.get("EMAILJS_PUBLIC_KEY");
  const privateKey = Deno.env.get("EMAILJS_PRIVATE_KEY"); // optional but recommended
  const templateId = Deno.env.get(
    kind === "approval" ? "EMAILJS_TEMPLATE_APPROVAL" : "EMAILJS_TEMPLATE_ORDER",
  );
  if (!serviceId || !templateId || !publicKey) {
    return json(500, { error: "email_not_configured" });
  }

  // 4) Send server-side via EmailJS. `accessToken` (the private key) is dropped
  //    from the JSON when undefined.
  const ejRes = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: serviceId,
      template_id: templateId,
      user_id: publicKey,
      accessToken: privateKey,
      // `cc_email` is only meaningful if the EmailJS template's Cc field is set to
      // "{{cc_email}}" — see README. Empty string when absent so the template's Cc
      // resolves to nothing rather than a literal placeholder.
      template_params: { to_email: to, subject, message_html: html, cc_email: cc ?? "" },
    }),
  });
  if (!ejRes.ok) {
    const detail = (await ejRes.text().catch(() => "")).slice(0, 300);
    return json(502, { error: "emailjs_failed", status: ejRes.status, detail });
  }
  return json(200, { ok: true });
});
