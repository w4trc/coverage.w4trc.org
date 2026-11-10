# W4TRC Repeater Coverage Map

A public map of where the club repeater can be reached: a predicted layer (Radio Mobile) and a
measured layer (signal reports from users, grouped into hexagons). It runs as one Cloudflare
Worker and is embedded in the club's Astro site with an iframe. The full specification is in
[specs.md](specs.md).

| Piece | Where |
|---|---|
| Worker (Hono API, security headers, cron backup) | `src/worker/` |
| Map page and report form (Leaflet, TypeScript, Vite) | `web/index.html`, `web/src/main.ts`, `web/src/report.ts` |
| Moderation page | `web/admin/index.html`, `web/src/admin.ts` |
| Rules shared by server and browser (bands, zoom to hexagon size) | `src/shared/constants.ts` |
| Database schema | `migrations/` |
| Overlay tools | `scripts/` |
| Page to copy into the Astro site | `astro/coverage.astro` |

## Run it locally

Needs Node 22 or newer.

```sh
npm install
cp .dev.vars.example .dev.vars     # test Turnstile keys and a dev admin login
npm run setup:local                # migrations, the W4TRC repeater, a SAMPLE overlay
npm run dev                        # http://localhost:8787  and  http://localhost:8787/admin/
```

Optional: `node scripts/seed-demo-reports.mjs` fills the local database with fake reports so the
hexagons and the moderation queue have content (`--clear` removes them). It cannot touch a
deployed database.

After changing frontend code, run `npm run build` and restart `npm run dev`.

Checks: `npm run typecheck`, `npm test`.

## The prediction overlay

The overlay shown after `setup:local` is **fake** (noise shaped like rings). The map labels it
"Placeholder image" because its R2 key sits under `overlays/sample/`. Replace it with a real
Radio Mobile run:

1. In Radio Mobile, set up the repeater (146.970 MHz, 50 W, omni at 50 ft, plus line loss and
   antenna gain) and a handheld receiver (low gain, about 5 ft high). Run a single-site
   Longley-Rice coverage plot with three colour bands: strong, moderate, fringe.
2. Export it for Google Earth (KMZ). The KMZ carries both the image and its bounds.
3. Process it:

   ```sh
   npm run overlay:process -- --input coverage.kmz --out scripts/out/w4trc-vhf
   ```

   Pass `--strong "#rrggbb" --moderate "#rrggbb" --fringe "#rrggbb"` if the plot does not use
   pure green, yellow and red. The script prints how much of the image fell in each band and
   which colours it dropped, so a wrong colour is easy to spot. With a bare PNG, add
   `--bounds "south,west,north,east"`.
4. Publish it, either from the admin page (Prediction overlay section: upload `overlay.png`
   and `bounds.json`) or from the command line:

   ```sh
   npm run overlay:publish -- --repeater w4trc-vhf --dir scripts/out/w4trc-vhf --remote \
     --notes "Longley-Rice, handheld at 5 ft, 50 W, omni at 50 ft"
   ```

## Deploy

One-time setup, in order:

1. `npx wrangler login`
2. `npx wrangler d1 create coverage` and paste the id into `wrangler.jsonc` (`database_id`).
3. `npx wrangler r2 bucket create coverage-assets`
4. Turnstile: create a widget for `coverage.w4trc.org`, put its site key in `wrangler.jsonc`
   (`TURNSTILE_SITE_KEY`), then `npx wrangler secret put TURNSTILE_SECRET_KEY`.
   **The config ships with Cloudflare's always-pass test key. Reports are not protected until
   both keys are replaced.**
5. `npx wrangler secret put IP_HASH_SECRET` (any long random string).
6. Cloudflare Access: create a self-hosted application covering `coverage.w4trc.org/admin*`
   and `coverage.w4trc.org/api/admin*`, allow the officers' emails, then set
   `ACCESS_TEAM_DOMAIN` (like `yourteam.cloudflareaccess.com`) and `ACCESS_AUD` (the
   application's audience tag) in `wrangler.jsonc`. The Worker verifies the Access token
   itself, so the admin pages return 403 until both values are set.
7. `npx wrangler d1 migrations apply DB --remote`
8. `npx wrangler d1 execute DB --remote --file seeds/w4trc-vhf.sql`
9. `npm run deploy`
10. Publish the real overlay (above), then copy `astro/coverage.astro` into the website repo.

Optional secrets: `SENTRY_DSN` (error tracking; completely off when unset) and
`NOTIFY_WEBHOOK_URL` (a Discord-style webhook pinged when a report is waiting).

Staging: the same steps with `--env staging` (`coverage-staging` database,
`coverage-assets-staging` bucket, `staging.coverage.w4trc.org`).

CI: `.github/workflows/deploy.yml` typechecks, tests and builds every push, and deploys `main`.
It needs the repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Operations

- **Health:** `GET /health` returns 200 with `{"status":"ok", checks: {d1, r2}}`, or 503 if
  either check fails. Point a Zabbix web scenario or Uptime Kuma at it.
- **Backups:** a daily cron writes every table to `backups/coverage-YYYY-MM-DD.json` in R2 and
  keeps the newest 30. Backups are not reachable over HTTP.
- **Logs:** structured JSON in Workers Logs.
- **Settings** (`wrangler.jsonc` vars): `SITE_ORIGINS` (sites allowed to embed the map and read
  the API), `REPORT_MAX_DISTANCE_MI` (default 100), `REPORT_RATE_LIMIT_PER_HOUR` (default 10),
  `TILE_URL` (basemap).

## Adding another repeater

Data entry only. `POST /api/admin/repeaters` with the repeater's details (see `RepeaterCreate`
in `src/worker/lib/schemas.ts`), or copy `seeds/w4trc-vhf.sql`, then publish an overlay for it.
The map shows a repeater picker as soon as two are active.

## Privacy

Raw IP addresses are never stored: only a keyed hash whose salt changes daily, used for rate
limiting and spotting batches. Coordinates are rounded to 4 decimals (about 36 ft) before they
are saved. Reports stay hidden until an admin approves them.
