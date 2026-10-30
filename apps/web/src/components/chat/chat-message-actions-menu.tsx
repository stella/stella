import { createContext, use, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  type EntityAction,
  EntityActions,
  EntityActionsButton,
} from "@stll/ui/entity-actions";
import { DownloadIcon, GitBranchIcon, PanelRightIcon } from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";

import type { PersistedChatMessage } from "@/components/chat/chat-ui-tools";
import type { CreateDocumentDraft } from "@/components/chat/create-document-draft.logic";
import { MessageExportMenu } from "@/components/chat/message-export-menu";
import {
  SidePanelChatAnnouncer,
  SidePanelChatNote,
} from "@/components/chat/side-panel-chat-status";
import { useSidePanelChat } from "@/components/chat/use-request-chat-about";
import { invalidateChatThreadLists } from "@/features/chat/queries";
import type { TranslationKey } from "@/i18n/types";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import type { ChatThreadId, ChatThreadRef } from "@/lib/chat-thread-ref";
import {
  chatThreadRoute,
  createChatThreadId,
  resolveChatContextMatterIds,
  toChatThreadId,
} from "@/lib/chat-thread-ref";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useIdempotentMutation } from "@/lib/idempotency/use-idempotent-mutation";
import { formatContextualTimestamp } from "@/lib/relative-time";
import { toSafeId } from "@/lib/safe-id";

type ChatMessageActionsProps = {
  canExport: boolean;
  canFork: boolean;
  /** The whole message: right-clicking anywhere in it opens its actions. */
  children: ReactNode;
  /** The chat's matter scope; the fork carries it, and an inspector tab
   *  must be told it. Defaults to the thread's own matter. */
  contextMatterIds?: readonly string[] | undefined;
  exportArtifact: CreateDocumentDraft | null;
  message: PersistedChatMessage;
  threadRef: ChatThreadRef;
};

/**
 * Where a fork opens: in place of this chat, or beside it in the inspector.
 * Two flat items rather than one item with a choice: the menu is a list of
 * one-click actions, and each item keeps its own pending state in place.
 */
const FORK_DESTINATIONS = ["main", "inspector"] as const;
type ForkDestination = (typeof FORK_DESTINATIONS)[number];

const FORK_DESTINATION_LABELS = {
  inspector: "chat.forkInSidePanel",
  main: "chat.forkFromHere",
} as const satisfies Record<ForkDestination, TranslationKey>;

const FORK_DESTINATION_ICONS = {
  inspector: PanelRightIcon,
  main: GitBranchIcon,
} as const satisfies Record<ForkDestination, unknown>;

/** No matters beyond the thread's own: the fork keeps just that scope. */
const NO_EXTRA_CONTEXT_MATTERS: readonly string[] = [];

type ChatMessageActionsRow = {
  extras: ReactNode;
  /** Registers the "…" button, which the export menu anchors to. */
  setTrigger: (trigger: HTMLButtonElement | null) => void;
};

const ChatMessageActionsRowContext =
  createContext<ChatMessageActionsRow | null>(null);

/** One message's actions: its right-click menu and its "…" button's list. */
const ChatMessageActions = ({
  canExport,
  canFork,
  children,
  contextMatterIds = NO_EXTRA_CONTEXT_MATTERS,
  exportArtifact,
  message,
  threadRef,
}: ChatMessageActionsProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // A fork to the side panel confirms on this action row: the menu closes
  // on click, so the row is where the eye still is.
  const sidePanelChat = useSidePanelChat();
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const pendingForkThreadId = useRef<ChatThreadId | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const workspaceId =
    threadRef.scope === "workspace" ? threadRef.workspaceId : undefined;

  const fork = useIdempotentMutation({
    idempotencyScope: `chat.${threadRef.threadId}.${message.id}.fork`,
    mutationFn: async (_destination: ForkDestination) => {
      if (pendingForkThreadId.current === null) {
        pendingForkThreadId.current = createChatThreadId();
      }
      const response = await api.chat
        .threads({ threadId: toSafeId<"chatThread">(threadRef.threadId) })
        .fork.post(
          {
            newThreadId: pendingForkThreadId.current,
            upToMessageId: toSafeId<"chatMessage">(message.id),
          },
          {
            query: workspaceId
              ? { workspaceId: toSafeId<"workspace">(workspaceId) }
              : {},
          },
        );
      return unwrapApiResponse(response);
    },
    onMutate: (destination) => {
      if (destination === "inspector") {
        sidePanelChat.begin();
      }
    },
    onSuccess: async ({ threadId }, destination) => {
      await invalidateChatThreadLists({ queryClient, workspaceId });
      if (destination === "inspector") {
        sidePanelChat.open({
          contextMatterIds: resolveChatContextMatterIds(
            threadRef,
            contextMatterIds,
          ),
          threadId: toChatThreadId(threadId),
          workspaceId,
        });
      } else {
        await navigate(chatThreadRoute({ threadId, workspaceId }));
      }
      pendingForkThreadId.current = null;
    },
    onError: (error) => {
      sidePanelChat.fail();
      getAnalytics().captureError(error, {
        fingerprintKey: "ChatMessageActionsMenu:failure",
        scope: { type: "handler", handlerId: "ChatMessageActionsMenu:failure" },
      });
      notifyUserError(error, t("errors.actionFailed"));
    },
  });

  const timestamp = message.createdAt
    ? formatContextualTimestamp({
        date: message.createdAt,
        today: (time) => t("chat.messageTimestampToday", { time }),
      })
    : null;

  // One list for the message's "…" button and its right-click menu.
  const forkActions: EntityAction[] = canFork
    ? FORK_DESTINATIONS.map((destination) => {
        const forking = fork.isPending && fork.variables === destination;
        const Icon = FORK_DESTINATION_ICONS[destination];
        return {
          disabled: fork.isPending,
          icon: forking ? (
            <Loader label={t("chat.forkingThread")} size="sm" />
          ) : (
            <Icon aria-hidden="true" />
          ),
          label: forking
            ? t("chat.forkingThread")
            : t(FORK_DESTINATION_LABELS[destination]),
          onClick: () => {
            fork.mutate(destination);
          },
        };
      })
    : [];
  const actions: EntityAction[] = canExport
    ? [
        ...forkActions,
        {
          icon: <DownloadIcon aria-hidden="true" />,
          label: t("common.export.title"),
          onClick: () => setExportOpen(true),
        },
      ]
    : forkActions;

  // The "…" button sits in the message's action row; the row's status note
  // and the export menu anchored to the button go with it.
  const row: ChatMessageActionsRow = {
    setTrigger,
    extras: (
      <>
        <SidePanelChatNote status={sidePanelChat.status} />
        <SidePanelChatAnnouncer status={sidePanelChat.status} />
        {canExport && (
          <MessageExportMenu
            anchor={trigger}
            artifact={exportArtifact ?? undefined}
            key={`${message.id}:${exportArtifact?.toolCallId ?? "message-only"}`}
            message={message}
            onOpenChange={setExportOpen}
            open={exportOpen}
            threadRef={threadRef}
          />
        )}
      </>
    ),
  };

  return (
    <ChatMessageActionsRowContext value={row}>
      <EntityActions
        actions={actions}
        heading={timestamp ?? undefined}
        label={t("common.actions")}
      >
        {children}
      </EntityActions>
    </ChatMessageActionsRowContext>
  );
};

type ChatMessageActionsScopeProps = Omit<
  ChatMessageActionsProps,
  "threadRef"
> & {
  /** Absent on embedded surfaces, which offer no message actions. */
  threadRef?: ChatThreadRef | undefined;
};

/**
 * Wraps a whole message (its content and its action row) in its actions
 * when the surface offers them, so right-clicking the message opens what its
 * "…" button opens. Without actions the message renders as it is.
 */
export const ChatMessageActionsScope = ({
  canFork,
  children,
  threadRef,
  ...props
}: ChatMessageActionsScopeProps): ReactNode =>
  // Explicit ReactNode: returning bare `children` would infer React 19's
  // Promise member, which promise-function-async flags on a sync component.
  threadRef !== undefined && canFork ? (
    <ChatMessageActions canFork={canFork} threadRef={threadRef} {...props}>
      {children}
    </ChatMessageActions>
  ) : (
    children
  );

/** The message's "…" button, inside the `ChatMessageActionsScope` around it. */
export const ChatMessageActionsButton = () => {
  const row = use(ChatMessageActionsRowContext);
  if (row === null) {
    panic(
      "ChatMessageActionsButton renders inside ChatMessageActionsScope, which owns its actions",
    );
  }
  const { extras, setTrigger } = row;
  return (
    <>
      <EntityActionsButton align="start" ref={setTrigger} side="top" />
      {extras}
    </>
  );
};
