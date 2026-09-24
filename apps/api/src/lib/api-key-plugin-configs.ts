import type { ApiKeyConfigurationOptions } from "@better-auth/api-key";

import { desktopRegistryKeyConfig } from "@/api/lib/business-registries/desktop/config";
import {
  MACHINE_API_KEY_CONFIG_ID,
  MACHINE_API_KEY_EXPIRY,
  MACHINE_API_KEY_LENGTH,
  MACHINE_API_KEY_NAME_MAX_LENGTH,
  MACHINE_API_KEY_PREFIX,
  MACHINE_API_KEY_RATE_LIMIT,
  MACHINE_API_KEY_START_LENGTH,
} from "@/api/lib/machine-api-key-config";

// Machine (CI / agent / CLI) credentials. Lifecycle runs through the org-scoped
// handlers in `handlers/api-keys/`, which is where the permission and audit-log
// requirements live; this configuration only establishes how a key is minted,
// stored, and verified.
const machineApiKeyPluginConfig = {
  configId: MACHINE_API_KEY_CONFIG_ID,
  // `referenceId` must hold a **user** id. The MCP credential path feeds it
  // straight into the same member/RLS authorization the JWT path uses, and that
  // requires a principal with a `member` row. `"organization"` would store an
  // org id there and leave nothing to authorize as.
  references: "user",
  defaultPrefix: MACHINE_API_KEY_PREFIX,
  defaultKeyLength: MACHINE_API_KEY_LENGTH,
  startingCharactersConfig: {
    shouldStore: true,
    charactersLength: MACHINE_API_KEY_START_LENGTH,
  },
  // A key nobody can identify is a key nobody revokes.
  requireName: true,
  // Match the HTTP boundary schema (defaults to 32 otherwise), so a name our
  // schema accepts is never rejected by the plugin with its own 400.
  maximumNameLength: MACHINE_API_KEY_NAME_MAX_LENGTH,
  enableMetadata: true,
  // Deliberately off. Enabling it would let any `x-api-key` header mint a mock
  // user session on *every* better-auth endpoint, turning a scoped machine
  // credential into a full interactive session outside the explicit scope
  // gating the MCP path applies. The only thing that may consume one of these
  // keys is `mcp/api-key-auth.ts`, which resolves it and then re-authorizes it
  // from scratch.
  enableSessionForAPIKeys: false,
  // Hashing stays on (the plugin stores a SHA-256 digest): `disableKeyHashing`
  // would put recoverable secrets in the table.
  rateLimit: MACHINE_API_KEY_RATE_LIMIT,
  keyExpiration: {
    defaultExpiresIn: MACHINE_API_KEY_EXPIRY.defaultSeconds,
    minExpiresIn: MACHINE_API_KEY_EXPIRY.minDays,
    maxExpiresIn: MACHINE_API_KEY_EXPIRY.maxDays,
  },
} as const satisfies ApiKeyConfigurationOptions;

/**
 * Every configuration registered on the API key plugin. The plugin
 * registration and the membership lifecycle (`lib/auth-artifacts.ts`) both read
 * this list, so a configuration cannot be registered without the lifecycle
 * deciding how a departing member's keys under it are scoped.
 */
export const API_KEY_PLUGIN_CONFIGS = [
  desktopRegistryKeyConfig,
  machineApiKeyPluginConfig,
] as const;

export type ApiKeyConfigId =
  (typeof API_KEY_PLUGIN_CONFIGS)[number]["configId"];
