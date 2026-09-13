import * as v from "valibot";

import { DESKTOP_ACCOUNT_POLICY } from "@stll/api-contract/desktop-registry";
import type { PermissionInput } from "@stll/permissions";

export const DESKTOP_REGISTRY_KEY_CONFIG = "desktop-registry";
export const DESKTOP_REGISTRY_KEY_PREFIX = DESKTOP_ACCOUNT_POLICY.keyPrefix;
// A revocable seven-day account link replaces the hourly registry prototype.
export const DESKTOP_REGISTRY_KEY_SECONDS =
  DESKTOP_ACCOUNT_POLICY.credentialLifetimeSeconds;
export const DESKTOP_REGISTRY_PERMISSION = {
  workspace: ["read"],
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
