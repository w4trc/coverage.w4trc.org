import L from "leaflet";
import {
  ANTENNA_LABELS,
  ANTENNA_TYPES,
  CONTEXT_LABELS,
  LOCATION_CONTEXTS,
  QUALITY,
  RADIO_LABELS,
  RADIO_TYPES,
} from "../../src/shared/constants";
import { ApiError, sendJson, type AppConfig, type Repeater } from "./api";
import { $, h, storageGet, storageSet } from "./dom";

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: Record<string, unknown>): string;
      reset(id?: string): void;
      remove(id?: string): void;
    };
  }
}

type Deps = {
  map: L.Map;
  config: AppConfig;
  repeater: () => Repeater | null;
  /** Switch the side panel. */
  show: (view: "main" | "report" | "thanks") => void;
};

const PREFS_KEY = "coverage.setup.v1";
const CALLSIGN_KEY = "coverage.callsign.v1";
const EARTH_RADIUS_MI = 3958.8;

function miles(a: L.LatLng, lat: number, lon: number): number {
  return (a.distanceTo(L.latLng(lat, lon)) / 6371000) * EARTH_RADIUS_MI;
}

let turnstileLoading: Promise<void> | null = null;
function loadTurnstile(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  turnstileLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      turnstileLoading = null;
      reject(new Error("Turnstile failed to load"));
    };
    document.head.append(s);
  });
  return turnstileLoading;
}

export function initReportFlow({ map, config, repeater, show }: Deps) {
  const form = $<HTMLFormElement>("view-report");
  const locStatus = $("loc-status");
  const submit = $<HTMLButtonElement>("report-submit");
  const errorBox = $("report-error");
  const comment = $<HTMLTextAreaElement>("report-comment");
  const callsign = $<HTMLInputElement>("report-callsign");
  callsign.value = storageGet(CALLSIGN_KEY) ?? "";
  const hint = $("map-hint");
  const tsBox = $("turnstile-box");

  let active = false;
  let pin: L.Marker | null = null;
  let token: string | null = null;
  let widgetId: string | null = null;
  let sending = false;

  // --- Build the choice controls ---
  const qualityBox = $("quality-choices");
  for (const q of QUALITY) {
    qualityBox.append(
      h(
        "label",
        { class: "choice" },
        h("input", { type: "radio", name: "quality", value: q.value }),
        h("span", { class: `badge sw-${q.key}`, "aria-hidden": "true" }, q.letter),
        h("span", {}, h("b", {}, q.label), h("small", {}, q.desc)),
      ),
    );
  }

  let saved: Record<string, string> = {};
  try {
    saved = JSON.parse(storageGet(PREFS_KEY) ?? "{}") as Record<string, string>;
  } catch {
    saved = {};
  }
  function chips(boxId: string, name: string, values: readonly string[], labels: Record<string, string>, fallback: string) {
    const box = $(boxId);
    const initial = values.includes(saved[name] ?? "") ? saved[name] : fallback;
    for (const v of values) {
      box.append(
        h("label", { class: "chip" }, h("input", { type: "radio", name, value: v, checked: v === initial }), labels[v] ?? v),
      );
    }
  }
  chips("radio-chips", "radio_type", RADIO_TYPES, RADIO_LABELS, "handheld");
  chips("antenna-chips", "antenna_type", ANTENNA_TYPES, ANTENNA_LABELS, "stock");
  chips("context-chips", "location_context", LOCATION_CONTEXTS, CONTEXT_LABELS, "outdoors");

  const picked = (name: string) => form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? null;

  function refresh() {
    submit.disabled = sending || !pin || picked("quality") === null || !token;
    submit.textContent = sending ? "Sending…" : "Send report";
  }
  form.addEventListener("change", refresh);

  function fail(message: string) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  // --- Location ---
  function setPin(latlng: L.LatLng, source: "gps" | "map") {
    const rep = repeater();
    if (rep && miles(latlng, rep.lat, rep.lon) > config.max_distance_mi) {
      locStatus.textContent = `That spot is more than ${config.max_distance_mi} miles from the repeater. Tap the map closer in.`;
      return;
    }
    if (!pin) {
      pin = L.marker(latlng, {
        draggable: true,
        keyboard: true,
        title: "Your report location. Drag to adjust.",
        icon: L.divIcon({ className: "", html: '<div class="pin-marker"></div>', iconSize: [26, 26], iconAnchor: [13, 30] }),
        zIndexOffset: 1000,
      }).addTo(map);
      pin.on("dragend", () => pin && setPin(pin.getLatLng(), "map"));
    } else {
      pin.setLatLng(latlng);
    }
    hint.hidden = true;
    locStatus.textContent =
      source === "gps"
        ? "Location found. Drag the pin if it is not quite right."
        : "Pin placed. Tap or drag to adjust.";
    if (source === "gps") map.setView(latlng, Math.max(map.getZoom(), 13));
    refresh();
  }

  function locate() {
    if (!("geolocation" in navigator)) {
      locStatus.textContent = "This device cannot share a location. Tap the map to place the pin.";
      hint.hidden = false;
      return;
    }
    locStatus.textContent = "Finding your location…";
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (active) setPin(L.latLng(pos.coords.latitude, pos.coords.longitude), "gps");
      },
      () => {
        if (!active || pin) return;
        locStatus.textContent = "Could not get your location. Tap the map to place the pin.";
        hint.hidden = false;
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  }
  $("loc-gps").addEventListener("click", locate);

  map.on("click", (e) => {
    if (active) setPin(e.latlng, "map");
  });

  // --- Turnstile ---
  async function mountTurnstile() {
    token = null;
    try {
      await loadTurnstile();
    } catch {
      fail("The verification check could not load. Turn off content blockers for this page and try again.");
      return;
    }
    if (!window.turnstile || !active) return;
    if (widgetId) {
      window.turnstile.reset(widgetId);
      return;
    }
    widgetId = window.turnstile.render(tsBox, {
      sitekey: config.turnstile_site_key,
      size: "flexible",
      callback: (t: string) => {
        token = t;
        refresh();
      },
      "expired-callback": () => {
        token = null;
        refresh();
      },
      "error-callback": () => {
        token = null;
        refresh();
      },
    });
  }

  // --- Open / close ---
  function open() {
    if (!repeater()) return;
    active = true;
    document.body.classList.add("reporting");
    errorBox.hidden = true;
    show("report");
    if (!pin) locate();
    void mountTurnstile();
    refresh();
  }

  function close(view: "main" | "thanks" = "main") {
    active = false;
    document.body.classList.remove("reporting");
    hint.hidden = true;
    if (pin) {
      pin.remove();
      pin = null;
    }
    show(view);
  }

  $("btn-report").addEventListener("click", open);
  $("fab-report").addEventListener("click", () => {
    open();
    form.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("report-cancel").addEventListener("click", () => close());
  $("thanks-done").addEventListener("click", () => show("main"));
  $("thanks-again").addEventListener("click", open);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const rep = repeater();
    const quality = picked("quality");
    if (!rep || !pin || quality === null || !token || sending) return;

    const setup = {
      radio_type: picked("radio_type") ?? "handheld",
      antenna_type: picked("antenna_type") ?? "stock",
      location_context: picked("location_context") ?? "outdoors",
    };
    storageSet(PREFS_KEY, JSON.stringify(setup));
    const call = callsign.value.trim().toUpperCase();
    storageSet(CALLSIGN_KEY, call);

    sending = true;
    errorBox.hidden = true;
    refresh();
    const { lat, lng } = pin.getLatLng();
    try {
      await sendJson("POST", `/api/repeaters/${encodeURIComponent(rep.id)}/reports`, {
        lat,
        lon: lng,
        quality: Number(quality),
        ...setup,
        comment: comment.value,
        callsign: call,
        turnstile_token: token,
      });
      comment.value = "";
      form.querySelectorAll<HTMLInputElement>('input[name="quality"]').forEach((i) => (i.checked = false));
      close("thanks");
    } catch (err) {
      fail(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      // A Turnstile token works once, so always get a fresh one.
      token = null;
      if (widgetId && window.turnstile) window.turnstile.reset(widgetId);
      sending = false;
      refresh();
    }
  });

  return { isActive: () => active };
}
