#!/usr/bin/env node
// LOCAL DEVELOPMENT ONLY. Fills the local D1 database with made-up reports so the
// hexagon layer and the moderation queue have something to show. It always targets
// the local database and cannot write to a deployed one.
//
//   node scripts/seed-demo-reports.mjs            add ~160 fake reports
//   node scripts/seed-demo-reports.mjs --clear    remove them again

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { latLngToCell } from "h3-js";

const REPEATER = { id: "w4trc-vhf", lat: 36.52673, lon: -82.58804 };
const MARK = "0DEM0"; // id prefix (still a valid ULID shape), so --clear removes exactly these rows
const clear = process.argv.includes("--clear");

// Deterministic pseudo-random numbers: the same demo data on every run.
let seed = 1469;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

const towns = [
  [36.5484, -82.5618, 40], // Kingsport
  [36.3134, -82.3535, 30], // Johnson City
  [36.5951, -82.1887, 25], // Bristol
  [36.4712, -82.8510, 12], // Church Hill
  [36.6376, -82.5749, 10], // Gate City
  [36.2940, -82.4735, 10], // Jonesborough
  [36.4076, -83.0054, 8], // Rogersville
  [36.3484, -82.2107, 10], // Elizabethton
];

const lines = [`DELETE FROM reports WHERE id LIKE '${MARK}%';`];
if (!clear) {
  let n = 0;
  for (const [tLat, tLon, count] of towns) {
    for (let i = 0; i < count; i++) {
      const lat = +(tLat + (rnd() - 0.5) * 0.09).toFixed(4);
      const lon = +(tLon + (rnd() - 0.5) * 0.11).toFixed(4);
      const dist = Math.hypot(lat - REPEATER.lat, (lon - REPEATER.lon) * 0.8);
      const quality = Math.max(0, Math.min(3, Math.round(3.3 - dist * 5.5 + (rnd() - 0.5) * 1.6)));
      const status = n % 9 === 0 ? "pending" : "approved";
      const when = new Date(Date.UTC(2026, 9, 1) + rnd() * 40 * 86400000).toISOString();
      const comment = n % 7 === 0 ? "'Demo report for local testing'" : "NULL";
      const id = `${MARK}${String(n).padStart(21, "0")}`;
      lines.push(
        `INSERT INTO reports (id, repeater_id, lat, lon, h3_r8, h3_r7, h3_r6, quality, radio_type, antenna_type, location_context, comment, status, submitted_at, ip_hash) VALUES (` +
          `'${id}', '${REPEATER.id}', ${lat}, ${lon}, '${latLngToCell(lat, lon, 8)}', '${latLngToCell(lat, lon, 7)}', '${latLngToCell(lat, lon, 6)}', ` +
          `${quality}, '${pick(["handheld", "handheld", "mobile", "base"])}', '${pick(["stock", "external", "vehicle", "outdoor"])}', ` +
          `'${pick(["outdoors", "in vehicle", "indoors"])}', ${comment}, '${status}', '${when}', 'demo${n % 5}');`,
      );
      n++;
    }
  }
  console.log(`Seeding ${n} demo reports into the LOCAL database`);
}

await mkdir("scripts/out", { recursive: true });
await writeFile("scripts/out/demo-reports.sql", lines.join("\n") + "\n");
const r = spawnSync(
  process.execPath,
  ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", "--local", "--file", "scripts/out/demo-reports.sql", "--yes"],
  { stdio: ["ignore", "ignore", "inherit"] },
);
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(clear ? "Demo reports removed." : "Done. Restart or wait 60 s for the hexagon cache to refresh.");
