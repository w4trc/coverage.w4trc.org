#!/usr/bin/env node
// Draws a FAKE "Radio Mobile style" coverage plot for local development, so the map has
// something to show before the real prediction exists. It is noise shaped like rings
// around the site. It is not a propagation model and must never be published as one
// (publish-overlay stores it under overlays/sample/, which the UI labels as a sample).

import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";

const SITE = { lat: 36.52673, lon: -82.58804 };
const HALF_LAT = 0.75; // degrees north/south of the site
const HALF_LON = 0.95;
const W = 900;
const H = 760;

const bounds = [
  [SITE.lat - HALF_LAT, SITE.lon - HALF_LON],
  [SITE.lat + HALF_LAT, SITE.lon + HALF_LON],
];

// Small deterministic value noise so the output is the same on every run.
function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const s = (t) => t * t * (3 - 2 * t);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * s(xf) + (c - a) * s(yf) + (a - b - c + d) * s(xf) * s(yf);
}
const fbm = (x, y) => 0.55 * noise(x, y) + 0.3 * noise(x * 2.1, y * 2.1) + 0.15 * noise(x * 4.3, y * 4.3);

const buf = Buffer.alloc(W * H * 4, 255); // white, opaque: like a Radio Mobile bitmap
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = (x / W - 0.5) * 2;
    const dy = (y / H - 0.5) * 2;
    const dist = Math.hypot(dx, dy);
    // Ridge-and-valley feel: stretch the noise along the NE-SW grain of the local terrain.
    const u = (dx + dy) * 2.2, v = (dx - dy) * 6.5;
    const signal = 1.15 - dist * 1.25 + (fbm(u + 20, v + 20) - 0.5) * 0.9;
    let rgb = null;
    if (signal > 0.72) rgb = [0, 255, 0];
    else if (signal > 0.45) rgb = [255, 255, 0];
    else if (signal > 0.22) rgb = [255, 0, 0];
    if (rgb) {
      const o = (y * W + x) * 4;
      buf[o] = rgb[0];
      buf[o + 1] = rgb[1];
      buf[o + 2] = rgb[2];
    }
  }
}

await mkdir("scripts/out", { recursive: true });
await sharp(buf, { raw: { width: W, height: H, channels: 4 } }).png().toFile("scripts/out/sample-radio-mobile.png");
await writeFile("scripts/out/sample-radio-mobile.bounds.json", JSON.stringify(bounds) + "\n");
console.log("Wrote scripts/out/sample-radio-mobile.png (fake plot for local development)");
