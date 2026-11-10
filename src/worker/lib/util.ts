import type { Context } from "hono";

export type AppEnv = {
  Bindings: Env;
  Variables: { adminEmail: string };
};
export type Ctx = Context<AppEnv>;

/** Structured JSON log line (searchable in Workers Logs). */
export function log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ level, message, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID: 48-bit time + 80 bits of crypto randomness, lexicographically sortable. */
export function ulid(now = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = "";
  for (const b of bytes) rand += CROCKFORD[b % 32];
  return time + rand;
}

export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const EARTH_RADIUS_MI = 3958.8;

export function distanceMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Round to 4 decimals (about 36 ft) before anything is stored. */
export function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * Salted hash of the client IP. The salt rotates daily (secret + UTC date), so
 * hashes cannot be correlated across days and the raw IP is never stored.
 */
export async function hashIp(secret: string, ip: string, now = new Date()): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const day = now.toISOString().slice(0, 10);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${day}|${ip}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type Bbox = { south: number; west: number; north: number; east: number };

/** Parses "west,south,east,north" (the usual bbox order). */
export function parseBbox(raw: string | undefined): Bbox | null {
  if (!raw) return null;
  const p = raw.split(",").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return null;
  const [west, south, east, north] = p as [number, number, number, number];
  if (south > north || west > east || south < -90 || north > 90) return null;
  return { south, west, north, east };
}

export function originsFrom(env: Env): string[] {
  return env.SITE_ORIGINS.split(/\s+/).filter(Boolean);
}

export function intVar(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * True only under wrangler dev, where .dev.vars sets ENVIRONMENT=development.
 * (The request hostname cannot be used: wrangler dev rewrites it to the domain of the route.)
 */
export function isDev(env: Env): boolean {
  return env.ENVIRONMENT === "development";
}
