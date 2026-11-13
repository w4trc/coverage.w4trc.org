import { z } from "zod";
import { ANTENNA_TYPES, COMMENT_MAX, LOCATION_CONTEXTS, RADIO_TYPES } from "../../shared/constants";

/** Strip control characters; text is stored raw and escaped on output. */
const cleanText = (s: string) => s.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").trim();

const comment = z
  .string()
  .max(COMMENT_MAX * 2)
  .transform(cleanText)
  .refine((s) => s.length <= COMMENT_MAX, `Comment must be ${COMMENT_MAX} characters or fewer`)
  .transform((s) => (s === "" ? null : s));

/** Optional amateur callsign: letters and digits with an optional /suffix, stored upper case. */
const reporterCallsign = z
  .string()
  .max(40)
  .transform((s) => cleanText(s).toUpperCase())
  .refine((s) => s === "" || /^[A-Z0-9]{3,8}(\/[A-Z0-9]{1,4})?$/.test(s), "Callsign doesn't look right")
  .transform((s) => (s === "" ? null : s));

export const ReportInput = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  quality: z.number().int().min(0).max(3),
  radio_type: z.enum(RADIO_TYPES),
  antenna_type: z.enum(ANTENNA_TYPES),
  location_context: z.enum(LOCATION_CONTEXTS),
  comment: comment.nullish().transform((v) => v ?? null),
  callsign: reporterCallsign.nullish().transform((v) => v ?? null),
  turnstile_token: z.string().min(1).max(4096),
});

export const ReportPatch = z
  .object({
    status: z.enum(["pending", "approved", "rejected"]).optional(),
    comment: comment.nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.comment !== undefined, "Nothing to change");

export const BulkAction = z.object({
  ids: z.array(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/)).min(1).max(200),
  action: z.enum(["approve", "reject", "delete"]),
});

const bounds = z
  .tuple([z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]), z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)])])
  .refine(([sw, ne]) => sw[0] < ne[0] && sw[1] < ne[1], "Bounds must be [[south, west],[north, east]]");

export const OverlayBounds = bounds;

const repeaterFields = {
  name: z.string().trim().min(1).max(100),
  callsign: z.string().trim().min(3).max(12).transform((s) => s.toUpperCase()),
  service: z.string().trim().min(1).max(40).default("amateur"),
  output_freq_mhz: z.number().positive().max(100000),
  input_freq_mhz: z.number().positive().max(100000).nullable().default(null),
  tone: z.string().trim().max(40).nullable().default(null),
  mode: z.string().trim().max(40).nullable().default(null),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  antenna_height_ft: z.number().min(0).max(3000).nullable().default(null),
  tx_power_w: z.number().min(0).max(5000).nullable().default(null),
  antenna_gain_dbd: z.number().min(-20).max(40).nullable().default(null),
  overlay_notes: z.string().trim().max(500).nullable().default(null),
  active: z.boolean().default(true),
};

export const RepeaterCreate = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, "Use lowercase letters, digits and dashes"),
  ...repeaterFields,
});

/** PUT replaces the editable fields; overlay columns are managed by the overlay endpoint. */
export const RepeaterUpdate = z.object(repeaterFields);

export function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
}
