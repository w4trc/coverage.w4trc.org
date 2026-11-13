import { Hono } from "hono";
import type { z } from "zod";
import { REPORTS_MIN_ZOOM } from "../../shared/constants";
import { cachedHexes, cellsFor, inBbox, isH3Res, resolutionOf } from "../lib/hexes";
import { getActiveRepeater, publicRepeater, type RepeaterRow } from "../lib/repeaters";
import { ReportInput, zodMessage } from "../lib/schemas";
import { verifyTurnstile } from "../lib/turnstile";
import { distanceMiles, hashIp, intVar, log, parseBbox, round4, ulid, type AppEnv } from "../lib/util";

export const publicApi = new Hono<AppEnv>();

const SHORT_CACHE = "public, max-age=60";
const MAX_BODY_BYTES = 8 * 1024;

/** Runtime settings the browser needs. Nothing secret. */
publicApi.get("/config", (c) => {
  let sentryDsn: string | null = null;
  if (c.env.SENTRY_DSN) sentryDsn = c.env.SENTRY_DSN; // a DSN is public by design
  c.header("Cache-Control", SHORT_CACHE);
  return c.json({
    turnstile_site_key: c.env.TURNSTILE_SITE_KEY,
    tile_url: c.env.TILE_URL,
    max_distance_mi: intVar(c.env.REPORT_MAX_DISTANCE_MI, 100),
    reports_min_zoom: REPORTS_MIN_ZOOM,
    sentry_dsn: sentryDsn,
    environment: c.env.ENVIRONMENT,
    version: c.env.APP_VERSION,
  });
});

publicApi.get("/repeaters", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM repeaters WHERE active = 1 ORDER BY name").all<RepeaterRow>();
  c.header("Cache-Control", SHORT_CACHE);
  return c.json({ repeaters: results.map(publicRepeater) });
});

publicApi.get("/repeaters/:id", async (c) => {
  const row = await getActiveRepeater(c.env.DB, c.req.param("id"));
  if (!row) return c.json({ error: "Repeater not found" }, 404);
  const stats = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM reports WHERE repeater_id = ? AND status = 'approved'",
  )
    .bind(row.id)
    .first<{ n: number }>();
  c.header("Cache-Control", SHORT_CACHE);
  return c.json({ repeater: publicRepeater(row), approved_reports: stats?.n ?? 0 });
});

publicApi.get("/repeaters/:id/hexes", async (c) => {
  const res = Number(c.req.query("res") ?? "7");
  if (!isH3Res(res)) return c.json({ error: "res must be 6, 7 or 8" }, 400);
  const rawBbox = c.req.query("bbox");
  const bbox = parseBbox(rawBbox);
  if (rawBbox && !bbox) return c.json({ error: "bbox must be west,south,east,north" }, 400);

  const row = await getActiveRepeater(c.env.DB, c.req.param("id"));
  if (!row) return c.json({ error: "Repeater not found" }, 404);

  let hexes = await cachedHexes(c.env.DB, row.id, res, (p) => c.executionCtx.waitUntil(p));
  if (bbox) hexes = hexes.filter((h) => inBbox(h, bbox));
  c.header("Cache-Control", SHORT_CACHE);
  return c.json({ res, hexes });
});

publicApi.get("/repeaters/:id/hexes/:h3", async (c) => {
  const cell = c.req.param("h3");
  const res = resolutionOf(cell);
  if (!res) return c.json({ error: "Unknown cell" }, 400);
  const row = await getActiveRepeater(c.env.DB, c.req.param("id"));
  if (!row) return c.json({ error: "Repeater not found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT quality, radio_type, antenna_type, location_context, comment, submitted_at
       FROM reports
      WHERE repeater_id = ? AND status = 'approved' AND h3_r${res} = ?
      ORDER BY submitted_at DESC`,
  )
    .bind(row.id, cell)
    .all<{
      quality: number;
      radio_type: string;
      antenna_type: string;
      location_context: string;
      comment: string | null;
      submitted_at: string;
    }>();

  if (results.length === 0) return c.json({ error: "No approved reports in this cell" }, 404);

  const tally = (key: "radio_type" | "antenna_type" | "location_context") => {
    const out: Record<string, number> = {};
    for (const r of results) out[r[key]] = (out[r[key]] ?? 0) + 1;
    return out;
  };
  const byQuality = [0, 0, 0, 0];
  let sum = 0;
  for (const r of results) {
    byQuality[r.quality] = (byQuality[r.quality] ?? 0) + 1;
    sum += r.quality;
  }

  c.header("Cache-Control", SHORT_CACHE);
  return c.json({
    h3: cell,
    res,
    count: results.length,
    avg: Math.round((sum / results.length) * 100) / 100,
    latest: results[0]!.submitted_at,
    by_quality: byQuality,
    by_radio: tally("radio_type"),
    by_antenna: tally("antenna_type"),
    by_context: tally("location_context"),
    recent: results.slice(0, 10),
  });
});

/** Individual approved reports for a small viewport (high zoom only). */
publicApi.get("/repeaters/:id/reports", async (c) => {
  const bbox = parseBbox(c.req.query("bbox"));
  if (!bbox) return c.json({ error: "bbox is required: west,south,east,north" }, 400);
  // Roughly the viewport of a large screen at the minimum zoom; anything bigger is refused.
  if (bbox.north - bbox.south > 0.6 || bbox.east - bbox.west > 1.2) {
    return c.json({ error: "Zoom in to see individual reports" }, 400);
  }
  const row = await getActiveRepeater(c.env.DB, c.req.param("id"));
  if (!row) return c.json({ error: "Repeater not found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT id, lat, lon, quality, radio_type, antenna_type, location_context, comment, submitted_at
       FROM reports
      WHERE repeater_id = ? AND status = 'approved'
        AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
      ORDER BY submitted_at DESC
      LIMIT 500`,
  )
    .bind(row.id, bbox.south, bbox.north, bbox.west, bbox.east)
    .all();
  c.header("Cache-Control", SHORT_CACHE);
  return c.json({ reports: results });
});

publicApi.post("/repeaters/:id/reports", async (c) => {
  // POST is accepted only from the app's own origin.
  const origin = c.req.header("Origin");
  if (!origin || origin !== new URL(c.req.url).origin) return c.json({ error: "Cross-origin submission refused" }, 403);

  if (Number(c.req.header("Content-Length") ?? "0") > MAX_BODY_BYTES) return c.json({ error: "Request too large" }, 413);
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) return c.json({ error: "Request too large" }, 413);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }
  const parsed = ReportInput.safeParse(json);
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const input = parsed.data;

  const repeater = await getActiveRepeater(c.env.DB, c.req.param("id"));
  if (!repeater) return c.json({ error: "Repeater not found" }, 404);

  const lat = round4(input.lat);
  const lon = round4(input.lon);
  const maxMiles = intVar(c.env.REPORT_MAX_DISTANCE_MI, 100);
  if (distanceMiles(lat, lon, repeater.lat, repeater.lon) > maxMiles) {
    return c.json({ error: `That location is more than ${maxMiles} miles from the repeater.` }, 422);
  }

  const ip = c.req.header("CF-Connecting-IP") ?? null;
  if (!(await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY, input.turnstile_token, ip))) {
    return c.json({ error: "Verification failed. Please try again." }, 403);
  }

  if (!c.env.IP_HASH_SECRET) {
    log("error", "IP_HASH_SECRET is not set; refusing submissions");
    return c.json({ error: "Reports are temporarily unavailable." }, 503);
  }
  const now = new Date();
  const ipHash = await hashIp(c.env.IP_HASH_SECRET, ip ?? "unknown", now);
  const cells = cellsFor(lat, lon);

  const hourAgo = new Date(now.getTime() - 3600_000).toISOString();
  const tenMinAgo = new Date(now.getTime() - 600_000).toISOString();
  const [rate, dup] = await c.env.DB.batch<{ n: number }>([
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE ip_hash = ? AND submitted_at > ?").bind(ipHash, hourAgo),
    c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM reports WHERE ip_hash = ? AND repeater_id = ? AND h3_r8 = ? AND submitted_at > ?",
    ).bind(ipHash, repeater.id, cells.h3_r8, tenMinAgo),
  ]);
  if ((rate?.results[0]?.n ?? 0) >= intVar(c.env.REPORT_RATE_LIMIT_PER_HOUR, 10)) {
    return c.json({ error: "Too many reports from this connection. Please try again later." }, 429);
  }
  if ((dup?.results[0]?.n ?? 0) > 0) {
    return c.json({ error: "You already reported from this spot a few minutes ago." }, 409);
  }

  const id = ulid(now.getTime());
  await c.env.DB.prepare(
    `INSERT INTO reports
       (id, repeater_id, lat, lon, h3_r8, h3_r7, h3_r6, quality, radio_type, antenna_type,
        location_context, comment, callsign, status, submitted_at, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(
      id,
      repeater.id,
      lat,
      lon,
      cells.h3_r8,
      cells.h3_r7,
      cells.h3_r6,
      input.quality,
      input.radio_type,
      input.antenna_type,
      input.location_context,
      input.comment,
      input.callsign,
      now.toISOString(),
      ipHash,
    )
    .run();

  log("info", "report submitted", { report_id: id, repeater_id: repeater.id, quality: input.quality });
  if (c.env.NOTIFY_WEBHOOK_URL) c.executionCtx.waitUntil(notifyPending(c.env, repeater, origin));
  if (c.env.RESEND_API_KEY && c.env.NOTIFY_EMAIL_FROM && c.env.NOTIFY_EMAIL_TO) {
    c.executionCtx.waitUntil(emailPending(c.env, repeater, { ...input, id, lat, lon }, origin));
  }

  return c.json({ id, status: "pending", message: "Thanks. Your report will appear after review." }, 201);
});

type SubmittedReport = Omit<z.output<typeof ReportInput>, "turnstile_token"> & { id: string };

const QUALITY_LABELS = ["No signal", "Poor", "Fair", "Good"];

/** Email alert through Resend. Errors are logged, never surfaced to the reporter. */
async function emailPending(env: Env, repeater: RepeaterRow, report: SubmittedReport, origin: string): Promise<void> {
  try {
    const freq = repeater.output_freq_mhz.toFixed(3);
    const text = [
      `A new coverage report is waiting for review.`,
      ``,
      `Repeater:  ${repeater.name} (${repeater.callsign} ${freq})`,
      `Quality:   ${QUALITY_LABELS[report.quality] ?? report.quality} (${report.quality}/3)`,
      `Location:  ${report.lat}, ${report.lon}  https://www.openstreetmap.org/?mlat=${report.lat}&mlon=${report.lon}#map=13/${report.lat}/${report.lon}`,
      `Radio:     ${report.radio_type}`,
      `Antenna:   ${report.antenna_type}`,
      `Context:   ${report.location_context}`,
      `Callsign:  ${report.callsign ?? "(none)"}`,
      `Comment:   ${report.comment ?? "(none)"}`,
      `Report ID: ${report.id}`,
      ``,
      `Review: ${origin}/admin/`,
    ].join("\n");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.NOTIFY_EMAIL_FROM,
        to: env.NOTIFY_EMAIL_TO.split(/[\s,]+/).filter(Boolean),
        subject: `New coverage report: ${repeater.callsign} ${freq}${report.callsign ? ` from ${report.callsign}` : ""}`,
        text,
      }),
    });
    if (!res.ok) log("warn", "notify email returned an error", { status: res.status, body: (await res.text()).slice(0, 500) });
  } catch (err) {
    log("warn", "notify email failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Discord-compatible webhook ({content}). Errors are logged, never surfaced to the reporter. */
async function notifyPending(env: Env, repeater: RepeaterRow, origin: string): Promise<void> {
  try {
    const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'pending'").first<{ n: number }>();
    const res = await fetch(env.NOTIFY_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `New coverage report for ${repeater.callsign} ${repeater.output_freq_mhz.toFixed(3)} is waiting for review (${pending?.n ?? 1} pending): ${origin}/admin/`,
      }),
    });
    if (!res.ok) log("warn", "notify webhook returned an error", { status: res.status });
  } catch (err) {
    log("warn", "notify webhook failed", { error: err instanceof Error ? err.message : String(err) });
  }
}
