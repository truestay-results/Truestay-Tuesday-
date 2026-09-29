# TrueStay Tuesday

Free fitness tools from TrueStay Results, hosted on Cloudflare Workers at truestaytuesday.

## How it's laid out

- `public/` static pages. Each tool gets its own folder, e.g. `public/checkin/index.html` → `/checkin`
- `src/index.js` the Worker. Handles `/api/*` for tools that need a backend; everything else is served from `public/`
- `wrangler.jsonc` Cloudflare config (Worker name must stay `truestay-tuesday`)

Pushing to `main` deploys automatically via Cloudflare Workers Builds.

## TrueStay Pay (`/pay`)

Private client payment and revenue tracker. Phone-first web app: add it to your home screen from Safari.

- Front end: `public/pay/` (plain HTML/CSS/JS, installable as an app; `sw.js` handles offline start + morning nudges)
- API: `src/pay.js` (routes, login, Face ID, settings, exports, nudges), `src/pay-plans.js` (plans), `src/pay-push.js` (Web Push), `src/pay-util.js`
- Data: Cloudflare D1 database `truestay-pay` (binding `PAY_DB`), schema in `migrations/`
- Plans: each client has a timeline of plans (PT / coaching / programme / break, paid monthly, upfront, split or as they go). Plans create their own payments; switching or ending a plan only removes its unpaid, not-yet-due payments
- Morning nudge: hourly cron (`triggers.crons` in `wrangler.jsonc`) sends one Web Push a day at the chosen UK hour; VAPID keys live in `pay_meta`
- Tapping the nudge opens `/pay/?needs=1` (or, if the app is already open, `sw.js` posts `{type:"needs"}`), which shows the "Needs you" sheet: due today, not marked paid, plans ending. The Today card's "N need you" chip is the same count as the app badge.
- Growth tab also has "Growth over time" (plan income and paying clients at each month end) and "Paying on time" (per client, since tracking began; up to a day late counts as on time). Both build up month by month.
- Sign-in: email and password once per device (sessions last a year), optional Face ID via passkeys
- Money stored in pence; tracking starts 28 September 2026
- Look, colours, sizes and the tap-area rules: see [`DESIGN.md`](DESIGN.md). Read it before changing how `/pay` looks

## TrueStay Logs (`/logs`)

Clients' nightly food and step screenshots, read automatically and sorted into one PDF per client. Same sign in as Pay (email, password, Face ID).

- Front end: `public/logs/` (`app.js` the app, `pdf.js` a small hand-written PDF maker, so there's no library to load)
- API: `src/logs.js`. The app's routes are `/api/pay/logs/*` (they sit behind Pay's sign in); the share button's are `/api/logs/clients` and `/api/logs/upload`, which need the link key made in the app (Settings, Share button)
- Getting screenshots in:
  - WhatsApp share button: an iPhone Shortcut, set up once from the steps in the app. Works for 1 or 50 at a time
  - Add screenshots: pick from Photos (resized on the phone before upload)
  - Import a WhatsApp chat: the Export Chat zip is opened on the phone, and each picture keeps the date and time it was sent
- Reading: Workers AI (binding `AI`), vision models listed at the top of `src/logs.js`. It reads the kind of screen, any date on it, the status bar clock, calories, protein, carbs, fat, steps and a few extras
- Which day a screenshot is for: worked out in `effDay` in `public/logs/app.js`, from a date on the screenshot, then when it was sent, then when it was shared. Anything it can't place goes in "Needs a day"
- Data: D1 database `truestay-logs` (binding `LOGS_DB`). Pictures are kept as base64 in parts under 1 MB and deleted 14 days after they go in a PDF (60 days at most) by the hourly cron. Repeats (the same screen arriving a second way) are spotted after reading and dropped
