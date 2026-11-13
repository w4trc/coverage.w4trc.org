import "@fontsource/heebo/latin-400.css";
import "@fontsource/heebo/latin-500.css";
import "@fontsource/heebo/latin-600.css";
import "@fontsource/signika/latin-600.css";
import "leaflet/dist/leaflet.css";
import "./style.css";

import L from "leaflet";
import {
  ANTENNA_LABELS,
  CONTEXT_LABELS,
  OVERLAY_COLORS,
  QUALITY,
  RADIO_LABELS,
  bandForAverage,
  h3ResForZoom,
  type QualityKey,
} from "../../src/shared/constants";
import { api, type AppConfig, type CellDetail, type Hex, type PublicReport, type Repeater } from "./api";
import { $, formatDate, h } from "./dom";
import { initReportFlow } from "./report";

const params = new URLSearchParams(location.search);
const embedded = params.get("embed") === "1" || window.self !== window.top;
const themeParam = params.get("theme");
if (themeParam === "dark" || themeParam === "light") document.documentElement.dataset.theme = themeParam;
if (embedded) document.body.classList.add("embed");

const BAND_COLOR: Record<QualityKey, string> = {
  strong: "#16a34a",
  moderate: "#eab308",
  fringe: "#dc2626",
  none: "#52525b",
};
// Wording for the prediction (a model), as opposed to what a person reported.
const PREDICTED_DESC: Record<Exclude<QualityKey, "none">, string> = {
  strong: "Clear on a handheld outdoors.",
  moderate: "Usable on a handheld, with some noise.",
  fringe: "Spotty on a handheld. A better antenna or a mobile radio helps.",
};
const bandInfo = (key: QualityKey) => QUALITY.find((q) => q.key === key)!;
const qualityInfo = (value: number) => QUALITY.find((q) => q.value === value) ?? QUALITY[3];

type View = "main" | "report" | "thanks" | "cell";
function show(view: View) {
  $("view-main").hidden = view !== "main";
  $("view-report").hidden = view !== "report";
  $("view-thanks").hidden = view !== "thanks";
  $("view-cell").hidden = view !== "cell";
}

async function start() {
  const [config, list] = await Promise.all([
    api<AppConfig>("/api/config"),
    api<{ repeaters: Repeater[] }>("/api/repeaters"),
  ]);
  if (config.sentry_dsn) void enableSentry(config);

  const repeaters = list.repeaters;
  let current: Repeater | null = null;

  // ---------- Map ----------
  const START_ZOOM_BOOST = 1.5;
  const map = L.map("map", { zoomControl: true, zoomSnap: 0.5, minZoom: 6, maxZoom: 17, worldCopyJump: true });
  map.attributionControl.setPrefix(false);
  L.tileLayer(config.tile_url, {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  }).addTo(map);
  L.control.scale({ imperial: true, metric: false }).addTo(map);

  // Stacking: prediction image below hexagons, hexagons below markers.
  map.createPane("prediction").style.zIndex = "350";
  map.createPane("hexes").style.zIndex = "420";
  map.createPane("hexlabels").style.zIndex = "430";
  map.getPane("hexlabels")!.style.pointerEvents = "none";

  const hexLayer = L.layerGroup().addTo(map);
  const dotLayer = L.layerGroup().addTo(map);
  let overlayLayer: L.ImageOverlay | null = null;
  let siteMarker: L.Marker | null = null;
  let overlayPixels: { ctx: CanvasRenderingContext2D; w: number; h: number } | null = null;

  const toggleOverlay = $<HTMLInputElement>("toggle-overlay");
  const toggleHexes = $<HTMLInputElement>("toggle-hexes");
  const opacity = $<HTMLInputElement>("overlay-opacity");

  const report = initReportFlow({ map, config, repeater: () => current, show });

  // ---------- Repeater ----------
  function fact(dl: HTMLElement, label: string, value: string | null) {
    if (value) dl.append(h("dt", {}, label), h("dd", {}, value));
  }

  async function selectRepeater(id: string) {
    const { repeater, approved_reports } = await api<{ repeater: Repeater; approved_reports: number }>(
      `/api/repeaters/${encodeURIComponent(id)}`,
    );
    current = repeater;
    hexCache.clear();

    $("stat-freq").textContent = `${repeater.output_freq_mhz.toFixed(3)} MHz`;
    $("stat-reports").textContent = approved_reports.toLocaleString();
    $("hex-empty").hidden = approved_reports > 0;

    // Info card
    $("rc-title").textContent = `${repeater.callsign} ${repeater.name}`;
    const dl = $("rc-facts");
    dl.replaceChildren();
    fact(dl, "Output", `${repeater.output_freq_mhz.toFixed(3)} MHz`);
    if (repeater.input_freq_mhz !== null) {
      const offset = repeater.input_freq_mhz - repeater.output_freq_mhz;
      fact(dl, "Input", `${repeater.input_freq_mhz.toFixed(3)} MHz (${offset > 0 ? "+" : "−"}${Math.abs(offset).toFixed(1)} MHz)`);
    }
    fact(dl, "Tone", repeater.tone);
    fact(dl, "Mode", repeater.mode);
    fact(dl, "Site", `${repeater.lat.toFixed(4)}, ${repeater.lon.toFixed(4)}`);
    fact(dl, "Power", repeater.tx_power_w !== null ? `${repeater.tx_power_w} W` : null);
    fact(dl, "Antenna", repeater.antenna_height_ft !== null ? `${repeater.antenna_height_ft} ft above ground` : null);
    fact(dl, "Antenna gain", repeater.antenna_gain_dbd !== null ? `${repeater.antenna_gain_dbd} dBd` : null);
    fact(dl, "Prediction updated", repeater.overlay?.updated_at ? formatDate(repeater.overlay.updated_at) : null);
    $("repeater-card").hidden = false;

    // Site marker
    siteMarker?.remove();
    siteMarker = L.marker([repeater.lat, repeater.lon], {
      title: `${repeater.callsign} repeater site`,
      icon: L.divIcon({
        className: "",
        html: '<div class="site-marker"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 21V10m-5 11 5-11 5 11M6.5 7a7.5 7.5 0 0 1 11 0M9.3 9.5a3.8 3.8 0 0 1 5.4 0"/></svg></div>',
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      }),
    }).addTo(map);
    siteMarker.bindPopup(
      h("div", {}, h("b", {}, `${repeater.callsign} ${repeater.name}`), h("br"), `${repeater.output_freq_mhz.toFixed(3)} MHz`, repeater.tone ? `, ${repeater.tone}` : ""),
    );

    // Prediction overlay
    overlayLayer?.remove();
    overlayLayer = null;
    overlayPixels = null;
    const ov = repeater.overlay;
    $("overlay-sample").hidden = !ov?.sample;
    $("legend-predicted").hidden = !ov;
    $("opacity-row").hidden = !ov;
    toggleOverlay.disabled = !ov;
    if (ov) {
      overlayLayer = L.imageOverlay(ov.url, ov.bounds, {
        pane: "prediction",
        opacity: Number(opacity.value) / 100,
        alt: "Predicted coverage",
        className: "prediction-image",
      });
      if (toggleOverlay.checked) overlayLayer.addTo(map);
      void readOverlayPixels(ov.url);
      const assumptions = ["Assumes a handheld at about 5 ft"];
      if (repeater.tx_power_w !== null) assumptions.push(`${repeater.tx_power_w} W transmitter`);
      if (repeater.antenna_height_ft !== null) assumptions.push(`antenna at ${repeater.antenna_height_ft} ft`);
      $("overlay-meta").textContent =
        `${ov.notes ?? assumptions.join(", ") + "."} Last updated ${formatDate(ov.updated_at)}.`;
      // Start one level closer than the whole prediction, centred on the repeater.
      const fitZoom = map.getBoundsZoom(ov.bounds, false, L.point(20, 20));
      map.setView([repeater.lat, repeater.lon], Math.min(fitZoom + START_ZOOM_BOOST, map.getMaxZoom()));
    } else {
      $("overlay-status").textContent = "The predicted coverage for this repeater has not been published yet.";
      $("overlay-meta").textContent = "";
      map.setView([repeater.lat, repeater.lon], 11);
    }
    show("main");
    await drawHexes();
  }

  // Keep a copy of the overlay pixels so a tap can be answered in words, not just colour.
  async function readOverlayPixels(url: string) {
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      overlayPixels = { ctx, w: canvas.width, h: canvas.height };
    } catch {
      overlayPixels = null;
    }
  }

  function predictedAt(latlng: L.LatLng): QualityKey | "outside" | null {
    const ov = current?.overlay;
    if (!ov || !overlayPixels) return null;
    const [[south, west], [north, east]] = ov.bounds;
    if (latlng.lat < south || latlng.lat > north || latlng.lng < west || latlng.lng > east) return "outside";
    // The image is stored in Web Mercator, so interpolate rows in projected space.
    const y = (lat: number) => L.CRS.EPSG3857.project(L.latLng(lat, 0)).y;
    const px = Math.min(overlayPixels.w - 1, Math.floor(((latlng.lng - west) / (east - west)) * overlayPixels.w));
    const py = Math.min(overlayPixels.h - 1, Math.floor(((y(north) - y(latlng.lat)) / (y(north) - y(south))) * overlayPixels.h));
    const [r, g, b, a] = overlayPixels.ctx.getImageData(px, py, 1, 1).data as unknown as [number, number, number, number];
    if (a < 128) return "outside";
    let best: QualityKey | "outside" = "outside";
    let bestD = 60 ** 2;
    for (const [key, c] of Object.entries(OVERLAY_COLORS) as [QualityKey, readonly number[]][]) {
      const d = (r - c[0]!) ** 2 + (g - c[1]!) ** 2 + (b - c[2]!) ** 2;
      if (d < bestD) {
        bestD = d;
        best = key;
      }
    }
    return best;
  }

  map.on("click", (e) => {
    if (report.isActive() || !overlayLayer || !map.hasLayer(overlayLayer)) return;
    const band = predictedAt(e.latlng);
    if (!band) return;
    const sample = current?.overlay?.sample;
    const body =
      band === "outside"
        ? h("div", {}, h("b", {}, "Predicted: outside coverage"), h("br"), "The model does not expect a usable handheld signal here.")
        : h("div", {}, h("b", {}, `Predicted: ${bandInfo(band).label}`), h("br"), band === "none" ? "" : PREDICTED_DESC[band]);
    if (sample) body.append(h("br"), h("i", {}, "Placeholder image, not a real prediction."));
    L.popup().setLatLng(e.latlng).setContent(body).openOn(map);
  });

  toggleOverlay.addEventListener("change", () => {
    if (!overlayLayer) return;
    if (toggleOverlay.checked) overlayLayer.addTo(map);
    else overlayLayer.remove();
  });
  opacity.addEventListener("input", () => overlayLayer?.setOpacity(Number(opacity.value) / 100));

  // ---------- Hexagons ----------
  const hexCache = new Map<number, { at: number; hexes: Hex[] }>();
  let hexRequest = 0;

  async function drawHexes() {
    hexLayer.clearLayers();
    if (!current || !toggleHexes.checked) return;
    const res = h3ResForZoom(map.getZoom());
    const mine = ++hexRequest;
    let entry = hexCache.get(res);
    if (!entry || Date.now() - entry.at > 60_000) {
      const data = await api<{ hexes: Hex[] }>(`/api/repeaters/${encodeURIComponent(current.id)}/hexes?res=${res}`);
      entry = { at: Date.now(), hexes: data.hexes };
      hexCache.set(res, entry);
    }
    if (mine !== hexRequest) return; // a newer zoom level won the race
    hexLayer.clearLayers();

    // Size the letters to the hexagons, which are only a few pixels wide when zoomed out.
    const sample = entry.hexes[0];
    let labelPx = 12;
    if (sample) {
      const a = map.latLngToLayerPoint(sample.boundary[0]!);
      const b = map.latLngToLayerPoint(sample.boundary[3]!);
      labelPx = Math.round(Math.max(8, Math.min(15, a.distanceTo(b) * 0.55)));
    }

    for (const hex of entry.hexes) {
      const info = bandInfo(hex.band);
      const sparse = hex.count <= 2;
      const poly = L.polygon(hex.boundary, {
        pane: "hexes",
        color: BAND_COLOR[hex.band],
        weight: sparse ? 1.5 : 2,
        dashArray: sparse ? "4 4" : undefined,
        fillColor: BAND_COLOR[hex.band],
        fillOpacity: sparse ? 0.25 : 0.6,
        bubblingMouseEvents: false,
      });
      // While placing a report pin, a tap on a hexagon is still a tap on the map.
      poly.on("click", (e) => (report.isActive() ? map.fire("click", e) : void openCell(hex)));
      poly.bindTooltip(`${info.label}: ${hex.count} report${hex.count === 1 ? "" : "s"}`, { sticky: true });
      hexLayer.addLayer(poly);
      // The letter makes each band readable without relying on colour.
      hexLayer.addLayer(
        L.marker(hex.center, {
          pane: "hexlabels",
          interactive: false,
          keyboard: false,
          icon: L.divIcon({ className: "hex-label", html: `<span style="font-size:${labelPx}px">${info.letter}</span>`, iconSize: [18, 18] }),
        }),
      );
    }
  }

  map.on("zoomend", () => {
    void drawHexes(); // cached per resolution, so this only refetches when the resolution changes
  });
  toggleHexes.addEventListener("change", () => {
    void drawHexes();
    void drawDots();
  });

  function bars(title: string, counts: [string, number][], total: number) {
    const box = h("div", {}, h("p", { class: "sub" }, title));
    const rows = h("div", { class: "bars" });
    for (const [label, n] of counts) {
      if (!n) continue;
      const fill = h("div", { class: "bar-fill" });
      fill.style.width = `${Math.round((n / total) * 100)}%`;
      rows.append(h("div", { class: "bar-row" }, h("span", {}, label), h("div", { class: "bar-track" }, fill), h("span", {}, n)));
    }
    box.append(rows);
    return box;
  }

  async function openCell(hex: Hex) {
    if (!current || report.isActive()) return;
    const body = $("cell-body");
    body.replaceChildren(h("p", { class: "muted" }, "Loading…"));
    show("cell");
    if (window.matchMedia("(max-width: 900px)").matches) $("view-cell").scrollIntoView({ behavior: "smooth", block: "nearest" });
    try {
      const d = await api<CellDetail>(`/api/repeaters/${encodeURIComponent(current.id)}/hexes/${hex.h3}`);
      const info = bandInfo(bandForAverage(d.avg));
      const label = (map: Record<string, string>) => (k: string) => map[k] ?? k;
      const entries = (rec: Record<string, number>, name: (k: string) => string) =>
        Object.entries(rec)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => [name(k), n] as [string, number]);

      body.replaceChildren(
        h(
          "div",
          { class: "cell-summary" },
          h("span", { class: `badge sw-${info.key}`, "aria-hidden": "true" }, info.letter),
          h(
            "div",
            {},
            h("b", {}, `Average: ${info.label}`),
            h("br"),
            `${d.count} report${d.count === 1 ? "" : "s"}, average ${d.avg.toFixed(1)} of 3. Most recent ${formatDate(d.latest)}.`,
          ),
        ),
        d.count <= 2 ? h("p", { class: "muted small" }, "Only a report or two here so far, so treat this as a hint.") : "",
        bars("Signal reported", QUALITY.map((q) => [q.label, d.by_quality[q.value] ?? 0]), d.count),
        bars("Radio", entries(d.by_radio, label(RADIO_LABELS)), d.count),
        bars("Antenna", entries(d.by_antenna, label(ANTENNA_LABELS)), d.count),
        bars("Where", entries(d.by_context, label(CONTEXT_LABELS)), d.count),
      );
      const comments = d.recent.filter((r) => r.comment);
      if (comments.length) {
        const ul = h("ul", { class: "comments" });
        for (const r of comments) {
          ul.append(h("li", {}, r.comment, h("br"), h("span", { class: "muted small" }, `${qualityInfo(r.quality).label}, ${formatDate(r.submitted_at)}`)));
        }
        body.append(h("div", {}, h("p", { class: "sub" }, "Comments"), ul));
      }
    } catch (err) {
      body.replaceChildren(h("p", { class: "error" }, err instanceof Error ? err.message : "Could not load this area."));
    }
  }
  $("cell-close").addEventListener("click", () => show("main"));

  // ---------- Individual reports at high zoom ----------
  let dotRequest = 0;
  async function drawDots() {
    dotLayer.clearLayers();
    if (!current || !toggleHexes.checked || map.getZoom() < config.reports_min_zoom) return;
    const b = map.getBounds();
    const mine = ++dotRequest;
    try {
      const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(5)).join(",");
      const { reports } = await api<{ reports: PublicReport[] }>(
        `/api/repeaters/${encodeURIComponent(current.id)}/reports?bbox=${bbox}`,
      );
      if (mine !== dotRequest) return;
      for (const r of reports) {
        const q = qualityInfo(r.quality);
        const dot = L.circleMarker([r.lat, r.lon], {
          radius: 6,
          color: "#fff",
          weight: 2,
          fillColor: BAND_COLOR[q.key],
          fillOpacity: 1,
          bubblingMouseEvents: false,
        });
        dot.bindPopup(
          h(
            "div",
            {},
            h("b", {}, q.label),
            h("br"),
            `${RADIO_LABELS[r.radio_type as keyof typeof RADIO_LABELS] ?? r.radio_type}, ${(CONTEXT_LABELS[r.location_context as keyof typeof CONTEXT_LABELS] ?? r.location_context).toLowerCase()}`,
            h("br"),
            h("span", {}, formatDate(r.submitted_at)),
            r.comment ? h("br") : null,
            r.comment,
          ),
        );
        dotLayer.addLayer(dot);
      }
    } catch {
      // Dots are a nice-to-have on top of the hexagons; stay quiet if they fail.
    }
  }
  map.on("moveend", () => void drawDots());

  // ---------- Repeater picker (only when there is a choice) ----------
  const select = $<HTMLSelectElement>("repeater-select");
  if (repeaters.length > 1) {
    for (const r of repeaters) select.append(h("option", { value: r.id }, `${r.callsign} ${r.output_freq_mhz.toFixed(3)} ${r.name}`));
    $("repeater-picker").hidden = false;
    select.addEventListener("change", () => void selectRepeater(select.value));
  }

  const wanted = params.get("repeater");
  const first = repeaters.find((r) => r.id === wanted) ?? repeaters[0];
  if (!first) {
    map.setView([36.5267, -82.588], 9);
    $("foot-error").textContent = "No repeaters are set up yet.";
    $<HTMLButtonElement>("btn-report").disabled = true;
    $("fab-report").hidden = true;
    return;
  }
  select.value = first.id;
  await selectRepeater(first.id);
}

/** Loaded only when the server reports a DSN, so the Sentry bundle is never fetched otherwise. */
async function enableSentry(config: AppConfig) {
  try {
    const Sentry = await import("@sentry/browser");
    Sentry.init({
      dsn: config.sentry_dsn ?? undefined,
      environment: config.environment,
      release: config.version,
      beforeSend(event) {
        delete event.user;
        if (event.request) {
          delete event.request.data;
          delete event.request.query_string;
          delete event.request.cookies;
        }
        return event;
      },
      // Breadcrumbs could capture typed comments or coordinates in request bodies.
      beforeBreadcrumb: (crumb) => (crumb.category === "ui.input" || crumb.category === "xhr" || crumb.category === "fetch" ? null : crumb),
    });
  } catch {
    // error tracking is optional
  }
}

// ---------- Embed helpers ----------
if (embedded) {
  // Tell the host page how tall the content is so the iframe can fit without a second scrollbar.
  const post = () => window.parent.postMessage({ type: "coverage:height", height: document.documentElement.scrollHeight }, "*");
  new ResizeObserver(post).observe(document.body);
  window.addEventListener("load", post);
  const link = $<HTMLAnchorElement>("fullscreen-link");
  link.href = `${location.origin}/`;
  link.hidden = false;
}

start().catch((err: unknown) => {
  console.error(err);
  $("foot-error").textContent = "The map could not load. Please refresh the page.";
});
