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
import type { readOpenLocalRunThread } from "@/api/handlers/chat/local-run-plan";
import {
  type ResolveRunContext,
  verifyRunCallerWith,
} from "@/api/handlers/chat/run-outputs/upload";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import { fileSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import type { VerifyBearerToken } from "@/api/mcp/auth";
import { resolveMcpSessionContext } from "@/api/mcp/context";
import { mcpMemberAuthority } from "@/api/mcp/effective-authority";

const runIdSchema = v.pipe(v.string(), v.uuid());

/** What filing a run's download takes of the member's context. */
type BrowserDownloadRunContext = Pick<
  Awaited<ReturnType<typeof resolveMcpSessionContext>>,
  | "accessibleWorkspaces"
  | "billingAccess"
  | "credentialPermissions"
  | "memberRole"
  | "pinServerValidatedWorkspaceId"
  | "recordAuditEvent"
  | "safeDb"
  | "scopedDb"
>;

export type LocalRunBrowserDownloadDependencies = {
  /** The bearer verifier; the provider's own in production. */
  verifyToken?: VerifyBearerToken;
  resolveContext?: ResolveRunContext<BrowserDownloadRunContext>;
  readRunThread?: typeof readOpenLocalRunThread;
  filing?: FileBrowserDownloadDependencies;
};

/**
 * Files a download the member's browser made for a run on their computer, as
 * the run's own agent token: into the run's chat's matter, or with the chat
 * when it is in none. The run row, never the request, names the chat, and the
 * chat names the matter; a matter the token or the member cannot reach is
 * refused, never swapped for another.
 */
export const createFileLocalRunBrowserDownload = (
  dependencies: LocalRunBrowserDownloadDependencies = {},
) =>
  createSafeTokenHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      contentDelivery: {
        type: "none",
        reason: "Files a download; it answers with where the file is.",
      },
      mcp: { type: "internal", reason: "upload_mechanics" },
      params: v.object({ runId: runIdSchema }),
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
    },
    verifyRunCallerWith<BrowserDownloadRunContext>({
      ...dependencies,
      resolveContext: dependencies.resolveContext ?? resolveMcpSessionContext,
    }),
    async function* ({ body, caller }) {
      const { organizationId, threadId, userId } = caller;
      const thread = yield* Result.await(
        caller.safeDb(
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
            message: "This run takes no files",
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
            memberRole: mcpMemberAuthority(caller),
            matter:
              matterId === null
                ? null
                : {
                    id: matterId,
                    // The token's matters and the member's own: a matter
                    // outside either is not reachable from this run.
                    workspace:
                      caller.pinServerValidatedWorkspaceId?.(matterId) === true
                        ? (caller.accessibleWorkspaces.find(
                            (workspace) => workspace.id === matterId,
                          ) ?? null)
                        : null,
                  },
            safeDb: caller.safeDb,
            scopedDb: caller.scopedDb,
            recordAuditEvent: caller.recordAuditEvent,
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

const fileLocalRunBrowserDownload = createFileLocalRunBrowserDownload();

declareAggregateMutation(fileLocalRunBrowserDownload, {
  type: "independent",
  reason:
    "Adds one document (or one chat file) with its audit event and storage object, or names a document the matter already holds; it changes no aggregate's ordered state.",
});

export default fileLocalRunBrowserDownload;
