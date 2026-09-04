import { createContext, use } from "react";
import type { ReactNode } from "react";

import { FieldTextProvider } from "@stll/workspace-ui/field-text";
import type { FieldTextRenderer } from "@stll/workspace-ui/field-text";

import { splitByMatch } from "@/components/workspaces/table/find-highlight.logic";

/**
 * What a cell, a name and a header mark up.
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

  return splitByMatch(text, highlight.term).map((segment, index) =>
    segment.matched ? (
      <mark
        className="bg-highlight text-highlight-foreground rounded-xs"
        // eslint-disable-next-line react/no-array-index-key -- segments are runs of one string with no identity of their own, and the list is rebuilt whenever the text or the term changes, so index-keyed reuse never mismatches rendered content.
        key={index}
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
 * find is running: mounting the providers only while a term is live would
 * remount the table underneath them.
 */
export const FindHighlightScope = ({
  children,
  highlight,
}: {
  children: ReactNode;
  highlight: TableFindHighlight | null;
}) => (
  <FindHighlightContext value={highlight}>
    <FieldTextProvider value={findTextRenderer}>{children}</FieldTextProvider>
  </FindHighlightContext>
);

const isSearched = (
  highlight: TableFindHighlight,
  propertyId: string | undefined,
): boolean =>
  propertyId === undefined
    ? highlight.matchesName
    : highlight.propertyIds.has(propertyId);

// The cell-text decoration handed to `@stll/workspace-ui`: one renderer per
// column, so a cell draws its own marks without every field component having
// to learn what a find is.
const findTextRenderer =
  (propertyId: string | undefined): FieldTextRenderer =>
  (text) => <HighlightedText propertyId={propertyId} text={text} />;
