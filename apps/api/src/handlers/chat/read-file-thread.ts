import { Result } from "better-result";
import { t } from "elysia";

import {
  readFileChatThreadMapping,
  type FileThreadLookupInput,
} from "@/api/handlers/chat/file-thread-mapping";
import {
  emptyMessagePage,
  findFieldKeyedChatThread,
  loadResolvedThreadMessagePage,
  loadWebSearchAvailable,
} from "@/api/handlers/chat/file-thread-shared";
import type { FileThreadMessagePage } from "@/api/handlers/chat/file-thread-shared";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";

/**
 * Read-only file-thread lookup, issued on every document open.
 *
 * Opening a document used to run the materializing POST sibling
 * (`resolve-file-thread.ts`): a write path (thread insert + mapping insert +
 * audit rows, 12 DB queries in the network baseline) executed just to render
 * a chat panel most opens never type into. This endpoint is the read half of
 * that split: resolve an existing thread's identity and initial message page,
 * or report that none exists (`threadId: null`) so the client mounts a local
 * draft. The POST now runs exactly once, when the first message is actually
 * sent (see `fileChatThreadOptions` / `materializeFileChatThread` on the web
 * side).
 *
 * Deliberately writes nothing: a mapping whose historical thread is hidden by
 * chat-thread RLS is reported as "no thread" here and left intact; the POST's
 * detach-and-replace branch handles it at materialization time.
 */
const readFileThreadQuerySchema = t.Object({
  entityId: tSafeId("entity"),
  fieldId: tSafeId("field"),
});

const config = {
  // `chat` has no separate read permission; ["create"] is the established
  // chat-access permission every chat read endpoint declares (get-threads,
  // get-messages).
  permissions: { chat: ["create"] },
  mcp: { type: "internal", reason: "assistant_chat" },
  query: readFileThreadQuerySchema,
} satisfies HandlerConfig;

type ReadFileThreadResult = FileThreadMessagePage & {
  threadId: SafeId<"chatThread"> | null;
};

const readFileThread = createSafeHandler(
  config,
  async function* ({ orgAIConfig, query, safeDb, session, user, workspaceId }) {
    const input: FileThreadLookupInput = {
      entityId: query.entityId,
      fieldId: query.fieldId,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      workspaceId,
    };

    const result = yield* Result.await(
      safeDb(async (tx): Promise<ReadFileThreadResult> => {
        const webSearchAvailable = await loadWebSearchAvailable(
          tx,
          input.organizationId,
        );

        const mapping = await readFileChatThreadMapping(tx, input);
        const thread =
          mapping?.thread ?? (await findFieldKeyedChatThread(tx, input));

        if (!thread) {
          return {
            threadId: null,
            ...emptyMessagePage(webSearchAvailable),
          };
        }

        const messagePage = await loadResolvedThreadMessagePage({
          tx,
          threadId: thread.id,
          userId: input.userId,
          organizationId: input.organizationId,
          orgAIConfig,
          webSearchAvailable,
          chatModel: thread.chatModel,
          chatReasoningEffort: thread.chatReasoningEffort,
          contextMatterIds: thread.contextMatterIds,
          usedAnonymization: thread.usedAnonymization,
          webSearchEnabled: thread.webSearchEnabled,
        });

        return { threadId: thread.id, ...messagePage };
      }),
    );

    return Result.ok(result);
  },
);

export default readFileThread;
