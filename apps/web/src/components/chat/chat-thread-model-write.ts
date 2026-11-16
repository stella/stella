import { Result } from "better-result";

import type { ReasoningEffort } from "@stll/ai-catalog";
import type { ChatRunTarget } from "@stll/api-contract/chat-run-target";

import { api } from "@/lib/api";
import { invokeAppOnlyWrite } from "@/lib/capabilities/capability-request";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { type APIError, toAPIError } from "@/lib/errors/api";
import { ClientOperationError } from "@/lib/errors/client";
import { toSafeId } from "@/lib/safe-id";

/** Client-observed ceiling for a model-selection PATCH: long enough for a
 *  slow network, short enough that a hung request can't indefinitely block
 *  message submit, which waits for every pending choice. */
const MODEL_SELECT_TIMEOUT_MS = 10_000;

export type ModelPersistError = APIError | ClientOperationError;

export type PersistedChatModelSelection = {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  /** Where the thread's turns run; absent leaves it as stored. */
  runTarget?: ChatRunTarget;
};

/**
 * Stores a thread's model choice (a draft's row is created by it). A
 * refused or failed write is an error; nothing is shown here.
 */
export const writeChatThreadModel = async (
  threadRef: ChatThreadRef,
  selection: PersistedChatModelSelection,
): Promise<Result<void, ModelPersistError>> => {
  // The route is internal to the assistant chat: an agent does not pick the
  // model or the computer a member's chat runs on, so it has no capability.
  const result = await Result.tryPromise(
    async () =>
      await invokeAppOnlyWrite("chat.threads.model.update", async () => {
        const { data, error } = await api.chat
          .threads({ threadId: toSafeId<"chatThread">(threadRef.threadId) })
          .model.patch(selection, {
            query:
              threadRef.scope === "workspace"
                ? { workspaceId: toSafeId<"workspace">(threadRef.workspaceId) }
                : {},
            fetch: { signal: AbortSignal.timeout(MODEL_SELECT_TIMEOUT_MS) },
          });
        return { data, error };
      }),
  );
  if (Result.isError(result)) {
    return Result.err(
      new ClientOperationError({
        action: "chat.selectModel",
        cause: result.error,
        message: "Failed to persist the selected model",
      }),
    );
  }
  if (result.value.error) {
    return Result.err(toAPIError(result.value.error));
  }
  return Result.ok(undefined);
};
