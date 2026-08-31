import { useRef } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { GitBranchIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Loader } from "@stll/ui/loader";
import { stellaToast } from "@stll/ui/toast";

import { invalidateChatThreadLists } from "@/features/chat/queries";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import type { ChatThreadId, ChatThreadRef } from "@/lib/chat-thread-ref";
import { chatThreadRoute, createChatThreadId } from "@/lib/chat-thread-ref";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";

type ChatMessageForkButtonProps = {
  /** The message the fork keeps history up to, inclusive. */
  messageId: string;
  threadRef: ChatThreadRef;
};

/**
 * "Fork from here": copies this thread's history up to one message into a new
 * thread and opens it, leaving the original untouched. Valid on any message,
 * not only the latest, so it deliberately does not reuse the retry gate.
 *
 * The new thread id is minted here rather than server-side, which is what
 * makes a retried request return the existing fork instead of a second copy.
 * A fork always lands in its source's scope, so the destination route comes
 * from `threadRef`.
 */
export const ChatMessageForkButton = ({
  messageId,
  threadRef,
}: ChatMessageForkButtonProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const workspaceId =
    threadRef.scope === "workspace" ? threadRef.workspaceId : undefined;
  // Minted once and reused across retries, so the server's caller-minted-id
  // idempotency actually engages: a fork whose response was lost converges on
  // the same durable thread instead of minting a second full copy per click.
  const pendingForkThreadId = useRef<ChatThreadId | null>(null);

  const fork = useMutation({
    mutationFn: async () => {
      // Not `??=`: React Compiler bails out of a component that uses a
      // logical assignment operator, and this one is cheap to spell out.
      if (pendingForkThreadId.current === null) {
        pendingForkThreadId.current = createChatThreadId();
      }
      const response = await api.chat
        .threads({ threadId: toSafeId<"chatThread">(threadRef.threadId) })
        .fork.post(
          {
            newThreadId: pendingForkThreadId.current,
            upToMessageId: toSafeId<"chatMessage">(messageId),
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
      pendingForkThreadId.current = null;
      await invalidateChatThreadLists({ queryClient, workspaceId });
      await navigate(chatThreadRoute({ threadId, workspaceId }));
    },
    onError: (error) => {
      getAnalytics().captureError(error);
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
    },
  });

  const label = fork.isPending
    ? t("chat.forkingThread")
    : t("chat.forkFromHere");

  return (
    <Button
      aria-label={label}
      className="text-muted-foreground h-6 px-1.5 text-xs"
      disabled={fork.isPending}
      onClick={() => {
        fork.mutate();
      }}
      size="xs"
      type="button"
      variant="ghost"
    >
      {fork.isPending ? (
        <Loader className="size-3.5" label={label} size="sm" />
      ) : (
        <GitBranchIcon aria-hidden="true" className="size-3.5" />
      )}
      {t("chat.forkFromHere")}
    </Button>
  );
};
