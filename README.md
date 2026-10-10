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
- Money lost (Growth tab, Month hero, client page): breaks count what the client's last paid plan was worth per month, day by day (open-ended breaks up to the end of this month); skipped payments count in full. Skipping moves a payment to `pay_skips` (reason + notes) instead of deleting it, plans never remake a skipped date, and Undo puts it back. Finished clients show separately as "gone for good"
- Other income (Income tab, `src/pay-income.js`): sources (classes, online, products, affiliate, another job, other) that are one-offs or repeat monthly on a set day; each expected amount is a row in `pay_income` (received or not), monthly ones made up to the end of next month. The Month tab's "All revenue" button (remembered per phone) adds other income into the hero, the tiles and the month bars, and lists it under the tiles
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

## TrueStay Cut (`/cut`)

Shan's own fat loss phase. Same sign in as Pay (email, password, Face ID). Add it to the home screen from Safari.

- Front end: `public/cut/` (`app.js` the app; Today, Progress and Photos tabs, settings from the person button)
- API: `src/cut.js`, routes `/api/pay/cut/*` behind Pay's sign in
- Data: D1 database `truestay-cut` (binding `CUT_DB`)
  - `cut_days`: one row per day. Weight in kg, steps, calories, a workout tick, and "hit my steps" / "on my calories" ticks. A tick you set wins; otherwise typing the number sets it (steps at or over target, calories at or under)
  - `cut_days` also holds protein (g) with its own tick (hit at or over target), and day tags (`tags`, comma list from `DAY_TAGS` in `src/cut.js`: bad sleep, salty food, drinks, takeaway, big carb day, late meal, hard leg day, travelling, ill, stressed) plus the short `note`. Columns added with ALTER TABLE on start-up if missing
  - Scale jumps (Progress): a weigh-in 0.5 kg or more over the one before (within 3 days), explained by tags on that day or the day before. The chart marks tagged days and the readout says what was tagged
  - `cut_targets`: steps, calories, protein and workouts a week, each in force from its `from_day`, so changing a target never rescores earlier weeks
  - `cut_meta`: phase start and end, and an optional rough goal weight
  - `cut_waist`: one waist measurement a week in cm, keyed by that week's Monday (the Weekly check-in card on Today). Shown in cm or inches (`waist_unit` in settings); stored in cm so switching never changes the numbers. Progress has its own waist chart (one measure per chart) and each week row shows the change
  - `cut_lifts` + `cut_sets`: the 3 or 4 main lifts (up to 6; removing one hides it and keeps its history) and one top set a week per lift (kg × reps, keyed by that week's Monday). Compared as an estimated one-rep max (Epley, reps capped at 12); bodyweight lifts (0 kg) compare on reps. Baseline is the best of the first two weeks. Holding is within 2.5% of it; Dropping is 2+ falls in a row and 5% or more under it, which shows a warning on Progress and on the lift's row on Today
  - `cut_breaks`: planned diet breaks, 1 to 3 whole weeks (Monday to Sunday) at a maintenance calorie target, never overlapping. Planning one can push the phase end back by the same length (`extended`), and removing it undoes that. On a break the calorie target for those days is the break's (`targetOn`); Settings still edits the normal targets (`baseTargetOn`). The break and the 7 days after it are left out of the rate of loss, and the stall check pauses until 3 clean weeks after that. The weight chart shades breaks and week rows are tagged. The suggested maintenance is the current target plus the deficit the rate points to (7,700 kcal a kg, kept between 250 and 900)
  - `cut_photos` + `cut_blobs`: one front, side and back photo a week (weeks start Monday), resized on the phone to 1400px, stored as base64 in parts under 1 MB. A new photo for the same week and pose replaces the old one. R2 isn't switched on for the account yet; if it is, photos could move there
- Camera (Photos, tap an empty slot or Swap): in-app camera with a ghost of an earlier photo of the same pose (last time, or week 1) over the live picture, strength slider, 0/3/10 second timer, front/back flip and a Library fallback. Live picture and ghost share one 3:4 frame and the same centre crop, so lining up with the ghost lines up the saved photo. The front camera is shown mirrored with the ghost mirrored to match, and saved the right way round. Camera choice, timer and ghost strength are remembered on the phone
- Numbers: 7-day average, week and month averages, change on the week before, and a rate in kg a week from a straight line through the last 4 weeks of weigh-ins (needs about a fortnight)
- Stall spotter (`stallCheck` in `public/cut/app.js`, no server side): this week's 7-day average against the 7 days that ended two weeks ago. Under 0.25% of bodyweight lost is flat. Needs 3 weeks into the phase and 4+ weigh-ins in each window. Waits 2 weeks after any target change. Only suggests a change when calories were on target on 80%+ of logged days (10+ logged) and steps on 70%+; otherwise it says tighten up first. Suggests one change: 150 kcal fewer (100 under 2,000), never below about 20 kcal per kg, or 2,000 more steps. The Today card can be snoozed for a week; Progress always shows the status
- Hourly cron clears photo uploads that never finished
