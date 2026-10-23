import { useId, useMemo, useState } from "react";

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useDebouncedCallback } from "use-debounce";
import { useNow, useTimeZone, useTranslations } from "use-intl";

import { SEARCH_QUERY_MAX_LENGTH } from "@stll/api-contract/limits";
import { Temporal } from "@stll/time";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { NewChatIcon, TrashIcon } from "@stll/ui/icons";
import {
  List,
  ListGroup,
  ListGroupHeader,
  ListGroupHeading,
  ListGroupTitle,
  ListItem,
  ListItemActions,
} from "@stll/ui/list";
import { ScrollArea } from "@stll/ui/scroll-area";
import { SearchField } from "@stll/ui/search-field";
import { Skeleton } from "@stll/ui/skeleton";

import {
  ChatThreadDecisionLabel,
  drawableChatThreadDecision,
  useOpenChatThreadDecision,
} from "@/components/chat/chat-thread-decision";
import { ChatThreadOriginPrefix } from "@/components/chat/chat-thread-origin-prefix";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import Tooltip from "@/components/tooltip";
import {
  MatterCombobox,
  toMatterOption,
} from "@/components/workspaces/matter-combobox";
import type { MatterOption } from "@/components/workspaces/matter-combobox";
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
import { useFormatter, useRelativeTime } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { api } from "@/lib/api";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { isPlaceholderThreadTitle } from "@/lib/chat-thread-title";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { MEDIUM_DATE_SHORT_TIME_FORMAT } from "@/lib/relative-time";
import { toSafeId } from "@/lib/safe-id";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";

import {
  CHAT_HISTORY_PERIOD,
  groupChatHistoryByPeriod,
  hasChatHistoryFilter,
  initialSearchFieldState,
  isMatterUnavailable,
  isStaleSearchWrite,
  syncSearchField,
} from "./chat-history.logic";
import type {
  ChatHistoryPeriod,
  ChatHistorySearch,
} from "./chat-history.logic";
import { ThreadContextLine, ThreadContextTooltip } from "./thread-context-line";
import { layoutThreadContext } from "./thread-context-line.logic";

const SEARCH_DEBOUNCE_MS = 250;
const SKELETON_ROW_COUNT = 6;

const PERIOD_LABEL = {
  [CHAT_HISTORY_PERIOD.today]: "common.today",
  [CHAT_HISTORY_PERIOD.previous7Days]: "chat.history.previous7Days",
  [CHAT_HISTORY_PERIOD.older]: "chat.history.older",
} as const satisfies Record<ChatHistoryPeriod, TranslationKey>;

const protectedRouteApi = getRouteApi("/_protected");

type ChatHistoryPageProps = {
  search: ChatHistorySearch;
  onSearchChange: (search: ChatHistorySearch) => void;
};

type DeleteDialog =
  { type: "closed" } | { type: "confirm"; thread: ChatHistoryItem };

/**
 * Every chat the reader has started, newest first, grouped by when it was
 * last active. Search (title, matter, pinned matters) and the matter filter
 * (chats that live in that matter) both run on the server, before paging.
 */
export const ChatHistoryPage = ({
  search,
  onSearchChange,
}: ChatHistoryPageProps) => {
  const t = useTranslations();
  const matterFieldId = useId();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const userId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.id,
  });
  const [searchField, setSearchField] = useState(() =>
    initialSearchFieldState(search.q),
  );
  // A query that reaches the URL from elsewhere (Back, Forward, a link)
  // replaces the field's text, adjusted during render rather than in an
  // effect; the field's own debounced write is recognised and left alone.
  const syncedSearchField = syncSearchField({
    state: searchField,
    urlQuery: search.q,
  });
  if (syncedSearchField !== searchField) {
    setSearchField(syncedSearchField);
  }
  // Each write remembers how many outside queries the field had seen when it
  // was typed; the debounced callback reads the latest field state, so a
  // write that an outside query has overtaken is dropped instead of undoing
  // that navigation.
  const commitQuery = useDebouncedCallback(
    (q: string, scheduledAfter: number) => {
      if (isStaleSearchWrite({ scheduledAfter, state: syncedSearchField })) {
        return;
      }
      const nextQuery = q.trim().length > 0 ? q : undefined;
      setSearchField((field) => ({
        ...field,
        pending: { status: "sent", query: nextQuery },
      }));
      onSearchChange({ ...search, q: nextQuery });
    },
    SEARCH_DEBOUNCE_MS,
  );
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialog>({
    type: "closed",
  });

  const threadsQuery = useInfiniteQuery({
    ...groupedChatThreadsOptions({
      activeOrganizationId,
      search: search.q,
      userId,
      workspaceId: search.matter,
    }),
    // Typing refines the list in place instead of blanking it per keystroke.
    placeholderData: keepPreviousData,
  });
  const threadsView = useQueryView(threadsQuery);
  useQueryViewError(threadsView);
  const matterUnavailable =
    threadsView.type === "error" &&
    isMatterUnavailable({ error: threadsView.error, matter: search.matter });
  // The combobox owns this list's loading and error states; the page only
  // resolves the URL's matter id to a name for it.
  const mattersQuery = useQuery(
    workspacesNavigationOptions({
      organizationId: activeOrganizationId,
      userId,
    }),
  );
  const mattersView = useQueryView(mattersQuery);
  useQueryViewError(mattersView);
  const matters = mattersView.type === "items" ? mattersView.items : undefined;
  // Base UI compares combobox props by identity; hand it one value object per
  // selection rather than a fresh copy on every render.
  const selectedMatter = useMemo(
    () => matterOption(matters?.workspaces, search.matter),
    [matters, search.matter],
  );

  const clearFilters = () => {
    commitQuery.cancel();
    setSearchField((field) => ({
      ...field,
      pending: { status: "sent", query: undefined },
      value: "",
    }));
    onSearchChange({});
  };

  return (
    <ScrollArea axis="vertical" className="min-h-0 w-full flex-1">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
        <h1 className="text-foreground text-lg font-semibold text-balance">
          {t("common.history")}
        </h1>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <SearchField
            aria-label={t("common.search")}
            clearLabel={t("common.clearSearch")}
            maxLength={SEARCH_QUERY_MAX_LENGTH}
            groupClassName="sm:flex-1"
            onValueChange={(value) => {
              setSearchField((field) => ({ ...field, value }));
              commitQuery(value, syncedSearchField.externalChanges);
            }}
            placeholder={t("common.search")}
            value={syncedSearchField.value}
          />
          <div className="flex min-w-0 flex-col gap-1 sm:w-64">
            <label className="sr-only" htmlFor={matterFieldId}>
              {t("common.matter")}
            </label>
            <MatterCombobox
              activeOrganizationId={activeOrganizationId}
              id={matterFieldId}
              // Remounts once the matter named in the URL resolves, so the
              // field opens showing it.
              key={matters === undefined ? "pending" : "ready"}
              onChange={(matter) => {
                onSearchChange({ ...search, matter: matter?.id });
              }}
              userId={userId}
              value={selectedMatter}
            />
          </div>
          {hasChatHistoryFilter(search) ? (
            <Button onClick={clearFilters} variant="ghost">
              {t("common.clearFilters")}
            </Button>
          ) : null}
        </div>
        {threadsView.type === "pending" ? <ChatHistorySkeleton /> : null}
        {matterUnavailable ? (
          <div
            className="text-muted-foreground flex flex-col items-start gap-2.5 px-1 text-sm"
            role="status"
          >
            {t("chat.history.matterUnavailable")}
            <Button
              onClick={() => onSearchChange({ ...search, matter: undefined })}
              size="sm"
              variant="outline"
            >
              {t("workspaces.filters.clear")}
            </Button>
          </div>
        ) : null}
        {threadsView.type !== "pending" && !matterUnavailable ? (
          <QueryViewFeedback view={threadsView} />
        ) : null}
        {threadsView.type === "items" ? (
          <ChatHistoryResults
            hasFilter={hasChatHistoryFilter(search)}
            items={listChatHistoryItems(
              mergeGroupedChatThreadPages(threadsView.items.pages),
            )}
            onClearFilters={clearFilters}
            onDelete={(thread) => setDeleteDialog({ type: "confirm", thread })}
          />
        ) : null}
        {threadsQuery.hasNextPage ? (
          <Button
            className="self-center"
            disabled={threadsQuery.isFetchingNextPage}
            onClick={() => {
              detached(
                threadsQuery.fetchNextPage(),
                "chat-history.fetch-next-page",
              );
            }}
            variant="ghost"
          >
            {threadsQuery.isFetchingNextPage
              ? t("common.loading")
              : t("common.loadMore")}
          </Button>
        ) : null}
      </div>
      <DeleteChatDialog
        dialog={deleteDialog}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteDialog({ type: "closed" });
          }
        }}
      />
    </ScrollArea>
  );
};

type NavigationMatter = Parameters<typeof toMatterOption>[0];

/** The selected matter as the combobox expects it, from the URL's id. */
function matterOption(
  matters: readonly NavigationMatter[] | undefined,
  matterId: string | undefined,
): MatterOption | null {
  if (matterId === undefined || matters === undefined) {
    return null;
  }
  const matter = matters.find(({ id }) => id === matterId);
  return matter === undefined ? null : toMatterOption(matter);
}

type ChatHistoryResultsProps = {
  hasFilter: boolean;
  items: ChatHistoryItem[];
  onClearFilters: () => void;
  onDelete: (thread: ChatHistoryItem) => void;
};

function ChatHistoryResults({
  hasFilter,
  items,
  onClearFilters,
  onDelete,
}: ChatHistoryResultsProps) {
  const t = useTranslations();
  const now = useNow();
  const timeZone = useTimeZone() ?? Temporal.Now.timeZoneId();

  if (items.length === 0) {
    return hasFilter ? (
      <div className="text-muted-foreground flex flex-col items-start gap-2.5 px-1 text-sm">
        {t("common.noResults")}
        <Button onClick={onClearFilters} size="sm" variant="outline">
          {t("common.clearFilters")}
        </Button>
      </div>
    ) : (
      <div className="text-muted-foreground flex flex-col items-start gap-2.5 px-1 text-sm">
        {t("chat.noThreads")}
        <Button render={<Link to="/chat" />} size="sm" variant="outline">
          <NewChatIcon className="size-4" />
          {t("chat.newChat")}
        </Button>
      </div>
    );
  }

  const groups = groupChatHistoryByPeriod({
    items,
    now: Temporal.Instant.fromEpochMilliseconds(now.getTime()),
    timeZone,
  });
  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <ListGroup key={group.period}>
          <ListGroupHeader>
            <ListGroupHeading>
              <ListGroupTitle>{t(PERIOD_LABEL[group.period])}</ListGroupTitle>
            </ListGroupHeading>
          </ListGroupHeader>
          <List>
            {group.items.map((thread) => (
              <ChatHistoryRow
                key={thread.id}
                onDelete={() => onDelete(thread)}
                thread={thread}
              />
            ))}
          </List>
        </ListGroup>
      ))}
    </div>
  );
}

type ChatHistoryRowProps = {
  onDelete: () => void;
  thread: ChatHistoryItem;
};

/**
 * One chat: the title links to it, the line below names where it came from
 * and what it drew on, and the trailing date says when it was last active.
 * Rename and delete stay visible on narrow screens; where there is room they
 * take the date's place on hover or focus.
 */
function ChatHistoryRow({ onDelete, thread }: ChatHistoryRowProps) {
  const t = useTranslations();
  const format = useFormatter();
  const relativeTime = useRelativeTime();
  const openChatThreadDecision = useOpenChatThreadDecision();
  const decision = drawableChatThreadDecision(thread);
  const threadRef = chatHistoryThreadRef(thread);
  const hasContext = layoutThreadContext(thread.context).hasContext;
  const committedTitle = isPlaceholderThreadTitle(thread.title)
    ? ""
    : thread.title;
  const updatedAt = new Date(thread.updatedAt);
  const contextLine = (
    <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 overflow-hidden text-xs font-normal whitespace-nowrap">
      <ChatThreadOriginPrefix origin={thread.origin} />
      {decision === null ? null : (
        <ChatThreadDecisionLabel decision={decision} />
      )}
      <ThreadContextLine context={thread.context} />
    </span>
  );
  const revealClass =
    "md:hidden md:group-focus-within:inline-flex md:group-hover:inline-flex";

  return (
    <ListItem className="group">
      <ChatTitleRename
        editClassName="min-w-0 flex-1 gap-0.5 text-sm font-medium"
        editDescription={contextLine}
        hasMessages
        ownsRenameCommand={false}
        renderView={({
          displayTitle,
          isSuggesting,
          startEditingWithSuggestion,
        }) => (
          <>
            <Tooltip
              content={
                hasContext ? (
                  <ThreadContextTooltip context={thread.context} />
                ) : null
              }
              render={
                <Link
                  className="focus-visible:ring-ring flex min-w-0 flex-1 flex-col gap-0.5 overflow-hidden rounded-md text-start outline-none focus-visible:ring-2"
                  onClick={(event) => {
                    openChatThreadDecision(event, thread);
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
                className="text-foreground truncate text-sm font-medium"
              >
                {displayTitle}
              </BidiText>
              {contextLine}
            </Tooltip>
            <time
              className="text-muted-foreground shrink-0 text-xs tabular-nums md:group-focus-within:hidden md:group-hover:hidden"
              dateTime={updatedAt.toISOString()}
              title={format.dateTime(updatedAt, MEDIUM_DATE_SHORT_TIME_FORMAT)}
            >
              {relativeTime(updatedAt)}
            </time>
            <ChatTitleSuggestButton
              className={revealClass}
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
      <ListItemActions>
        <Button
          aria-label={t("chat.deleteThread")}
          className={revealClass}
          onClick={onDelete}
          size="icon-sm"
          variant="ghost"
        >
          <TrashIcon />
        </Button>
      </ListItemActions>
    </ListItem>
  );
}

function chatHistoryThreadRef(thread: ChatHistoryItem): ChatThreadRef {
  return thread.scope === "workspace"
    ? {
        scope: thread.scope,
        threadId: toChatThreadId(thread.id),
        workspaceId: thread.workspaceId,
      }
    : { scope: thread.scope, threadId: toChatThreadId(thread.id) };
}

type DeleteChatDialogProps = {
  dialog: DeleteDialog;
  onOpenChange: (open: boolean) => void;
};

function DeleteChatDialog({ dialog, onOpenChange }: DeleteChatDialogProps) {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const deleteThread = useMutation({
    mutationFn: async (thread: ChatHistoryItem) => {
      const response = await api.chat
        .threads({ threadId: toChatThreadId(thread.id) })
        .delete(
          {},
          {
            query:
              thread.scope === "workspace"
                ? { workspaceId: toSafeId<"workspace">(thread.workspaceId) }
                : {},
          },
        );
      unwrapApiResponse(response);
    },
    onError: (error) => {
      notifyUserError(error, t("errors.actionFailed"));
    },
    onSettled: async (_data, _error, thread) => {
      await invalidateChatThreadLists({
        queryClient,
        workspaceId:
          thread.scope === "workspace" ? thread.workspaceId : undefined,
      });
    },
    onSuccess: () => {
      onOpenChange(false);
    },
  });
  const thread = dialog.type === "confirm" ? dialog.thread : null;
  const name =
    thread === null || isPlaceholderThreadTitle(thread.title)
      ? t("chat.newChat")
      : thread.title;

  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open && !deleteThread.isPending) {
          onOpenChange(false);
        }
      }}
      open={thread !== null}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("chat.deleteThread")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("common.deleteConfirmDescription", { name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose
            disabled={deleteThread.isPending}
            render={
              <Button disabled={deleteThread.isPending} variant="ghost" />
            }
          >
            {t("common.cancel")}
          </AlertDialogClose>
          <Button
            loading={deleteThread.isPending}
            onClick={() => {
              if (thread !== null) {
                deleteThread.mutate(thread);
              }
            }}
            variant="destructive"
          >
            {t("common.delete")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function ChatHistorySkeleton() {
  const t = useTranslations();
  return (
    <div className="flex flex-col gap-6">
      <span className="sr-only" role="status">
        {t("common.loading")}
      </span>
      <ListGroup aria-hidden="true">
        <ListGroupHeader>
          <Skeleton className="h-4 w-24" />
        </ListGroupHeader>
        <List>
          {Array.from({ length: SKELETON_ROW_COUNT }, (_, row) => (
            <li className="flex min-h-14 items-center gap-3 px-4" key={row}>
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-56 max-w-full" />
                <Skeleton className="h-3 w-40 max-w-full" />
              </div>
              <Skeleton className="h-3 w-12" />
            </li>
          ))}
        </List>
      </ListGroup>
    </div>
  );
}
