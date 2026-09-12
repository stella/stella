import { panic, Result } from "better-result";
import { t } from "elysia";

import { Temporal } from "@stll/time";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { getAuth } from "@/api/lib/auth";
import {
  DESKTOP_REGISTRY_KEY_CONFIG,
  DESKTOP_REGISTRY_KEY_SECONDS,
  DESKTOP_REGISTRY_PERMISSION,
} from "@/api/lib/business-registries/desktop/config";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

export default createSafeRootHandler(
  {
    permissions: DESKTOP_REGISTRY_PERMISSION,
    mcp: { type: "internal", reason: "provider_secret" },
    body: t.Object({}, { additionalProperties: false }),
  },
  async function* ({ user, session, safeDb, recordAuditEvent, set }) {
    set.headers["cache-control"] = "no-store";
    const account = yield* Result.await(
      safeDb((tx) =>
        tx.query.user.findFirst({
          where: { id: { eq: user.id } },
          columns: { email: true, name: true },
        }),
      ),
    );
    if (!account) {
      return Result.err(
        new HandlerError({
          status: 401,
          message: "Desktop account is unavailable",
        }),
      );
    }
    const minted = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await getAuth().api.createApiKey({
            body: {
              configId: DESKTOP_REGISTRY_KEY_CONFIG,
              name: "Desktop account",
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
      account: {
        email: account.email,
        name: account.name,
        verifiedAt: Temporal.Now.instant().toString(),
      },
      key: minted.key,
      expiresAt: minted.expiresAt.toISOString(),
    });
  },
);
