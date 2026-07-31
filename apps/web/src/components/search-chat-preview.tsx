import { useCallback, useMemo, useRef, useState } from "react";

import type { PluggableList } from "unified";

import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import { rehypeSearchMatches } from "@/components/chat/rehype-search-matches";
import { SearchMatchControls } from "@/components/search-match-controls";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import {
  getAdjacentSearchMatchIndex,
  getCenteredSearchMatchScrollTop,
  MAX_SEARCH_PREVIEW_MATCHES,
  type SearchMatchSummary,
} from "@/lib/search-match-navigation";
import { searchTextQueryKey } from "@/lib/search-text";
import type { SearchTextQuery } from "@/lib/search-text";
import type { SearchPreviewChatMessage } from "@/lib/search.logic";

type SearchChatPreviewProps = {
  messages: SearchPreviewChatMessage[];
  searchText: SearchTextQuery;
};

const EMPTY_MATCH_SUMMARY: SearchMatchSummary = {
  count: 0,
  truncated: false,
};

export const SearchChatPreview = ({
  messages,
  searchText,
}: SearchChatPreviewProps) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const lastScrolledMatchRef = useRef<Element | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [domRevision, setDomRevision] = useState(0);
  const [matchSummary, setMatchSummary] =
    useState<SearchMatchSummary>(EMPTY_MATCH_SUMMARY);
  const searchTextKey = searchTextQueryKey(searchText);
  const rehypePluginsByMessage = useMemo<PluggableList[]>(() => {
    // The API bounds both message count and total preview characters. Keep the
    // transform cap immutable per message so Strict Mode/concurrent replays
    // cannot inherit a consumed budget; the DOM summary applies the global cap.
    return messages.map(() => [
      [
        rehypeSearchMatches,
        { maxMatches: MAX_SEARCH_PREVIEW_MATCHES + 1, searchText },
      ],
    ]);
  }, [messages, searchText]);

  useExternalSyncEffect(() => {
    setActiveIndex(0);
    lastScrolledMatchRef.current = null;
  }, [searchTextKey]);

  useExternalSyncEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return undefined;
    }

    const syncMatchSummary = () => {
      const total = root.querySelectorAll("[data-search-match]").length;
      const next = {
        count: Math.min(total, MAX_SEARCH_PREVIEW_MATCHES),
        truncated: total > MAX_SEARCH_PREVIEW_MATCHES,
      };
      setMatchSummary((current) =>
        current.count === next.count && current.truncated === next.truncated
          ? current
          : next,
      );
      setDomRevision((current) => current + 1);
    };
    syncMatchSummary();
    const observer = new MutationObserver(syncMatchSummary);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [rehypePluginsByMessage]);

  useExternalSyncEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const matches = [
      ...root.querySelectorAll<HTMLElement>("[data-search-match]"),
    ].slice(0, MAX_SEARCH_PREVIEW_MATCHES);
    const clampedIndex =
      matches.length === 0 ? 0 : Math.min(activeIndex, matches.length - 1);
    if (clampedIndex !== activeIndex) {
      setActiveIndex(clampedIndex);
      return;
    }

    for (const [index, match] of matches.entries()) {
      if (index === clampedIndex) {
        match.dataset["active"] = "true";
      } else {
        delete match.dataset["active"];
      }
    }
    const activeMatch = matches.at(clampedIndex);
    if (!activeMatch || lastScrolledMatchRef.current === activeMatch) {
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
      }),
    });
    lastScrolledMatchRef.current = activeMatch;
  }, [activeIndex, domRevision, matchSummary.count]);

  const navigate = useCallback(
    (direction: "next" | "previous") => {
      setActiveIndex((current) =>
        getAdjacentSearchMatchIndex({
          activeIndex: current,
          direction,
          matchCount: matchSummary.count,
        }),
      );
    },
    [matchSummary.count],
  );

  return (
    <div
      ref={rootRef}
      className="[&_[data-search-match]]:bg-highlight/45 [&_[data-search-match][data-active=true]]:bg-highlight/90 space-y-5 [&_[data-search-match]]:text-inherit"
    >
      {matchSummary.count > 0 && (
        <div className="bg-background/90 sticky top-0 z-10 ms-auto flex w-fit rounded-md border p-0.5 shadow-sm backdrop-blur">
          <SearchMatchControls
            activeIndex={activeIndex}
            matchCount={matchSummary.count}
            onNext={() => navigate("next")}
            onPrevious={() => navigate("previous")}
            truncated={matchSummary.truncated}
          />
        </div>
      )}
      {messages.map((message, index) => (
        <Message from={message.role} key={message.id}>
          <MessageContent>
            <MessageResponse rehypePlugins={rehypePluginsByMessage[index]}>
              {message.content}
            </MessageResponse>
          </MessageContent>
        </Message>
      ))}
    </div>
  );
};
