import { Result } from "better-result";
import { t } from "elysia";

import { createSafeSessionHandler } from "@/api/lib/api-handlers";
import type { SessionHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { presignDownloadUrl } from "@/api/lib/s3-presign";
import {
  authorizeVerifiedShareRecipient,
  loadExternalShareItem,
  recordExternalShareAccess,
} from "@/api/lib/share-space-access";

const DISPLAY_URL_EXPIRY_SECONDS = 5 * 60;
const DOWNLOAD_URL_EXPIRY_SECONDS = 60;

const config = {
  params: t.Object({
    shareSpaceId: tSafeId("shareSpace"),
    shareItemId: tSafeId("shareItem"),
  }),
  query: t.Object({ kind: t.UnionEnum(["display", "download"] as const) }),
  mcp: { type: "internal", reason: "auth_plumbing" },
  access: "read",
} satisfies SessionHandlerConfig;

const createExternalShareItemUrl = createSafeSessionHandler(
  config,
  async function* ({ params, query, user, request, server }) {
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

    const item = yield* Result.await(
      loadExternalShareItem({
        authorization,
        userId: user.id,
        shareItemId: params.shareItemId,
      }),
    );
    if (!item) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Shared item is not available.",
        }),
      );
    }
    if (query.kind === "download" && item.downloadPolicy !== "allowed") {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Downloads are disabled for this share.",
        }),
      );
    }

    const storageKey =
      query.kind === "display"
        ? item.displayStorageKey
        : item.originalStorageKey;
    if (!storageKey) {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "Shared item is not available.",
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
            action:
              query.kind === "download"
                ? AUDIT_ACTION.DOWNLOAD
                : AUDIT_ACTION.ACCESS,
            resourceType: AUDIT_RESOURCE_TYPE.SHARE_ITEM,
            resourceId: item.id,
            event: `${query.kind}_url_requested`,
          }),
      ),
    );

    const expiresIn =
      query.kind === "display"
        ? DISPLAY_URL_EXPIRY_SECONDS
        : DOWNLOAD_URL_EXPIRY_SECONDS;
    const url = yield* Result.await(
      Result.tryPromise(
        async () =>
          await presignDownloadUrl(storageKey, {
            expiresIn,
            ...(query.kind === "download"
              ? { fileName: item.originalFileName }
              : {}),
          }),
      ),
    );
    return Result.ok({ url, expiresIn });
  },
);

export default createExternalShareItemUrl;
