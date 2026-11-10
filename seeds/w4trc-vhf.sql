-- Launch repeater: W4TRC 146.970 on Bays Mountain.
-- Safe to re-run: it never overwrites overlay fields or an edited row.
INSERT INTO repeaters
  (id, name, callsign, service, output_freq_mhz, input_freq_mhz, tone, mode,
   lat, lon, antenna_height_ft, tx_power_w, antenna_gain_dbd, active)
VALUES
  ('w4trc-vhf', 'Bays Mountain VHF', 'W4TRC', 'amateur', 146.970, 146.370, 'PL 123.0 Hz', 'FM',
   36.52673425948623, -82.58803781854375, 50, 50, NULL, 1)
ON CONFLICT (id) DO NOTHING;
