import { createContext, use } from "react";
import type { ReactNode } from "react";

import { splitByMatch } from "@/components/workspaces/table/find-highlight.logic";

/**
 * What a cell, a name and a header mark up.
 *
 * `term` is the find bar's submitted term, never what it currently holds
 * typed: these marks explain the rows already on screen, and a term the server
 * has not answered for yet would mark runs in rows fetched for a different one.
 *
 * `matchesName` follows the scope: once the reader narrows to columns, the
 * search is about those cells, so the row's name and the column headers stop
 * highlighting along with the name half of the query.
 */
export type TableFindHighlight = {
  matchesName: boolean;
  propertyIds: ReadonlySet<string>;
  term: string;
};

const FindHighlightContext = createContext<TableFindHighlight | null>(null);

/**
 * Mark the runs of `text` the find term produced.
 *
 * With a `propertyId` the text is a cell, marked only when that column is one
 * the server actually searched; without one it is the row's name or a column
 * header, marked only while the scope is unrestricted. A row can be on screen
 * because a different column matched, so marking every occurrence would claim
 * a match that never happened.
 */
export const HighlightedText = ({
  propertyId,
  text,
}: {
  propertyId?: string | undefined;
  text: string;
}): ReactNode => {
  const highlight = use(FindHighlightContext);
  if (!highlight || !isSearched(highlight, propertyId)) {
    return text;
  }

  return splitByMatch(text, highlight.term).map((segment) =>
    segment.matched ? (
      <mark
        className="bg-highlight text-highlight-foreground rounded-xs"
        key={segment.start}
      >
        {segment.text}
      </mark>
    ) : (
      segment.text
    ),
  );
};

/**
 * Publish a find to the rows under it. Always rendered, with `null` when no
 * find is running: mounting the provider only while a term is live would
 * remount the table underneath it.
 */
export const FindHighlightScope = ({
  children,
  highlight,
}: {
  children: ReactNode;
  highlight: TableFindHighlight | null;
}) => <FindHighlightContext value={highlight}>{children}</FindHighlightContext>;

const isSearched = (
  highlight: TableFindHighlight,
  propertyId: string | undefined,
): boolean =>
  propertyId === undefined
    ? highlight.matchesName
    : highlight.propertyIds.has(propertyId);
