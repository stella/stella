import {
  type DefaultError,
  experimental_streamedQuery as streamedQuery,
  queryOptions,
} from "@tanstack/react-query";

import {
  CHAT_LOCAL_RUN_STEP_CONTENT_STATE,
  type ChatLocalRunStepContent,
} from "@stll/api-contract/chat-local-run-step-content";

import { chatKeys } from "@/features/chat/chat-query-contract";
import {
  foldLocalRunStepOutput,
  LOCAL_RUN_STEP_OUTPUT_UNREAD,
  localRunStepOutputStaleTime,
  type LocalRunStepOutputView,
} from "@/features/chat/local-run-step-output.logic";
import { api } from "@/lib/api";
import { unwrapApiResponse } from "@/lib/errors/api";
import type { SafeId } from "@/lib/safe-id";
import { resourceQueryOptions } from "@/lib/workspace-realtime";

type LocalRunStepOutputKey = {
  activeOrganizationId: string;
  userId: string;
  threadId: SafeId<"chatThread">;
  callId: string;
};

type ReadStepOptions = Pick<LocalRunStepOutputKey, "threadId" | "callId"> & {
  signal: AbortSignal;
};

/**
 * One step's content as stella stores it with the conversation: the first
 * answer, then, for a text, each further window from where the last ended.
 *
 * @yields Each answer of the API in order.
 */
async function* readLocalRunStepContent({
  threadId,
  callId,
  signal,
}: ReadStepOptions): AsyncGenerator<ChatLocalRunStepContent> {
  const step = api.chat.threads({ threadId })["local-run-steps"]({ callId });
  let start = 0;
  // One window at a time: each starts where the one before ended, which
  // only that answer says.
  for (;;) {
    const content = unwrapApiResponse(
      await step.content.get({ query: { start }, fetch: { signal } }),
    );
    yield content;
    if (
      content.state !== CHAT_LOCAL_RUN_STEP_CONTENT_STATE.stored ||
      content.kind === "image" ||
      content.nextStart === null
    ) {
      return;
    }
    start = content.nextStart;
  }
}

/**
 * One step's content, read from the API as the row opens, window by window
 * for a text. A settled step holds for good (its content never changes, so
 * it is never polled); one still arriving, or not yet copied to a fork, is
 * read again when the row opens again.
 */
export const localRunStepOutputOptions = ({
  activeOrganizationId,
  userId,
  threadId,
  callId,
}: LocalRunStepOutputKey) =>
  // A step's content is written by the computer that ran it, never by a
  // member's write, so no realtime event of stella's makes it stale.
  resourceQueryOptions(
    // Named, so the stale time below reads the output's own type.
    queryOptions<
      LocalRunStepOutputView,
      DefaultError,
      LocalRunStepOutputView,
      ReturnType<typeof chatKeys.localRunStepOutput>
    >({
      queryKey: chatKeys.localRunStepOutput({
        activeOrganizationId,
        userId,
        threadId,
        callId,
      }),
      queryFn: streamedQuery({
        streamFn: ({ signal }) =>
          readLocalRunStepContent({ threadId, callId, signal }),
        reducer: foldLocalRunStepOutput,
        initialValue: LOCAL_RUN_STEP_OUTPUT_UNREAD,
      }),
      staleTime: (query) => localRunStepOutputStaleTime(query.state.data),
      retry: false,
    }),
    { type: "independent" },
  );
