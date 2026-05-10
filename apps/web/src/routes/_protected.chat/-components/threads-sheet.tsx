import { useState } from "react";
import type { ReactNode } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useMatch, useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon, TrashIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Sheet,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
  SheetTrigger,
} from "@stll/ui/components/sheet";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { api } from "@/lib/api";
import type { ChatThreadId, ChatThreadRef } from "@/lib/chat-thread-ref";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { toAPIError } from "@/lib/errors";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";
import { groupedChatThreadsOptions } from "@/routes/_protected.chat/-queries";

type ThreadsSheetProps = {
  icon?: ReactNode;
  label?: string | undefined;
  triggerVariant?: "section" | "toolbar";
};

export const ThreadsSheet = ({
  icon,
  label,
  triggerVariant = "toolbar",
}: ThreadsSheetProps) => {
  const t = useTranslations();
  const commonT = useTranslations("common");
  const [isOpen, setIsOpen] = useState(false);
  const triggerLabel = label ?? commonT("history");

  const globalThreadMatch = useMatch({
    from: "/_protected/chat/$threadId",
    shouldThrow: false,
  });
  const workspaceThreadMatch = useMatch({
    from: "/_protected/chat/workspaces/$workspaceId/$threadId",
    shouldThrow: false,
  });

  const activeThreadRef: ChatThreadRef | null = workspaceThreadMatch
    ? {
        scope: "workspace",
        workspaceId: workspaceThreadMatch.params.workspaceId,
        threadId: toChatThreadId(workspaceThreadMatch.params.threadId),
      }
    : globalThreadMatch
      ? {
          scope: "global",
          threadId: toChatThreadId(globalThreadMatch.params.threadId),
        }
      : null;

  const { data } = useQuery(groupedChatThreadsOptions());

  return (
    <Sheet onOpenChange={setIsOpen} open={isOpen}>
      {triggerVariant === "section" ? (
        <SheetTrigger
          render={
            <button
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex items-center gap-2 rounded-md px-1 text-xs font-semibold tracking-widest uppercase transition-colors outline-none focus-visible:ring-2"
              type="button"
            />
          }
        >
          {icon ?? <MessageSquareIcon className="size-4" />}
          {triggerLabel}
        </SheetTrigger>
      ) : (
        <SheetTrigger
          render={
            <Button aria-label={triggerLabel} size="sm" variant="ghost" />
          }
        >
          <MessageSquareIcon className="size-4" />
          {triggerLabel}
        </SheetTrigger>
      )}
      <SheetPopup side="right">
        <SheetHeader>
          <SheetTitle>{triggerLabel}</SheetTitle>
        </SheetHeader>
        <SheetPanel>
          <div className="flex flex-col gap-4">
            <ThreadGroup
              activeThreadRef={activeThreadRef}
              emptyLabel={t("chat.noThreads")}
              heading={t("navigation.chat")}
              onOpenChange={setIsOpen}
              scope="global"
              threads={(data?.global ?? []).map((thread) => ({
                createdAt: thread.createdAt,
                id: thread.id,
                title: thread.title,
              }))}
            />
            {(data?.workspaces ?? []).map((workspace) => (
              <ThreadGroup
                activeThreadRef={activeThreadRef}
                heading={workspace.workspaceName}
                key={workspace.workspaceId}
                onOpenChange={setIsOpen}
                scope="workspace"
                threads={workspace.threads.map((thread) => ({
                  createdAt: thread.createdAt,
                  id: thread.id,
                  title: thread.title,
                }))}
                workspaceId={workspace.workspaceId}
              />
            ))}
          </div>
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
};

type DeleteThreadButtonProps = {
  activeThreadRef: ChatThreadRef | null;
  threadRef: ChatThreadRef;
};

const DeleteThreadButton = ({
  activeThreadRef,
  threadRef,
}: DeleteThreadButtonProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const deleteThread = useMutation({
    mutationFn: async ({
      threadId,
      workspaceId,
    }: {
      threadId: ChatThreadId;
      workspaceId: SafeId<"workspace"> | undefined;
    }) => {
      const response = await api.chat.threads({ threadId }).delete(
        {},
        {
          query: workspaceId ? { workspaceId } : {},
        },
      );

      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: groupedChatThreadsOptions().queryKey,
      });
    },
    onError: () => {
      stellaToast.add({
        title: t("errors.actionFailed"),
        type: "error",
      });
    },
    onSuccess: async (_data, variables) => {
      if (activeThreadRef?.threadId === variables.threadId) {
        await navigate({ to: "/chat" });
      }
    },
  });

  return (
    <Button
      className="me-1 opacity-0 group-hover:opacity-100"
      disabled={deleteThread.isPending}
      onClick={() =>
        deleteThread.mutate({
          threadId: threadRef.threadId,
          workspaceId:
            threadRef.scope === "workspace"
              ? toSafeId<"workspace">(threadRef.workspaceId)
              : undefined,
        })
      }
      size="icon-sm"
      variant="ghost"
    >
      <TrashIcon />
    </Button>
  );
};

type ThreadGroupBaseProps = {
  activeThreadRef: ChatThreadRef | null;
  emptyLabel?: string | undefined;
  heading: string;
  onOpenChange: (open: boolean) => void;
  threads: {
    createdAt: string | Date;
    id: string;
    title: string;
  }[];
};

type ThreadGroupProps =
  | (ThreadGroupBaseProps & {
      scope: "global";
      workspaceId?: never;
    })
  | (ThreadGroupBaseProps & {
      scope: "workspace";
      workspaceId: string;
    });

const ThreadGroup = ({
  activeThreadRef,
  emptyLabel,
  heading,
  workspaceId,
  onOpenChange,
  scope,
  threads,
}: ThreadGroupProps) => {
  if (threads.length === 0) {
    if (!emptyLabel) {
      return null;
    }

    return (
      <div className="flex flex-col gap-1">
        <p className="text-muted-foreground px-1 text-xs font-medium uppercase">
          {heading}
        </p>
        <p className="text-muted-foreground py-4 text-center text-sm">
          {emptyLabel}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground px-1 text-xs font-medium uppercase">
        {heading}
      </p>
      {threads.map((thread) => {
        const threadRef: ChatThreadRef =
          scope === "workspace"
            ? {
                scope,
                threadId: toChatThreadId(thread.id),
                workspaceId,
              }
            : {
                scope,
                threadId: toChatThreadId(thread.id),
              };
        return (
          <div
            className={cn(
              "group flex items-center gap-1 rounded-lg transition-colors",
              activeThreadRef?.threadId === threadRef.threadId
                ? "bg-muted"
                : "hover:bg-muted",
            )}
            key={threadRef.threadId}
          >
            <Link
              className="flex flex-1 flex-col gap-0.5 overflow-hidden px-3 py-2 text-start"
              onClick={() => onOpenChange(false)}
              {...(threadRef.scope === "global"
                ? {
                    to: "/chat/$threadId",
                    params: { threadId: threadRef.threadId },
                  }
                : {
                    to: "/chat/workspaces/$workspaceId/$threadId",
                    params: {
                      threadId: threadRef.threadId,
                      workspaceId: threadRef.workspaceId,
                    },
                  })}
            >
              <span className="truncate text-sm font-medium">
                {thread.title}
              </span>
              <span className="text-muted-foreground text-xs">
                {new Date(thread.createdAt).toLocaleDateString()}
              </span>
            </Link>
            <DeleteThreadButton
              activeThreadRef={activeThreadRef}
              threadRef={threadRef}
            />
          </div>
        );
      })}
    </div>
  );
};
