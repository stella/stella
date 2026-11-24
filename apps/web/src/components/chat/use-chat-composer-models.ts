import { useState, useSyncExternalStore } from "react";

import {
  type DataTag,
  type QueryKey,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { panic, type Result } from "better-result";
import { useTranslations } from "use-intl";

import type { ReasoningEffort } from "@stll/ai-catalog";
import {
  CHAT_CLOUD_RUN_TARGET,
  type ChatLocalRunReadiness,
  type ChatLocalRunTarget,
  type ChatRunTarget,
} from "@stll/api-contract/chat-run-target";
import type { ChatSendIntent } from "@stll/api-contract/chat-send-intent";

import {
  CHAT_RUN_ON_CLOUD_ONLY,
  type ComposerModelsMenuProps,
} from "@/components/chat/chat-model-options-menu";
import {
  type ChatCloudStart,
  effectiveRunTarget,
  newChatStart,
} from "@/components/chat/chat-run-target-menu.logic";
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
import type { ChatThreadRef } from "@/features/chat/chat-thread-ref-types";
import {
  type DesktopLaunchCause,
  needsDesktopLaunch,
} from "@/features/chat/desktop-launch.logic";
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
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import { type QueryView, queryView } from "@/lib/query-view.logic";
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
   * For a surface that mostly opens new chats (the new-chat page, an
   * inspector chat tab): before the chat's first read, its row lays out for
   * the member's last Run on choice. On every surface, a chat the server
   * holds no row for when first read starts on that choice; this only
   * shapes the row while that read is pending.
   */
  opensNewChats?: boolean;
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
   * Opens stella desktop when a send that starts a turn (`intent`, from
   * `chatSendIntent`) runs it on the member's computer and none of their
   * computers is connected; the turn's request then waits for it
   * (`heldForDesktop`). A message steered into or queued behind a running
   * turn never opens it. Call it first in a send handler, before any
   * `await`, so it runs inside the member's click or key press: a browser
   * opens a `stella://` link only then.
   */
  openDesktopForSend: (intent: ChatSendIntent) => void;
};

/**
 * Where a new chat's turns start, decided once from the chat's first read:
 * the member's last Run on choice for a chat the server held no row for
 * then, `null` for one it held. A last choice on the member's computer is
 * `checking` until their computers are read, and starts in the cloud, with
 * the reason, when its harness cannot take a turn there. The start stands
 * until this chat's own choice is stored, so a write that creates the row
 * without one (web search turned on) does not drop it, and the first send
 * carries it.
 */
type ThreadStart =
  | { type: "undecided" }
  | { type: "checking"; remembered: ChatLocalRunTarget }
  | {
      type: "decided";
      target: ChatRunTarget | null;
      cloudStart: ChatCloudStart | null;
    };

/** One thread's choice owner, and where its turns start. */
type ThreadChoice = {
  owner: ComposerChoiceOwner<ModelPersistError>;
  start: ThreadStart;
};

/** The chat's own choice is stored; it starts from nothing else. */
const STORED_START = {
  type: "decided",
  target: null,
  cloudStart: null,
} as const satisfies ThreadStart;

/**
 * The start as decided, read when a send or a pick happens. A send made
 * while the computers are still being read carries the member's last
 * choice.
 */
const startOf = ({ start }: ThreadChoice): ChatRunTarget | null => {
  switch (start.type) {
    case "undecided":
      return null;
    case "checking":
      return start.remembered;
    case "decided":
      return start.target;
    default:
      start satisfies never;
      return panic("Unknown chat start");
  }
};

/** The start of a chat first read as `stored`, before its computers are. */
const firstStart = ({
  activeOrganizationId,
  runOn,
  stored,
}: {
  activeOrganizationId: string;
  runOn: "choice" | "cloud_only";
  stored: StoredChatModels;
}): ThreadStart => {
  const remembered =
    runOn === "choice" && !stored.threadExists
      ? rememberedRunTarget(activeOrganizationId)
      : undefined;
  return remembered?.kind === "local"
    ? { type: "checking", remembered }
    : { type: "decided", target: remembered ?? null, cloudStart: null };
};

/** The member's computers as a start check reads them; `undefined` until read. */
const startReadiness = (
  view: QueryView<ChatLocalRunReadiness, Error>,
): ChatLocalRunReadiness | "check_failed" | undefined => {
  switch (view.type) {
    case "items":
      return view.items;
    case "error":
    case "empty":
      return "check_failed";
    case "pending":
      return undefined;
    default:
      view satisfies never;
      return panic("Unknown query view");
  }
};

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
 * A new chat, on every surface that offers Run on, starts where the member
 * last chose to run turns, on stella or on their computer with the model and
 * effort chosen there, and its first send carries that target. When that
 * harness cannot take a turn now (the computer offline, the agent signed
 * out), the chat starts on stella instead and the where chip says why. Every
 * Run on pick, in any chat, is remembered as the member's last choice.
 */
export const useChatComposerModels = ({
  activeOrganizationId,
  threadRef,
  stored,
  queryKey,
  runOn = "choice",
  opensNewChats = false,
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
            created.start = STORED_START;
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
    thread.start = firstStart({ activeOrganizationId, runOn, stored });
  }
  const runnersView = queryView(
    useQuery({
      ...localRunnersOptions(activeOrganizationId),
      enabled: thread.start.type === "checking",
    }),
  );
  if (thread.start.type === "checking") {
    const readiness = startReadiness(runnersView);
    if (readiness !== undefined) {
      const decided = newChatStart(thread.start.remembered, readiness);
      thread.start =
        decided.type === "remembered"
          ? { type: "decided", target: decided.target, cloudStart: null }
          : {
              type: "decided",
              target: CHAT_CLOUD_RUN_TARGET,
              cloudStart: decided.reason,
            };
    }
  }
  const start = startOf(thread);
  const cloudStart =
    thread.start.type === "decided" ? thread.start.cloudStart : null;
  const { owner } = thread;
  const desired = useSyncExternalStore(owner.subscribe, owner.desired);
  const shown =
    desired ?? (stored === undefined ? undefined : choiceOf(stored, start));
  // Before the first read, a surface that opens new chats lays its row out
  // for where a new chat starts, the member's last Run on choice, which this
  // browser holds: the web search switch, for one, is absent for a chat on
  // the member's computer, so it does not show and then leave. Nothing is
  // decided on it (the start is decided on the read, above), and the menus
  // and the model chip stay pending until then.
  const shownTarget =
    shown?.runTarget ??
    (runOn === "choice" && opensNewChats && stored === undefined
      ? rememberedRunTarget(activeOrganizationId)
      : undefined);
  const choiceTarget = useEffectiveRunTarget(
    activeOrganizationId,
    runOn === "choice" ? shownTarget : undefined,
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
  const openDesktopIfOffline = (
    cause: DesktopLaunchCause,
    target: ChatRunTarget,
  ) => {
    if (
      needsDesktopLaunch({
        cause,
        target,
        readiness: queryClient.getQueryData(
          localRunnersOptions(activeOrganizationId).queryKey,
        ),
      })
    ) {
      detached(desktop.launch(), "chat-composer.open-desktop");
    }
  };
  const openDesktopForSend = useLatestCallback((intent: ChatSendIntent) => {
    openDesktopIfOffline({ type: "send", intent }, getRunTarget());
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
      // Also while a new chat's last choice waits on the computers' read,
      // so the chips never show a place the chat may not start on.
      state:
        stored === undefined || thread.start.type === "checking"
          ? "loading"
          : "ready",
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
              // Said only while the chat shows its start, not a pick.
              startedInCloud: desired === null ? cloudStart : null,
              select: (target) => {
                rememberRunTarget(activeOrganizationId, target);
                // Picking the member's computer while none is connected
                // opens stella desktop now, so it is ready by the send.
                openDesktopIfOffline({ type: "pick" }, target);
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
