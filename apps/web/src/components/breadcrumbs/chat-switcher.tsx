import { useState } from "react";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@stll/ui/command";
import { CheckIcon, ChevronDownIcon } from "@stll/ui/icons";
import { MatterIcon } from "@stll/ui/matter-icon";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import {
  Tooltip as TooltipRoot,
  TooltipPopup,
  TooltipTrigger,
} from "@stll/ui/tooltip";
import { TruncatedText } from "@stll/ui/truncated-text";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import {
  type ChatHistoryItem,
  groupedChatThreadsOptions,
  listChatHistoryItems,
  mergeGroupedChatThreadPages,
} from "@/features/chat/queries";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { isPlaceholderThreadTitle } from "@/lib/chat-thread-title";
import { detached } from "@/lib/detached";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";
import { workspacesNavigationOptions } from "@/lib/workspaces/queries";

/** How long typing settles before the switcher asks the server again. */
const SEARCH_DEBOUNCE_MS = 200;
/**
 * The most recent chats listed: as many as the popup shows without
 * scrolling, so All chats stays in view; the history holds the rest.
 */
const RECENT_CHAT_LIMIT = 8;

type ChatSwitcherProps = {
  threadId: string;
};

/**
 * The breadcrumb's caret beside the chat title: the member's recent chats,
 * the same list and scope the chat history shows, searchable and walked
 * with the keyboard, the current one checked, and last a way to the whole
 * history. The list loads only once the popover opens.
 */
export const ChatSwitcher = ({ threadId }: ChatSwitcherProps) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const commitSearch = useDebouncedCallback(setSearch, SEARCH_DEBOUNCE_MS);
  const threadsView = queryView(
    useInfiniteQuery({
      ...groupedChatThreadsOptions({ activeOrganizationId, search, userId }),
      enabled: open,
    }),
  );
  useQueryViewError(threadsView, "ChatSwitcher:query");
  // The sidebar's matter list, for each matter chat's colour.
  const mattersView = queryView(
    useQuery({
      ...workspacesNavigationOptions({
        organizationId: activeOrganizationId,
        userId,
      }),
      enabled: open,
    }),
  );
  const matterColor = (workspaceId: string) =>
    mattersView.type === "items"
      ? (mattersView.items.workspaces.find(({ id }) => id === workspaceId)
          ?.color ?? null)
      : null;
  const chats =
    threadsView.type === "items"
      ? listChatHistoryItems(
          mergeGroupedChatThreadPages(threadsView.items.pages),
        ).slice(0, RECENT_CHAT_LIMIT)
      : [];
  const label = t("chat.switcher.trigger");

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery("");
      commitSearch.cancel();
      setSearch("");
    }
  };

  const switchToChat = (chat: ChatHistoryItem) => {
    changeOpen(false);
    if (chat.id === threadId) {
      return;
    }
    detached(
      chat.scope === "workspace"
        ? navigate({
            to: "/chat/workspaces/$workspaceId/$threadId",
            params: { threadId: chat.id, workspaceId: chat.workspaceId },
          })
        : navigate({
            to: "/chat/$threadId",
            params: { threadId: chat.id },
          }),
      "chat-switcher.navigate",
    );
  };

  const openHistory = () => {
    changeOpen(false);
    detached(navigate({ to: "/chat/history" }), "chat-switcher.history");
  };

  return (
    <Popover onOpenChange={changeOpen} open={open}>
      <TooltipRoot>
        <PopoverTrigger
          render={
            <TooltipTrigger
              render={
                <Button aria-label={label} size="icon-xs" variant="ghost" />
              }
            />
          }
        >
          <ChevronDownIcon />
        </PopoverTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </TooltipRoot>
      <PopoverPopup align="start" className="w-80" padding="none">
        <Command
          mode="none"
          onValueChange={(next) => {
            setQuery(next);
            commitSearch(next.trim());
          }}
          value={query}
        >
          <div className="border-b px-2.5 py-2">
            <CommandInput
              aria-label={label}
              autoFocus
              placeholder={t("chat.switcher.searchPlaceholder")}
              size="sm"
            />
          </div>
          <CommandList>
            <div className="p-1">
              {threadsView.type !== "items" ||
              threadsView.refetchError !== undefined ? (
                <div className="px-2 py-1.5">
                  <QueryViewFeedback view={threadsView} />
                </div>
              ) : null}
              {threadsView.type === "items" && chats.length === 0 ? (
                <p className="text-muted-foreground px-2 py-1.5 text-sm">
                  {t("common.noResults")}
                </p>
              ) : null}
              {chats.map((chat) => {
                const isCurrent = chat.id === threadId;
                return (
                  <CommandItem
                    aria-current={isCurrent ? "page" : undefined}
                    key={chat.id}
                    onClick={() => switchToChat(chat)}
                    value={chat.id}
                  >
                    <TruncatedText render={<BidiText as="span" />}>
                      {isPlaceholderThreadTitle(chat.title)
                        ? t("chat.newChat")
                        : chat.title}
                    </TruncatedText>
                    {chat.scope === "workspace" ? (
                      <MatterIcon
                        className="size-3.5 shrink-0"
                        matter={{
                          id: chat.workspaceId,
                          color: matterColor(chat.workspaceId),
                        }}
                      />
                    ) : null}
                    {chat.scope === "workspace" ? (
                      <TruncatedText
                        className="text-muted-foreground max-w-28 shrink-0 text-xs"
                        render={<BidiText as="span" />}
                      >
                        {chat.workspaceName}
                      </TruncatedText>
                    ) : null}
                    {isCurrent ? (
                      <CheckIcon className="ms-auto shrink-0" />
                    ) : null}
                  </CommandItem>
                );
              })}
              <CommandSeparator className="my-1" />
              <CommandItem onClick={openHistory} value="__all-chats__">
                <TruncatedText>{t("chat.switcher.allChats")}</TruncatedText>
              </CommandItem>
            </div>
          </CommandList>
        </Command>
      </PopoverPopup>
    </Popover>
  );
};
