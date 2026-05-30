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
  let body: { to?: string; subject?: string; html?: string; kind?: string };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const { to, subject, html, kind } = body ?? {};
  if (!to || !subject || !html) return json(400, { error: "missing_fields" });

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
      template_params: { to_email: to, subject, message_html: html },
    }),
  });
  if (!ejRes.ok) {
    const detail = (await ejRes.text().catch(() => "")).slice(0, 300);
    return json(502, { error: "emailjs_failed", status: ejRes.status, detail });
  }
  return json(200, { ok: true });
});
