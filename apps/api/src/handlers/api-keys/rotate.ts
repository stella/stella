import { Result } from "better-result";
import { t } from "elysia";

import {
  disableMachineApiKey,
  loadOrganizationMachineApiKey,
  machineApiKeyAlreadyRevoked,
  machineApiKeyExpiresInDaysSchema,
  mintMachineApiKey,
  validateGrantablePermissions,
} from "@/api/handlers/api-keys/mint";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";

const rotateApiKeyBody = t.Object({
  keyId: t.String({ minLength: 1, maxLength: 128 }),
  expiresInDays: machineApiKeyExpiresInDaysSchema,
});

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "internal", reason: "provider_secret" },
  body: rotateApiKeyBody,
} satisfies HandlerConfig;

/**
 * Rotate a machine API key: mint a replacement carrying the same name, scopes,
 * and permissions, then disable the original.
 *
 * The new key is minted **before** the old one is disabled so a failed mint
 * leaves the caller with a working credential rather than none. The reverse
 * order would turn a transient failure into an outage for whatever the key
 * drives.
 *
 * The stored permissions are re-validated against the caller's *current* role,
 * not grandfathered: a rotation performed after the caller was demoted must not
 * re-issue authority they no longer hold.
 */
const rotateMachineApiKey = createSafeRootHandler(
  config,
  async function* ({
    safeDb,
    session,
    user,
    body,
    memberRole,
    recordAuditEvent,
  }) {
    const existing = yield* Result.await(
      loadOrganizationMachineApiKey({
        keyId: body.keyId,
        organizationId: session.activeOrganizationId,
      }),
    );

    // Refuse to rotate an already-revoked key. Minting off a disabled row
    // (a retried rotation, or a rotate racing a revoke) would resurrect the
    // revoked key's scopes and permissions on a fresh active credential —
    // undoing the revocation the operator just performed.
    if (!existing.enabled) {
      return Result.err(machineApiKeyAlreadyRevoked());
    }

    const validation = validateGrantablePermissions({
      memberRole,
      requested: existing.permissions,
    });

    if (validation.type === "error") {
      return Result.err(validation.error);
    }

    const minted = yield* Result.await(
      mintMachineApiKey({
        name: existing.name,
        scopes: existing.scopes,
        permissions: existing.permissions,
        expiresInDays: body.expiresInDays,
        userId: user.id,
        organizationId: session.activeOrganizationId,
      }),
    );

    yield* Result.await(
      disableMachineApiKey({
        keyId: existing.id,
        ownerUserId: existing.ownerUserId,
      }),
    );

    yield* Result.await(
      safeDb(async (tx) => {
        await recordAuditEvent(tx, [
          {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.MACHINE_API_KEY,
            resourceId: minted.id,
            metadata: {
              name: minted.name,
              scopes: minted.scopes,
              permissions: minted.permissions,
              rotatedFrom: existing.id,
            },
          },
          {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.MACHINE_API_KEY,
            resourceId: existing.id,
            metadata: {
              name: existing.name,
              scopes: existing.scopes,
              reason: "rotated",
              rotatedTo: minted.id,
            },
          },
        ]);
      }),
    );

    return Result.ok({
      id: minted.id,
      name: minted.name,
      start: minted.start,
      key: minted.key,
      scopes: minted.scopes,
      expiresAt: minted.expiresAt,
      revokedKeyId: existing.id,
    });
  },
);

export default rotateMachineApiKey;
