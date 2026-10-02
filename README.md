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
- Didn't pay: clients pay up front for the month ahead, so a payment that never comes isn't a debt to chase. "Didn't pay" (on a late payment in Needs you, the chase list or the payment itself) keeps it on record as lost (`missed_on`) and takes it off overdue, the badge, chasing and the nudge. By default their service stops from its due date: plans end the day before, later payments and plans come off, and they go on an open-ended break (or are marked finished; "Skip this one" leaves the plan running). Month, Calendar and Growth show it as lost against what was due. Everything the stop changed is saved on the payment (`missed_undo`), so Undo or "They've paid after all" puts it back exactly, as long as their plans haven't been changed since. Paid and didn't-pay payments are both kept records: no plan change removes or rewrites them
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
- Reading (reader version 2, `src/logs-read.js`): Workers AI (binding `AI`), vision models listed at the top of `src/logs.js`. The model says what each number IS, not just what it is:
  - the kind of screen: a whole-day total, one meal, part of a diary, one food, steps, weight, or a summary of several days (never used for a day)
  - whole-day eaten, goal, remaining and over kept apart; eaten/goal pairs like `16/81 g` are copied as text and split in code (first is eaten), so a goal can't become the eaten number
  - every meal section with whether it's empty, its own totals (only kept if copied off the screen) and its foods
  - steps for one day (not a week's average), and whether they're rounded (`11.2k`)
  - sums that can't be right (macros worth more than the calories, eaten equal to the goal, a number that doesn't match its copied text) get a focused second look; anything still wrong is marked unsure
  - screenshots read by an older reader are read again (by the app while it's open, and 20 an hour by the cron, each in its own invocation through the `Reader` loopback entrypoint in `src/index.js`). When the day's free AI allowance runs out, reading pauses until 1am instead of failing
- Putting a day together (`public/logs/reconcile.js`, shared by the app and the PDF):
  - the app's own day total when one was sent; meal screenshots only check it and are never added on top. A "day total" with no dashboard signs is counted as a meal when a real dashboard came in too or the meals add up to more, and one equal to the calorie goal is ignored
  - otherwise the meals are added up, once each (repeats dropped, a meal sent twice counts the later one)
  - confidence for calories, macros and steps: high, medium or low, with the reasons in plain words. Low: a partial day (meal sections empty and well short of the client's usual), a running total taken before 4pm, meals missing, screenshots that disagree, food logged without macros (drinks excepted: alcohol isn't missing macros), or a number the reader wasn't sure of
  - averages only use high and medium days, and say how many were left out and why. Shan can overrule a day (Count it / Leave it out) or type numbers on a screenshot, marked as the whole day's or one meal's
  - tests: `read_unit.mjs`, `reconcile_unit.mjs` and the Angie regression (`regress_angie.mjs`, every day checked against her screenshots)
- Which day a screenshot is for: worked out in `effDay` in `public/logs/reconcile.js`, from a date on the screenshot (not a range like "Sep 6–12"), then when it was sent, then when it was shared. A screenshot taken between midnight and 4am of a screen still showing "Today" is the night before's log. Anything it can't place goes in "Needs a day"
- Data: D1 database `truestay-logs` (binding `LOGS_DB`). Pictures are kept as base64 in parts under 1 MB and deleted 14 days after they go in a PDF (60 days at most) by the hourly cron. Repeats (the same screen arriving a second way) are spotted after reading and dropped
