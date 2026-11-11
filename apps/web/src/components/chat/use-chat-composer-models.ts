import {
  type DataTag,
  type QueryKey,
  useQueryClient,
} from "@tanstack/react-query";

import type { ReasoningEffort } from "@stll/ai-catalog";
import type { ChatRunTarget } from "@stll/api-contract/chat-run-target";

import type { ComposerModelsMenuProps } from "@/components/chat/chat-model-options-menu";
import {
  type ChatModelSelection,
  useChatModelSelection,
} from "@/components/chat/use-chat-model-selection";
import { useEffectiveRunTarget } from "@/components/chat/use-effective-run-target";
import { applyChatModelChange } from "@/features/chat/queries";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { toSafeId } from "@/lib/safe-id";

/** What the thread, or the draft that becomes it, stores about its turns. */
type StoredChatModels = {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  runTarget?: ChatRunTarget | undefined;
};

type UseChatComposerModelsOptions = {
  activeOrganizationId: string;
  threadRef: ChatThreadRef;
  /** The stored choice; `undefined` while a draft's read is pending. */
  stored: StoredChatModels | undefined;
  /** The cache entry `stored` was read from, updated once a choice lands. */
  queryKey: DataTag<QueryKey, StoredChatModels, Error>;
};

export type ChatComposerModels = {
  /** The model menu's props, Run on included. */
  models: ComposerModelsMenuProps;
  /** Where the next turn runs, as the menu shows it. */
  runTarget: ChatRunTarget;
  /** `runTarget` read at send time, for the chat runtime's context. */
  getRunTarget: () => ChatRunTarget;
  /** Gate a send on the latest choice having landed. */
  awaitPendingSelection: ChatModelSelection["awaitPendingSelection"];
};

/**
 * The one owner of a chat composer's model and of where its turns run, for
 * a new chat's draft and an existing thread alike. A choice is stored on the
 * thread (a draft's row is created by it), so the first send carries what
 * the menu shows and a reload shows the same choice.
 */
export const useChatComposerModels = ({
  activeOrganizationId,
  threadRef,
  stored,
  queryKey,
}: UseChatComposerModelsOptions): ChatComposerModels => {
  const queryClient = useQueryClient();
  const runTarget = useEffectiveRunTarget(
    activeOrganizationId,
    stored?.runTarget,
  );
  const getRunTarget = useLatestCallback((): ChatRunTarget => runTarget);
  const selection = useChatModelSelection({
    onPersisted: ({ model, reasoningEffort, runTarget: persisted }) => {
      applyChatModelChange({
        model,
        reasoningEffort,
        runTarget: persisted,
        queryClient,
        queryKey,
        threadId: toSafeId<"chatThread">(threadRef.threadId),
      });
    },
    threadRef,
  });
  const selectedModel = stored?.model ?? null;
  const selectedReasoningEffort = stored?.reasoningEffort ?? null;
  return {
    models: {
      activeOrganizationId,
      threadRef,
      selectedModel,
      selectedReasoningEffort,
      selectModel: selection.selectModel,
      runTarget: {
        type: "choice",
        selected: runTarget,
        // Kept beside the model, which stays as it is.
        select: (target) =>
          selection.selectModel({
            model: selectedModel,
            reasoningEffort: selectedReasoningEffort,
            runTarget: target,
          }),
      },
    },
    runTarget,
    getRunTarget,
    awaitPendingSelection: selection.awaitPendingSelection,
  };
};
