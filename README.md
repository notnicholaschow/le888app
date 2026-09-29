# MyApp — setup guide (main frame)

This is the deployable skeleton for your **new, standalone** app.
It is a clone of your existing rewards/mini-game PWA, but wired to a **new
database, new bucket, and new worker name** so it never touches the original.

Rebranding, new games, and self-signup come **after** this is live.

---

## 1. Folder layout

Put the files in exactly this shape before you push to GitHub:

```
myapp/
├─ index.ts                    ← your backend (from your upload)
├─ schema.sql                  ← your DB schema (from your upload)
├─ migration-hardening.sql     ← your DB migration (from your upload)
├─ wrangler.toml               ← NEW (provided)
├─ package.json                ← NEW (provided)
├─ tsconfig.json               ← NEW (provided)
├─ .gitignore                  ← NEW (provided)
├─ README.md                   ← NEW (this file)
└─ public/                     ← everything the browser downloads lives here
   ├─ index.html               ← your player app (from your upload)
   ├─ admin.html               ← your admin app (from your upload)
   ├─ sw.js                    ← your service worker (from your upload)
   ├─ manifest-game.webmanifest← NEW (provided) — edit name/colors later
   ├─ icon-192.png             ← app icon (see step 6)
   ├─ icon-512.png             ← app icon
   ├─ icon-180.png             ← apple touch icon
   └─ img/                      ← logos, backgrounds, game art, rank badges
```

> **Important:** `index.html`, `admin.html`, and `sw.js` must go **inside
> `public/`**, not at the root. The backend serves them from there.

---

## 2. Two things you MUST know before you deploy

**a) Your `schema.sql` is only a starting slice — not the full database.**
Your backend (`index.ts`) uses many more tables than `schema.sql` creates
(games config, promos, chat, withdrawals, RTP, VIP rewards, player game IDs,
manual credits, and more). The app is written to *not crash* when a table is
missing — it just shows "being set up" for those features until the table
exists.

The complete, tested database definition lives in your **original repo's
migration files**. For a fully-working clone, copy those migration `.sql`
files into this repo and run them too (see step 5). If you can't find them,
tell me and I'll rebuild a complete `schema.sql` from your `index.ts`.

**b) Assets (icons, logos, backgrounds, game images) are not in your upload.**
Those are image files that only exist in your original project. Copy the whole
`public/img/` folder and the icons over from the original. Without them the app
runs but shows blank images. You'll replace them during the rebrand anyway.

---

## 3. Install the tools (one time)

- Install **Node.js** (v18+): https://nodejs.org
- In your project folder, run:

```
npm install
npx wrangler login
```

`wrangler login` opens your browser to connect your Cloudflare account.

---

## 4. Create the new database and bucket

```
npx wrangler d1 create myapp-db
npx wrangler r2 bucket create myapp-images
```

- `d1 create` prints a **database_id**. Copy it.
- Open `wrangler.toml` and paste it into `database_id = "..."`.

---

## 5. Build the database tables

Run these **in order** (schema first, then the hardening migration):

```
npm run db:init
npm run db:harden
```

Then, if you brought over your original migration files, run each the same way:

```
npx wrangler d1 execute myapp-db --file=./your-migration-02.sql --remote
npx wrangler d1 execute myapp-db --file=./your-migration-03.sql --remote
...and so on for each one, in number order
```

---

## 6. App icons

You need three PNGs in `public/`:

- `icon-192.png` (192×192)
- `icon-512.png` (512×512)
- `icon-180.png` (180×180, Apple)

For now, copy them from your original repo (or drop in any placeholder square
PNGs). You'll swap in the new logo during the rebrand.

---

## 7. Set your secrets

Run each command, then paste the value when prompted:

```
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ADMIN_SETUP_SECRET
```

- **SESSION_SECRET** — a long random string (40+ characters). This signs login
  tokens. Make a fresh one; don't reuse the original app's.
- **ADMIN_SETUP_SECRET** — another random string. You'll type this once on the
  admin page to create your first admin account.

**Push notifications (optional — skip for the main frame):**
Push is best-effort and the app works fine without it. Add it later. Note: the
private key must be in **PKCS8** format, so the plain `web-push` CLI output
won't work directly. Easiest option later is to reuse the two VAPID secrets
from your original app. Until then, just leave them unset.

```
# (later, optional)
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
```

---

## 8. Deploy

```
npm run deploy
```

Wrangler prints a URL like `https://myapp.<your-subdomain>.workers.dev`.
Open it — you should see the login screen.

---

## 9. Create your first admin

- Go to `https://<your-worker-url>/admin`
- It detects there are no admins yet and shows **First-time setup**.
- Enter a username, a password, and your **ADMIN_SETUP_SECRET**.
- You're in.

---

## 10. Add your custom domain (optional, anytime)

- In `wrangler.toml`, uncomment the `routes` block and set your new domain.
- Add the domain to Cloudflare (DNS), then run `npm run deploy` again.

---

## 11. Push to GitHub

```
git init
git add .
git commit -m "Initial main frame (standalone clone)"
git branch -M main
git remote add origin https://github.com/YOU/YOUR-NEW-REPO.git
git push -u origin main
```

> `.gitignore` already keeps `node_modules/`, `.wrangler/`, and secrets out of
> the repo. Your secrets live only in Cloudflare, never in GitHub.

---

## Decoupling checklist (so nothing links to the original)

- [ ] New GitHub repo (not a fork of the original)
- [ ] `database_id` in `wrangler.toml` is the NEW database
- [ ] `name` in `wrangler.toml` is a new worker name
- [ ] R2 bucket is the new `myapp-images`
- [ ] Fresh `SESSION_SECRET` and `ADMIN_SETUP_SECRET`
- [ ] New custom domain (when ready)

---

## What's next (the redesign — separate step)

Once this main frame is live, we do the three changes:

1. **Rebrand** — new name, colors, logo, subtitle, all old-brand strings, the
   service-worker cache name, manifest, install page, push text, contact email.
2. **New mini-games** — reskinned/new games on the same server-decided engine
   (points to play → winnings into reward credits).
3. **Self-signup** — players register themselves from the login screen, active
   immediately + auto-login, with an admin on/off switch.
