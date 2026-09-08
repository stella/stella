import { panic, Result } from "better-result";
import { t } from "elysia";

import {
  DESKTOP_REGISTRY_KEY_CONFIG,
  DESKTOP_REGISTRY_KEY_SECONDS,
  DESKTOP_REGISTRY_PERMISSION,
} from "@/api/handlers/desktop-registry/config";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { getAuth } from "@/api/lib/auth";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export default createSafeRootHandler(
  {
    permissions: DESKTOP_REGISTRY_PERMISSION,
    mcp: { type: "internal", reason: "provider_secret" },
    body: t.Object({}, { additionalProperties: false }),
  },
  async function* ({ user, session, safeDb, recordAuditEvent, set }) {
    set.headers["cache-control"] = "no-store";
    const minted = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await getAuth().api.createApiKey({
            body: {
              configId: DESKTOP_REGISTRY_KEY_CONFIG,
              name: "Desktop registry search",
              userId: user.id,
              expiresIn: DESKTOP_REGISTRY_KEY_SECONDS,
              metadata: {
                purpose: DESKTOP_REGISTRY_KEY_CONFIG,
                organizationId: session.activeOrganizationId,
              },
            },
          }),
        catch: () =>
          new HandlerError({
            status: 503,
            message: "Could not connect registry search",
          }),
      }),
    );
    const audited = await safeDb(
      async (tx) =>
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.MACHINE_API_KEY,
          resourceId: minted.id,
          metadata: { purpose: DESKTOP_REGISTRY_KEY_CONFIG },
        }),
    );
    if (audited.isErr()) {
      // Never hand out an unaudited credential; invalidate the plugin-created row.
      yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await getAuth().api.updateApiKey({
              body: {
                configId: DESKTOP_REGISTRY_KEY_CONFIG,
                keyId: minted.id,
                userId: user.id,
                enabled: false,
              },
            }),
          catch: () =>
            new HandlerError({
              status: 503,
              message: "Registry connection cleanup failed",
            }),
        }),
      );
      return Result.err(audited.error);
    }
    if (!minted.expiresAt) {
      panic("Registry grant was minted without an expiry");
    }
    return Result.ok({
      key: minted.key,
      expiresAt: minted.expiresAt.toISOString(),
    });
  },
);

