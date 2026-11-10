#!/usr/bin/env node
// Uploads a processed overlay to R2 and points the repeater row at it, using Wrangler.
//
//   node scripts/publish-overlay.mjs --repeater w4trc-vhf --dir scripts/out/w4trc-vhf --remote \
//        --notes "Longley-Rice, handheld at 5 ft, 50 W, omni at 50 ft"
//
//   --local            write to the local dev database / bucket (default)
//   --remote           write to the deployed D1 database and R2 bucket
//   --env staging      target the staging environment
//   --sample           store under overlays/sample/ so the UI labels it as a placeholder
//
// The admin page (/admin/) can do the same upload from a browser.

import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    repeater: { type: "string" },
    dir: { type: "string" },
    notes: { type: "string" },
    env: { type: "string" },
    local: { type: "boolean" },
    remote: { type: "boolean" },
    sample: { type: "boolean" },
  },
});

if (!opt.repeater || !opt.dir) {
  console.error("Usage: node scripts/publish-overlay.mjs --repeater <id> --dir <processed dir> [--remote] [--env staging]");
  process.exit(1);
}
if (!/^[a-z0-9][a-z0-9-]*$/.test(opt.repeater)) {
  console.error("Repeater id may only contain lowercase letters, digits and dashes.");
  process.exit(1);
}

const bounds = JSON.parse(await readFile(join(opt.dir, "bounds.json"), "utf8"));
const where = opt.remote ? "--remote" : "--local";
const envArgs = opt.env ? ["--env", opt.env] : [];
const bucket = opt.env === "staging" ? "coverage-assets-staging" : "coverage-assets";

const now = new Date();
const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const key = `overlays/${opt.sample ? "sample/" : ""}${opt.repeater}/${stamp}.png`;

function wrangler(args) {
  // Run the local Wrangler directly with Node: no shell, so arguments need no quoting.
  const r = spawnSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", ...args], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log(`Uploading ${key} (${opt.remote ? "remote" : "local"})`);
wrangler(["r2", "object", "put", `${bucket}/${key}`, "--file", join(opt.dir, "overlay.png"), "--content-type", "image/png", where, ...envArgs]);

// SQL goes through a file so no shell quoting is involved.
const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
const notes = opt.sample ? "Sample image for development. Not a real prediction." : opt.notes;
const sql =
  `UPDATE repeaters SET overlay_key = ${q(key)}, overlay_bounds = ${q(JSON.stringify(bounds))}, ` +
  `overlay_updated_at = ${q(now.toISOString())}` +
  (notes ? `, overlay_notes = ${q(notes)}` : "") +
  ` WHERE id = ${q(opt.repeater)};\n`;
const sqlFile = join(tmpdir(), `coverage-overlay-${stamp}.sql`);
await writeFile(sqlFile, sql);
wrangler(["d1", "execute", "DB", where, ...envArgs, "--file", sqlFile, "--yes"]);
console.log("Done. Reload the map to see the new overlay.");
