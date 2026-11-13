-- Optional callsign of the person sending a report. Shown to admins only.
ALTER TABLE reports ADD COLUMN callsign TEXT;
