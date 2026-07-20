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
import { findOrganizationMachineApiKey } from "@/api/lib/machine-api-key-queries";
import type { MachineApiKeyRow } from "@/api/lib/machine-api-key-queries";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";

const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * Deserialize one of the plugin's JSON text columns. Returns `null` on
 * malformed JSON so the valibot parse downstream reports it the same way it
 * reports a wrong shape, rather than this throwing mid-request.
 */
const parseJsonColumn = (value: string | null): unknown => {
  if (value === null) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

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
  /**
   * The member who minted the key. Lifecycle is organization-scoped, so this is
   * frequently somebody other than the caller; the plugin's update endpoint
   * still wants it (see `disableMachineApiKey`).
   */
  ownerUserId: string;
};

/**
 * Load one machine key from the caller's organization.
 *
 * Scoping is organization-wide, not caller-wide: an admin must be able to reach
 * a key a colleague minted, otherwise a departing employee's credential can
 * never be revoked. `findOrganizationMachineApiKey` applies the organization
 * predicate in SQL — see the header comment in `machine-api-key-queries.ts`
 * for why that is the tenant boundary here and why it cannot move into JS.
 *
 * Every failure returns the same 404 so probing ids cannot distinguish a key in
 * another organization from one that does not exist.
 */
export const loadOrganizationMachineApiKey = async ({
  keyId,
  organizationId,
}: {
  keyId: string;
  organizationId: SafeId<"organization">;
}): Promise<Result<LoadedMachineApiKey, HandlerError>> => {
  const found = await Result.tryPromise({
    try: async () =>
      await findOrganizationMachineApiKey({ keyId, organizationId }),
    catch: (error: unknown) => error,
  });

  if (found.isErr()) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Could not load the API key",
        cause: found.error,
      }),
    );
  }

  const apiKey = found.value;
  if (apiKey === null) {
    return Result.err(machineApiKeyNotFound());
  }

  const summary = toMachineApiKeySummary(apiKey);
  if (summary === null) {
    return Result.err(machineApiKeyNotFound());
  }

  return Result.ok(summary);
};

/**
 * Parse the stored JSON columns of one row into the shape handlers work with,
 * or `null` when the row was not written by these handlers (unparseable
 * metadata or permissions, or a missing name — `requireName` is on for this
 * configuration). Shared by the single-key load and the list so both describe a
 * key the same way, and so neither renders a key it cannot describe accurately.
 */
export const toMachineApiKeySummary = (
  row: MachineApiKeyRow,
): LoadedMachineApiKey | null => {
  // `metadata` and `permissions` arrive as raw JSON **text**. The plugin's own
  // read endpoints deserialize them on the way out; these rows come straight
  // from the table (see `machine-api-key-queries.ts` for why the plugin's
  // reads are bypassed), so the parse has to happen here. Reading them as
  // objects would make every key look undescribable and silently empty the
  // list.
  const metadata = v.safeParse(
    machineApiKeyMetadataSchema,
    parseJsonColumn(row.metadata),
  );
  if (!metadata.success) {
    return null;
  }

  const permissions = v.safeParse(
    machineApiKeyPermissionsSchema,
    parseJsonColumn(row.permissions),
  );
  if (!permissions.success) {
    return null;
  }

  const { name } = row;
  if (name === null) {
    return null;
  }

  return {
    enabled: row.enabled,
    id: row.id,
    name,
    ownerUserId: row.referenceId,
    permissions: permissions.output,
    scopes: metadata.output.scopes,
  };
};

/**
 * Disable a key. Revocation is never a delete: the row carries the audit trail
 * and the `start` prefix operators use to recognize a leaked credential, and
 * `mcp/api-key-auth.ts` already refuses a disabled key.
 *
 * Called with **no headers** and an explicit `userId`. That is the plugin's
 * documented server-side path: with no request or headers present it takes the
 * principal from `body.userId` instead of a session, and then enforces
 * `referenceId === userId`. Passing the key's real owner satisfies that check
 * while leaving authorization to this codebase — the caller has already been
 * gated on the `organizationSettings` permission and the key has already been
 * proven to belong to their organization by a SQL predicate. Passing the
 * caller's headers instead would re-impose the plugin's caller-scoping and make
 * a colleague's key unrevokable.
 */
export const disableMachineApiKey = async ({
  keyId,
  ownerUserId,
}: {
  keyId: string;
  ownerUserId: string;
}): Promise<Result<void, HandlerError>> => {
  const updated = await Result.tryPromise({
    try: async () =>
      await getAuth().api.updateApiKey({
        body: {
          configId: MACHINE_API_KEY_CONFIG_ID,
          keyId,
          enabled: false,
          userId: ownerUserId,
        },
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
