import { Result } from "better-result";
import { t } from "elysia";
import * as v from "valibot";

import { getAuth } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  MACHINE_API_KEY_CONFIG_ID,
  MACHINE_API_KEY_EXPIRY,
  MACHINE_API_KEY_GRANTABLE_SCOPES,
  machineApiKeyMetadataSchema,
  machineApiKeyPermissionsSchema,
  parseMachineApiKeyPermissions,
} from "@/api/lib/machine-api-key-config";
import type { MachineApiKeyScope } from "@/api/lib/machine-api-key-config";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";

const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * Boundary schemas shared by `create` and `rotate`. They live here rather than
 * on either endpoint so the two paths cannot drift into accepting different
 * shapes for the same credential.
 */
export const machineApiKeyNameSchema = t.String({
  minLength: 1,
  maxLength: 64,
});

/**
 * Scopes are constrained at the HTTP boundary to the grantable set, so an
 * unknown or anonymized-surface scope is a 422 before any handler code runs.
 */
export const machineApiKeyScopesSchema = t.Array(
  t.UnionEnum([...MACHINE_API_KEY_GRANTABLE_SCOPES]),
  { minItems: 1, uniqueItems: true },
);

/**
 * Deliberately an untyped record at the boundary: the resource/action names are
 * checked against the canonical `statements` map by
 * `validateGrantablePermissions`, which produces a far better error than a
 * TypeBox union of every resource would, and keeps this schema out of the
 * type-instantiation hot path.
 */
export const machineApiKeyPermissionsBodySchema = t.Record(
  t.String(),
  t.Array(t.String({ minLength: 1 }), { minItems: 1 }),
);

export const machineApiKeyExpiresInDaysSchema = t.Optional(
  t.Integer({
    minimum: MACHINE_API_KEY_EXPIRY.minDays,
    maximum: MACHINE_API_KEY_EXPIRY.maxDays,
  }),
);

/**
 * Rotate and revoke answer "not found" for a key that exists but belongs to
 * another organization. A 403 would confirm the id is real, which is exactly
 * what an attacker enumerating ids across tenants wants back.
 */
const machineApiKeyNotFound = (): HandlerError =>
  new HandlerError({ status: 404, message: "API key not found" });

type ValidatedPermissions =
  | { type: "ok" }
  | { type: "error"; error: HandlerError };

/**
 * The no-escalation gate. Two independent checks, both required:
 *
 *  1. Every requested resource/action exists in the canonical `statements` map.
 *     An unrecognized name would otherwise mint a key that *looks* scoped but
 *     actually restricts nothing.
 *  2. The requested set is a subset of what the **caller's** role can grant.
 *     Without this, any member permitted to reach these endpoints could mint a
 *     credential more powerful than themselves.
 */
export const validateGrantablePermissions = ({
  memberRole,
  requested,
}: {
  memberRole: AuthorizedMemberRole;
  requested: Record<string, string[]>;
}): ValidatedPermissions => {
  const parsed = parseMachineApiKeyPermissions(requested);

  if (parsed.type === "empty") {
    return {
      type: "error",
      error: new HandlerError({
        status: 400,
        message: "At least one permission is required",
      }),
    };
  }

  if (parsed.type === "unknown-resource") {
    return {
      type: "error",
      error: new HandlerError({
        status: 400,
        message: `Unknown permission resource: ${parsed.resource}`,
      }),
    };
  }

  if (parsed.type === "unknown-action") {
    return {
      type: "error",
      error: new HandlerError({
        status: 400,
        message: `Unknown permission action for ${parsed.resource}: ${parsed.action}`,
      }),
    };
  }

  if (!hasMemberPermission(memberRole, parsed.permissions)) {
    return {
      type: "error",
      error: new HandlerError({
        status: 403,
        message: "An API key cannot be granted more than your own role holds",
      }),
    };
  }

  return { type: "ok" };
};

type MintMachineApiKeyOptions = {
  name: string;
  scopes: MachineApiKeyScope[];
  permissions: Record<string, string[]>;
  expiresInDays: number | undefined;
  /** Always the caller (`ctx.user.id`); never a body-supplied id. */
  userId: SafeId<"user">;
  /** Always `ctx.session.activeOrganizationId`; never body-supplied. */
  organizationId: SafeId<"organization">;
};

export type MintedMachineApiKey = {
  id: string;
  name: string;
  start: string | null;
  /**
   * The plaintext credential. Returned by the plugin exactly once at creation
   * (only a SHA-256 digest is stored), so this is the only moment it can reach
   * the caller and it must never be persisted or logged.
   */
  key: string;
  scopes: MachineApiKeyScope[];
  permissions: Record<string, string[]>;
  expiresAt: Date | null;
};

/**
 * Mint a machine key.
 *
 * Called without `headers` on purpose: `permissions`, `userId`, and the rate
 * limit fields are server-only on the plugin's create endpoint and it rejects
 * them outright whenever a request or header bag is present. The ownership ids
 * are parameters rather than body fields precisely so this path cannot be
 * pointed at another user or organization.
 */
export const mintMachineApiKey = async ({
  name,
  scopes,
  permissions,
  expiresInDays,
  userId,
  organizationId,
}: MintMachineApiKeyOptions): Promise<
  Result<MintedMachineApiKey, HandlerError>
> => {
  const created = await Result.tryPromise({
    try: async () =>
      await getAuth().api.createApiKey({
        body: {
          configId: MACHINE_API_KEY_CONFIG_ID,
          name,
          userId,
          permissions,
          metadata: { organizationId, scopes },
          ...(expiresInDays === undefined
            ? {}
            : { expiresIn: expiresInDays * SECONDS_PER_DAY }),
        },
      }),
    catch: (error: unknown) => error,
  });

  if (created.isErr()) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Could not create the API key",
        cause: created.error,
      }),
    );
  }

  const apiKey = created.value;

  return Result.ok({
    id: apiKey.id,
    name,
    start: apiKey.start,
    key: apiKey.key,
    scopes,
    permissions,
    expiresAt: apiKey.expiresAt,
  });
};

export type LoadedMachineApiKey = {
  id: string;
  name: string;
  scopes: MachineApiKeyScope[];
  permissions: Record<string, string[]>;
  enabled: boolean;
};

/**
 * Load one machine key and prove it belongs to the caller's organization.
 *
 * Two layers of scoping, both necessary:
 *  - the plugin's own `get` runs under the session and 404s a key whose
 *    `referenceId` is not the caller, and
 *  - the organization id in the key's server-written metadata must match the
 *    caller's active organization. The plugin has no notion of our orgs, so
 *    without this second check a user who belongs to two organizations could
 *    manage one organization's keys while acting in the other.
 */
export const loadOrganizationMachineApiKey = async ({
  keyId,
  organizationId,
  headers,
}: {
  keyId: string;
  organizationId: SafeId<"organization">;
  headers: Headers;
}): Promise<Result<LoadedMachineApiKey, HandlerError>> => {
  const found = await Result.tryPromise({
    try: async () =>
      await getAuth().api.getApiKey({
        query: { configId: MACHINE_API_KEY_CONFIG_ID, id: keyId },
        headers,
      }),
    catch: (error: unknown) => error,
  });

  if (found.isErr()) {
    return Result.err(machineApiKeyNotFound());
  }

  const apiKey = found.value;

  const metadata = v.safeParse(machineApiKeyMetadataSchema, apiKey.metadata);
  if (!metadata.success || metadata.output.organizationId !== organizationId) {
    return Result.err(machineApiKeyNotFound());
  }

  const permissions = v.safeParse(
    machineApiKeyPermissionsSchema,
    apiKey.permissions,
  );
  if (!permissions.success) {
    return Result.err(machineApiKeyNotFound());
  }

  // `requireName` is on for this configuration, so a null name means the row
  // was written by something other than these handlers. Treat it as absent
  // rather than inventing a placeholder a rotation would then propagate.
  const { name } = apiKey;
  if (name === null) {
    return Result.err(machineApiKeyNotFound());
  }

  return Result.ok({
    id: apiKey.id,
    name,
    scopes: metadata.output.scopes,
    permissions: permissions.output,
    enabled: apiKey.enabled,
  });
};

/**
 * Disable a key. Revocation is never a delete: the row carries the audit trail
 * and the `start` prefix operators use to recognize a leaked credential, and
 * `mcp/api-key-auth.ts` already refuses a disabled key.
 */
export const disableMachineApiKey = async ({
  keyId,
  headers,
}: {
  keyId: string;
  headers: Headers;
}): Promise<Result<void, HandlerError>> => {
  const updated = await Result.tryPromise({
    try: async () =>
      await getAuth().api.updateApiKey({
        body: {
          configId: MACHINE_API_KEY_CONFIG_ID,
          keyId,
          enabled: false,
        },
        headers,
      }),
    catch: (error: unknown) => error,
  });

  if (updated.isErr()) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Could not revoke the API key",
        cause: updated.error,
      }),
    );
  }

  return Result.ok(undefined);
};
