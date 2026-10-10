import { useState } from "react";
import type { ReactNode } from "react";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  getRouteApi,
  Link,
  useMatch,
  useNavigate,
} from "@tanstack/react-router";
import { useDebounce } from "use-debounce";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { HistoryIcon, TrashIcon } from "@stll/ui/icons";
import { InputGroup, InputGroupInput } from "@stll/ui/input-group";
import { LANDING_SECTION_HEADING_CLASS } from "@stll/ui/landing";
import {
  Sheet,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
  SheetTrigger,
} from "@stll/ui/sheet";
import { cn } from "@stll/ui/utils";

import {
  ChatThreadDecisionLabel,
  drawableChatThreadDecision,
  useOpenChatThreadDecision,
} from "@/components/chat/chat-thread-decision";
import { ChatThreadOriginPrefix } from "@/components/chat/chat-thread-origin-prefix";
import Tooltip from "@/components/tooltip";
import {
  ChatTitleRename,
  ChatTitleSuggestButton,
} from "@/features/chat/components/chat-title-rename";
import {
  groupedChatThreadsOptions,
  invalidateChatThreadLists,
  listChatHistoryItems,
  mergeGroupedChatThreadPages,
} from "@/features/chat/queries";
import type { ChatHistoryItem } from "@/features/chat/queries";
import { useFormatter } from "@/i18n/formatting-context";
import { api } from "@/lib/api";
import type { ChatThreadId, ChatThreadRef } from "@/lib/chat-thread-ref";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { isPlaceholderThreadTitle } from "@/lib/chat-thread-title";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import type { SafeId } from "@/lib/safe-id";
import { toSafeId } from "@/lib/safe-id";

import { ThreadContextLine, ThreadContextTooltip } from "./thread-context-line";
import { layoutThreadContext } from "./thread-context-line.logic";

type ThreadsSheetProps = {
  icon?: ReactNode;
  label?: string | undefined;
  triggerVariant?: "section" | "toolbar";
};

const protectedRouteApi = getRouteApi("/_protected");

export const ThreadsSheet = ({
  icon,
  label,
  triggerVariant = "toolbar",
}: ThreadsSheetProps) => {
  const t = useTranslations();
  const commonT = useTranslations("common");
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch] = useDebounce(search, 250);
  const triggerLabel = label ?? commonT("history");
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const userId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.id,
  });

  const globalThreadMatch = useMatch({
    from: "/_protected/chat/$threadId",
    shouldThrow: false,
  });
  const workspaceThreadMatch = useMatch({
    from: "/_protected/chat/workspaces/$workspaceId/$threadId",
    shouldThrow: false,
  });

  const activeThreadRef: ChatThreadRef | null = (() => {
    if (workspaceThreadMatch) {
      return {
        scope: "workspace",
        workspaceId: workspaceThreadMatch.params.workspaceId,
        threadId: toChatThreadId(workspaceThreadMatch.params.threadId),
      };
    }
    if (globalThreadMatch) {
      return {
        scope: "global",
        threadId: toChatThreadId(globalThreadMatch.params.threadId),
      };
    }
    return null;
  })();

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetching,
    isFetchingNextPage,
    isPending,
    refetch,
  } = useInfiniteQuery(
    groupedChatThreadsOptions({
      activeOrganizationId,
      search: debouncedSearch,
      userId,
    }),
  );
  const groupedThreads = mergeGroupedChatThreadPages(data?.pages);
  const historyItems = listChatHistoryItems(groupedThreads);
  const emptyLabel = (() => {
    if (isPending) {
      return commonT("loading");
    }
    if (debouncedSearch.trim().length > 0) {
      return commonT("noResults");
    }
    return t("chat.noThreads");
  })();
  const threadListState: ThreadListState = (() => {
    if (isError && historyItems.length === 0) {
      return {
        isRetrying: isFetching,
        onRetry: () => {
          detached(refetch(), "threads-sheet.refetch");
        },
        status: "error",
      };
    }
    return { emptyLabel, status: "ready" };
  })();

  return (
    <Sheet onOpenChange={setIsOpen} open={isOpen}>
      {triggerVariant === "section" ? (
        <SheetTrigger
          render={
            <button className={LANDING_SECTION_HEADING_CLASS} type="button" />
          }
        >
          {icon ?? <HistoryIcon className="size-4" />}
          {triggerLabel}
        </SheetTrigger>
      ) : (
        <SheetTrigger
          render={
            <Button aria-label={triggerLabel} size="icon-sm" variant="ghost" />
          }
        >
          <HistoryIcon className="size-4" />
        </SheetTrigger>
      )}
      <SheetPopup side="inline-end">
        <SheetHeader>
          <SheetTitle>{triggerLabel}</SheetTitle>
        </SheetHeader>
        <SheetPanel>
          <div className="flex flex-col gap-4">
            <InputGroup className="bg-background sticky top-0 z-10">
              <InputGroupInput
                aria-label={commonT("search")}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={commonT("search")}
                type="search"
                value={search}
              />
            </InputGroup>
            <ThreadList
              activeThreadRef={activeThreadRef}
              onOpenChange={setIsOpen}
              state={threadListState}
              threads={historyItems}
            />
            {hasNextPage ? (
              <Button
                className="self-center"
                disabled={isFetchingNextPage}
                onClick={() => {
                  detached(fetchNextPage(), "threads-sheet.fetch-next-page");
                }}
                size="sm"
                variant="ghost"
              >
                {isFetchingNextPage ? commonT("loading") : commonT("loadMore")}
              </Button>
            ) : null}
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
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const userId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.id,
  });

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
    onSettled: async (_data, error, variables) => {
      if (error) {
        await queryClient.invalidateQueries({
          queryKey: groupedChatThreadsOptions({
            activeOrganizationId,
            userId,
          }).queryKey,
        });
        return;
      }
      await invalidateChatThreadLists({
        queryClient,
        workspaceId: variables.workspaceId,
      });
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
    onSuccess: async (_data, variables) => {
      if (activeThreadRef?.threadId === variables.threadId) {
        await navigate({ to: "/chat" });
      }
    },
  });

  return (
    <Button
      aria-label={t("chat.deleteThread")}
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

type ThreadListState =
  | {
      isRetrying: boolean;
      onRetry: () => void;
      status: "error";
    }
  | {
      emptyLabel: string;
      status: "ready";
    };

type ThreadListProps = {
  activeThreadRef: ChatThreadRef | null;
  onOpenChange: (open: boolean) => void;
  state: ThreadListState;
  threads: ChatHistoryItem[];
};

const ThreadList = ({
  activeThreadRef,
  onOpenChange,
  state,
  threads,
}: ThreadListProps) => {
  const t = useTranslations();

  if (state.status === "error") {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-4">
        <p className="text-muted-foreground text-center text-sm">
          {t("common.somethingWentWrong")}
        </p>
        <Button
          disabled={state.isRetrying}
          onClick={state.onRetry}
          size="sm"
          variant="outline"
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <p className="text-muted-foreground py-4 text-center text-sm">
        {state.emptyLabel}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {threads.map((thread) => (
        <ThreadRow
          activeThreadRef={activeThreadRef}
          key={thread.id}
          onOpenChange={onOpenChange}
          thread={thread}
        />
      ))}
    </div>
  );
};

type ThreadRowProps = {
  activeThreadRef: ChatThreadRef | null;
  onOpenChange: (open: boolean) => void;
  thread: ChatHistoryItem;
};

const ThreadRow = ({
  activeThreadRef,
  onOpenChange,
  thread,
}: ThreadRowProps) => {
  const format = useFormatter();
  const openChatThreadDecision = useOpenChatThreadDecision();
  const decision = drawableChatThreadDecision(thread);
  const threadRef: ChatThreadRef =
    thread.scope === "workspace"
      ? {
          scope: thread.scope,
          threadId: toChatThreadId(thread.id),
          workspaceId: thread.workspaceId,
        }
      : {
          scope: thread.scope,
          threadId: toChatThreadId(thread.id),
        };
  const hasContext = layoutThreadContext(thread.context).hasContext;
  const committedTitle = isPlaceholderThreadTitle(thread.title)
    ? ""
    : thread.title;
  const contextLine = (
    <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs font-normal whitespace-nowrap">
      <ChatThreadOriginPrefix origin={thread.origin} />
      {decision === null ? null : (
        <ChatThreadDecisionLabel decision={decision} />
      )}
      <ThreadContextLine context={thread.context} />
      <span className="shrink-0 tabular-nums">
        {format.dateTime(new Date(thread.updatedAt).getTime())}
      </span>
    </span>
  );
  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-lg",
        activeThreadRef?.threadId === threadRef.threadId
          ? "bg-muted"
          : "hover:bg-muted",
      )}
    >
      {/* Rename lives on the row itself: the wand opens inline editing
          prefilled with a suggestion, replacing the navigation link until
          committed or cancelled. Listed threads always have messages. */}
      <ChatTitleRename
        editClassName="min-w-0 flex-1 gap-0.5 px-3 py-2 text-sm font-medium"
        editDescription={contextLine}
        hasMessages
        ownsRenameCommand={false}
        renderView={({
          displayTitle,
          isSuggesting,
          startEditingWithSuggestion,
        }) => (
          <>
            {/* The link owns the context tooltip, so hovering the row and
                focusing it with the keyboard both reveal the full list. */}
            <Tooltip
              content={
                hasContext ? (
                  <ThreadContextTooltip context={thread.context} />
                ) : null
              }
              render={
                <Link
                  className="flex flex-1 flex-col gap-0.5 overflow-hidden px-3 py-2 text-start"
                  onClick={(event) => {
                    openChatThreadDecision(event, thread);
                    onOpenChange(false);
                  }}
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
                />
              }
            >
              <BidiText
                as="span"
                className="overflow-hidden text-sm font-medium text-ellipsis whitespace-pre"
              >
                {displayTitle}
              </BidiText>
              {/* One line that never wraps: provenance, the matters and files
                  the chat drew on (chips truncate, the rest fold into "+N"),
                  then the date, which always stays visible. A matter chat's
                  own matter leads the context, so it is not repeated. */}
              {contextLine}
            </Tooltip>
            <ChatTitleSuggestButton
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              hasMessages
              isPending={isSuggesting}
              onTrigger={startEditingWithSuggestion}
              usedAnonymization={thread.usedAnonymization}
            />
          </>
        )}
        threadRef={threadRef}
        title={committedTitle}
        usedAnonymization={thread.usedAnonymization}
      />
      <DeleteThreadButton
        activeThreadRef={activeThreadRef}
        threadRef={threadRef}
      />
    </div>
  );
};
