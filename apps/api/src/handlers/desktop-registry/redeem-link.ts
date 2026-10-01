import { panic, Result } from "better-result";

import { Temporal } from "@stll/time";

import { safeDbFromScoped } from "@/api/db/safe-db";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditRecorder,
} from "@/api/lib/audit-log";
import { getAuth } from "@/api/lib/auth";
import { authorizeDesktopRegistry } from "@/api/lib/business-registries/desktop/auth";
import {
  DESKTOP_REGISTRY_KEY_CONFIG,
  DESKTOP_REGISTRY_KEY_SECONDS,
} from "@/api/lib/business-registries/desktop/config";
import { authorizeDesktopLinkGrant } from "@/api/lib/business-registries/desktop/link-grants";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { permissiveBodySchema } from "@/api/lib/permissive-route-schema";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";

export default createSafeTokenHandler(
  {
    mcp: { type: "internal", reason: "provider_secret" },
    body: permissiveBodySchema({
      keys: [
        "correlationId",
        "verifier",
        "expectedUserId",
        "expectedOrganizationId",
      ],
    }),
  },
  async function* ({ body, request, set }) {
    set.headers[CACHE_CONTROL_HEADER] = PRIVATE_CACHE_CONTROL;
    const identity = yield* Result.await(authorizeDesktopLinkGrant(body));
    if (request.headers.has("authorization")) {
      const linked = yield* Result.await(authorizeDesktopRegistry(request));
      if (
        linked.userId !== identity.userId ||
        linked.organizationId !== identity.organizationId
      ) {
        return Result.err(
          new HandlerError({
            status: 401,
            message: "Desktop account is unavailable",
          }),
        );
      }
      return Result.ok({
        status: "connected" as const,
        identity: {
          userId: identity.userId,
          organizationId: identity.organizationId,
        },
      });
    }
    const safeDb = safeDbFromScoped(identity.scopedDb);
    const recordAuditEvent = createAuditRecorder({
      userId: identity.userId,
      organizationId: identity.organizationId,
      workspaceId: null,
      request,
      server: null,
    });
    const account = yield* Result.await(
      safeDb((tx) =>
        tx.query.user.findFirst({
          where: { id: { eq: identity.userId } },
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
              userId: identity.userId,
              expiresIn: DESKTOP_REGISTRY_KEY_SECONDS,
              metadata: {
                purpose: DESKTOP_REGISTRY_KEY_CONFIG,
                organizationId: identity.organizationId,
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
                userId: identity.userId,
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
      status: "credential" as const,
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
