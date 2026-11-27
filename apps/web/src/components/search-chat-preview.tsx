import { useMemo, useRef, useState } from "react";

import type { PluggableList } from "unified";

import { useExternalSyncEffect, useKeyedState } from "@stll/ui/effects";
import { useObservedValue } from "@stll/ui/effects-dom";
import { SEARCH_HIT_MARK, textMarkClass } from "@stll/ui/text-mark";

import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  allocateSearchMatchBudgets,
  rehypeSearchMatches,
} from "@/components/chat/rehype-search-matches";
import { SearchMatchControls } from "@/components/search-match-controls";
import {
  getAdjacentSearchMatchIndex,
  getCenteredSearchMatchScrollTop,
  MAX_SEARCH_PREVIEW_MATCHES,
  readScrollPaddingBlockEnd,
  type SearchMatchSummary,
} from "@/lib/search-match-navigation";
import { searchTextQueryKey } from "@/lib/search-text";
import type { SearchTextQuery } from "@/lib/search-text";
import type { SearchPreviewChatMessage } from "@/lib/search.logic";

type SearchChatPreviewProps = {
  messages: SearchPreviewChatMessage[];
  searchText: SearchTextQuery;
};

type RenderedMatches = SearchMatchSummary & {
  /** Bumped on every change to the rendered messages, so the active match
   *  is marked again on the new nodes. */
  revision: number;
};

const NO_RENDERED_MATCHES: RenderedMatches = {
  count: 0,
  truncated: false,
  revision: 0,
};

// Shared by every preview, so a reading never repeats an earlier revision.
let lastMatchRevision = 0;

export const SearchChatPreview = ({
  messages,
  searchText,
}: SearchChatPreviewProps) => {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const lastScrolledMatchRef = useRef<{
    searchTextKey: string;
    match: Element;
  } | null>(null);
  const searchTextKey = searchTextQueryKey(searchText);
  // A new search starts at its first match.
  const [activeIndex, setActiveIndex] = useKeyedState(searchTextKey, 0);
  // oxlint-disable-next-line no-manual-memo/no-manual-memo -- load-bearing, without this memo boundary the React Compiler does not cache this value
  const rehypePluginsByMessage = useMemo<PluggableList[]>(() => {
    // Allocate immutable per-message budgets from the same matcher before
    // rendering. Their sum is globally bounded while each transform remains
    // deterministic under Strict Mode and concurrent replays.
    const budgets = allocateSearchMatchBudgets({
      contents: messages.map(({ content }) => content),
      maxMatches: MAX_SEARCH_PREVIEW_MATCHES + 1,
      searchText,
    });
    return messages.map((_, index) => [
      [rehypeSearchMatches, { maxMatches: budgets[index] ?? 0, searchText }],
    ]);
  }, [messages, searchText]);

  const renderedMatches = useObservedValue<HTMLDivElement, RenderedMatches>(
    root,
    (observed, emit) => {
      const read = () => {
        const total = observed.querySelectorAll("[data-search-match]").length;
        lastMatchRevision += 1;
        emit({
          count: Math.min(total, MAX_SEARCH_PREVIEW_MATCHES),
          truncated: total > MAX_SEARCH_PREVIEW_MATCHES,
          revision: lastMatchRevision,
        });
      };
      read();
      const observer = new MutationObserver(read);
      observer.observe(observed, { childList: true, subtree: true });
      return () => observer.disconnect();
    },
    [rehypePluginsByMessage],
    NO_RENDERED_MATCHES,
  );
  const matchSummary: SearchMatchSummary = {
    count: renderedMatches.count,
    truncated: renderedMatches.truncated,
  };
  // The index stays inside the matches the messages render now.
  const shownIndex =
    matchSummary.count === 0
      ? 0
      : Math.min(activeIndex, matchSummary.count - 1);

  useExternalSyncEffect(() => {
    if (!root) {
      return;
    }
    const matches = [
      ...root.querySelectorAll<HTMLElement>("[data-search-match]"),
    ].slice(0, MAX_SEARCH_PREVIEW_MATCHES);
    for (const [index, match] of matches.entries()) {
      match.className = textMarkClass({
        ...SEARCH_HIT_MARK,
        state: index === shownIndex ? "active" : "rest",
      });
    }
    const activeMatch = matches.at(shownIndex);
    const lastScrolled = lastScrolledMatchRef.current;
    if (
      !activeMatch ||
      (lastScrolled?.searchTextKey === searchTextKey &&
        lastScrolled.match === activeMatch)
    ) {
      return;
    }
    const scrollArea = activeMatch.closest<HTMLElement>(
      '[data-slot="search-preview-scroll-area"]',
    );
    if (!scrollArea) {
      return;
    }
    const containerRect = scrollArea.getBoundingClientRect();
    const matchRect = activeMatch.getBoundingClientRect();
    scrollArea.scrollTo({
      top: getCenteredSearchMatchScrollTop({
        containerHeight: containerRect.height,
        containerTop: containerRect.top,
        currentScrollTop: scrollArea.scrollTop,
        matchHeight: matchRect.height,
        matchTop: matchRect.top,
        obscuredBlockEnd: readScrollPaddingBlockEnd(scrollArea),
      }),
    });
    lastScrolledMatchRef.current = { searchTextKey, match: activeMatch };
  }, [root, searchTextKey, shownIndex, renderedMatches]);

  const navigate = (direction: "next" | "previous") => {
    setActiveIndex(
      getAdjacentSearchMatchIndex({
        activeIndex: shownIndex,
        direction,
        matchCount: matchSummary.count,
      }),
    );
  };

  return (
    <div ref={setRoot} className="space-y-5">
      {matchSummary.count > 0 && (
        <div className="bg-background/90 sticky top-0 z-10 ms-auto flex w-fit rounded-md border p-0.5 shadow-sm backdrop-blur">
          <SearchMatchControls
            activeIndex={shownIndex}
            matchCount={matchSummary.count}
            onNext={() => navigate("next")}
            onPrevious={() => navigate("previous")}
            truncated={matchSummary.truncated}
          />
        </div>
      )}
      {messages.map((message, index) => {
        const rehypePlugins = rehypePluginsByMessage.at(index);
        return (
          <Message from={message.role} key={message.id}>
            <MessageContent>
              <MessageResponse
                {...(rehypePlugins === undefined ? {} : { rehypePlugins })}
              >
                {message.content}
              </MessageResponse>
            </MessageContent>
          </Message>
        );
      })}
    </div>
  );
};
