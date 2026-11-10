# Repeater Coverage Map: Specification

**Status:** Draft v0.1, Nov 10, 2026
**Owner:** Joshua (N4JHC)
**Project:** Predicted + crowdsourced coverage map for W4TRC / KARC repeaters

---

## 1. Summary

A public, interactive map showing where a club repeater can be reached, combining two layers:

1. **Predicted coverage**: a propagation model (Radio Mobile) rendered as a green / yellow / red overlay (strong, moderate, fringe).
2. **Measured coverage**: signal reports submitted by real users, aggregated into hexagons and viewable on the map.

The map is a **standalone Cloudflare Worker app** and is **embedded in the Astro website via iframe**. It launches with one repeater but is designed so more can be added without schema or code changes.

### Goals
- Give club members and visitors a clear picture of where they can expect to reach the repeater.
- Let people add real-world reports from their location in under 30 seconds on a phone.
- Make it easy to add more repeaters later.
- Keep moderation light but present, since reports are held for approval.

### Non-goals (v1)
- Real-time signal telemetry from radios.
- User accounts or logins for reporters.
- Mobile native app.
- Automatic regeneration of predictions (done manually when the repeater changes).

---

## 2. Decisions Made

| Topic | Decision |
|---|---|
| Scope | One repeater at launch, schema and UI multi-repeater ready |
| Prediction source | Radio Mobile, not yet set up (see section 5) |
| Who can report | Anyone, but reports are **held for admin approval** before appearing |
| Website integration | **Iframe** embed in Astro |
| Hosting | Cloudflare Workers + D1 (+ R2 for overlay assets) |

---

## 3. Architecture

```
 Astro site (club website)
   /coverage  ──iframe──►  coverage.<club-domain>   (Cloudflare Worker)
                              │
                              ├── Static frontend (Leaflet or MapLibre GL, Vite build)
                              ├── API routes (Hono)
                              ├── D1   : repeaters, reports, admin audit log
                              ├── R2   : prediction overlay images + metadata
                              └── Turnstile + rate limiting on submissions
```

### Stack
- **Runtime:** Cloudflare Workers, Hono for routing
- **Database:** D1 (SQLite)
- **Assets:** Workers static assets for the frontend, R2 for prediction overlays
- **Map library:** Leaflet (simple, small, image overlays are trivial). MapLibre GL is an alternative if vector tiles are wanted later.
- **Hex grid:** `h3-js`, computed in the Worker (server-side aggregation)
- **Basemap:** OpenStreetMap-based tiles. Confirm the tile provider's usage policy; OSM's own tile servers are not intended for heavy production use, so plan for a hosted provider with a free tier if traffic grows.
- **Admin auth:** Cloudflare Access in front of `/admin/*` and `/api/admin/*`

### Why separate from Astro
Reports need a backend (storage, validation, spam control, aggregation). Decoupling means a new report never triggers a site rebuild, and the app can be reused for other repeaters or clubs.

---

## 4. Data Model (D1)

### `repeaters`
| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | slug, e.g. `w4trc-main` |
| name | TEXT | Display name |
| callsign | TEXT | |
| service | TEXT | `amateur` (extensible) |
| output_freq_mhz | REAL | |
| input_freq_mhz | REAL | |
| tone | TEXT | CTCSS / DCS / none |
| mode | TEXT | FM, DMR, D-STAR, etc. |
| lat, lon | REAL | Site location |
| antenna_height_ft | REAL | Above ground level |
| tx_power_w | REAL | |
| antenna_gain_dbd | REAL | |
| overlay_key | TEXT | R2 key of current prediction image |
| overlay_bounds | TEXT | JSON `[[south, west],[north, east]]` |
| overlay_updated_at | TEXT | ISO timestamp |
| active | INTEGER | 1/0 |

### `reports`
| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | ULID |
| repeater_id | TEXT FK | |
| lat, lon | REAL | Rounded to 4 decimals (about 36 ft) before storage |
| h3_r8 | TEXT | Precomputed H3 cell at resolution 8 |
| h3_r7 | TEXT | Resolution 7 |
| h3_r6 | TEXT | Resolution 6 |
| quality | INTEGER | 0 = no signal, 1 = fringe, 2 = moderate, 3 = strong |
| radio_type | TEXT | `handheld`, `mobile`, `base`, `other` |
| antenna_type | TEXT | `stock`, `external`, `vehicle`, `outdoor`, `other` |
| location_context | TEXT | `outdoors`, `in vehicle`, `indoors` |
| comment | TEXT | Optional, max 280 chars, sanitized |
| status | TEXT | `pending`, `approved`, `rejected` |
| submitted_at | TEXT | ISO timestamp |
| reviewed_at | TEXT | |
| reviewed_by | TEXT | Access identity email |
| ip_hash | TEXT | Salted SHA-256, for rate limiting and abuse review only |

Indexes: `(repeater_id, status)`, `(repeater_id, h3_r8)`, `(repeater_id, h3_r7)`, `(repeater_id, h3_r6)`.

### `admin_log`
Audit trail of approve / reject / delete actions (who, when, report id, action).

### Privacy note
Raw IP addresses are never stored. Coordinates are rounded before storage. Public API responses only expose aggregated hexagon data and, on tap, individual approved reports with coordinates already rounded.

---

## 5. Prediction Layer (Radio Mobile)

Radio Mobile is Windows software, so this runs on a desktop machine and is a manual, occasional job.

### Setup tasks
1. Install Radio Mobile and download terrain elevation data (SRTM) for the coverage area.
2. Optionally load land cover data for better accuracy.
3. Define the repeater unit: frequency, TX power, line loss, antenna gain, antenna height (AGL).
4. Define the receiving unit as a **handheld**: low gain, low height (about 5 ft), so predictions match the worst common case.
5. Run a coverage-from-one-site (Longley-Rice) analysis.
6. Define signal thresholds that map to the three bands (to be tuned against real reports):
   - **Strong:** clear handheld reception outdoors
   - **Moderate:** usable with some noise
   - **Fringe:** spotty on a handheld
7. Export the result as a georeferenced image (Google Earth KMZ export is the easiest route), then extract the PNG and its bounding box.

### Processing script (repo: `scripts/process-overlay`)
- Input: Radio Mobile PNG + bounds
- Steps: confirm the color bands, make the background transparent, reproject if needed, optimize PNG size
- Output: final `overlay.png` plus `bounds.json`
- Upload to R2 and update the `repeaters` row via an admin endpoint or a Wrangler script

### Display
- Single image overlay on the map (adequate for one repeater and one metro-sized area)
- Opacity slider and on/off toggle
- "Last updated" date and model assumptions shown in the panel (handheld height, power, antenna)
- If the area grows too large for one image, move to pre-rendered raster tiles in R2 (future)

### Future option
Evaluate SPLAT! as an open-source alternative that could run in a container on the homelab for automated regeneration.

---

## 6. Reports (Measured Layer)

### Submission flow
1. User taps **Add a report**.
2. Browser requests location (with a manual "tap the map to place a pin" fallback).
3. Form fields: signal quality (4 choices with plain-language descriptions), radio type, antenna type, location context, optional comment.
4. Turnstile challenge completes, user submits.
5. Server validates, rounds coordinates, computes H3 cells, stores as `pending`.
6. User sees a confirmation: "Thanks. Your report will appear after review."

### Validation
- Coordinates must be within a configurable distance of the repeater (default: 100 miles) to block junk
- Quality and enum fields must match the allowed values
- Comment is length-limited and HTML-escaped on output
- Repeater must exist and be active
- Duplicate protection: same `ip_hash` + same H3 r8 cell + same repeater within 10 minutes is rejected

### Spam and abuse controls
- **Cloudflare Turnstile** on the form (required, verified server-side)
- Rate limit per `ip_hash` (default: 10 submissions per hour)
- Held-for-approval moderation
- Admin can bulk-reject and block patterns

### Moderation (admin)
- Protected by Cloudflare Access
- Queue of pending reports, shown on a map and list together
- Approve, reject, edit comment, or delete
- Bulk actions for obvious batches
- All actions written to `admin_log`
- Optional notification (email or Matrix/Discord webhook) when new reports are pending

---

## 7. Hexagon Aggregation

- Library: `h3-js`
- Resolutions by zoom level:

| Map zoom | H3 resolution | Approx. cell size |
|---|---|---|
| 8 and below | 6 | about 3.7 mi edge |
| 9 to 10 | 7 | about 0.76 mi edge |
| 11 and above | 8 | about 0.29 mi edge (roughly half a mile across) |

- Each cell shows the **average quality** of approved reports in it, mapped to Strong / Moderate / Fringe / No signal.
- Cells with only one or two reports render paler, to signal low confidence.
- Tapping a cell opens a panel: report count, average, breakdown by radio and antenna type, and most recent report date.
- Aggregation is done by SQL (`GROUP BY h3_rN`) and cached at the edge for 60 seconds. Cache is purged when a report is approved.

---

## 8. API

Public:
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/repeaters` | List active repeaters |
| GET | `/api/repeaters/:id` | Repeater details + overlay URL and bounds |
| GET | `/api/repeaters/:id/hexes?res=7&bbox=...` | Aggregated approved reports for the viewport |
| GET | `/api/repeaters/:id/hexes/:h3` | Detail for one cell |
| GET | `/api/repeaters/:id/reports?bbox=...` | Individual approved reports (high zoom only) |
| POST | `/api/repeaters/:id/reports` | Submit a report (Turnstile required) |
| GET | `/health` | Health check (see section 11) |

Admin (behind Cloudflare Access):
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/reports?status=pending` | Moderation queue |
| PATCH | `/api/admin/reports/:id` | Approve, reject, edit |
| DELETE | `/api/admin/reports/:id` | Delete |
| POST | `/api/admin/reports/bulk` | Bulk action |
| POST | `/api/admin/repeaters` | Create repeater |
| PUT | `/api/admin/repeaters/:id` | Update repeater |
| POST | `/api/admin/repeaters/:id/overlay` | Upload new prediction overlay + bounds |

---

## 9. Frontend / UX

### Layout (follows the reference design)
- Page header with title and a short plain-language intro
- Quick stats: repeater output frequency and total approved reports
- Large map with a side panel (stacks below the map on phones)

### Side panel
- **Predicted signal:** legend (Strong / Moderate / Fringe) with plain-language meaning, plus a toggle
- **Measured by reports:** explanation of hexagons, legend (adds "No signal"), plus a toggle
- **Add a report** button (prominent, especially on mobile)
- Repeater info card: callsign, frequency, tone, mode, location, last prediction update

### Behavior
- Mobile-first, with the report flow designed for one-handed use
- Accessible: color is never the only indicator (patterns or labels for bands), keyboard focus states, sufficient contrast
- Respects light/dark mode where practical
- Multi-repeater ready: a repeater selector appears only when more than one is active

---

## 10. Astro Embed

- Astro page at `/coverage` with a short intro and the iframe
- Iframe attributes:
  - `src` pointing at the Worker's subdomain
  - `allow="geolocation"` so "use my location" works inside the iframe
  - `loading="lazy"`, `title` for accessibility
- Worker sets `Content-Security-Policy: frame-ancestors` to allow only the club website domain(s)
- Optional `postMessage` height handshake so the iframe resizes without double scrollbars (fallback: fixed viewport-relative height)
- Standalone URL still works, and a "Open full screen" link is shown beside the embed for phone users
- Turnstile is loaded inside the iframe, so the widget's allowed hostnames must include the Worker's domain

---

## 11. Monitoring and Operations

### Health endpoint (required)
`GET /health` returns JSON, no auth, no caching:

```json
{
  "status": "ok",
  "version": "<git sha or semver>",
  "time": "<ISO timestamp>",
  "checks": {
    "d1": "ok",
    "r2": "ok"
  }
}
```

- HTTP 200 when all checks pass, 503 when any fail
- D1 check: trivial query. R2 check: head on a known object.
- Hook into the existing monitoring stack (Zabbix web scenario and/or Uptime Kuma-style status page)

### Error tracking (optional, Sentry)
- Controlled by the `SENTRY_DSN` environment secret. If unset, Sentry is disabled and the app works normally.
- Use `toucan-js` (Sentry for Workers) on the Worker, and `@sentry/browser` on the frontend if enabled.
- Scrub IPs and report comments from events.

### Other
- Structured logs via Workers Logs
- Wrangler-managed migrations for D1
- D1 export / backup on a schedule (cron trigger to R2)
- Staging environment (`staging.` subdomain) using separate D1 and R2

---

## 12. Security

- Turnstile on the public submission form, verified server-side on every POST
- All inputs validated with a schema library (e.g., Zod)
- Parameterized D1 queries only
- Output escaping for all user-provided text
- CSP header on the app, with `frame-ancestors` restricted
- Cloudflare Access on all admin routes, with the allowed identities limited to club officers and Joshua
- CORS: public GET endpoints permit the club site origin; POST only from the app's own origin
- No raw IPs stored; salted hash with a rotating salt

---

## 13. Phases

### Phase 1: Prediction map (MVP)
- Radio Mobile setup, coverage run, thresholds tuned
- Overlay processing script
- Worker app with the map, repeater info, legend, and toggle
- Astro `/coverage` page with the iframe
- `/health` endpoint, optional Sentry wiring, CI deploy

### Phase 2: Reports
- D1 schema and migrations
- Submission form with Turnstile and rate limiting
- Admin moderation queue behind Cloudflare Access
- Hex aggregation and layer, cell detail panel

### Phase 3: Polish and expansion
- Multi-repeater selector and admin screens for adding repeaters
- Pending-report notifications
- Compare predicted vs. measured (e.g., flag cells where reports disagree with the model)
- Evaluate SPLAT! for automated predictions
- Publicity: announce to club, post to social media

---

## 14. Open Questions

1. **Which repeater first?** Need callsign, frequencies, tone, mode, site coordinates, antenna height, power, and gain.
2. **Domain:** `coverage.<club-domain>` or another subdomain?
3. **Who approves reports?** One person or a few officers? (Affects Access policy and notification setup.)
4. **Coverage radius:** How far out should the prediction extend, and how large a distance should the report validation allow?
5. **Basemap provider:** Is a free tier from a hosted provider acceptable, or should the app stick to OSM tiles at low volume?
6. **Report retention:** Keep reports indefinitely, or expire after a set period (e.g., 2 years) so old data doesn't mislead after equipment changes?
7. **Prediction thresholds:** Radio Mobile signal levels for each band need tuning, ideally against a handful of drive-test reports.

---

## 15. Acceptance Criteria (v1 complete = Phases 1 and 2)

- [ ] Public page loads on desktop and mobile with the predicted overlay and legend
- [ ] Map embeds in the Astro site via iframe, with geolocation working inside it
- [ ] A visitor can submit a report in under 30 seconds; Turnstile is enforced server-side
- [ ] Submitted reports stay hidden until an admin approves them
- [ ] Approved reports appear as hexagons that change resolution with zoom
- [ ] Tapping a hexagon shows its report count, average, and breakdown
- [ ] Admin can approve, reject, and delete reports; actions are logged
- [ ] `/health` returns correct status for D1 and R2 and is monitored
- [ ] Sentry can be enabled by setting `SENTRY_DSN`, and is fully inert without it
- [ ] No raw IPs stored; coordinates rounded on write
- [ ] Adding a second repeater requires only data entry, with no code change