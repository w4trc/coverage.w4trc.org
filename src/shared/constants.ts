// Shared between the Worker and the browser bundle. Keep this dependency-free.

export const QUALITY = [
  { value: 3, key: "strong", label: "Strong", letter: "S", desc: "Clear audio, full quieting or close to it." },
  { value: 2, key: "moderate", label: "Moderate", letter: "M", desc: "Usable, with some noise or hiss." },
  { value: 1, key: "fringe", label: "Fringe", letter: "F", desc: "Spotty. Drops in and out, hard to copy." },
  { value: 0, key: "none", label: "No signal", letter: "N", desc: "Could not hear or reach the repeater." },
] as const;

export type QualityKey = (typeof QUALITY)[number]["key"];

export const RADIO_TYPES = ["handheld", "mobile", "base", "other"] as const;
export const ANTENNA_TYPES = ["stock", "external", "vehicle", "outdoor", "other"] as const;
export const LOCATION_CONTEXTS = ["outdoors", "in vehicle", "indoors"] as const;

export const RADIO_LABELS: Record<(typeof RADIO_TYPES)[number], string> = {
  handheld: "Handheld",
  mobile: "Mobile",
  base: "Base",
  other: "Other",
};
export const ANTENNA_LABELS: Record<(typeof ANTENNA_TYPES)[number], string> = {
  stock: "Stock antenna",
  external: "Aftermarket whip",
  vehicle: "Vehicle antenna",
  outdoor: "Outdoor / roof",
  other: "Other",
};
export const CONTEXT_LABELS: Record<(typeof LOCATION_CONTEXTS)[number], string> = {
  outdoors: "Outdoors",
  "in vehicle": "In a vehicle",
  indoors: "Indoors",
};

export const COMMENT_MAX = 280;

/** Average quality (0..3) to band. */
export function bandForAverage(avg: number): QualityKey {
  if (avg >= 2.5) return "strong";
  if (avg >= 1.5) return "moderate";
  if (avg >= 0.5) return "fringe";
  return "none";
}

/** Map zoom to H3 resolution (spec section 7). */
export function h3ResForZoom(zoom: number): 6 | 7 | 8 {
  if (zoom <= 8) return 6;
  if (zoom <= 10) return 7;
  return 8;
}

/** Individual approved reports are only served / drawn at or above this zoom. */
export const REPORTS_MIN_ZOOM = 13;

/** Canonical colours written by scripts/process-overlay and read back by the map. */
export const OVERLAY_COLORS = {
  strong: [22, 163, 74],
  moderate: [234, 179, 8],
  fringe: [220, 38, 38],
} as const;
