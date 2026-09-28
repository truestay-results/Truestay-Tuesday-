# TrueStay Tuesday

Free fitness tools from TrueStay Results, hosted on Cloudflare Workers at truestaytuesday.

## How it's laid out

- `public/` static pages. Each tool gets its own folder, e.g. `public/checkin/index.html` → `/checkin`
- `src/index.js` the Worker. Handles `/api/*` for tools that need a backend; everything else is served from `public/`
- `wrangler.jsonc` Cloudflare config (Worker name must stay `truestay-tuesday`)

Pushing to `main` deploys automatically via Cloudflare Workers Builds.
