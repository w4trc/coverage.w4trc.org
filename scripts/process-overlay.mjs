#!/usr/bin/env node
// Turns a Radio Mobile coverage export into the overlay the map displays.
//
//   node scripts/process-overlay.mjs --input coverage.kmz --out scripts/out/w4trc-vhf
//   node scripts/process-overlay.mjs --input export/coverage.kml --out scripts/out/w4trc-vhf   (folder export)
//   node scripts/process-overlay.mjs --input coverage.png --bounds "S,W,N,E" --out scripts/out/w4trc-vhf
//
// What it does:
//   1. Reads the PNG (straight, or from inside a Google Earth KMZ, which also carries the bounds).
//   2. Confirms the colour bands: every pixel is matched to the nearest of the three band
//      colours, anything else becomes transparent, and a summary is printed.
//   3. Reprojects rows from plain lat/lon (how Radio Mobile / KML images are laid out) to
//      Web Mercator (how the map stretches an image), so the overlay lines up top to bottom.
//   4. Writes a small palette PNG in the app's canonical colours plus bounds.json.
//
// Options:
//   --strong / --moderate / --fringe  "#rrggbb" colours used in the Radio Mobile plot
//                                     (defaults: green 00ff00, yellow ffff00, red ff0000)
//   --tolerance N    max RGB distance to count as a band colour (default 90)
//   --max-width N    downscale wider images (default 2400)
//   --bounds-file F  JSON [[south, west],[north, east]] instead of --bounds

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { parseArgs } from "node:util";
import sharp from "sharp";
import { unzipSync, strFromU8 } from "fflate";

// Keep in sync with OVERLAY_COLORS in src/shared/constants.ts.
const CANONICAL = { strong: [22, 163, 74], moderate: [234, 179, 8], fringe: [220, 38, 38] };
const BANDS = ["strong", "moderate", "fringe"];

const { values: opt } = parseArgs({
  options: {
    input: { type: "string", short: "i" },
    out: { type: "string", short: "o", default: "scripts/out/overlay" },
    bounds: { type: "string" },
    "bounds-file": { type: "string" },
    strong: { type: "string", default: "#00ff00" },
    moderate: { type: "string", default: "#ffff00" },
    fringe: { type: "string", default: "#ff0000" },
    tolerance: { type: "string", default: "90" },
    "max-width": { type: "string", default: "2400" },
    help: { type: "boolean", short: "h" },
  },
});

if (opt.help || !opt.input) {
  console.log("Usage: node scripts/process-overlay.mjs --input <file.kmz|file.kml|file.png> [--bounds S,W,N,E] --out <dir>");
  process.exit(opt.help ? 0 : 1);
}

const fail = (msg) => {
  console.error(`Error: ${msg}`);
  process.exit(1);
};

const hex = (s) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(s);
  if (!m) fail(`Bad colour "${s}". Use #rrggbb.`);
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};

function checkBounds(b) {
  const ok =
    Array.isArray(b) && b.length === 2 && b.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
  if (!ok || b[0][0] >= b[1][0] || b[0][1] >= b[1][1]) fail("Bounds must be [[south, west],[north, east]].");
  return b;
}

function parseKml(kml) {
  const tag = (name) => {
    const m = new RegExp(`<${name}>\\s*([-0-9.eE+]+)\\s*</${name}>`).exec(kml);
    return m ? Number(m[1]) : NaN;
  };
  const box = [
    [tag("south"), tag("west")],
    [tag("north"), tag("east")],
  ];
  if (/<rotation>\s*[-0-9.]*[1-9]/.test(kml)) console.warn("Warning: the KML overlay is rotated; rotation is ignored.");
  const href = /<GroundOverlay>[\s\S]*?<href>\s*([^<]+?)\s*<\/href>/.exec(kml)?.[1];
  return { bounds: box.flat().every(Number.isFinite) ? box : null, href };
}

function warnIfJpeg(name) {
  if (/\.jpe?g$/i.test(name)) console.warn("Warning: JPEG overlays have fuzzy colours. Export as PNG if you can.");
}

async function loadInput() {
  const raw = await readFile(opt.input);
  let image = raw;
  let bounds = null;

  const ext = extname(opt.input).toLowerCase();
  if (ext === ".kmz") {
    const files = unzipSync(new Uint8Array(raw));
    const kmlName = Object.keys(files).find((n) => n.toLowerCase().endsWith(".kml"));
    if (!kmlName) fail("No .kml file inside the KMZ.");
    const kml = parseKml(strFromU8(files[kmlName]));
    bounds = kml.bounds;
    const imgName =
      (kml.href && Object.keys(files).find((n) => n === kml.href || n.endsWith(`/${kml.href}`))) ??
      Object.keys(files).find((n) => /\.(png|gif|jpe?g)$/i.test(n));
    if (!imgName) fail("No overlay image inside the KMZ.");
    warnIfJpeg(imgName);
    image = Buffer.from(files[imgName]);
    console.log(`KMZ: image ${imgName}${bounds ? ", bounds read from KML" : ""}`);
  } else if (ext === ".kml") {
    // Radio Mobile's folder export: a .kml next to the image it names.
    const kml = parseKml(raw.toString("utf8"));
    if (!kml.href) fail("The KML does not name an overlay image.");
    bounds = kml.bounds;
    const imgPath = join(dirname(opt.input), kml.href);
    warnIfJpeg(imgPath);
    image = await readFile(imgPath).catch(() => fail(`Cannot read ${imgPath} (named by the KML).`));
    console.log(`KML: image ${kml.href}${bounds ? ", bounds read from KML" : ""}`);
  }

  if (opt.bounds) {
    const p = opt.bounds.split(",").map(Number);
    if (p.length !== 4) fail('--bounds takes "south,west,north,east".');
    bounds = [
      [p[0], p[1]],
      [p[2], p[3]],
    ];
  } else if (opt["bounds-file"]) {
    bounds = JSON.parse(await readFile(opt["bounds-file"], "utf8"));
  }
  if (!bounds) fail('No bounds. Pass --bounds "south,west,north,east" or use a KMZ export.');
  return { image, bounds: checkBounds(bounds) };
}

const mercY = (latDeg) => Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360));
const invMercY = (y) => (Math.atan(Math.exp(y)) * 360) / Math.PI - 90;

const { image, bounds } = await loadInput();
const [[south, west], [north, east]] = bounds;

let pipeline = sharp(image).ensureAlpha();
const meta = await pipeline.metadata();
const maxWidth = Number(opt["max-width"]);
if (meta.width > maxWidth) pipeline = pipeline.resize({ width: maxWidth, kernel: "nearest" });
const { data: src, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
const { width, height } = info;

// --- 1. Classify every pixel into a band (or background). ---
const sourceColors = BANDS.map((b) => hex(opt[b]));
const tol2 = Number(opt.tolerance) ** 2;
const classes = new Uint8Array(width * height); // 0 = background, 1..3 = band
const counts = [0, 0, 0, 0];
const strays = new Map();

for (let i = 0, p = 0; i < classes.length; i++, p += 4) {
  const r = src[p], g = src[p + 1], b = src[p + 2], a = src[p + 3];
  let cls = 0;
  // Radio Mobile writes its plot half-transparent (alpha 127), so any visible pixel counts.
  if (a > 0) {
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const c = sourceColors[k];
      const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
      if (d < best) {
        best = d;
        cls = k + 1;
      }
    }
    if (best > tol2) {
      cls = 0;
      // Track what was dropped (coarsely) so unexpected colours are visible in the summary.
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      strays.set(key, (strays.get(key) ?? 0) + 1);
    }
  }
  classes[i] = cls;
  counts[cls]++;
}

const total = classes.length;
const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
console.log(`Input: ${width} x ${height} px`);
BANDS.forEach((b, k) => console.log(`  ${b.padEnd(9)} ${opt[b]}  ${pct(counts[k + 1])}`));
console.log(`  background        ${pct(counts[0])}`);
const topStrays = [...strays.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
if (topStrays.length) {
  const fmt = ([key, n]) => {
    const to8 = (v) => (v * 17).toString(16).padStart(2, "0");
    return `#${to8(key >> 8)}${to8((key >> 4) & 15)}${to8(key & 15)} (${pct(n)})`;
  };
  console.log(`  dropped colours:  ${topStrays.map(fmt).join(", ")}`);
}
BANDS.forEach((b, k) => {
  if (counts[k + 1] === 0) console.warn(`Warning: no "${b}" pixels found. Check --${b} matches the plot colour.`);
});
if (counts[1] + counts[2] + counts[3] === 0) fail("No band colours matched. Nothing to write.");

// --- 2. Reproject rows from equirectangular to Web Mercator, and paint. ---
const out = Buffer.alloc(width * height * 4);
const yN = mercY(north);
const yS = mercY(south);
for (let j = 0; j < height; j++) {
  const lat = invMercY(yN - ((j + 0.5) / height) * (yN - yS));
  const srcRow = Math.min(height - 1, Math.max(0, Math.floor(((north - lat) / (north - south)) * height)));
  for (let x = 0; x < width; x++) {
    const cls = classes[srcRow * width + x];
    if (!cls) continue;
    const c = CANONICAL[BANDS[cls - 1]];
    const o = (j * width + x) * 4;
    out[o] = c[0];
    out[o + 1] = c[1];
    out[o + 2] = c[2];
    out[o + 3] = 255;
  }
}

// --- 3. Write the palette PNG and bounds. ---
await mkdir(opt.out, { recursive: true });
const pngPath = join(opt.out, "overlay.png");
await sharp(out, { raw: { width, height, channels: 4 } })
  .png({ palette: true, colours: 8, compressionLevel: 9, effort: 10 })
  .toFile(pngPath);
await writeFile(join(opt.out, "bounds.json"), JSON.stringify(bounds) + "\n");

const { size } = await sharp(pngPath).metadata();
console.log(`Wrote ${pngPath}${size ? ` (${(size / 1024).toFixed(0)} KB)` : ""} and bounds.json from ${basename(opt.input)}`);
console.log(`Bounds [[south, west],[north, east]]: ${JSON.stringify(bounds)}`);
