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
- Sign-in: email and password once per device (sessions last a year), optional Face ID via passkeys
- Money stored in pence; tracking starts 28 September 2026
