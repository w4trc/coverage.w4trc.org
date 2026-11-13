import { Hono } from "hono";
import { requireAdmin } from "../lib/access";
import { purgeHexCache } from "../lib/hexes";
import { OVERLAY_PREFIX, publicRepeater, type RepeaterRow } from "../lib/repeaters";
import { BulkAction, OverlayBounds, RepeaterCreate, RepeaterUpdate, ReportPatch, zodMessage } from "../lib/schemas";
import { log, ULID_RE, type AppEnv, type Ctx } from "../lib/util";

export const adminApi = new Hono<AppEnv>();

adminApi.use("*", requireAdmin);

// State-changing admin calls must come from the app's own pages.
adminApi.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("Origin");
    if (!origin || origin !== new URL(c.req.url).origin) return c.json({ error: "Cross-origin request refused" }, 403);
  }
  await next();
});

type ReportRow = {
  id: string;
  repeater_id: string;
  status: string;
  comment: string | null;
};

function logStmt(c: Ctx, action: string, f: { report_id?: string; repeater_id?: string; detail?: unknown }) {
  return c.env.DB.prepare(
    "INSERT INTO admin_log (at, admin_email, action, report_id, repeater_id, detail) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(
    new Date().toISOString(),
    c.get("adminEmail"),
    action,
    f.report_id ?? null,
    f.repeater_id ?? null,
    f.detail === undefined ? null : JSON.stringify(f.detail),
  );
}

async function readJson(c: Ctx): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

adminApi.get("/me", (c) => c.json({ email: c.get("adminEmail") }));

// ---- Reports ----

adminApi.get("/reports", async (c) => {
  const status = c.req.query("status") ?? "pending";
  if (!["pending", "approved", "rejected"].includes(status)) return c.json({ error: "Bad status" }, 400);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "200") || 200, 1), 500);

  const where = ["status = ?"];
  const args: (string | number)[] = [status];
  const repeaterId = c.req.query("repeater_id");
  if (repeaterId) {
    where.push("repeater_id = ?");
    args.push(repeaterId);
  }
  const before = c.req.query("before"); // id cursor (ULIDs sort by time)
  if (before && ULID_RE.test(before)) {
    where.push("id < ?");
    args.push(before);
  }

  // ip_hash is shortened: enough to spot a batch from one sender, nothing more.
  const [list, counts] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT id, repeater_id, lat, lon, quality, radio_type, antenna_type, location_context, comment,
              callsign, status, submitted_at, reviewed_at, reviewed_by, substr(ip_hash, 1, 10) AS sender
         FROM reports WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`,
    ).bind(...args, limit),
    c.env.DB.prepare("SELECT status, COUNT(*) AS n FROM reports GROUP BY status"),
  ]);
  const totals: Record<string, number> = { pending: 0, approved: 0, rejected: 0 };
  for (const r of (counts?.results ?? []) as { status: string; n: number }[]) totals[r.status] = r.n;
  return c.json({ reports: list?.results ?? [], totals });
});

adminApi.patch("/reports/:id", async (c) => {
  const id = c.req.param("id");
  const parsed = ReportPatch.safeParse(await readJson(c));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const patch = parsed.data;

  const before = await c.env.DB.prepare("SELECT id, repeater_id, status, comment FROM reports WHERE id = ?")
    .bind(id)
    .first<ReportRow>();
  if (!before) return c.json({ error: "Report not found" }, 404);

  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  if (patch.status !== undefined && patch.status !== before.status) {
    const reviewed = patch.status !== "pending";
    stmts.push(
      c.env.DB.prepare("UPDATE reports SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?").bind(
        patch.status,
        reviewed ? now : null,
        reviewed ? c.get("adminEmail") : null,
        id,
      ),
      logStmt(c, patch.status === "approved" ? "approve" : patch.status === "rejected" ? "reject" : "reopen", {
        report_id: id,
        repeater_id: before.repeater_id,
        detail: { from: before.status },
      }),
    );
  }
  if (patch.comment !== undefined && patch.comment !== before.comment) {
    stmts.push(
      c.env.DB.prepare("UPDATE reports SET comment = ? WHERE id = ?").bind(patch.comment, id),
      logStmt(c, "edit", {
        report_id: id,
        repeater_id: before.repeater_id,
        detail: { comment_before: before.comment, comment_after: patch.comment },
      }),
    );
  }
  if (stmts.length) {
    await c.env.DB.batch(stmts);
    if (before.status === "approved" || patch.status === "approved") await purgeHexCache([before.repeater_id]);
  }
  return c.json({ ok: true });
});

adminApi.delete("/reports/:id", async (c) => {
  const id = c.req.param("id");
  const before = await c.env.DB.prepare("SELECT id, repeater_id, status, comment FROM reports WHERE id = ?")
    .bind(id)
    .first<ReportRow>();
  if (!before) return c.json({ error: "Report not found" }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM reports WHERE id = ?").bind(id),
    logStmt(c, "delete", { report_id: id, repeater_id: before.repeater_id, detail: { status: before.status } }),
  ]);
  if (before.status === "approved") await purgeHexCache([before.repeater_id]);
  return c.json({ ok: true });
});

adminApi.post("/reports/bulk", async (c) => {
  const parsed = BulkAction.safeParse(await readJson(c));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const { ids, action } = parsed.data;

  const marks = ids.map(() => "?").join(",");
  const { results: rows } = await c.env.DB.prepare(
    `SELECT id, repeater_id, status, comment FROM reports WHERE id IN (${marks})`,
  )
    .bind(...ids)
    .all<ReportRow>();
  if (rows.length === 0) return c.json({ ok: true, changed: 0 });

  const now = new Date().toISOString();
  const email = c.get("adminEmail");
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    if (action === "delete") {
      stmts.push(c.env.DB.prepare("DELETE FROM reports WHERE id = ?").bind(r.id));
    } else {
      const status = action === "approve" ? "approved" : "rejected";
      if (r.status === status) continue;
      stmts.push(
        c.env.DB.prepare("UPDATE reports SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?").bind(
          status,
          now,
          email,
          r.id,
        ),
      );
    }
    stmts.push(logStmt(c, action, { report_id: r.id, repeater_id: r.repeater_id, detail: { from: r.status, bulk: true } }));
  }
  if (stmts.length) await c.env.DB.batch(stmts);
  await purgeHexCache(rows.map((r) => r.repeater_id));
  return c.json({ ok: true, changed: stmts.length / 2 });
});

adminApi.get("/log", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "100") || 100, 1), 500);
  const { results } = await c.env.DB.prepare("SELECT * FROM admin_log ORDER BY id DESC LIMIT ?").bind(limit).all();
  return c.json({ log: results });
});

// ---- Repeaters ----

adminApi.get("/repeaters", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM repeaters ORDER BY name").all<RepeaterRow>();
  return c.json({ repeaters: results.map(publicRepeater) });
});

adminApi.post("/repeaters", async (c) => {
  const parsed = RepeaterCreate.safeParse(await readJson(c));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const r = parsed.data;
  const exists = await c.env.DB.prepare("SELECT 1 FROM repeaters WHERE id = ?").bind(r.id).first();
  if (exists) return c.json({ error: "A repeater with that id already exists" }, 409);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO repeaters (id, name, callsign, service, output_freq_mhz, input_freq_mhz, tone, mode, lat, lon,
                              antenna_height_ft, tx_power_w, antenna_gain_dbd, overlay_notes, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      r.id,
      r.name,
      r.callsign,
      r.service,
      r.output_freq_mhz,
      r.input_freq_mhz,
      r.tone,
      r.mode,
      r.lat,
      r.lon,
      r.antenna_height_ft,
      r.tx_power_w,
      r.antenna_gain_dbd,
      r.overlay_notes,
      r.active ? 1 : 0,
    ),
    logStmt(c, "repeater.create", { repeater_id: r.id, detail: r }),
  ]);
  return c.json({ ok: true, id: r.id }, 201);
});

adminApi.put("/repeaters/:id", async (c) => {
  const id = c.req.param("id");
  const parsed = RepeaterUpdate.safeParse(await readJson(c));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const r = parsed.data;
  const exists = await c.env.DB.prepare("SELECT 1 FROM repeaters WHERE id = ?").bind(id).first();
  if (!exists) return c.json({ error: "Repeater not found" }, 404);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE repeaters SET name = ?, callsign = ?, service = ?, output_freq_mhz = ?, input_freq_mhz = ?, tone = ?,
              mode = ?, lat = ?, lon = ?, antenna_height_ft = ?, tx_power_w = ?, antenna_gain_dbd = ?,
              overlay_notes = ?, active = ?
        WHERE id = ?`,
    ).bind(
      r.name,
      r.callsign,
      r.service,
      r.output_freq_mhz,
      r.input_freq_mhz,
      r.tone,
      r.mode,
      r.lat,
      r.lon,
      r.antenna_height_ft,
      r.tx_power_w,
      r.antenna_gain_dbd,
      r.overlay_notes,
      r.active ? 1 : 0,
      id,
    ),
    logStmt(c, "repeater.update", { repeater_id: id, detail: r }),
  ]);
  return c.json({ ok: true });
});

const MAX_OVERLAY_BYTES = 15 * 1024 * 1024;

function sniffImage(bytes: Uint8Array): { type: string; ext: string } | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => bytes[i] === b)) return { type: "image/png", ext: "png" };
  const ascii = (o: number, s: string) => [...s].every((ch, i) => bytes[o + i] === ch.charCodeAt(0));
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return { type: "image/webp", ext: "webp" };
  return null;
}

/** multipart/form-data: file (PNG or WebP), bounds (JSON [[s,w],[n,e]]), optional notes. */
adminApi.post("/repeaters/:id/overlay", async (c) => {
  const id = c.req.param("id");
  if (Number(c.req.header("Content-Length") ?? "0") > MAX_OVERLAY_BYTES + 4096) {
    return c.json({ error: "Overlay is larger than 15 MB" }, 413);
  }
  const repeater = await c.env.DB.prepare("SELECT * FROM repeaters WHERE id = ?").bind(id).first<RepeaterRow>();
  if (!repeater) return c.json({ error: "Repeater not found" }, 404);

  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !(file instanceof File)) return c.json({ error: "Attach the overlay image as 'file'" }, 400);
  if (file.size > MAX_OVERLAY_BYTES) return c.json({ error: "Overlay is larger than 15 MB" }, 413);

  let boundsJson: unknown;
  try {
    boundsJson = JSON.parse(String(form.get("bounds") ?? ""));
  } catch {
    return c.json({ error: "bounds must be JSON: [[south, west],[north, east]]" }, 400);
  }
  const bounds = OverlayBounds.safeParse(boundsJson);
  if (!bounds.success) return c.json({ error: zodMessage(bounds.error) }, 400);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) return c.json({ error: "Overlay must be a PNG or WebP image" }, 415);

  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const key = `${OVERLAY_PREFIX}${id}/${stamp}.${kind.ext}`;
  await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: kind.type } });

  const notesRaw = form.get("notes");
  const notes = typeof notesRaw === "string" && notesRaw.trim() ? notesRaw.trim().slice(0, 500) : repeater.overlay_notes;

  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE repeaters SET overlay_key = ?, overlay_bounds = ?, overlay_updated_at = ?, overlay_notes = ? WHERE id = ?",
    ).bind(key, JSON.stringify(bounds.data), now.toISOString(), notes, id),
    logStmt(c, "repeater.overlay", { repeater_id: id, detail: { key, bounds: bounds.data, previous: repeater.overlay_key } }),
  ]);
  log("info", "overlay uploaded", { repeater_id: id, key, bytes: bytes.length });
  return c.json({ ok: true, key });
});
