# `send-email` Edge Function

Server-side email proxy so EmailJS credentials never ship in the browser bundle.
The web app calls this function with the signed-in user's Supabase JWT; the
function validates the session and sends via EmailJS using keys held as Supabase
secrets.

## Deploy (one-time)

Requires the Supabase CLI (`npm i -g supabase`) and a login (`supabase login`).
The project ref for this app is `bowfbamsjgozigcaygqq`.

```bash
# 1) Set the function secrets (values from your EmailJS dashboard)
supabase secrets set \
  EMAILJS_SERVICE=service_xxxxxxx \
  EMAILJS_TEMPLATE_ORDER=template_xxxxxxx \
  EMAILJS_TEMPLATE_APPROVAL=template_xxxxxxx \
  EMAILJS_PUBLIC_KEY=xxxxxxxxxxxxxxxx \
  EMAILJS_PRIVATE_KEY=xxxxxxxxxxxxxxxx \
  --project-ref bowfbamsjgozigcaygqq

# 2) Deploy. Keep JWT verification ON — do NOT pass --no-verify-jwt.
supabase functions deploy send-email --project-ref bowfbamsjgozigcaygqq
```

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are injected automatically — don't set them.

`EMAILJS_PRIVATE_KEY` is optional but recommended: set it **and** enable
"API calls require Private Key" in EmailJS (Account → Security) so that even a
leaked public key cannot send without the server-held private key.

## Request contract

`POST {SUPABASE_URL}/functions/v1/send-email` with the user's session:

```
Authorization: Bearer <user access token>
apikey: <anon key>
Content-Type: application/json

{ "to": "a@b.com", "subject": "…", "html": "<p>…</p>", "kind": "order" | "approval" }
```

Responses: `200 {ok:true}`, `401` (not a signed-in user), `400` (bad payload),
`500` (function secrets missing), `502` (EmailJS rejected the send).

## Smoke test

```bash
# Expect HTTP 401 — the anon key is not a user session.
curl -i -X POST "https://bowfbamsjgozigcaygqq.supabase.co/functions/v1/send-email" \
  -H "Authorization: Bearer $VITE_SUPABASE_ANON" \
  -H "apikey: $VITE_SUPABASE_ANON" \
  -H "Content-Type: application/json" \
  -d '{"to":"you@example.com","subject":"t","html":"<p>t</p>","kind":"order"}'
```
