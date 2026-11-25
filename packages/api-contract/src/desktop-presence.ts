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

/**
 * The version a build made from a checkout reports. Release builds stamp the
 * release tag over it; local builds report the committed value from
 * apps/desktop/src-tauri/Cargo.toml, which local-client-support.test.ts binds
 * this to. No release carries it, so it is never refused nor offered an
 * update.
 */
export const DESKTOP_WORKSPACE_VERSION = "0.0.1";

const RELEASE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;

const releaseVersionParts = (
  version: string,
): readonly [number, number, number] | undefined => {
  const match = RELEASE_VERSION_PATTERN.exec(version);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined;
};

/**
 * Whether release `version` comes before release `minimum`. Only plain
 * `X.Y.Z` releases compare; anything else (a pre-release, a build made from a
 * checkout) is never below.
 */
export const releaseVersionIsBelow = (
  version: string,
  minimum: string,
): boolean => {
  const current = releaseVersionParts(version);
  const floor = releaseVersionParts(minimum);
  if (!current || !floor) {
    return false;
  }
  for (const [index, part] of current.entries()) {
    const difference = part - (floor[index] ?? 0);
    if (difference !== 0) {
      return difference < 0;
    }
  }
  return false;
};

/**
 * The first desktop release each feature of a chat on the member's computer
 * needs. A desktop below one is offered an update when a release that has it
 * is out.
 */
export const DESKTOP_FEATURE_MINIMUM_VERSIONS = {
  /** Website approvals applied to browser steps on the member's computer. */
  browserSiteApprovals: "0.9.91",
} as const satisfies Record<string, string>;
export type DesktopFeature = keyof typeof DESKTOP_FEATURE_MINIMUM_VERSIONS;

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
