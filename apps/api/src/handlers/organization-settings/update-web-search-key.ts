import { Result } from "better-result";
import { t } from "elysia";

import { organizationSettings } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  maskWebSearchKey,
  validateWebSearchKey,
  webSearchKeyAuditField,
  webSearchKeyColumns,
  WEB_SEARCH_KEY_KINDS,
} from "@/api/lib/web-search/keys";
import { WebSearchProviderError } from "@/api/lib/web-search/types";

const updateWebSearchKeyBody = t.Object({
  kind: t.UnionEnum(WEB_SEARCH_KEY_KINDS),
  apiKey: t.String({ minLength: 1, maxLength: 256 }),
});

const WEB_SEARCH_KEY_ERROR_CODE = {
  keyRejected: "provider_key_rejected",
  rateLimited: "provider_rate_limited",
} as const;

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "internal", reason: "provider_secret" },
  body: updateWebSearchKeyBody,
} satisfies HandlerConfig;

/**
 * Set or rotate one of the org's web-search BYOK keys (search provider
 * or url fetcher). Validates the key with a lightweight provider probe
 * before persisting; an unusable key never reaches the database.
 */
const updateWebSearchKey = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    const { kind } = body;
    const apiKey = body.apiKey.trim();

    if (apiKey.length === 0) {
      return Result.err(
        new HandlerError({ status: 400, message: "API key is required" }),
      );
    }

    const probe = await Result.tryPromise({
      try: async () => await validateWebSearchKey({ kind, apiKey }),
      catch: (error: unknown) => error,
    });

    if (probe.isErr()) {
      const error = probe.error;
      if (WebSearchProviderError.is(error)) {
        if (error.status === 401 || error.status === 403) {
          return Result.err(
            new HandlerError({
              code: WEB_SEARCH_KEY_ERROR_CODE.keyRejected,
              status: 400,
              message: "The provider rejected the API key",
            }),
          );
        }
        if (error.status === 429) {
          return Result.err(
            new HandlerError({
              code: WEB_SEARCH_KEY_ERROR_CODE.rateLimited,
              status: 429,
              message: "Rate limited while validating the key",
            }),
          );
        }
      }
      captureError(error);
      return Result.err(
        new HandlerError({
          status: 502,
          message: "Could not reach the provider to validate the key",
        }),
      );
    }

    const { ciphertext, iv } = await encryptContent(
      session.activeOrganizationId,
      apiKey,
    );
    const columns = webSearchKeyColumns(kind, { ciphertext, iv });

    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .insert(organizationSettings)
          .values({
            id: createSafeId<"organizationSettings">(),
            organizationId: session.activeOrganizationId,
            ...columns,
          })
          .onConflictDoUpdate({
            target: organizationSettings.organizationId,
            set: { ...columns, updatedAt: new Date() },
          });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: session.activeOrganizationId,
          metadata: { field: webSearchKeyAuditField(kind), change: "set" },
        });
      }),
    );

    return Result.ok({ kind, apiKeyMasked: maskWebSearchKey(apiKey) });
  },
);

export default updateWebSearchKey;
