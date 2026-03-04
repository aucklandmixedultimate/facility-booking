# FacilityBook — Setup Guide

## What's included
| File | Purpose |
|---|---|
| `booking-system.jsx` | Full React app (single file, drop into Vite) |
| `supabase-setup.sql` | Run once in Supabase SQL Editor to create the DB |
| `email-template-order.html` | EmailJS template — order confirmations (`template_uk1ym9r`) |
| `email-template-approval.html` | EmailJS template — approval/rejection outcomes (`template_kfbh12t`) |
| `email-template-deletion.html` | EmailJS template — removal notifications (use `template_uk1ym9r` or a third template) |

---

## Step 1 — Supabase (database, ~5 min)

1. Go to [supabase.com](https://supabase.com) → **New Project** → name it, set a DB password, pick a region (Sydney is closest to NZ)
2. Once ready → **SQL Editor** → paste `supabase-setup.sql` → **Run**
3. Go to **Settings → API** and copy:
   - **Project URL** (`https://xxxx.supabase.co`)
   - **anon / public key** (long `eyJ...` string)
4. Open `booking-system.jsx` and replace lines 8–9:
```js
const SUPABASE_URL  = "https://YOUR_PROJECT.supabase.co";
const SUPABASE_ANON = "YOUR_ANON_KEY";
```

> ⚠️ **Security:** Never commit these values to a public GitHub repo. Use a `.env` file instead (see Step 3).

---

## Step 2 — Local dev (Vite + React)

You need [Node.js](https://nodejs.org) installed.

```bash
# Run these commands inside your project folder (e.g. C:\Users\you\facility-booking)
npm create vite@latest facility-booking -- --template react
cd facility-booking
npm install
```

Replace `src/App.jsx` with the contents of `booking-system.jsx`.

```bash
npm run dev
```

Open http://localhost:5173 — bookings should save to Supabase.

---

## Step 3 — Deploy to GitHub Pages

### 3a. Keep secrets out of git (recommended)

Create a `.env` file **inside your project folder**:
```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON=your-anon-key
```

Add to `.gitignore`:
```
.env
```

In `booking-system.jsx` change lines 8–9 to:
```js
const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON;
```

### 3b. Configure Vite for GitHub Pages

Edit `vite.config.js` (replace `facility-booking` with your actual repo name):
```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/facility-booking/',
})
```

### 3c. Install gh-pages

```bash
# Make sure you're in your project folder first!
cd C:\Users\you\facility-booking

npm install --save-dev gh-pages
```

Add to `package.json` under `"scripts"`:
```json
"scripts": {
  "dev": "vite",
  "build": "vite build",
  "preview": "vite preview",
  "deploy": "gh-pages -d dist"
}
```

### 3d. Create GitHub repo

1. Go to [github.com/new](https://github.com/new)
2. Name it `facility-booking`, set to **Public**, click **Create repository**

### 3e. Push and deploy

```bash
# ⚠️ These commands must be run from INSIDE your project folder
cd C:\Users\you\facility-booking

git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/facility-booking.git
git push -u origin main

npm run build
npm run deploy
```

> **Common error:** `Missing script: "deploy"` means you ran `npm run deploy` from the wrong folder (e.g. `C:\Users\you`). Always `cd` into your project folder first.

### 3f. Enable GitHub Pages

- GitHub repo → **Settings** → **Pages**
- Source: **Deploy from branch** → Branch: `gh-pages` → **Save**

Your site will be live at:
`https://YOUR_USERNAME.github.io/facility-booking/`

---

## Step 4 — EmailJS (email notifications, free)

### 4a. Create account & service
1. Sign up at [emailjs.com](https://emailjs.com)
2. **Email Services** → Add Service → connect Gmail (or other)
3. Note your **Service ID** (e.g. `service_w2qamo7`)

### 4b. Create templates

You need **two** templates:

**Template 1 — Order Confirmation** (`template_uk1ym9r` or create new)
- Paste contents of `email-template-order.html` into the HTML body
- Required variables: `{{to_email}}`, `{{to_name}}`, `{{order_ref}}`, `{{subject}}`, `{{message_html}}`
- Set "To Email" field to `{{to_email}}`
- Set "Subject" field to `{{subject}}`

**Template 2 — Approval Outcome** (`template_kfbh12t` or create new)
- Paste contents of `email-template-approval.html` into the HTML body
- Same variable set as above
- This template receives approve/reject/cancel notifications

**Template 3 — Deletion Notice** (optional, or reuse Template 1)
- Paste contents of `email-template-deletion.html`

### 4c. Update constants in booking-system.jsx

Around line 100:
```js
const EJ_SERVICE          = "service_w2qamo7";   // ← your Service ID
const EJ_TEMPLATE_ORDER   = "template_uk1ym9r";  // ← Template 1 ID
const EJ_TEMPLATE_APPROVAL= "template_kfbh12t";  // ← Template 2 ID
const EJ_KEY              = "21HLBTcxCRtWaFyud"; // ← your Public Key
```

---

## Customisation

| What | Where in booking-system.jsx |
|---|---|
| Facility names / colours | `FACILITIES` array (~line 15) |
| Admin email | `ADMIN_PASSWORD` constant |
| Opening hours | `CAL_START` / `CAL_END` constants |
| Available durations | `DURATIONS` array |

---

## Booking rules

| Situation | Behaviour |
|---|---|
| Same facility, same time | ⚠️ Warning shown — user can proceed (shared use allowed) |
| Different facility, same time | ⚠️ Warning shown — user can proceed |
| New booking | Status starts as **Pending** until admin approves |
| Past booking (non-admin) | 🔒 Read-only — cannot be edited or cancelled |
| Edit/cancel | Only available on your own bookings |


---

## Troubleshooting

### `Missing script: "deploy"`
You ran `npm run deploy` from the wrong folder. Always `cd` into your project first:
```bash
cd C:\Users\you\facility-booking
npm run deploy
```

### `Error: spawn git ENOENT` — Git not found
Git is not installed or not on your system PATH.

**Install Git for Windows:**
1. Download from [git-scm.com/download/win](https://git-scm.com/download/win)
2. Run the installer — keep all defaults, especially **"Git from the command line and also from 3rd-party software"**
3. **Close and reopen** your terminal (cmd / PowerShell) after installing
4. Verify: `git --version` should print a version number
5. Then re-run your deploy commands

**If git is installed but still not found:**
```bash
# Check if git is on PATH
where git
# If nothing appears, add C:\Program Files\Git\cmd to your system PATH
# via: System Properties → Environment Variables → Path → Edit → New
```

### EmailJS 422 Unprocessable Content
This means the template variable names in EmailJS don't match what the app sends.
The app sends: `to_email`, `subject`, `message_html`

In your EmailJS template settings, make sure:
- **To** field is set to `{{to_email}}`  
- **Subject** field is set to `{{subject}}`
- **Body / Content** field is set to `{{message_html}}` with HTML mode enabled

