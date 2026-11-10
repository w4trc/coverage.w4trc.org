export type AppConfig = {
  turnstile_site_key: string;
  tile_url: string;
  max_distance_mi: number;
  reports_min_zoom: number;
  sentry_dsn: string | null;
  environment: string;
  version: string;
};

export type Overlay = {
  url: string;
  bounds: [[number, number], [number, number]];
  updated_at: string | null;
  notes: string | null;
  sample: boolean;
};

export type Repeater = {
  id: string;
  name: string;
  callsign: string;
  service: string;
  output_freq_mhz: number;
  input_freq_mhz: number | null;
  tone: string | null;
  mode: string | null;
  lat: number;
  lon: number;
  antenna_height_ft: number | null;
  tx_power_w: number | null;
  antenna_gain_dbd: number | null;
  overlay: Overlay | null;
  active: boolean;
};

export type Hex = {
  h3: string;
  count: number;
  avg: number;
  band: "strong" | "moderate" | "fringe" | "none";
  latest: string;
  center: [number, number];
  boundary: [number, number][];
};

export type CellDetail = {
  h3: string;
  res: number;
  count: number;
  avg: number;
  latest: string;
  by_quality: number[];
  by_radio: Record<string, number>;
  by_antenna: Record<string, number>;
  by_context: Record<string, number>;
  recent: { quality: number; radio_type: string; antenna_type: string; location_context: string; comment: string | null; submitted_at: string }[];
};

export type PublicReport = {
  id: string;
  lat: number;
  lon: number;
  quality: number;
  radio_type: string;
  antenna_type: string;
  location_context: string;
  comment: string | null;
  submitted_at: string;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError("Could not reach the server. Check your connection and try again.", 0);
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export function sendJson<T>(method: string, path: string, body: unknown): Promise<T> {
  return api<T>(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

/** Map credit line: OpenStreetMap always, plus CARTO when its basemap is used. */
export function tileAttribution(tileUrl: string): string {
  const osm = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
  return tileUrl.includes("cartocdn.com")
    ? `${osm} &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>`
    : osm;
}
