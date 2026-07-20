import { Result } from "better-result";
import { t } from "elysia";

import {
  machineApiKeyExpiresInDaysSchema,
  machineApiKeyNameSchema,
  machineApiKeyPermissionsBodySchema,
  machineApiKeyScopesSchema,
  mintMachineApiKey,
  validateGrantablePermissions,
} from "@/api/handlers/api-keys/mint";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";

const createApiKeyBody = t.Object({
  name: machineApiKeyNameSchema,
  scopes: machineApiKeyScopesSchema,
  permissions: machineApiKeyPermissionsBodySchema,
  expiresInDays: machineApiKeyExpiresInDaysSchema,
});

const config = {
  // Owner/admin only. Minting a credential that acts inside the organization is
  // an organization-configuration act, and this is the same statement the other
  // org-scoped secret endpoints (AI provider config, DeepL key) are gated on.
  permissions: { organizationSettings: ["update"] },
  // Secret material must never transit an agent surface: the response carries
  // the plaintext credential, and an agent able to mint credentials could grant
  // itself durable access outside the consent flow that granted it its own.
  mcp: { type: "internal", reason: "provider_secret" },
  body: createApiKeyBody,
} satisfies HandlerConfig;

/**
 * Mint a machine (CI / agent / CLI) API key for the caller, scoped to their
 * active organization.
 *
 * The plaintext key in the response is shown exactly once: only a SHA-256
 * digest is stored, and there is deliberately no read-back endpoint. The audit
 * record therefore holds the id, name, and scopes — never the secret or its
 * digest.
 */
const createMachineApiKey = createSafeRootHandler(
  config,
  async function* ({
    safeDb,
    session,
    user,
    body,
    memberRole,
    recordAuditEvent,
  }) {
    const validation = validateGrantablePermissions({
      memberRole,
      requested: body.permissions,
    });

    if (validation.type === "error") {
      return Result.err(validation.error);
    }

    const minted = yield* Result.await(
      mintMachineApiKey({
        name: body.name,
        scopes: [...body.scopes],
        permissions: body.permissions,
        expiresInDays: body.expiresInDays,
        // Ownership never comes from the body: the key belongs to the caller,
        // in the organization the session says they are acting in.
        userId: user.id,
        organizationId: session.activeOrganizationId,
      }),
    );

    yield* Result.await(
      safeDb(async (tx) => {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.MACHINE_API_KEY,
          resourceId: minted.id,
          metadata: {
            name: minted.name,
            scopes: minted.scopes,
            permissions: minted.permissions,
          },
        });
      }),
    );

    return Result.ok({
      id: minted.id,
      name: minted.name,
      start: minted.start,
      key: minted.key,
      scopes: minted.scopes,
      expiresAt: minted.expiresAt,
    });
  },
);

export default createMachineApiKey;
