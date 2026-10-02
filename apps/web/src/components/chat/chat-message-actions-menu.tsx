import { useRef, useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  DownloadIcon,
  EllipsisIcon,
  GitBranchIcon,
  PanelRightIcon,
} from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@stll/ui/menu";
import { stellaToast } from "@stll/ui/toast";

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
import { unwrapEden } from "@/lib/errors/api";
import { formatContextualTimestamp } from "@/lib/relative-time";
import { toSafeId } from "@/lib/safe-id";

type ChatMessageActionsMenuProps = {
  canExport: boolean;
  canFork: boolean;
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

export const ChatMessageActionsMenu = ({
  canExport,
  canFork,
  contextMatterIds = NO_EXTRA_CONTEXT_MATTERS,
  exportArtifact,
  message,
  threadRef,
}: ChatMessageActionsMenuProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // A fork to the side panel confirms on this action row: the menu closes
  // on click, so the row is where the eye still is.
  const sidePanelChat = useSidePanelChat();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pendingForkThreadId = useRef<ChatThreadId | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const workspaceId =
    threadRef.scope === "workspace" ? threadRef.workspaceId : undefined;

  const fork = useMutation({
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
      return unwrapEden(response);
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
      getAnalytics().captureError(error);
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    },
  });

  const timestamp = message.createdAt
    ? formatContextualTimestamp({
        date: message.createdAt,
        today: (time) => t("chat.messageTimestampToday", { time }),
      })
    : null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={triggerRef}
          render={
            <Button
              aria-label={t("common.actions")}
              className="size-6"
              size="icon-xs"
              variant="muted"
            >
              <EllipsisIcon aria-hidden="true" className="size-3.5" />
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="min-w-56" side="top">
          {timestamp !== null && (
            <>
              <DropdownMenuGroup>
                <DropdownMenuLabel className="font-normal">
                  {timestamp}
                </DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          )}
          {canFork &&
            FORK_DESTINATIONS.map((destination) => {
              const forking = fork.isPending && fork.variables === destination;
              const Icon = FORK_DESTINATION_ICONS[destination];
              return (
                <DropdownMenuItem
                  disabled={fork.isPending}
                  key={destination}
                  onClick={() => {
                    fork.mutate(destination);
                  }}
                >
                  {forking ? (
                    <Loader label={t("chat.forkingThread")} size="sm" />
                  ) : (
                    <Icon aria-hidden="true" />
                  )}
                  {forking
                    ? t("chat.forkingThread")
                    : t(FORK_DESTINATION_LABELS[destination])}
                </DropdownMenuItem>
              );
            })}
          {canExport && (
            <DropdownMenuItem onClick={() => setExportOpen(true)}>
              <DownloadIcon aria-hidden="true" />
              {t("common.export.title")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <SidePanelChatNote status={sidePanelChat.status} />
      <SidePanelChatAnnouncer status={sidePanelChat.status} />
      {canExport && (
        <MessageExportMenu
          anchor={triggerRef}
          artifact={exportArtifact ?? undefined}
          key={`${message.id}:${exportArtifact?.toolCallId ?? "message-only"}`}
          message={message}
          onOpenChange={setExportOpen}
          open={exportOpen}
          threadRef={threadRef}
        />
      )}
    </>
  );
};
