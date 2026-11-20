import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DocumentIdentityBadge } from "@stll/ui/document-identity-badge";
import { SEARCH_HIT_MARK, TextMark } from "@stll/ui/text-mark";

import {
  StatuteSearchResultRow,
  StatuteSearchResultsPending,
  StatuteSearchResultsSection,
} from "@/features/statutes/components/statute-search-results.pending";
import type { StatuteSearchHit } from "@/features/statutes/queries/statutes";
import { statuteDocumentIdentity } from "@/lib/legal/statute-act-number";

const decodeSearchText = (text: string): string =>
  text.replace(/&(amp|lt|gt|quot|#x27);/gu, (entity) => {
    switch (entity) {
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&#x27;":
        return "'";
      default:
        return entity;
    }
  });

/** Offsets identify runs in the source; only exact engine mark delimiters count. */
const snippetSegments = (headline: string) => {
  const segments: { start: number; text: string; type: "text" | "match" }[] =
    [];
  let start = 0;
  let type: "text" | "match" = "text";
  for (const delimiter of headline.matchAll(/<mark>|<\/mark>/gu)) {
    if (delimiter.index > start) {
      segments.push({
        start,
        text: decodeSearchText(headline.slice(start, delimiter.index)),
        type,
      });
    }
    type = delimiter[0] === "<mark>" ? "match" : "text";
    start = delimiter.index + delimiter[0].length;
  }
  if (start < headline.length) {
    segments.push({
      start,
      text: decodeSearchText(headline.slice(start)),
      type,
    });
  }
  return segments;
};

/** Every publisher character is a React child, never an HTML insertion. */
export const StatuteSearchSnippet = ({ headline }: { headline: string }) => (
  <p className="text-muted-foreground text-sm whitespace-pre-line">
    {snippetSegments(headline).map((segment) =>
      segment.type === "match" ? (
        <TextMark key={segment.start} {...SEARCH_HIT_MARK}>
          {segment.text}
        </TextMark>
      ) : (
        <span key={segment.start}>{segment.text}</span>
      ),
    )}
  </p>
);

type StatuteSearchResultsProps = {
  hits: readonly StatuteSearchHit[];
  isLoading: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  onLoadMore: () => void;
  titleLink: (hit: StatuteSearchHit) => ReactNode;
};

export const StatuteSearchResults = ({
  hits,
  isLoading,
  isFetchingNextPage,
  hasNextPage,
  onLoadMore,
  titleLink,
}: StatuteSearchResultsProps) => {
  const t = useTranslations();
  if (isLoading) {
    return <StatuteSearchResultsPending label={t("common.loading")} />;
  }
  if (hits.length === 0) {
    return (
      <p role="status" className="text-muted-foreground p-4 text-sm">
        {t("common.noResults")}
      </p>
    );
  }
  return (
    <StatuteSearchResultsSection
      busy={isFetchingNextPage}
      rows={hits.map((hit) => (
        <StatuteSearchResultRow
          key={hit.documentId}
          heading={
            <>
              <DocumentIdentityBadge
                identity={statuteDocumentIdentity(hit.eli)}
                title={hit.title}
              />
              {titleLink(hit)}
            </>
          }
          snippet={
            hit.headline === null ? null : (
              <StatuteSearchSnippet headline={hit.headline} />
            )
          }
        />
      ))}
      trailing={
        hasNextPage && (
          <Button
            disabled={isFetchingNextPage}
            onClick={onLoadMore}
            variant="ghost"
          >
            {isFetchingNextPage ? t("common.loading") : t("common.loadMore")}
          </Button>
        )
      }
    />
  );
};
