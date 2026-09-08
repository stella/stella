import * as v from "valibot";

export const DESKTOP_REGISTRY_KEY_CONFIG = "desktop-registry";
export const DESKTOP_REGISTRY_KEY_PREFIX = "stella_dr_";
// The prototype requires a fresh, explicit connection after one hour.
export const DESKTOP_REGISTRY_KEY_SECONDS = 60 * 60;
export const DESKTOP_REGISTRY_PERMISSION = { workspace: ["read"] } as const;
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

