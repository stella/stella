import { useRef, useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { DownloadIcon, EllipsisIcon, GitBranchIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
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
import { invalidateChatThreadLists } from "@/features/chat/queries";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import type { ChatThreadId, ChatThreadRef } from "@/lib/chat-thread-ref";
import { chatThreadRoute, createChatThreadId } from "@/lib/chat-thread-ref";
import { unwrapEden } from "@/lib/errors/api";
import { formatContextualTimestamp } from "@/lib/relative-time";
import { toSafeId } from "@/lib/safe-id";

type ChatMessageActionsMenuProps = {
  canExport: boolean;
  canFork: boolean;
  exportArtifact: CreateDocumentDraft | null;
  message: PersistedChatMessage;
  threadRef: ChatThreadRef;
};

export const ChatMessageActionsMenu = ({
  canExport,
  canFork,
  exportArtifact,
  message,
  threadRef,
}: ChatMessageActionsMenuProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pendingForkThreadId = useRef<ChatThreadId | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const workspaceId =
    threadRef.scope === "workspace" ? threadRef.workspaceId : undefined;

  const fork = useMutation({
    mutationFn: async () => {
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
    onSuccess: async ({ threadId }) => {
      await invalidateChatThreadLists({ queryClient, workspaceId });
      await navigate(chatThreadRoute({ threadId, workspaceId }));
      pendingForkThreadId.current = null;
    },
    onError: (error) => {
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
              className="text-muted-foreground size-6"
              size="icon-xs"
              variant="ghost"
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
          {canFork && (
            <DropdownMenuItem
              disabled={fork.isPending}
              onClick={() => {
                fork.mutate();
              }}
            >
              {fork.isPending ? (
                <Loader label={t("chat.forkingThread")} size="sm" />
              ) : (
                <GitBranchIcon aria-hidden="true" />
              )}
              {fork.isPending
                ? t("chat.forkingThread")
                : t("chat.forkFromHere")}
            </DropdownMenuItem>
          )}
          {canExport && (
            <DropdownMenuItem onClick={() => setExportOpen(true)}>
              <DownloadIcon aria-hidden="true" />
              {t("common.export.title")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
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
