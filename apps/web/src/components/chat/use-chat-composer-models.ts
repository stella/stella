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
import { needsDesktopLaunch } from "@/features/chat/desktop-launch.logic";
import {
  applyChatModelChange,
  localRunnersOptions,
} from "@/features/chat/queries";
import {
  rememberedRunTarget,
  rememberRunTarget,
} from "@/features/chat/run-on-preference-store";
import { useDesktopLaunch } from "@/features/chat/use-desktop-launch";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
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
  /**
   * For a surface that opens new chats (the new-chat page, an inspector chat
   * tab): a chat the server holds no row for when first read starts on the
   * member's last Run on choice. A thread page shows what its thread stores.
   */
  startsOnLastChoice?: boolean;
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
  /**
   * Opens stella desktop when the next turn runs on the member's computer
   * and none of their computers is connected; the turn's request then waits
   * for it (`heldForDesktop`). Call it first in a send handler, before any
   * `await`, so it runs inside the member's click or key press: a browser
   * opens a `stella://` link only then.
   */
  openDesktopForSend: () => void;
};

/**
 * One thread's choice owner, and where a new chat's turns start. `start` is
 * decided once, from the chat's first read: the member's last Run on choice
 * for a chat the server held no row for then, `null` for one it held. It
 * stands until this chat's own choice is stored, so a write that creates
 * the row without one (web search turned on) does not drop it, and the first
 * send carries it.
 */
type ThreadChoice = {
  owner: ComposerChoiceOwner<ModelPersistError>;
  start:
    { type: "undecided" } | { type: "decided"; target: ChatRunTarget | null };
};

/** The start as decided, read when a send or a pick happens. */
const startOf = (thread: ThreadChoice): ChatRunTarget | null =>
  thread.start.type === "decided" ? thread.start.target : null;

const choiceOf = (
  stored: StoredChatModels,
  start: ChatRunTarget | null,
): ComposerChoice => ({
  model: stored.model,
  reasoningEffort: stored.reasoningEffort,
  runTarget: start ?? stored.runTarget ?? CHAT_CLOUD_RUN_TARGET,
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
  startsOnLastChoice = false,
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
            created.start = { type: "decided", target: null };
            applyStored(choice);
          },
          refetch,
          failed,
        }),
        start: { type: "undecided" },
      };
      threads.set(threadId, created);
      return created;
    })();
  // Decided on the chat's first read, and the same on every render after.
  if (thread.start.type === "undecided" && stored !== undefined) {
    thread.start = {
      type: "decided",
      target:
        runOn === "choice" && startsOnLastChoice && !stored.threadExists
          ? (rememberedRunTarget(activeOrganizationId) ?? null)
          : null,
    };
  }
  const start = startOf(thread);
  const { owner } = thread;
  const desired = useSyncExternalStore(owner.subscribe, owner.desired);
  const shown =
    desired ?? (stored === undefined ? undefined : choiceOf(stored, start));
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
          : choiceOf(current, startOf(thread)).runTarget),
      queryClient.getQueryData(
        localRunnersOptions(activeOrganizationId).queryKey,
      ),
    );
  });
  const desktop = useDesktopLaunch(activeOrganizationId);
  // Called only inside the member's own pick or send. A turn sent while the
  // launch waits holds its request for it; nothing else awaits it.
  const openDesktopIfOffline = (target: ChatRunTarget) => {
    if (
      needsDesktopLaunch(
        target,
        queryClient.getQueryData(
          localRunnersOptions(activeOrganizationId).queryKey,
        ),
      )
    ) {
      detached(desktop.launch(), "chat-composer.open-desktop");
    }
  };
  const openDesktopForSend = useLatestCallback(() => {
    openDesktopIfOffline(getRunTarget());
  });
  const pick = (change: Partial<ComposerChoice>) => {
    const current = queryClient.getQueryData(queryKey);
    if (current === undefined) {
      return;
    }
    owner.pick(choiceOf(current, startOf(thread)), change);
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
                // Picking the member's computer while none is connected
                // opens stella desktop now, so it is ready by the send.
                openDesktopIfOffline(target);
                pick({ runTarget: target });
              },
            }
          : CHAT_RUN_ON_CLOUD_ONLY,
    },
    runTarget,
    getRunTarget,
    awaitPendingSelection: owner.settled,
    openDesktopForSend,
  };
};
