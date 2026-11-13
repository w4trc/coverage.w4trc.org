import { describe, expect, it } from "vitest";
import { bandForAverage, h3ResForZoom } from "../src/shared/constants";
import { cellsFor, resolutionOf } from "../src/worker/lib/hexes";
import { publicRepeater, type RepeaterRow } from "../src/worker/lib/repeaters";
import { BulkAction, ReportInput, ReportPatch } from "../src/worker/lib/schemas";
import { distanceMiles, hashIp, parseBbox, round4, ulid, ULID_RE } from "../src/worker/lib/util";

const SITE = { lat: 36.52673, lon: -82.58804 };

describe("shared rules", () => {
  it("maps zoom to H3 resolution as specified", () => {
    expect([6, 8, 9, 10, 11, 15].map(h3ResForZoom)).toEqual([6, 6, 7, 7, 8, 8]);
  });
  it("maps an average to a band", () => {
    expect([3, 2.5, 2.49, 1.5, 0.5, 0.49, 0].map(bandForAverage)).toEqual([
      "strong", "strong", "moderate", "moderate", "fringe", "none", "none",
    ]);
  });
});

describe("util", () => {
  it("rounds coordinates to 4 decimals", () => {
    expect(round4(36.526734259)).toBe(36.5267);
    expect(round4(-82.588037818)).toBe(-82.588);
  });
  it("measures distance in miles", () => {
    expect(distanceMiles(SITE.lat, SITE.lon, SITE.lat, SITE.lon)).toBe(0);
    // Kingsport to Knoxville is roughly 80 miles in a straight line.
    const d = distanceMiles(SITE.lat, SITE.lon, 35.9606, -83.9207);
    expect(d).toBeGreaterThan(75);
    expect(d).toBeLessThan(95);
  });
  it("parses and rejects bboxes", () => {
    expect(parseBbox("-83,36,-82,37")).toEqual({ west: -83, south: 36, east: -82, north: 37 });
    expect(parseBbox("-82,37,-83,36")).toBeNull();
    expect(parseBbox("a,b,c,d")).toBeNull();
    expect(parseBbox(undefined)).toBeNull();
  });
  it("makes sortable, well-formed ULIDs", () => {
    const a = ulid(1_000_000);
    const b = ulid(2_000_000);
    expect(a).toMatch(ULID_RE);
    expect(a < b).toBe(true);
    expect(ulid()).not.toBe(ulid());
  });
  it("hashes IPs with a salt that rotates daily and never echoes the IP", async () => {
    const day1 = new Date("2026-11-10T12:00:00Z");
    const a = await hashIp("secret", "203.0.113.7", day1);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("203");
    expect(await hashIp("secret", "203.0.113.7", day1)).toBe(a);
    expect(await hashIp("secret", "203.0.113.8", day1)).not.toBe(a);
    expect(await hashIp("other", "203.0.113.7", day1)).not.toBe(a);
    expect(await hashIp("secret", "203.0.113.7", new Date("2026-11-11T12:00:00Z"))).not.toBe(a);
  });
});

describe("hexes", () => {
  it("computes nested cells at the three resolutions", () => {
    const c = cellsFor(SITE.lat, SITE.lon);
    expect(resolutionOf(c.h3_r8)).toBe(8);
    expect(resolutionOf(c.h3_r7)).toBe(7);
    expect(resolutionOf(c.h3_r6)).toBe(6);
  });
  it("rejects junk cell ids", () => {
    expect(resolutionOf("not-a-cell")).toBeNull();
    expect(resolutionOf("' OR 1=1 --")).toBeNull();
  });
});

describe("report validation", () => {
  const good = {
    lat: 36.55,
    lon: -82.56,
    quality: 2,
    radio_type: "handheld",
    antenna_type: "stock",
    location_context: "in vehicle",
    turnstile_token: "tok",
  };
  it("accepts a valid report and normalises the comment", () => {
    const r = ReportInput.parse({ ...good, comment: "  hello\u0000 there  " });
    expect(r.comment).toBe("hello there");
    expect(ReportInput.parse(good).comment).toBeNull();
    expect(ReportInput.parse({ ...good, comment: "   " }).comment).toBeNull();
  });
  it("normalizes an optional callsign", () => {
    expect(ReportInput.parse(good).callsign).toBeNull();
    expect(ReportInput.parse({ ...good, callsign: "  " }).callsign).toBeNull();
    expect(ReportInput.parse({ ...good, callsign: " w4abc " }).callsign).toBe("W4ABC");
    expect(ReportInput.parse({ ...good, callsign: "kj4xyz/m" }).callsign).toBe("KJ4XYZ/M");
    expect(ReportInput.safeParse({ ...good, callsign: "not a call" }).success).toBe(false);
  });
  it("rejects bad values", () => {
    expect(ReportInput.safeParse({ ...good, quality: 4 }).success).toBe(false);
    expect(ReportInput.safeParse({ ...good, quality: 1.5 }).success).toBe(false);
    expect(ReportInput.safeParse({ ...good, radio_type: "tank" }).success).toBe(false);
    expect(ReportInput.safeParse({ ...good, lat: 91 }).success).toBe(false);
    expect(ReportInput.safeParse({ ...good, comment: "x".repeat(281) }).success).toBe(false);
    expect(ReportInput.safeParse({ ...good, turnstile_token: "" }).success).toBe(false);
  });
  it("validates admin payloads", () => {
    expect(ReportPatch.safeParse({}).success).toBe(false);
    expect(ReportPatch.safeParse({ status: "approved" }).success).toBe(true);
    expect(ReportPatch.safeParse({ comment: null }).success).toBe(true);
    expect(ReportPatch.safeParse({ status: "published" }).success).toBe(false);
    expect(BulkAction.safeParse({ ids: [ulid()], action: "approve" }).success).toBe(true);
    expect(BulkAction.safeParse({ ids: ["x"], action: "approve" }).success).toBe(false);
    expect(BulkAction.safeParse({ ids: [], action: "approve" }).success).toBe(false);
  });
});

describe("public repeater shape", () => {
  const row: RepeaterRow = {
    id: "w4trc-vhf", name: "Bays Mountain VHF", callsign: "W4TRC", service: "amateur",
    output_freq_mhz: 146.97, input_freq_mhz: 146.37, tone: "PL 123.0 Hz", mode: "FM",
    lat: SITE.lat, lon: SITE.lon, antenna_height_ft: 50, tx_power_w: 50, antenna_gain_dbd: null,
    overlay_key: null, overlay_bounds: null, overlay_updated_at: null, overlay_notes: null, active: 1,
  };
  it("has no overlay until one is published", () => {
    expect(publicRepeater(row).overlay).toBeNull();
  });
  it("only exposes keys under overlays/ and flags samples", () => {
    const bounds = "[[35.7,-83.5],[37.2,-81.6]]";
    expect(publicRepeater({ ...row, overlay_key: "backups/x.json", overlay_bounds: bounds }).overlay).toBeNull();
    expect(publicRepeater({ ...row, overlay_key: "overlays/w4trc-vhf/a.png", overlay_bounds: "oops" }).overlay).toBeNull();
    const real = publicRepeater({ ...row, overlay_key: "overlays/w4trc-vhf/a.png", overlay_bounds: bounds }).overlay;
    expect(real).toMatchObject({ url: "/overlays/w4trc-vhf/a.png", sample: false });
    expect(publicRepeater({ ...row, overlay_key: "overlays/sample/w4trc-vhf/a.png", overlay_bounds: bounds }).overlay?.sample).toBe(true);
  });
});
