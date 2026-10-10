import { Result } from "better-result";
import * as v from "valibot";

import { DESKTOP_ACCOUNT_POLICY } from "@stll/api-contract/desktop-registry";
import type { PermissionInput } from "@stll/permissions";
import { Temporal } from "@stll/time";

export const DESKTOP_REGISTRY_KEY_CONFIG = "desktop-registry";
export const DESKTOP_REGISTRY_KEY_PREFIX = DESKTOP_ACCOUNT_POLICY.keyPrefix;
// Foreground use rotates the credential and renews its inactivity deadline.
export const DESKTOP_REGISTRY_KEY_SECONDS =
  DESKTOP_ACCOUNT_POLICY.credentialLifetimeSeconds;
// A generation younger than this answers 429 instead of rotating again.
export const DESKTOP_REGISTRY_ROTATION_INTERVAL_SECONDS =
  DESKTOP_ACCOUNT_POLICY.rotationIntervalSeconds;
export const DESKTOP_ACCOUNT_PERMISSION = {
  workspace: ["read"],
} satisfies PermissionInput;

/**
 * The desktop search key is the member's own integration: the same grant
 * gates minting one and every later request the key carries, so a member who
 * may no longer hold the integration cannot keep using a key they already
 * have.
 */
export const DESKTOP_REGISTRY_PERMISSION = {
  integration: ["create"],
} satisfies PermissionInput;
const desktopRegistryMetadata = v.strictObject({
  purpose: v.literal(DESKTOP_REGISTRY_KEY_CONFIG),
  organizationId: v.pipe(v.string(), v.nonEmpty()),
  deviceJkt: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/u)),
  inactivityExpiresAt: v.union([
    v.pipe(
      v.string(),
      v.isoTimestamp(),
      v.check((value) => Result.try(() => Temporal.Instant.from(value)).isOk()),
    ),
    // verifyApiKey decodes metadata with better-auth's JSON reviver, which
    // turns the stored ISO timestamp into a Date. Normalize it to the stored
    // string form; v.date() rejects an invalid Date.
    v.pipe(
      v.date(),
      v.transform((value) => value.toISOString()),
    ),
  ]),
});

export const parseDesktopRegistryMetadata = (metadata: unknown) => {
  const decoded =
    typeof metadata === "string"
      ? Result.try((): unknown => JSON.parse(metadata)).unwrapOr(null)
      : metadata;
  return v.safeParse(desktopRegistryMetadata, decoded);
};

export const desktopRegistryKeyConfig = {
  configId: DESKTOP_REGISTRY_KEY_CONFIG,
  references: "user",
  defaultPrefix: DESKTOP_REGISTRY_KEY_PREFIX,
  defaultKeyLength: 64,
  requireName: true,
  enableMetadata: true,
  enableSessionForAPIKeys: false,
  rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 60 },
  keyExpiration: {
    defaultExpiresIn: null,
    minExpiresIn: DESKTOP_REGISTRY_KEY_SECONDS / 86_400,
    maxExpiresIn: DESKTOP_REGISTRY_KEY_SECONDS / 86_400,
  },
} as const;
