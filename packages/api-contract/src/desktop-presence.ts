import * as v from "valibot";

import { API_STORABLE_INSTANT_CHECK } from "./api-date";
import policy from "./desktop-presence-policy.json";

export const DESKTOP_PRESENCE_POLICY = policy;

export const desktopVersionSchema = v.pipe(
  v.string(),
  v.maxLength(64),
  v.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u),
);
export const desktopProtocolSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(2_147_483_647),
);

export const desktopPresenceReportSchema = v.strictObject({
  desktopId: v.pipe(v.string(), v.uuid()),
  version: desktopVersionSchema,
  protocol: desktopProtocolSchema,
});
export type DesktopPresenceReport = v.InferOutput<
  typeof desktopPresenceReportSchema
>;

/**
 * The answer to a presence report. `latestVersion` is the newest desktop
 * release the API read from the desktop's own updater feed, or null when it
 * could not: a desktop older than it runs its normal, signature-verified
 * update check at once instead of at its next scheduled one.
 */
export const desktopPresenceReportResponseSchema = v.strictObject({
  reported: v.boolean(),
  latestVersion: v.nullable(desktopVersionSchema),
});
export type DesktopPresenceReportResponse = v.InferOutput<
  typeof desktopPresenceReportResponseSchema
>;

const desktopSchema = v.strictObject({
  version: desktopVersionSchema,
  protocol: desktopProtocolSchema,
  lastSeenAt: v.pipe(
    v.string(),
    v.maxLength(32),
    v.isoTimestamp(),
    API_STORABLE_INSTANT_CHECK,
  ),
});

export const desktopPresenceSchema = v.variant("type", [
  v.strictObject({ type: v.literal("current"), desktop: desktopSchema }),
  v.strictObject({ type: v.literal("outdated"), desktop: desktopSchema }),
  v.strictObject({ type: v.literal("not_connected"), desktop: desktopSchema }),
  v.strictObject({ type: v.literal("none") }),
]);
export type DesktopPresence = v.InferOutput<typeof desktopPresenceSchema>;
