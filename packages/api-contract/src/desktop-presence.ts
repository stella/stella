import * as v from "valibot";

import policy from "./desktop-presence-policy.json";

export const DESKTOP_PRESENCE_POLICY = policy;

const desktopVersionSchema = v.pipe(
  v.string(),
  v.maxLength(64),
  v.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u),
);
const desktopProtocolSchema = v.pipe(
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

const desktopSchema = v.strictObject({
  version: desktopVersionSchema,
  protocol: desktopProtocolSchema,
  lastSeenAt: v.pipe(v.string(), v.maxLength(32), v.isoTimestamp()),
});

export const desktopPresenceSchema = v.variant("type", [
  v.strictObject({ type: v.literal("current"), desktop: desktopSchema }),
  v.strictObject({ type: v.literal("outdated"), desktop: desktopSchema }),
  v.strictObject({ type: v.literal("not_connected"), desktop: desktopSchema }),
  v.strictObject({ type: v.literal("none") }),
]);
export type DesktopPresence = v.InferOutput<typeof desktopPresenceSchema>;
