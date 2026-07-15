import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import {
  compareDocxVersions,
  generateRedlineDocx,
} from "@stll/folio-core/server";

import { member, user } from "@/api/db/auth-schema";
import { desktopEditSessions, entityVersions, fields } from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { countVersionDiffWords } from "@/api/handlers/entities/version-diff-word-counts";
import { createFileKey } from "@/api/handlers/files/utils";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getS3 } from "@/api/lib/s3";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "document_processing" },
  params: workspaceParams({
    entityId: tSafeId("entity"),
  }),
  body: t.Object({
    baseVersionId: tSafeId("entityVersion"),
    targetVersionId: tSafeId("entityVersion"),
    entityId: tSafeId("entity"),
  }),
} satisfies HandlerConfig;

export default createSafeHandler(
  config,
  async function* ({
    safeDb,
    workspaceId,
    params,
    body: { baseVersionId, targetVersionId, entityId },
    session,
  }) {
    const organizationId = session.activeOrganizationId;

    if (params.entityId !== entityId) {
      return Result.err(
        new HandlerError({ status: 400, message: "Entity ID mismatch" }),
      );
    }

    // Fetch fields for both versions to get file content
    const [baseFieldsResult, targetFieldsResult] = await Promise.all([
      safeDb((tx) =>
        tx
          .select({ content: fields.content })
          .from(fields)
          .innerJoin(
            entityVersions,
            and(
              eq(fields.entityVersionId, entityVersions.id),
              eq(entityVersions.entityId, entityId),
            ),
          )
          .where(eq(fields.entityVersionId, baseVersionId)),
      ),
      safeDb((tx) =>
        tx
          .select({ content: fields.content })
          .from(fields)
          .innerJoin(
            entityVersions,
            and(
              eq(fields.entityVersionId, entityVersions.id),
              eq(entityVersions.entityId, entityId),
            ),
          )
          .where(eq(fields.entityVersionId, targetVersionId)),
      ),
    ]);

    const baseFields = yield* baseFieldsResult;
    const targetFields = yield* targetFieldsResult;

    // Find the DOCX file field in each version
    const findDocxContent = (
      fieldList: { content: FieldContent }[],
    ): Extract<FieldContent, { type: "file" }> | null => {
      for (const f of fieldList) {
        if (
          f.content.type === "file" &&
          f.content.mimeType === DOCX_MIME_TYPE
        ) {
          return f.content;
        }
      }
      return null;
    };

    const baseFile = findDocxContent(baseFields);
    const targetFile = findDocxContent(targetFields);

    if (!baseFile || !targetFile) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Both versions must contain a DOCX file",
        }),
      );
    }

    // Download both DOCX files from S3 and look up the target version's
    // author concurrently; the author query runs in its own safeDb
    // transaction and does not depend on the file bytes.
    const [baseBuffer, targetBuffer, targetAuthorResult] = await Promise.all([
      getS3()
        .file(
          createFileKey({
            organizationId,
            workspaceId,
            fileId: baseFile.id,
            mimeType: DOCX_MIME_TYPE,
          }),
        )
        .arrayBuffer(),
      getS3()
        .file(
          createFileKey({
            organizationId,
            workspaceId,
            fileId: targetFile.id,
            mimeType: DOCX_MIME_TYPE,
          }),
        )
        .arrayBuffer(),
      safeDb((tx) =>
        tx
          .select({ userName: user.name })
          .from(desktopEditSessions)
          .innerJoin(user, eq(desktopEditSessions.createdBy, user.id))
          .innerJoin(
            member,
            and(
              eq(member.userId, desktopEditSessions.createdBy),
              eq(member.organizationId, organizationId),
            ),
          )
          .where(
            and(
              eq(desktopEditSessions.finalizedVersionId, targetVersionId),
              eq(desktopEditSessions.workspaceId, workspaceId),
            ),
          )
          .limit(1),
      ),
    ]);
    const targetAuthorRows = yield* targetAuthorResult;
    const authorName = targetAuthorRows.at(0)?.userName ?? "Unknown";

    // Block-level diff for the word stats plus the tracked-changes redline;
    // both come from the same folio comparison, so the counts describe the
    // document the user downloads. Accept-all yields the target version,
    // reject-all yields the base version.
    const compared = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          const [diff, redline] = await Promise.all([
            compareDocxVersions(baseBuffer, targetBuffer),
            generateRedlineDocx(baseBuffer, targetBuffer, {
              author: authorName,
            }),
          ]);
          return { diff, redline };
        },
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Failed to compare document versions",
            cause,
          }),
      }),
    );

    const { wordsAdded, wordsRemoved } = countVersionDiffWords(compared.diff);
    const docxBase64 = Buffer.from(compared.redline.buffer).toString("base64");

    return Result.ok({
      docxBase64,
      editsApplied: compared.redline.applied.length,
      wordsAdded,
      wordsRemoved,
    });
  },
);
