import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import * as v from "valibot";

import { generatedVisualInputSchema } from "@stll/api-contract/generated-visual";

import { chatThreads, userFiles } from "@/api/db/schema";
import { TEXT_PLAIN_MIME_TYPE } from "@/api/handlers/chat/attachment-validation";
import { prepareGeneratedVisual } from "@/api/handlers/visual-sandbox/prepare";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readStoredFile } from "@/api/lib/file-scan/stored-file";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";

// JSON string escaping can expand the bounded page and data in storage.
const STORED_VISUAL_BYTES = 4 * 1024 * 1024;
const VISUAL_READ_TIMEOUT_MS = 30_000;

export const createReadUserFileVisual = (readObject = readStoredFile) =>
  createSafeRootHandler(
    {
      contentDelivery: { type: "audited" },
      permissions: { chat: ["create"] },
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "upload_mechanics" },
      params: t.Object({ fileId: tSafeId("userFile") }),
    },
    async function* ({
      params: { fileId },
      safeDb,
      session: { activeOrganizationId },
      user,
      recordAuditEvent,
      request,
    }) {
      const file = yield* Result.await(
        safeDb(async (tx) => {
          const row = (
            await tx
              .select({
                s3Key: userFiles.s3Key,
                workspaceId: chatThreads.workspaceId,
              })
              .from(userFiles)
              .innerJoin(
                chatThreads,
                and(
                  eq(chatThreads.id, userFiles.threadId),
                  eq(chatThreads.userId, userFiles.userId),
                ),
              )
              .where(
                and(
                  eq(userFiles.id, fileId),
                  eq(userFiles.userId, user.id),
                  eq(chatThreads.userId, user.id),
                  eq(chatThreads.organizationId, activeOrganizationId),
                ),
              )
              .limit(1)
          ).at(0);
          if (!row) {
            return null;
          }
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.ACCESS,
            resourceType: AUDIT_RESOURCE_TYPE.USER_FILE,
            resourceId: fileId,
            workspaceId: row.workspaceId,
          });
          return row;
        }),
      );
      if (!file) {
        return Result.err(
          new HandlerError({ status: 404, message: "User file not found" }),
        );
      }
      const read = await Result.tryPromise({
        try: async () =>
          await readObject({
            key: file.s3Key,
            mimeType: TEXT_PLAIN_MIME_TYPE,
            maxBytes: STORED_VISUAL_BYTES,
            signal: AbortSignal.any([
              request.signal,
              AbortSignal.timeout(VISUAL_READ_TIMEOUT_MS),
            ]),
          }),
        catch: (cause) => cause,
      });
      if (read.isErr()) {
        captureError(read.error, { source: "read-user-file-visual" });
        return Result.err(
          new HandlerError({
            status: 503,
            message: "The generated view could not be read",
          }),
        );
      }
      const decoded = Result.try((): unknown =>
        JSON.parse(new TextDecoder().decode(read.value.bytes)),
      );
      if (decoded.isErr()) {
        return Result.err(
          new HandlerError({
            status: 422,
            message: "The attachment is not a generated view",
          }),
        );
      }
      const parsed = v.safeParse(generatedVisualInputSchema, decoded.value);
      if (!parsed.success) {
        return Result.err(
          new HandlerError({
            status: 422,
            message: "The attachment is not a generated view",
          }),
        );
      }
      const prepared = prepareGeneratedVisual(parsed.output);
      if (prepared.isErr()) {
        return Result.err(
          new HandlerError({
            status: 422,
            message: "The attachment is not a generated view",
          }),
        );
      }
      const { title, html, data, links, literalLinks } = prepared.value;
      return Result.ok(
        Response.json(
          { title, html, data, links, literalLinks },
          {
            headers: { [CACHE_CONTROL_HEADER]: PRIVATE_CACHE_CONTROL },
          },
        ),
      );
    },
  );

export default createReadUserFileVisual();
