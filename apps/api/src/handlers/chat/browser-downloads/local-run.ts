import { Result } from "better-result";
import * as v from "valibot";

import type { FileBrowserDownloadDependencies } from "@/api/handlers/chat/browser-downloads/file-download";
import {
  BROWSER_DOWNLOAD_REQUEST_MAX_BYTES,
  browserDownloadBodySchema,
  fileForOwnChat,
} from "@/api/handlers/chat/browser-downloads/own-chat";
import type { readOpenLocalRunThread } from "@/api/handlers/chat/local-run-plan";
import {
  type ResolveRunContext,
  verifyRunCallerWith,
} from "@/api/handlers/chat/run-outputs/upload";
import { ACCOUNT_ACCESS, createSafeTokenHandler } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { VerifyBearerToken } from "@/api/mcp/auth";
import { resolveMcpSessionContext } from "@/api/mcp/context";
import {
  hasEffectiveAuthority,
  mcpMemberAuthority,
} from "@/api/mcp/effective-authority";

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
      body: browserDownloadBodySchema,
      requestBodyMaxBytes: BROWSER_DOWNLOAD_REQUEST_MAX_BYTES,
    },
    verifyRunCallerWith<BrowserDownloadRunContext>({
      ...dependencies,
      resolveContext: dependencies.resolveContext ?? resolveMcpSessionContext,
    }),
    async function* ({ body, caller }) {
      // As the member route asks: a role that cannot change its chats files
      // nothing into one, whatever matter the chat is in.
      if (!hasEffectiveAuthority(caller, { chat: ["update"] })) {
        return Result.err(
          new HandlerError({
            status: 403,
            code: "forbidden",
            message: "This run may not add files to its chat",
          }),
        );
      }
      const filed = yield* Result.await(
        fileForOwnChat({
          body,
          chat: {
            threadId: caller.threadId,
            organizationId: caller.organizationId,
            userId: caller.userId,
            memberRole: mcpMemberAuthority(caller),
            safeDb: caller.safeDb,
            scopedDb: caller.scopedDb,
            recordAuditEvent: caller.recordAuditEvent,
          },
          ...(dependencies.filing === undefined
            ? {}
            : { dependencies: dependencies.filing }),
          noChatMessage: "This run takes no files",
          // The token's matters and the member's own: a matter outside
          // either is not reachable from this run.
          reachMatter: async (matterId) =>
            await Promise.resolve(
              caller.pinServerValidatedWorkspaceId?.(matterId) === true
                ? (caller.accessibleWorkspaces.find(
                    (workspace) => workspace.id === matterId,
                  ) ?? null)
                : null,
            ),
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
