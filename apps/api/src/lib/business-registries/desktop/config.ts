import * as v from "valibot";

import { DESKTOP_ACCOUNT_POLICY } from "@stll/api-contract/desktop-registry";
import type { PermissionInput } from "@stll/permissions";

export const DESKTOP_REGISTRY_KEY_CONFIG = "desktop-registry";
export const DESKTOP_REGISTRY_KEY_PREFIX = DESKTOP_ACCOUNT_POLICY.keyPrefix;
// A revocable seven-day account link replaces the hourly registry prototype.
export const DESKTOP_REGISTRY_KEY_SECONDS =
  DESKTOP_ACCOUNT_POLICY.credentialLifetimeSeconds;
/**
 * The desktop search key is the member's own integration: the same grant
 * gates minting one and every later request the key carries, so a member who
 * may no longer hold the integration cannot keep using a key they already
 * have.
 */
export const DESKTOP_REGISTRY_PERMISSION = {
  integration: ["create"],
} satisfies PermissionInput;
export const desktopRegistryMetadata = v.strictObject({
  purpose: v.literal(DESKTOP_REGISTRY_KEY_CONFIG),
  organizationId: v.pipe(v.string(), v.nonEmpty()),
});

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
    defaultExpiresIn: DESKTOP_REGISTRY_KEY_SECONDS,
    minExpiresIn: DESKTOP_REGISTRY_KEY_SECONDS / 86_400,
    maxExpiresIn: DESKTOP_REGISTRY_KEY_SECONDS / 86_400,
  },
} as const;
