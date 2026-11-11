import { useState, useSyncExternalStore } from "react";

import {
  type DataTag,
  type QueryKey,
  useQueryClient,
} from "@tanstack/react-query";
import type { Result } from "better-result";
import { useTranslations } from "use-intl";

import type { ReasoningEffort } from "@stll/ai-catalog";
import {
  CHAT_CLOUD_RUN_TARGET,
  type ChatRunTarget,
} from "@stll/api-contract/chat-run-target";

import {
  CHAT_RUN_ON_CLOUD_ONLY,
  type ComposerModelsMenuProps,
} from "@/components/chat/chat-model-options-menu";
import { effectiveRunTarget } from "@/components/chat/chat-run-target-menu.logic";
import {
  type ModelPersistError,
  writeChatThreadModel,
} from "@/components/chat/chat-thread-model-write";
import {
  type ComposerChoice,
  type ComposerChoiceOwner,
  type ComposerChoiceSuperseded,
  createComposerChoice,
} from "@/components/chat/composer-choice";
import { useEffectiveRunTarget } from "@/components/chat/use-effective-run-target";
import {
  applyChatModelChange,
  localRunnersOptions,
} from "@/features/chat/queries";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import {
  rememberedRunTarget,
  rememberRunTarget,
} from "@/lib/chat-run-on-preference-store";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { notifyUserError } from "@/lib/errors/user-toast";
import { toSafeId } from "@/lib/safe-id";

/** What the thread, or the draft that becomes it, stores about its turns. */
type StoredChatModels = {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  runTarget?: ChatRunTarget | undefined;
  /** `false` for a new chat whose row the server does not hold yet. */
  threadExists: boolean;
};

type UseChatComposerModelsOptions = {
  activeOrganizationId: string;
  threadRef: ChatThreadRef;
  /** The stored choice; `undefined` while a draft's read is pending. */
  stored: StoredChatModels | undefined;
  /** The cache entry `stored` was read from; every stored write lands there. */
  queryKey: DataTag<QueryKey, StoredChatModels, Error>;
  /**
   * `cloud_only` for a surface whose turns need tools only stella's own
   * models drive in this page (the file chat's review queue): its menu offers
   * no Run on, and its turns run on stella whatever the thread stores.
   */
  runOn?: "choice" | "cloud_only";
};

export type ChatComposerModels = {
  /** The model menu's props, Run on included. */
  models: ComposerModelsMenuProps;
  /** Where the next turn runs, as the menu shows it. */
  runTarget: ChatRunTarget;
  /** Where the next turn runs, read at send time after `awaitPendingSelection`. */
  getRunTarget: () => ChatRunTarget;
  /** Gate a send on every choice so far being stored; an error was shown. */
  awaitPendingSelection: () => Promise<
    Result<void, ModelPersistError | ComposerChoiceSuperseded>
  >;
};

/**
 * One thread's choice owner, and where a new chat's turns start: the member's
 * last Run on choice, read when the composer first showed the chat, until a
 * choice of this chat is stored.
 */
type ThreadChoice = {
  owner: ComposerChoiceOwner<ModelPersistError>;
  start: ChatRunTarget | null;
};

const choiceOf = (
  stored: StoredChatModels,
  start: ChatRunTarget | null,
): ComposerChoice => ({
  model: stored.model,
  reasoningEffort: stored.reasoningEffort,
  runTarget:
    !stored.threadExists && start !== null
      ? start
      : (stored.runTarget ?? CHAT_CLOUD_RUN_TARGET),
});

/**
 * A chat composer's model and where its turns run, for a new chat's draft
 * and an existing thread alike, owned by one `createComposerChoice`: the
 * menus and a send read the member's newest pick, every write carries the
 * whole choice and lands in the stored choice in order, and a failed write
 * shows the stored choice again. The menus stay disabled until the stored
 * choice is known, so no pick composes on a choice not yet read.
 *
 * A new chat starts where the member last chose to run turns, on stella or
 * on their computer, and its first send carries that target. A computer
 * that is offline is shown so in the bar; the turn is never moved to stella
 * in its place. Every Run on pick, in any chat, is remembered as the member's
 * last choice.
 */
export const useChatComposerModels = ({
  activeOrganizationId,
  threadRef,
  stored,
  queryKey,
  runOn = "choice",
}: UseChatComposerModelsOptions): ChatComposerModels => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const threadId = toSafeId<"chatThread">(threadRef.threadId);
  // The owner reads these at the time it writes; their identity is stable.
  const write = useLatestCallback(
    async (choice: ComposerChoice) =>
      await writeChatThreadModel(threadRef, choice),
  );
  const applyStored = useLatestCallback((choice: ComposerChoice) => {
    applyChatModelChange({ ...choice, queryClient, queryKey, threadId });
  });
  const refetch = useLatestCallback(async () => {
    await queryClient.refetchQueries({ queryKey, exact: true });
  });
  const failed = useLatestCallback((error: ModelPersistError) => {
    notifyUserError(error, t("common.somethingWentWrong"));
  });
  // One owner per thread: a draft rotated by `/new` starts from its own.
  // Created once per thread and kept, as the cache of a pure lookup.
  const [threads] = useState(() => new Map<string, ThreadChoice>());
  const thread =
    threads.get(threadId) ??
    (() => {
      const created: ThreadChoice = {
        owner: createComposerChoice<ModelPersistError>({
          write,
          stored: (choice) => {
            // The chat's own choice is stored now; it no longer starts from
            // the member's last one.
            created.start = null;
            applyStored(choice);
          },
          refetch,
          failed,
        }),
        start:
          runOn === "choice"
            ? (rememberedRunTarget(activeOrganizationId) ?? null)
            : null,
      };
      threads.set(threadId, created);
      return created;
    })();
  const { owner } = thread;
  const desired = useSyncExternalStore(owner.subscribe, owner.desired);
  const shown =
    desired ??
    (stored === undefined ? undefined : choiceOf(stored, thread.start));
  const choiceTarget = useEffectiveRunTarget(
    activeOrganizationId,
    runOn === "choice" ? shown?.runTarget : undefined,
  );
  const runTarget = runOn === "choice" ? choiceTarget : CHAT_CLOUD_RUN_TARGET;
  const getRunTarget = useLatestCallback((): ChatRunTarget => {
    if (runOn === "cloud_only") {
      return CHAT_CLOUD_RUN_TARGET;
    }
    const current = queryClient.getQueryData(queryKey);
    return effectiveRunTarget(
      owner.desired()?.runTarget ??
        (current === undefined
          ? undefined
          : choiceOf(current, thread.start).runTarget),
      queryClient.getQueryData(
        localRunnersOptions(activeOrganizationId).queryKey,
      ),
    );
  });
  const pick = (change: Partial<ComposerChoice>) => {
    const current = queryClient.getQueryData(queryKey);
    if (current === undefined) {
      return;
    }
    owner.pick(choiceOf(current, thread.start), change);
  };
  return {
    models: {
      activeOrganizationId,
      threadRef,
      state: stored === undefined ? "loading" : "ready",
      selectedModel: shown?.model ?? null,
      selectedReasoningEffort: shown?.reasoningEffort ?? null,
      selectModel: ({ model, reasoningEffort }) => {
        pick({ model, reasoningEffort });
      },
      runTarget:
        runOn === "choice"
          ? {
              type: "choice",
              selected: runTarget,
              select: (target) => {
                rememberRunTarget(activeOrganizationId, target);
                pick({ runTarget: target });
              },
            }
          : CHAT_RUN_ON_CLOUD_ONLY,
    },
    runTarget,
    getRunTarget,
    awaitPendingSelection: owner.settled,
  };
};
