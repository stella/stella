import * as v from "valibot";

import { statements } from "@stll/permissions";
import type { PermissionInput } from "@stll/permissions";

import { MCP_DEFAULT_RESOURCE_SCOPES } from "@/api/mcp/constants";

/**
 * `statements` widened to an index signature. This is an ordinary assignment
 * rather than a cast: it lets an arbitrary string key be looked up (yielding
 * `undefined` for unknown resources) without asserting anything the compiler
 * cannot already check.
 */
const STATEMENT_ACTIONS: Record<string, readonly string[]> = statements;

/**
 * Shared, dependency-light configuration for machine (CI/agent/CLI) API keys.
 *
 * This module deliberately imports neither `lib/auth.ts` nor the database: both
 * the auth plugin registration and the MCP credential path need these constants,
 * and routing them through a leaf module keeps that from becoming an import
 * cycle.
 */

/**
 * `configId` for the machine-key configuration registered on the API key plugin.
 * Every lifecycle call must pass it — the plugin scopes `get`/`update`/`delete`
 * by `configId`, so a key minted under this configuration cannot be manipulated
 * through a differently-configured endpoint.
 */
export const MACHINE_API_KEY_CONFIG_ID = "machine";

/**
 * Credential prefix. This is the discriminator the MCP transport uses to tell a
 * machine key from a JWT bearer token (a JWT is three base64url segments and can
 * never begin with this), and it is what makes leaked keys greppable in logs and
 * secret scanners.
 */
export const MACHINE_API_KEY_PREFIX = "stella_mk_";

/** Random bytes (pre-prefix) in a generated key. */
export const MACHINE_API_KEY_LENGTH = 64;

/**
 * Characters of the key stored in plaintext so the UI/CLI can identify a key it
 * can never show again. Covers the prefix plus a short discriminating tail.
 */
export const MACHINE_API_KEY_START_LENGTH = MACHINE_API_KEY_PREFIX.length + 6;

/**
 * Per-key request budget. Machine callers are batchy by nature, so this is well
 * above the interactive auth limits (`AUTH_RATE_LIMITS.signIn` etc., which guard
 * brute-forcing a human secret) while still bounding a runaway or stolen key.
 * The window is milliseconds — the plugin's unit, not the seconds used by
 * better-auth's own rate limiter.
 */
export const MACHINE_API_KEY_RATE_LIMIT = {
  enabled: true,
  timeWindow: 60_000,
  maxRequests: 600,
} as const;

/**
 * Lifetime bounds. A machine credential with no expiry is a credential nobody
 * ever rotates, so an expiry is always set and capped.
 *
 * The units are the plugin's, and they are not consistent — the suffixes here
 * are load-bearing, do not "tidy" them into one unit:
 *  - `keyExpiration.defaultExpiresIn` is **seconds**. The plugin's own type
 *    comment claims milliseconds, but the implementation feeds it to
 *    `getDate(value, "sec")` on the same line as the client-supplied value, so
 *    the comment is wrong and seconds is what actually applies.
 *  - `keyExpiration.minExpiresIn` / `maxExpiresIn` are **days**; the plugin
 *    divides the client's seconds by 86400 before comparing.
 *  - `createApiKey`'s `expiresIn` body field is **seconds**.
 */
export const MACHINE_API_KEY_EXPIRY = {
  defaultSeconds: 90 * 24 * 60 * 60,
  minDays: 1,
  maxDays: 365,
} as const;

/**
 * Scopes a machine key may carry. Anonymized-resource scopes are deliberately
 * excluded: they exist for a different consent surface and are not something an
 * org admin grants to a headless caller here.
 */
export const MACHINE_API_KEY_GRANTABLE_SCOPES = MCP_DEFAULT_RESOURCE_SCOPES;

export type MachineApiKeyScope =
  (typeof MACHINE_API_KEY_GRANTABLE_SCOPES)[number];

const machineApiKeyScopeSchema = v.picklist(MACHINE_API_KEY_GRANTABLE_SCOPES);

/**
 * What travels in the plugin's `metadata` column.
 *
 * The organization id lives here rather than in `referenceId` because the plugin
 * stores exactly one owner id, and that slot has to hold the **user** id: a
 * machine key resolves to a real principal that holds a `member` row and thus an
 * RLS identity (see `mcp/api-key-auth.ts`). Configuring the plugin with
 * `references: "organization"` would put the org id there instead and leave no
 * user to authorize against.
 *
 * `strictObject` because this is parsed back out of a text column: unknown keys
 * mean the row was written by something other than the current code path, and
 * silently stripping them would hide that.
 */
export const machineApiKeyMetadataSchema = v.strictObject({
  organizationId: v.pipe(v.string(), v.nonEmpty()),
  scopes: v.array(machineApiKeyScopeSchema),
});

export type MachineApiKeyMetadata = v.InferOutput<
  typeof machineApiKeyMetadataSchema
>;

/**
 * Permission sets a machine key may carry, parsed back out of the plugin's
 * `permissions` column. The plugin stores an untyped `Record<string, string[]>`;
 * callers re-check the parsed value against the owner's *current* role before
 * trusting it, so this only has to establish the shape.
 */
export const machineApiKeyPermissionsSchema = v.record(
  v.string(),
  v.array(v.string()),
);

export type MachineApiKeyPermissionsParse =
  | { type: "valid"; permissions: PermissionInput }
  | { type: "empty" }
  | { type: "unknown-resource"; resource: string }
  | { type: "unknown-action"; resource: string; action: string };

/**
 * Validate a permission record against the canonical `statements` map and narrow
 * it to what the permission system accepts.
 *
 * Every resource and action is checked against `statements` rather than being
 * passed through on the assumption that `authorize()` will reject what it does
 * not recognize. An unrecognized name is far more likely to be a typo or a
 * renamed resource than an attack, and silently letting it ride would make a key
 * that *looks* scoped to something actually be scoped to nothing — a permission
 * set that quietly stops restricting is the failure mode worth failing loudly on.
 */
export const parseMachineApiKeyPermissions = (
  permissions: Record<string, string[]>,
): MachineApiKeyPermissionsParse => {
  const entries = Object.entries(permissions);
  if (entries.length === 0) {
    return { type: "empty" };
  }

  for (const [resource, actions] of entries) {
    const known = STATEMENT_ACTIONS[resource];
    if (!known) {
      return { type: "unknown-resource", resource };
    }
    const unknownAction = actions.find((action) => !known.includes(action));
    if (unknownAction !== undefined) {
      return { type: "unknown-action", resource, action: unknownAction };
    }
  }

  return {
    // SAFETY: every key is a `statements` resource and every action is one of
    // that resource's declared actions (checked immediately above), so the only
    // gap against `PermissionInput` is its `RequireAtLeastOne` constraint, which
    // the `entries.length === 0` guard establishes and which no runtime narrowing
    // can express.
    permissions: permissions as PermissionInput,
    type: "valid",
  };
};

/**
 * Does this credential claim to be a machine key? Purely a shape test on the
 * prefix — it asserts nothing about validity, which only `verifyApiKey` decides.
 */
export const isMachineApiKeyCredential = (credential: string): boolean =>
  credential.startsWith(MACHINE_API_KEY_PREFIX);
