import { log } from "./util";

const HEALTH_KEY = "health/probe.txt";

async function check(fn: () => Promise<void>): Promise<"ok" | "fail"> {
  try {
    await fn();
    return "ok";
  } catch (err) {
    log("error", "health check failed", { error: err instanceof Error ? err.message : String(err) });
    return "fail";
  }
}

/** GET /health: 200 when D1 and R2 both answer, 503 otherwise. Never cached. */
export async function health(env: Env): Promise<Response> {
  const [d1, r2] = await Promise.all([
    check(async () => {
      const row = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      if (row?.ok !== 1) throw new Error("unexpected D1 result");
    }),
    check(async () => {
      // HEAD a known object; create it the first time so a new bucket passes.
      if (!(await env.BUCKET.head(HEALTH_KEY))) await env.BUCKET.put(HEALTH_KEY, "ok");
    }),
  ]);
  const ok = d1 === "ok" && r2 === "ok";
  return Response.json(
    { status: ok ? "ok" : "degraded", version: env.APP_VERSION, time: new Date().toISOString(), checks: { d1, r2 } },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}

const BACKUP_PREFIX = "backups/";
const BACKUPS_TO_KEEP = 30;

/** Cron: dump every table to one JSON object in R2 and keep the newest 30. */
export async function backup(env: Env): Promise<void> {
  const tables = ["repeaters", "reports", "admin_log"] as const;
  const dump: Record<string, unknown> = { taken_at: new Date().toISOString(), version: env.APP_VERSION };
  for (const t of tables) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${t}`).all();
    dump[t] = results;
  }
  const key = `${BACKUP_PREFIX}coverage-${new Date().toISOString().slice(0, 10)}.json`;
  await env.BUCKET.put(key, JSON.stringify(dump), { httpMetadata: { contentType: "application/json" } });

  const listed = await env.BUCKET.list({ prefix: BACKUP_PREFIX });
  const stale = listed.objects
    .map((o) => o.key)
    .sort()
    .slice(0, -BACKUPS_TO_KEEP);
  if (stale.length) await env.BUCKET.delete(stale);
  log("info", "backup written", { key, removed: stale.length });
}
