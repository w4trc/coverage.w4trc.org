-- Repeater coverage map: initial schema (spec section 4).

CREATE TABLE repeaters (
  id                 TEXT PRIMARY KEY,           -- slug, e.g. w4trc-vhf
  name               TEXT NOT NULL,
  callsign           TEXT NOT NULL,
  service            TEXT NOT NULL DEFAULT 'amateur',
  output_freq_mhz    REAL NOT NULL,
  input_freq_mhz     REAL,
  tone               TEXT,                       -- CTCSS / DCS / none
  mode               TEXT,                       -- FM, DMR, D-STAR, ...
  lat                REAL NOT NULL,
  lon                REAL NOT NULL,
  antenna_height_ft  REAL,                       -- above ground level
  tx_power_w         REAL,
  antenna_gain_dbd   REAL,
  overlay_key        TEXT,                       -- R2 key of current prediction image
  overlay_bounds     TEXT,                       -- JSON [[south, west],[north, east]]
  overlay_updated_at TEXT,                       -- ISO timestamp
  overlay_notes      TEXT,                       -- model assumptions shown in the panel
  active             INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE reports (
  id               TEXT PRIMARY KEY,             -- ULID
  repeater_id      TEXT NOT NULL REFERENCES repeaters(id),
  lat              REAL NOT NULL,                -- rounded to 4 decimals before storage
  lon              REAL NOT NULL,
  h3_r8            TEXT NOT NULL,
  h3_r7            TEXT NOT NULL,
  h3_r6            TEXT NOT NULL,
  quality          INTEGER NOT NULL CHECK (quality BETWEEN 0 AND 3),
  radio_type       TEXT NOT NULL,
  antenna_type     TEXT NOT NULL,
  location_context TEXT NOT NULL,
  comment          TEXT,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  submitted_at     TEXT NOT NULL,
  reviewed_at      TEXT,
  reviewed_by      TEXT,
  ip_hash          TEXT NOT NULL                 -- salted hash, never the raw IP
);

CREATE INDEX idx_reports_repeater_status ON reports (repeater_id, status);
CREATE INDEX idx_reports_repeater_r8 ON reports (repeater_id, h3_r8);
CREATE INDEX idx_reports_repeater_r7 ON reports (repeater_id, h3_r7);
CREATE INDEX idx_reports_repeater_r6 ON reports (repeater_id, h3_r6);
CREATE INDEX idx_reports_ip_time ON reports (ip_hash, submitted_at);

CREATE TABLE admin_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  admin_email TEXT NOT NULL,
  action      TEXT NOT NULL,                     -- approve, reject, delete, edit, repeater.create, ...
  report_id   TEXT,
  repeater_id TEXT,
  detail      TEXT                               -- JSON
);

CREATE INDEX idx_admin_log_at ON admin_log (at);
