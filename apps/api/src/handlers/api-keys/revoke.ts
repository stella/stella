import { Result } from "better-result";
import { t } from "elysia";

import {
  disableMachineApiKey,
  loadOrganizationMachineApiKey,
} from "@/api/handlers/api-keys/mint";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";

const revokeApiKeyBody = t.Object({
  keyId: t.String({ minLength: 1, maxLength: 128 }),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "internal", reason: "provider_secret" },
  body: revokeApiKeyBody,
} satisfies HandlerConfig;

/**
 * Revoke a machine API key by disabling it.
 *
 * The row is kept: it carries the audit trail and the `start` prefix an
 * operator needs to match a leaked credential back to the key that leaked, and
 * a deleted row would take both with it. `mcp/api-key-auth.ts` rejects a
 * disabled key, so this takes effect on the next request the credential makes.
 */
const revokeMachineApiKey = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body, request, recordAuditEvent }) {
    const existing = yield* Result.await(
      loadOrganizationMachineApiKey({
        keyId: body.keyId,
        organizationId: session.activeOrganizationId,
        headers: request.headers,
      }),
    );

    // Idempotent: revoking an already-revoked key is a no-op rather than an
    // error, so a retried request cannot fail, and it records no second audit
    // row claiming a revocation that did not happen.
    if (!existing.enabled) {
      return Result.ok({ id: existing.id, revoked: true });
    }

    yield* Result.await(
      disableMachineApiKey({ keyId: existing.id, headers: request.headers }),
    );

    yield* Result.await(
      safeDb(async (tx) => {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.MACHINE_API_KEY,
          resourceId: existing.id,
          metadata: {
            name: existing.name,
            scopes: existing.scopes,
            reason: "revoked",
          },
        });
      }),
    );

    return Result.ok({ id: existing.id, revoked: true });
  },
);

export default revokeMachineApiKey;
