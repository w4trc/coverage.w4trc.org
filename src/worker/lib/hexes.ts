import { cellToBoundary, cellToLatLng, getResolution, isValidCell, latLngToCell } from "h3-js";
import { bandForAverage } from "../../shared/constants";
import type { Bbox } from "./util";

export const H3_RESOLUTIONS = [6, 7, 8] as const;
export type H3Res = (typeof H3_RESOLUTIONS)[number];

export function isH3Res(n: number): n is H3Res {
  return n === 6 || n === 7 || n === 8;
}

export function cellsFor(lat: number, lon: number) {
  return {
    h3_r8: latLngToCell(lat, lon, 8),
    h3_r7: latLngToCell(lat, lon, 7),
    h3_r6: latLngToCell(lat, lon, 6),
  };
}

/** Resolution of a cell id if it is one we aggregate at, else null. */
export function resolutionOf(cell: string): H3Res | null {
  if (!isValidCell(cell)) return null;
  const res = getResolution(cell);
  return isH3Res(res) ? res : null;
}

export type Hex = {
  h3: string;
  count: number;
  avg: number;
  band: string;
  latest: string;
  center: [number, number];
  boundary: [number, number][];
};

const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** GROUP BY h3_rN over approved reports. The column name comes from a fixed whitelist. */
export async function aggregateHexes(db: D1Database, repeaterId: string, res: H3Res): Promise<Hex[]> {
  const col = `h3_r${res}`;
  const { results } = await db
    .prepare(
      `SELECT ${col} AS h3, COUNT(*) AS count, AVG(quality) AS avg, MAX(submitted_at) AS latest
         FROM reports
        WHERE repeater_id = ? AND status = 'approved'
        GROUP BY ${col}`,
    )
    .bind(repeaterId)
    .all<{ h3: string; count: number; avg: number; latest: string }>();

  return results.map((r) => {
    const [lat, lng] = cellToLatLng(r.h3);
    return {
      h3: r.h3,
      count: r.count,
      avg: Math.round(r.avg * 100) / 100,
      band: bandForAverage(r.avg),
      latest: r.latest,
      center: [round5(lat), round5(lng)],
      boundary: cellToBoundary(r.h3).map(([la, ln]) => [round5(la), round5(ln)] as [number, number]),
    };
  });
}

export function inBbox(hex: Hex, b: Bbox): boolean {
  // Keep any cell whose centre or any vertex falls in the viewport.
  const pts = [hex.center, ...hex.boundary];
  return pts.some(([lat, lon]) => lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east);
}

// ---- Edge cache (Cache API). 60 s TTL, purged when the approved set changes. ----

const CACHE_TTL_S = 60;
const cacheKey = (repeaterId: string, res: H3Res) =>
  new Request(`https://cache.coverage.internal/v1/${encodeURIComponent(repeaterId)}/hexes/${res}`);

export async function cachedHexes(
  db: D1Database,
  repeaterId: string,
  res: H3Res,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Hex[]> {
  const cache = caches.default;
  const key = cacheKey(repeaterId, res);
  const hit = await cache.match(key);
  if (hit) return (await hit.json()) as Hex[];

  const hexes = await aggregateHexes(db, repeaterId, res);
  waitUntil(
    cache.put(
      key,
      new Response(JSON.stringify(hexes), {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_TTL_S}` },
      }),
    ),
  );
  return hexes;
}

/**
 * Drop cached aggregates for a repeater. Cache API deletes are per data centre,
 * so other locations catch up within the 60 s TTL.
 */
export async function purgeHexCache(repeaterIds: Iterable<string>): Promise<void> {
  const cache = caches.default;
  const jobs: Promise<boolean>[] = [];
  for (const id of new Set(repeaterIds)) {
    for (const res of H3_RESOLUTIONS) jobs.push(cache.delete(cacheKey(id, res)));
  }
  await Promise.all(jobs);
}
