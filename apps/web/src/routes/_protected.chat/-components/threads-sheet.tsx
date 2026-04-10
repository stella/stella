import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useMatch, useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon, TrashIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import {
  Sheet,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
  SheetTrigger,
} from "@stella/ui/components/sheet";
import { cn } from "@stella/ui/lib/utils";

import { api } from "@/lib/api";
import { useChatPanelStore } from "@/lib/chat-panel-store";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import {
  chatKeys,
  groupedChatThreadsOptions,
} from "@/routes/_protected.chat/-queries";

type GroupedChatThreads = {
  global: {
    createdAt: Date;
    id: string;
    title: string;
    updatedAt: Date;
  }[];
  workspaces: {
    threads: {
      createdAt: Date;
      id: string;
      title: string;
      updatedAt: Date;
    }[];
    workspaceId: string;
    workspaceName: string;
  }[];
};

type ThreadLinkTarget =
  | {
      params: { threadId: string };
      to: "/chat/$threadId";
    }
  | {
      params: {
        threadId: string;
        workspaceId: string;
      };
      to: "/chat/workspaces/$workspaceId/$threadId";
    };

const getThreadLinkTarget = (threadRef: ChatThreadRef): ThreadLinkTarget =>
  threadRef.scope === "global"
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
      };

export const ThreadsSheet = () => {
  const t = useTranslations();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setGlobalThreadId = useChatPanelStore(
    (state) => state.setGlobalThreadId,
  );
  const setWorkspaceThreadId = useChatPanelStore(
    (state) => state.setWorkspaceThreadId,
  );
  const [isOpen, setIsOpen] = useState(false);

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
        threadId: workspaceThreadMatch.params.threadId,
      }
    : globalThreadMatch
      ? {
          scope: "global",
          threadId: globalThreadMatch.params.threadId,
        }
      : null;

  const { data } = useQuery(groupedChatThreadsOptions());

  const handleDelete = async (threadRef: ChatThreadRef) => {
    await api.chat.threads({ threadId: threadRef.threadId }).delete({
      query:
        threadRef.scope === "workspace"
          ? { workspaceId: threadRef.workspaceId }
          : {},
    });

    if (threadRef.scope === "global") {
      setGlobalThreadId(null);
    } else {
      setWorkspaceThreadId(threadRef.workspaceId, null);
    }

    queryClient.setQueryData(
      groupedChatThreadsOptions().queryKey,
      (previous: GroupedChatThreads | undefined) => {
        if (!previous) {
          return previous;
        }

        if (threadRef.scope === "global") {
          return {
            ...previous,
            global: previous.global.filter(
              (thread) => thread.id !== threadRef.threadId,
            ),
          };
        }

        return {
          ...previous,
          workspaces: previous.workspaces
            .map((workspace) => {
              if (workspace.workspaceId !== threadRef.workspaceId) {
                return workspace;
              }

              return {
                ...workspace,
                threads: workspace.threads.filter(
                  (thread) => thread.id !== threadRef.threadId,
                ),
              };
            })
            .filter((workspace) => workspace.threads.length > 0),
        };
      },
    );

    queryClient.removeQueries({
      queryKey: chatKeys.thread(threadRef),
    });

    if (isSameThread(activeThreadRef, threadRef)) {
      await navigate({ to: "/chat" });
    }
  };

  return (
    <Sheet onOpenChange={setIsOpen} open={isOpen}>
      <SheetTrigger
        render={
          <Button aria-label={t("chat.threads")} size="sm" variant="ghost" />
        }
      >
        <MessageSquareIcon className="size-4" />
        {t("chat.threads")}
      </SheetTrigger>
      <SheetPopup side="right">
        <SheetHeader>
          <SheetTitle>{t("chat.threads")}</SheetTitle>
        </SheetHeader>
        <SheetPanel>
          <div className="flex flex-col gap-4">
            <ThreadGroup
              activeThreadRef={activeThreadRef}
              emptyLabel={t("chat.noThreads")}
              heading={t("navigation.chat")}
              onDelete={handleDelete}
              onOpenChange={setIsOpen}
              threads={(data?.global ?? []).map((thread) => ({
                createdAt: thread.createdAt,
                ref: { scope: "global", threadId: thread.id } as const,
                title: thread.title,
              }))}
            />
            {(data?.workspaces ?? []).map((workspace) => (
              <ThreadGroup
                activeThreadRef={activeThreadRef}
                heading={workspace.workspaceName}
                key={workspace.workspaceId}
                onDelete={handleDelete}
                onOpenChange={setIsOpen}
                threads={workspace.threads.map((thread) => ({
                  createdAt: thread.createdAt,
                  ref: {
                    scope: "workspace",
                    threadId: thread.id,
                    workspaceId: workspace.workspaceId,
                  } as const,
                  title: thread.title,
                }))}
              />
            ))}
          </div>
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
};

type ThreadGroupProps = {
  activeThreadRef: ChatThreadRef | null;
  emptyLabel?: string | undefined;
  heading: string;
  onDelete: (threadRef: ChatThreadRef) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  threads: {
    createdAt: string | Date;
    ref: ChatThreadRef;
    title: string;
  }[];
};

const ThreadGroup = ({
  activeThreadRef,
  emptyLabel,
  heading,
  onDelete,
  onOpenChange,
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
        const target = getThreadLinkTarget(thread.ref);

        return (
          <div
            className={cn(
              "group flex items-center gap-1 rounded-lg transition-colors",
              isSameThread(activeThreadRef, thread.ref)
                ? "bg-muted"
                : "hover:bg-muted",
            )}
            key={`${thread.ref.scope}-${thread.ref.threadId}`}
          >
            <Link
              className="flex flex-1 flex-col gap-0.5 overflow-hidden px-3 py-2 text-start"
              onClick={() => onOpenChange(false)}
              params={target.params}
              to={target.to}
            >
              <span className="truncate text-sm font-medium">
                {thread.title}
              </span>
              <span className="text-muted-foreground text-xs">
                {new Date(thread.createdAt).toLocaleDateString()}
              </span>
            </Link>
            <Button
              aria-label={`${heading}-${thread.title}`}
              className="me-1 opacity-0 group-hover:opacity-100"
              onClick={async () => await onDelete(thread.ref)}
              size="icon-sm"
              variant="ghost"
            >
              <TrashIcon />
            </Button>
          </div>
        );
      })}
    </div>
  );
};

const isSameThread = (
  left: ChatThreadRef | null,
  right: ChatThreadRef,
): boolean => {
  if (!left) {
    return false;
  }

  if (left.scope !== right.scope || left.threadId !== right.threadId) {
    return false;
  }

  if (left.scope === "global" && right.scope === "global") {
    return true;
  }

  return left.scope === "workspace" && right.scope === "workspace"
    ? left.workspaceId === right.workspaceId
    : false;
};
