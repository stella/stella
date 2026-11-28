import { Result } from "better-result";
import * as v from "valibot";

import type { FileBrowserDownloadDependencies } from "@/api/handlers/chat/browser-downloads/file-download";
import {
  BROWSER_DOWNLOAD_REQUEST_MAX_BYTES,
  browserDownloadBodySchema,
  fileForOwnChat,
} from "@/api/handlers/chat/browser-downloads/own-chat";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

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
  body: browserDownloadBodySchema,
  requestBodyMaxBytes: BROWSER_DOWNLOAD_REQUEST_MAX_BYTES,
  aggregateMutation: {
    type: "independent",
    reason:
      "Adds one document (or one chat file) with its audit event and storage object, or names a document the matter already holds; it changes no aggregate's ordered state.",
  },
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
      const filed = yield* Result.await(
        fileForOwnChat({
          body,
          chat: {
            threadId,
            organizationId: session.activeOrganizationId,
            userId: user.id,
            memberRole,
            safeDb,
            scopedDb,
            recordAuditEvent,
          },
          ...(dependencies.filing === undefined
            ? {}
            : { dependencies: dependencies.filing }),
          noChatMessage: "This chat takes no files",
          reachMatter: getWorkspaceAccess,
        }),
      );
      return Result.ok(filed);
    },
  );

const fileChatThreadBrowserDownload = createFileChatThreadBrowserDownload();

export default fileChatThreadBrowserDownload;
