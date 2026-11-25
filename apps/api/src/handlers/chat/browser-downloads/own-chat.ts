import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import {
  BROWSER_DOWNLOAD_FILE_MAX_BYTES,
  BROWSER_DOWNLOAD_REFUSAL_CODE,
  type BrowserDownloadFiled,
  browserDownloadOriginSchema,
} from "@stll/api-contract/browser-downloads";
import { MULTIPART_ENVELOPE_MAX_BYTES } from "@stll/api-contract/limits";

import type { SafeDbError } from "@/api/db/safe-db-types";
import { chatThreads } from "@/api/db/schema";
import {
  fileBrowserDownload,
  type FileBrowserDownloadDependencies,
} from "@/api/handlers/chat/browser-downloads/file-download";
import type { AccessibleWorkspace } from "@/api/lib/auth/accessible-workspace";
import type { SafeId } from "@/api/lib/branded-types";
import { fileSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

/**
 * What both routes that file a browser download share: the multipart form
 * they take, and how the chat they file it for names its matter.
 */

/** A filed download's form: the file and where it came from. */
export const browserDownloadBodySchema = v.strictObject({
  file: v.pipe(
    fileSchema({ maxBytes: BROWSER_DOWNLOAD_FILE_MAX_BYTES }),
    v.minSize(1),
  ),
  sourceUrl: browserDownloadOriginSchema.entries.sourceUrl,
  pageUrl: v.optional(
    v.nonNullable(browserDownloadOriginSchema.entries.pageUrl),
  ),
  downloadedAt: browserDownloadOriginSchema.entries.downloadedAt,
});

/** The largest request either route reads: one file and its form. */
export const BROWSER_DOWNLOAD_REQUEST_MAX_BYTES =
  BROWSER_DOWNLOAD_FILE_MAX_BYTES + MULTIPART_ENVELOPE_MAX_BYTES;

/** The chat a download is filed for, as the filing owner takes it. */
type BrowserDownloadChat = Parameters<typeof fileBrowserDownload>[0]["chat"];

type FileForOwnChat = {
  /** The chat as the caller verified it, before its matter is read. */
  chat: Omit<BrowserDownloadChat, "matter">;
  body: v.InferOutput<typeof browserDownloadBodySchema>;
  /** The chat's matter as the caller may reach it now; null when it cannot. */
  reachMatter: (
    matterId: SafeId<"workspace">,
  ) => Promise<AccessibleWorkspace | null>;
  /** What a refused caller hears when the chat is not theirs. */
  noChatMessage: string;
  dependencies?: FileBrowserDownloadDependencies;
};

/**
 * Files a download for a chat of the caller's own, in their organization:
 * the chat row, never the request, names the matter, and a matter the
 * caller cannot reach now is refused, never swapped for another.
 */
export const fileForOwnChat = async ({
  body,
  chat,
  dependencies,
  noChatMessage,
  reachMatter,
}: FileForOwnChat): Promise<
  Result<BrowserDownloadFiled, HandlerError | SafeDbError>
> =>
  await Result.gen(async function* () {
    const thread = yield* Result.await(
      chat.safeDb(
        async (tx) =>
          await tx
            .select({ workspaceId: chatThreads.workspaceId })
            .from(chatThreads)
            .where(
              and(
                eq(chatThreads.id, chat.threadId),
                eq(chatThreads.userId, chat.userId),
                eq(chatThreads.organizationId, chat.organizationId),
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
          message: noChatMessage,
        }),
      );
    }
    const matterId = thread.workspaceId;
    return await fileBrowserDownload({
      chat: {
        ...chat,
        matter:
          matterId === null
            ? null
            : { id: matterId, workspace: await reachMatter(matterId) },
      },
      bytes: new Uint8Array(await body.file.arrayBuffer()),
      fileName: sanitizeFilename(body.file.name),
      origin: {
        sourceUrl: body.sourceUrl,
        pageUrl: body.pageUrl ?? null,
        downloadedAt: body.downloadedAt,
      },
      ...(dependencies === undefined ? {} : { dependencies }),
    });
  });
