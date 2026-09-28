// TrueStay Tuesday: one Worker, many tools.
// Static pages live in /public (each tool gets its own folder, e.g. /public/checkin/).
// Anything under /api/* runs here, so tools can have real backends (D1, KV, etc).

import { handlePay, payCron } from "./pay.js";
import { handleLogsShare, logsCron } from "./logs.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "truestay-tuesday", time: new Date().toISOString() });
    }

    if (url.pathname === "/api/pay" || url.pathname.startsWith("/api/pay/")) {
      return handlePay(request, env, url, ctx);
    }

    // TrueStay Logs share button (iPhone Shortcut). The app's own routes live under /api/pay/logs.
    if (url.pathname.startsWith("/api/logs/")) {
      return handleLogsShare(request, env, url, ctx);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },

  // Hourly cron (see wrangler.jsonc). TrueStay Pay sends its morning nudge at the chosen UK hour;
  // TrueStay Logs reads anything it missed and clears out old screenshots.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(payCron(env));
    ctx.waitUntil(logsCron(env).catch((e) => console.error("logs cron", e && e.message)));
  },
};
