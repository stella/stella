import { Result } from "better-result";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { shareSpace: ["read"] },
  mcp: { type: "capability", reason: "external_sharing" },
  access: "read",
  params: workspaceParams({ shareSpaceId: tSafeId("shareSpace") }),
} satisfies HandlerConfig;

const getShareSpace = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params }) {
    const space = yield* Result.await(
      safeDb((tx) =>
        tx.query.shareSpaces.findFirst({
          where: {
            id: { eq: params.shareSpaceId },
            workspaceId: { eq: workspaceId },
          },
          columns: {
            id: true,
            name: true,
            status: true,
            downloadPolicy: true,
            expiresAt: true,
            revokedAt: true,
            createdAt: true,
            updatedAt: true,
          },
          with: {
            recipients: {
              columns: {
                id: true,
                emailNormalized: true,
                role: true,
                status: true,
                verifiedAt: true,
                lastAccessAt: true,
              },
            },
            items: {
              columns: {
                id: true,
                displayName: true,
                status: true,
                originalMimeType: true,
                originalSizeBytes: true,
                versionStamp: true,
                verificationCode: true,
                failureCode: true,
                publishedAt: true,
              },
            },
          },
        }),
      ),
    );
    if (!space) {
      return Result.err(
        new HandlerError({ status: 404, message: "Share Space not found." }),
      );
    }

    return Result.ok({
      ...space,
      expiresAt: space.expiresAt?.toISOString() ?? null,
      revokedAt: space.revokedAt?.toISOString() ?? null,
      createdAt: space.createdAt.toISOString(),
      updatedAt: space.updatedAt.toISOString(),
      recipients: space.recipients.map((recipient) => ({
        id: recipient.id,
        emailNormalized: recipient.emailNormalized,
        role: recipient.role,
        status: recipient.status,
        verifiedAt: recipient.verifiedAt?.toISOString() ?? null,
        lastAccessAt: recipient.lastAccessAt?.toISOString() ?? null,
      })),
      items: space.items.map((item) => ({
        id: item.id,
        displayName: item.displayName,
        status: item.status,
        originalMimeType: item.originalMimeType,
        originalSizeBytes: item.originalSizeBytes,
        versionStamp: item.versionStamp,
        verificationCode: item.verificationCode,
        failureCode: item.failureCode,
        publishedAt: item.publishedAt?.toISOString() ?? null,
      })),
    });
  },
);

export default getShareSpace;
