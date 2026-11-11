import { useRef } from "react";

import {
  type DataTag,
  type QueryKey,
  useQueryClient,
} from "@tanstack/react-query";

import type { ReasoningEffort } from "@stll/ai-catalog";
import type { ChatRunTarget } from "@stll/api-contract/chat-run-target";

import type { ComposerModelsMenuProps } from "@/components/chat/chat-model-options-menu";
import { effectiveRunTarget } from "@/components/chat/chat-run-target-menu.logic";
import {
  type ChatModelSelection,
  useChatModelSelection,
} from "@/components/chat/use-chat-model-selection";
import { useEffectiveRunTarget } from "@/components/chat/use-effective-run-target";
import {
  applyChatModelChange,
  localRunnersOptions,
} from "@/features/chat/queries";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
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
 *
 * Each choice is written whole (model, effort and run target) on top of the
 * newest one not yet stored, and the writes go out in order, so a model
 * chosen just before a run target, or the other way round, is kept. A send
 * waits for the newest write (`awaitPendingSelection`) and then reads the run
 * target from the cache that write updated, never from a render that may not
 * have caught up.
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
  /** The newest choice still being written, and for which thread. */
  const pendingChoiceRef = useRef<{
    threadId: string;
    choice: StoredChatModels;
  } | null>(null);
  const storedNow = () => queryClient.getQueryData(queryKey);
  const getRunTarget = useLatestCallback((): ChatRunTarget =>
    effectiveRunTarget(
      storedNow()?.runTarget,
      queryClient.getQueryData(
        localRunnersOptions(activeOrganizationId).queryKey,
      ),
    ),
  );
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
  const choose = (change: Partial<StoredChatModels>) => {
    const pending = pendingChoiceRef.current;
    const current = storedNow();
    const base =
      pending?.threadId === threadRef.threadId
        ? pending.choice
        : {
            model: current?.model ?? null,
            reasoningEffort: current?.reasoningEffort ?? null,
            runTarget: current?.runTarget,
          };
    const next = {
      threadId: threadRef.threadId,
      choice: { ...base, ...change },
    };
    pendingChoiceRef.current = next;
    const { model, reasoningEffort, runTarget: target } = next.choice;
    selection.selectModel({
      model,
      reasoningEffort,
      ...(target === undefined ? {} : { runTarget: target }),
    });
    detached(
      (async () => {
        // Stored or refused, this choice is no longer pending: the selection
        // reports a refused write, and the next choice composes on what the
        // server stores.
        const settled = await selection.awaitPendingSelection();
        if (pendingChoiceRef.current === next) {
          pendingChoiceRef.current = null;
        }
        return settled;
      })(),
      "use-chat-composer-models.settle-choice",
    );
  };
  return {
    models: {
      activeOrganizationId,
      threadRef,
      selectedModel: stored?.model ?? null,
      selectedReasoningEffort: stored?.reasoningEffort ?? null,
      selectModel: ({ model, reasoningEffort }) =>
        choose({ model, reasoningEffort }),
      runTarget: {
        type: "choice",
        selected: runTarget,
        select: (target) => choose({ runTarget: target }),
      },
    },
    runTarget,
    getRunTarget,
    awaitPendingSelection: selection.awaitPendingSelection,
  };
};
