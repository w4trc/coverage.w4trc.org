import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import { isDev, log, type AppEnv } from "./util";

// JWKS fetchers are safe to keep at module scope: they hold public keys, not request state.
const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(teamDomain: string) {
  let jwks = jwksByTeam.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    jwksByTeam.set(teamDomain, jwks);
  }
  return jwks;
}

/**
 * Resolves the admin identity for a request, or null.
 *
 * Production: Cloudflare Access sits in front of /admin and /api/admin and adds a
 * signed JWT. We verify it here as well, so the routes stay closed even if the
 * Access application is misconfigured or the Worker is reached another way.
 *
 * Local dev: DEV_ADMIN_EMAIL is honoured only when ENVIRONMENT is "development",
 * which only .dev.vars sets. Deployed environments are "production" or "staging".
 */
export async function adminIdentity(request: Request, env: Env): Promise<string | null> {
  const team = env.ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.ACCESS_AUD?.trim();

  if (team && aud) {
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, jwksFor(team), {
        issuer: `https://${team}`,
        audience: aud,
      });
      return typeof payload.email === "string" && payload.email ? payload.email : null;
    } catch (err) {
      log("warn", "access jwt rejected", { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  if (env.DEV_ADMIN_EMAIL && isDev(env)) return env.DEV_ADMIN_EMAIL;
  return null;
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const email = await adminIdentity(c.req.raw, c.env);
  if (!email) return c.json({ error: "Not authorized" }, 403);
  c.set("adminEmail", email);
  await next();
};
