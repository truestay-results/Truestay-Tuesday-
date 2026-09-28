// TrueStay Tuesday: one Worker, many tools.
// Static pages live in /public (each tool gets its own folder, e.g. /public/checkin/).
// Anything under /api/* runs here, so tools can have real backends (D1, KV, etc).

import { handlePay, payCron } from "./pay.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "truestay-tuesday", time: new Date().toISOString() });
    }

    if (url.pathname === "/api/pay" || url.pathname.startsWith("/api/pay/")) {
      return handlePay(request, env, url);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },

  // Hourly cron (see wrangler.jsonc). TrueStay Pay sends its morning nudge at the chosen UK hour.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(payCron(env));
  },
};
