import "@fontsource/heebo/latin-400.css";
import "@fontsource/heebo/latin-500.css";
import "@fontsource/heebo/latin-600.css";
import "@fontsource/signika/latin-600.css";
import "leaflet/dist/leaflet.css";
import "./style.css";
import "./admin.css";

import L from "leaflet";
import { ANTENNA_LABELS, COMMENT_MAX, CONTEXT_LABELS, QUALITY, RADIO_LABELS } from "../../src/shared/constants";
import { api, sendJson, type AppConfig, type Repeater } from "./api";
import { $, formatDateTime, h } from "./dom";

type Status = "pending" | "approved" | "rejected";
type AdminReport = {
  id: string;
  repeater_id: string;
  lat: number;
  lon: number;
  quality: number;
  radio_type: string;
  antenna_type: string;
  location_context: string;
  comment: string | null;
  status: Status;
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  sender: string;
  callsign: string | null;
};

const BAND_COLOR = ["#52525b", "#dc2626", "#eab308", "#16a34a"];
const qualityInfo = (v: number) => QUALITY.find((q) => q.value === v) ?? QUALITY[3];
const lookup = (map: Record<string, string>, k: string) => map[k] ?? k;

let status: Status = "pending";
let reports: AdminReport[] = [];
let totals: Record<Status, number> = { pending: 0, approved: 0, rejected: 0 };
const selected = new Set<string>();
const markers = new Map<string, L.Marker>();

const errorBox = $("admin-error");
function showError(err: unknown) {
  errorBox.textContent = err instanceof Error ? err.message : String(err);
  errorBox.hidden = false;
}

async function start() {
  const [config, me, reps] = await Promise.all([
    api<AppConfig>("/api/config"),
    api<{ email: string }>("/api/admin/me"),
    api<{ repeaters: Repeater[] }>("/api/admin/repeaters"),
  ]);
  $("who").textContent = `Signed in as ${me.email}`;

  const map = L.map("map", { minZoom: 5, maxZoom: 18 });
  map.attributionControl.setPrefix(false);
  L.tileLayer(config.tile_url, {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  const firstRep = reps.repeaters[0];
  map.setView(firstRep ? [firstRep.lat, firstRep.lon] : [36.5267, -82.588], 10);
  for (const r of reps.repeaters) {
    L.circleMarker([r.lat, r.lon], { radius: 7, color: "#fff", weight: 2, fillColor: "#121212", fillOpacity: 1 })
      .bindTooltip(`${r.callsign} ${r.output_freq_mhz.toFixed(3)} site`)
      .addTo(map);
  }

  // ---- Tabs ----
  const tabs = $("tabs");
  function renderTabs() {
    tabs.replaceChildren(
      ...(["pending", "approved", "rejected"] as Status[]).map((s) => {
        const b = h("button", { class: "tab", type: "button", role: "tab", "aria-selected": String(s === status) }, `${s[0]!.toUpperCase()}${s.slice(1)} (${totals[s]})`);
        b.addEventListener("click", () => {
          status = s;
          void load();
        });
        return b;
      }),
    );
  }

  // ---- Bulk bar ----
  const selectAll = $<HTMLInputElement>("select-all");
  const bulkButtons = {
    approve: $<HTMLButtonElement>("bulk-approve"),
    reject: $<HTMLButtonElement>("bulk-reject"),
    delete: $<HTMLButtonElement>("bulk-delete"),
  };
  function renderBulk() {
    const n = selected.size;
    $("selected-count").textContent = n ? `${n} selected` : "Select all";
    selectAll.checked = n > 0 && n === reports.length;
    selectAll.indeterminate = n > 0 && n < reports.length;
    bulkButtons.approve.disabled = n === 0 || status === "approved";
    bulkButtons.reject.disabled = n === 0 || status === "rejected";
    bulkButtons.delete.disabled = n === 0;
    bulkButtons.delete.textContent = "Delete";
    bulkButtons.delete.dataset.armed = "";
  }
  selectAll.addEventListener("change", () => {
    selected.clear();
    if (selectAll.checked) for (const r of reports) selected.add(r.id);
    renderList();
  });

  async function bulk(action: "approve" | "reject" | "delete") {
    if (!selected.size) return;
    // Deleting is permanent, so the button asks for a second click instead of a browser dialog.
    if (action === "delete" && bulkButtons.delete.dataset.armed !== "1") {
      bulkButtons.delete.dataset.armed = "1";
      bulkButtons.delete.textContent = `Really delete ${selected.size}?`;
      return;
    }
    try {
      await sendJson("POST", "/api/admin/reports/bulk", { ids: [...selected], action });
      await load();
    } catch (err) {
      showError(err);
    }
  }
  bulkButtons.approve.addEventListener("click", () => void bulk("approve"));
  bulkButtons.reject.addEventListener("click", () => void bulk("reject"));
  bulkButtons.delete.addEventListener("click", () => void bulk("delete"));

  // ---- List ----
  const list = $("list");

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      await load();
    } catch (err) {
      showError(err);
    }
  }

  function focusReport(id: string, pan: boolean) {
    list.querySelectorAll(".report.focused").forEach((el) => el.classList.remove("focused"));
    const card = list.querySelector(`[data-id="${id}"]`);
    card?.classList.add("focused");
    const m = markers.get(id);
    if (pan && m) map.setView(m.getLatLng(), Math.max(map.getZoom(), 13));
    else card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function card(r: AdminReport): HTMLElement {
    const q = qualityInfo(r.quality);
    const check = h("input", { type: "checkbox", "aria-label": `Select report from ${formatDateTime(r.submitted_at)}`, checked: selected.has(r.id) });
    check.addEventListener("change", () => {
      if (check.checked) selected.add(r.id);
      else selected.delete(r.id);
      renderBulk();
    });

    const commentView = h("div", {});
    function renderComment() {
      const edit = h("button", { class: "btn-link small", type: "button" }, r.comment ? "Edit comment" : "Add comment");
      edit.addEventListener("click", () => {
        const ta = h("textarea", { rows: 2, maxlength: COMMENT_MAX, "aria-label": "Comment" });
        ta.value = r.comment ?? "";
        const save = h("button", { class: "btn btn-primary btn-sm", type: "button" }, "Save");
        const cancel = h("button", { class: "btn btn-outline btn-sm", type: "button" }, "Cancel");
        save.addEventListener("click", () => void act(() => sendJson("PATCH", `/api/admin/reports/${r.id}`, { comment: ta.value.trim() || null })));
        cancel.addEventListener("click", renderComment);
        commentView.replaceChildren(ta, h("div", { class: "row" }, save, cancel));
        ta.focus();
      });
      commentView.replaceChildren(r.comment ? h("p", { class: "report-comment" }, r.comment) : "", edit);
    }
    renderComment();

    const sameSender = h("button", { class: "btn-link small", type: "button", title: "Select every listed report from this sender" }, "select all from sender");
    sameSender.addEventListener("click", () => {
      for (const x of reports) if (x.sender === r.sender) selected.add(x.id);
      renderList();
    });

    const actions = h("div", { class: "row" });
    const button = (label: string, cls: string, fn: () => Promise<unknown>) => {
      const b = h("button", { class: `btn btn-sm ${cls}`, type: "button" }, label);
      b.addEventListener("click", () => void act(fn));
      actions.append(b);
    };
    const patch = (s: Status) => () => sendJson("PATCH", `/api/admin/reports/${r.id}`, { status: s });
    if (r.status !== "approved") button("Approve", "btn-primary", patch("approved"));
    if (r.status !== "rejected") button("Reject", "btn-outline", patch("rejected"));
    if (r.status !== "pending") button("Back to pending", "btn-outline", patch("pending"));
    const del = h("button", { class: "btn btn-sm btn-danger", type: "button" }, "Delete");
    del.addEventListener("click", () => {
      if (del.dataset.armed === "1") void act(() => api(`/api/admin/reports/${r.id}`, { method: "DELETE" }));
      else {
        del.dataset.armed = "1";
        del.textContent = "Really delete?";
      }
    });
    actions.append(del);

    const locate = h("button", { class: "btn-link small", type: "button" }, `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}`);
    locate.addEventListener("click", () => focusReport(r.id, true));

    return h(
      "article",
      { class: `report q${r.quality}`, "data-id": r.id },
      check,
      h(
        "div",
        { class: "report-body" },
        h("div", { class: "report-title" }, `${q.letter} · ${q.label}`, h("span", { class: "muted small" }, `  ${formatDateTime(r.submitted_at)}`)),
        h(
          "div",
          { class: "small" },
          `${lookup(RADIO_LABELS, r.radio_type)}, ${lookup(ANTENNA_LABELS, r.antenna_type).toLowerCase()}, ${lookup(CONTEXT_LABELS, r.location_context).toLowerCase()}`,
        ),
        h("div", { class: "small muted" }, locate, " · sender ", r.callsign ? h("b", {}, r.callsign, " ") : null, h("span", { class: "sender" }, r.sender), " · ", sameSender),
        r.reviewed_by ? h("div", { class: "small muted" }, `${r.status} by ${r.reviewed_by}, ${formatDateTime(r.reviewed_at)}`) : null,
        commentView,
        actions,
      ),
    );
  }

  function renderList() {
    list.replaceChildren(
      ...(reports.length ? reports.map(card) : [h("p", { class: "muted" }, status === "pending" ? "Nothing waiting for review." : `No ${status} reports.`)]),
    );
    renderBulk();
  }

  function renderMarkers(fit: boolean) {
    layer.clearLayers();
    markers.clear();
    for (const r of reports) {
      const q = qualityInfo(r.quality);
      const m = L.marker([r.lat, r.lon], {
        title: `${q.label}, ${formatDateTime(r.submitted_at)}`,
        icon: L.divIcon({
          className: "",
          html: `<div class="marker-dot q${r.quality}" style="background:${BAND_COLOR[r.quality] ?? BAND_COLOR[0]}">${q.letter}</div>`,
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        }),
      });
      m.on("click", () => focusReport(r.id, false));
      layer.addLayer(m);
      markers.set(r.id, m);
    }
    if (fit && reports.length) {
      map.fitBounds(L.latLngBounds(reports.map((r) => [r.lat, r.lon] as [number, number])).pad(0.3), { maxZoom: 13 });
    }
  }

  async function load() {
    errorBox.hidden = true;
    const data = await api<{ reports: AdminReport[]; totals: Record<Status, number> }>(`/api/admin/reports?status=${status}`);
    reports = data.reports;
    totals = data.totals;
    for (const id of [...selected]) if (!reports.some((r) => r.id === id)) selected.delete(id);
    renderTabs();
    renderList();
    renderMarkers(true);
    if ($<HTMLDetailsElement>("log-details").open) void loadLog();
  }

  // ---- Overlay upload ----
  const ovRepeater = $<HTMLSelectElement>("ov-repeater");
  for (const r of reps.repeaters) ovRepeater.append(h("option", { value: r.id }, `${r.callsign} ${r.output_freq_mhz.toFixed(3)} ${r.name}`));
  $<HTMLFormElement>("overlay-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const statusEl = $("ov-status");
    const file = $<HTMLInputElement>("ov-file").files?.[0];
    const boundsFile = $<HTMLInputElement>("ov-bounds").files?.[0];
    if (!file || !boundsFile) return;
    statusEl.textContent = "Uploading…";
    try {
      const body = new FormData();
      body.set("file", file);
      body.set("bounds", await boundsFile.text());
      body.set("notes", $<HTMLTextAreaElement>("ov-notes").value);
      await api(`/api/admin/repeaters/${encodeURIComponent(ovRepeater.value)}/overlay`, { method: "POST", body });
      statusEl.textContent = "Uploaded. The map now shows the new overlay.";
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : "Upload failed.";
    }
  });

  // ---- Activity log ----
  type LogRow = { at: string; admin_email: string; action: string; report_id: string | null; repeater_id: string | null };
  async function loadLog() {
    const { log } = await api<{ log: LogRow[] }>("/api/admin/log?limit=50");
    $("log").replaceChildren(
      ...(log.length
        ? log.map((l) => h("div", {}, `${formatDateTime(l.at)}  ${l.admin_email}  ${l.action}  ${l.report_id ?? l.repeater_id ?? ""}`))
        : [h("p", { class: "muted" }, "No activity yet.")]),
    );
  }
  $<HTMLDetailsElement>("log-details").addEventListener("toggle", (e) => {
    if ((e.target as HTMLDetailsElement).open) void loadLog().catch(showError);
  });

  await load();
}

start().catch(showError);
