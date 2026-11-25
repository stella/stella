import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import {
  BROWSER_DOWNLOAD_FILE_MAX_BYTES,
  BROWSER_DOWNLOAD_REFUSAL_CODE,
  browserDownloadOriginSchema,
} from "@stll/api-contract/browser-downloads";
import { MULTIPART_ENVELOPE_MAX_BYTES } from "@stll/api-contract/limits";

import { chatThreads } from "@/api/db/schema";
import {
  fileBrowserDownload,
  type FileBrowserDownloadDependencies,
} from "@/api/handlers/chat/browser-downloads/file-download";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { fileSchema, resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

const config = {
  contract: "patch",
  contentDelivery: {
    type: "none",
    reason: "Files a download; it answers with where the file is.",
  },
  permissions: { chat: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  // The chat page hands over what the member's own browser downloaded for
  // the chat; no agent surface has such a file to send.
  mcp: { type: "internal", reason: "upload_mechanics" },
  realtime: noResourceSetUpdates(
    "The document write owner announces a new document to its matter; a file kept with a chat is listed by the chat itself.",
  ),
  params: v.object({ threadId: resourceIdSchema("chatThread") }),
  body: v.strictObject({
    file: v.pipe(
      fileSchema({ maxBytes: BROWSER_DOWNLOAD_FILE_MAX_BYTES }),
      v.minSize(1),
    ),
    sourceUrl: browserDownloadOriginSchema.entries.sourceUrl,
    pageUrl: v.optional(
      v.nonNullable(browserDownloadOriginSchema.entries.pageUrl),
    ),
    downloadedAt: browserDownloadOriginSchema.entries.downloadedAt,
  }),
  requestBodyMaxBytes:
    BROWSER_DOWNLOAD_FILE_MAX_BYTES + MULTIPART_ENVELOPE_MAX_BYTES,
} satisfies HandlerConfig;

export type ChatThreadBrowserDownloadDependencies = {
  filing?: FileBrowserDownloadDependencies;
};

/**
 * Files a download the member's browser made for one of their own chats on
 * stella's models: into the chat's own matter as a document that keeps
 * where it came from, or with the chat when it is in none. The chat row,
 * never the request, names the matter; a matter the member can no longer
 * reach, or may not add documents to, is refused, never swapped for
 * another.
 */
export const createFileChatThreadBrowserDownload = (
  dependencies: ChatThreadBrowserDownloadDependencies = {},
) =>
  createSafeRootHandler(
    config,
    async function* ({
      body,
      getWorkspaceAccess,
      memberRole,
      params: { threadId },
      recordAuditEvent,
      safeDb,
      scopedDb,
      session,
      user,
    }) {
      const organizationId = session.activeOrganizationId;
      const userId = user.id;
      const thread = yield* Result.await(
        safeDb(
          async (tx) =>
            await tx
              .select({ workspaceId: chatThreads.workspaceId })
              .from(chatThreads)
              .where(
                and(
                  eq(chatThreads.id, threadId),
                  eq(chatThreads.userId, userId),
                  eq(chatThreads.organizationId, organizationId),
                ),
              )
              .limit(1)
              .then((rows) => rows.at(0) ?? null),
        ),
      );
      if (thread === null) {
        return Result.err(
          new HandlerError({
            status: 404,
            code: BROWSER_DOWNLOAD_REFUSAL_CODE.noChat,
            message: "This chat takes no files",
          }),
        );
      }
      const matterId = thread.workspaceId;
      const filed = yield* Result.await(
        fileBrowserDownload({
          chat: {
            threadId,
            organizationId,
            userId,
            memberRole,
            matter:
              matterId === null
                ? null
                : {
                    id: matterId,
                    workspace: await getWorkspaceAccess(matterId),
                  },
            safeDb,
            scopedDb,
            recordAuditEvent,
          },
          bytes: new Uint8Array(await body.file.arrayBuffer()),
          fileName: sanitizeFilename(body.file.name),
          origin: {
            sourceUrl: body.sourceUrl,
            pageUrl: body.pageUrl ?? null,
            downloadedAt: body.downloadedAt,
          },
          ...(dependencies.filing === undefined
            ? {}
            : { dependencies: dependencies.filing }),
        }),
      );
      return Result.ok(filed);
    },
  );

const fileChatThreadBrowserDownload = createFileChatThreadBrowserDownload();

declareAggregateMutation(fileChatThreadBrowserDownload, {
  type: "independent",
  reason:
    "Adds one document (or one chat file) with its audit event and storage object, or names a document the matter already holds; it changes no aggregate's ordered state.",
});

export default fileChatThreadBrowserDownload;
