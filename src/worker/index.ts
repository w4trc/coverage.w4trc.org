import { Hono } from "hono";
import { adminIdentity } from "./lib/access";
import { backup, health } from "./lib/ops";
import { OVERLAY_PREFIX } from "./lib/repeaters";
import { initSentry } from "./lib/sentry";
import { isDev, log, originsFrom, type AppEnv } from "./lib/util";
import { adminApi } from "./routes/admin";
import { publicApi } from "./routes/public";

const app = new Hono<AppEnv>();

app.get("/health", (c) => health(c.env));

// CORS: the club site may read the public GET API. Everything else is same-origin.
app.use("/api/*", async (c, next) => {
  const origin = c.req.header("Origin");
  const allowed = !!origin && !c.req.path.startsWith("/api/admin") && originsFrom(c.env).includes(origin);
  if (c.req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: allowed
        ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET", Vary: "Origin" }
        : {},
    });
  }
  await next();
  if (allowed && c.req.method === "GET") {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin", { append: true });
  }
});

app.route("/api/admin", adminApi);
app.route("/api", publicApi);
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// Prediction overlays from R2. Only keys under overlays/ are reachable; backups are not.
app.get(`/${OVERLAY_PREFIX}*`, async (c) => {
  const key = decodeURIComponent(c.req.path.slice(1));
  if (key.includes("..")) return c.notFound();
  const obj = await c.env.BUCKET.get(key);
  if (!obj) return c.notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("ETag", obj.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { headers });
});

// Static frontend. /admin pages are checked here as well as by Cloudflare Access.
app.get("*", async (c) => {
  const path = c.req.path;
  if (path === "/admin" || path.startsWith("/admin/")) {
    if (!(await adminIdentity(c.req.raw, c.env))) return c.text("Not authorized", 403);
  }
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status === 404) return c.text("Not found", 404);
  return res;
});

app.onError((err, c) => {
  log("error", "unhandled error", {
    path: c.req.path,
    method: c.req.method,
    error: err.message,
    stack: err.stack,
  });
  initSentry(c.req.raw, c.env, c.executionCtx)?.captureException(err);
  return c.json({ error: "Something went wrong" }, 500);
});

function contentSecurityPolicy(env: Env): string {
  const ancestors = ["'self'", ...originsFrom(env)];
  // Lets the local Astro dev server embed a local Worker.
  if (isDev(env)) ancestors.push("http://localhost:*", "http://127.0.0.1:*");

  const tileOrigin = (() => {
    try {
      // Leaflet templates like https://{s}.example.com/{z}/{x}/{y}.png become a wildcard host.
      return new URL(env.TILE_URL.replace("{s}.", "*.").replace(/\{[^}]+\}/g, "0")).origin.replace("%2A", "*");
    } catch {
      return "https://tile.openstreetmap.org";
    }
  })();

  let connect = "'self'";
  if (env.SENTRY_DSN) {
    try {
      connect += ` ${new URL(env.SENTRY_DSN).origin}`;
    } catch {
      // ignore a malformed DSN
    }
  }

  return [
    "default-src 'self'",
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${tileOrigin}`,
    "font-src 'self'",
    `connect-src ${connect}`,
    "frame-src https://challenges.cloudflare.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${ancestors.join(" ")}`,
  ].join("; ");
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const res = await app.fetch(request, env, ctx);
    // Asset responses have immutable headers, so copy before adding ours.
    const out = new Response(res.body, res);
    out.headers.set("Content-Security-Policy", contentSecurityPolicy(env));
    out.headers.set("X-Content-Type-Options", "nosniff");
    out.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    // The embed needs geolocation; nothing else is requested.
    out.headers.set("Permissions-Policy", "geolocation=(self), camera=(), microphone=(), payment=()");
    return out;
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      backup(env).catch((err: unknown) => {
        log("error", "backup failed", { error: err instanceof Error ? err.message : String(err) });
      }),
    );
  },
} satisfies ExportedHandler<Env>;
