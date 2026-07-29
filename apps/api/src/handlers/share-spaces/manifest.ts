import { Result } from "better-result";
import { t } from "elysia";

import { createSafeSessionHandler } from "@/api/lib/api-handlers";
import type { SessionHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  authorizeVerifiedShareRecipient,
  loadExternalShareManifest,
  recordExternalShareAccess,
} from "@/api/lib/share-space-access";

const config = {
  params: t.Object({ shareSpaceId: tSafeId("shareSpace") }),
  mcp: { type: "internal", reason: "auth_plumbing" },
  access: "read",
} satisfies SessionHandlerConfig;

const readExternalShareManifest = createSafeSessionHandler(
  config,
  async function* ({ params, user, request, server }) {
    const authorization = yield* Result.await(
      Result.tryPromise(
        async () =>
          await authorizeVerifiedShareRecipient({
            shareSpaceId: params.shareSpaceId,
            userId: user.id,
          }),
      ),
    );
    if (!authorization) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Share link is not available.",
        }),
      );
    }

    const manifest = yield* Result.await(
      loadExternalShareManifest({ authorization, userId: user.id }),
    );
    if (!manifest) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Share link is not available.",
        }),
      );
    }

    yield* Result.await(
      Result.tryPromise(
        async () =>
          await recordExternalShareAccess({
            authorization,
            userId: user.id,
            request,
            server: server ?? null,
            action: AUDIT_ACTION.ACCESS,
            resourceType: AUDIT_RESOURCE_TYPE.SHARE_SPACE,
            resourceId: authorization.shareSpaceId,
            event: "manifest_read",
            touchRecipient: true,
          }),
      ),
    );

    return Result.ok({
      id: manifest.id,
      name: manifest.name,
      expiresAt: manifest.expiresAt?.toISOString() ?? null,
      downloadPolicy: manifest.downloadPolicy,
      items: manifest.items.map((item) => ({
        id: item.id,
        displayName: item.displayName,
        displayMimeType: item.displayMimeType,
        originalMimeType: item.originalMimeType,
        originalSizeBytes: item.originalSizeBytes,
        versionStamp: item.versionStamp,
        verificationCode: item.verificationCode,
        publishedAt: item.publishedAt?.toISOString() ?? null,
      })),
    });
  },
);

export default readExternalShareManifest;
