import { Result } from "better-result";
import { t } from "elysia";

import { organizationSettings } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { encryptContent } from "@/api/lib/content-encryption";
import {
  DeepLAuthError,
  DeepLQuotaError,
  DeepLRateLimitError,
  fetchTargetLanguages,
  maskDeepLKey,
  resolveDeepLBaseUrl,
} from "@/api/lib/deepl";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const FREE_BASE_URL = "https://api-free.deepl.com";

const updateDeepLKeyBody = t.Object({
  apiKey: t.String({ minLength: 1, maxLength: 256 }),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  body: updateDeepLKeyBody,
} satisfies HandlerConfig;

/**
 * Set or rotate the org's DeepL API key. Validates the key by
 * calling DeepL's lightweight `/v2/languages` endpoint before
 * persisting; an unusable key never reaches the database.
 */
const updateDeepLKey = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    const apiKey = body.apiKey.trim();

    if (apiKey.length === 0) {
      return Result.err(
        new HandlerError({ status: 400, message: "API key is required" }),
      );
    }

    const probe = await Result.tryPromise({
      try: async () => await fetchTargetLanguages(apiKey),
      catch: (error: unknown) => error,
    });

    if (probe.isErr()) {
      const error = probe.error;
      if (DeepLAuthError.is(error)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message: "DeepL rejected the API key",
          }),
        );
      }
      if (DeepLQuotaError.is(error)) {
        return Result.err(
          new HandlerError({
            status: 400,
            message:
              "DeepL key is valid but its character quota is already exhausted",
          }),
        );
      }
      if (DeepLRateLimitError.is(error)) {
        return Result.err(
          new HandlerError({
            status: 429,
            message: "DeepL rate limit hit while validating the key",
          }),
        );
      }
      captureError(error);
      return Result.err(
        new HandlerError({
          status: 502,
          message: "Could not reach DeepL to validate the key",
        }),
      );
    }

    const { ciphertext, iv } = await encryptContent(
      session.activeOrganizationId,
      apiKey,
    );

    yield* Result.await(
      safeDb(async (tx) => {
        await tx
          .insert(organizationSettings)
          .values({
            id: createSafeId<"organizationSettings">(),
            organizationId: session.activeOrganizationId,
            deeplApiKeyEncrypted: ciphertext,
            deeplApiKeyIv: iv,
          })
          .onConflictDoUpdate({
            target: organizationSettings.organizationId,
            set: {
              deeplApiKeyEncrypted: ciphertext,
              deeplApiKeyIv: iv,
              updatedAt: new Date(),
            },
          });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: session.activeOrganizationId,
          metadata: { field: "deeplApiKey", change: "set" },
        });
      }),
    );

    return Result.ok({
      apiKeyMasked: maskDeepLKey(apiKey),
      tier:
        resolveDeepLBaseUrl(apiKey) === FREE_BASE_URL
          ? ("free" as const)
          : ("pro" as const),
    });
  },
);

export default updateDeepLKey;
