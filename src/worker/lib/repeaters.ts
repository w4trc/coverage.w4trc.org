export type RepeaterRow = {
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
  overlay_key: string | null;
  overlay_bounds: string | null;
  overlay_updated_at: string | null;
  overlay_notes: string | null;
  active: number;
};

/** R2 keys under this prefix are the only ones served publicly. */
export const OVERLAY_PREFIX = "overlays/";

export function parseBounds(raw: string | null): [[number, number], [number, number]] | null {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw);
    if (Array.isArray(b) && b.length === 2 && b.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) {
      return b as [[number, number], [number, number]];
    }
  } catch {
    // fall through
  }
  return null;
}

export function publicRepeater(r: RepeaterRow) {
  const bounds = parseBounds(r.overlay_bounds);
  const hasOverlay = !!r.overlay_key && r.overlay_key.startsWith(OVERLAY_PREFIX) && !!bounds;
  return {
    id: r.id,
    name: r.name,
    callsign: r.callsign,
    service: r.service,
    output_freq_mhz: r.output_freq_mhz,
    input_freq_mhz: r.input_freq_mhz,
    tone: r.tone,
    mode: r.mode,
    lat: r.lat,
    lon: r.lon,
    antenna_height_ft: r.antenna_height_ft,
    tx_power_w: r.tx_power_w,
    antenna_gain_dbd: r.antenna_gain_dbd,
    overlay: hasOverlay
      ? {
          // The key changes on every upload, so the URL is safe to cache forever.
          url: `/${r.overlay_key}`,
          bounds,
          updated_at: r.overlay_updated_at,
          notes: r.overlay_notes,
          // Keys under overlays/sample/ are placeholder art, not a real prediction.
          sample: r.overlay_key!.startsWith(`${OVERLAY_PREFIX}sample/`),
        }
      : null,
    active: r.active === 1,
  };
}

export async function getActiveRepeater(db: D1Database, id: string): Promise<RepeaterRow | null> {
  return db.prepare("SELECT * FROM repeaters WHERE id = ? AND active = 1").bind(id).first<RepeaterRow>();
}
