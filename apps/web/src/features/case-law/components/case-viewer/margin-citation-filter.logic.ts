/**
 * Which cited-provision cards the reader's margin lists. A focused paragraph
 * narrows the list to what that paragraph cites, a selection to what the
 * selected words cite; with neither, the margin lists every card.
 *
 * Cards and selections share one offset axis: a card's ranges are where its
 * citation links sit in the paragraph's rendered text, and a selection anchor
 * indexes the same words (`selection-anchor.ts`).
 */

import { panic } from "better-result";

import type { DecisionProvisionCard } from "@stll/decision-reader/decision-text";

import type { SelectionAnchor } from "@/components/legal-reader/annotations/selection-anchor";

export const MARGIN_CITATION_FILTER = {
  all: "all",
  paragraph: "paragraph",
  selection: "selection",
} as const;

export type ParagraphCitationFilter = {
  type: typeof MARGIN_CITATION_FILTER.paragraph;
  paragraphId: string;
};

export type SelectionCitationFilter = {
  type: typeof MARGIN_CITATION_FILTER.selection;
  citationIds: readonly string[];
};

export type MarginCitationFilter =
  | { type: typeof MARGIN_CITATION_FILTER.all }
  | ParagraphCitationFilter
  | SelectionCitationFilter;

export const ALL_CITATIONS = {
  type: MARGIN_CITATION_FILTER.all,
} as const satisfies MarginCitationFilter;

type FilterableCard = Pick<
  DecisionProvisionCard,
  "citationIds" | "ranges" | "startAnchorId"
>;

/** One key per distinct filter, so equal filters compare equal. */
export const marginCitationFilterKey = (
  filter: MarginCitationFilter | null,
): string => {
  if (filter === null) {
    return "";
  }
  switch (filter.type) {
    case MARGIN_CITATION_FILTER.all: {
      return filter.type;
    }
    case MARGIN_CITATION_FILTER.paragraph: {
      return `${filter.type}:${filter.paragraphId}`;
    }
    case MARGIN_CITATION_FILTER.selection: {
      return `${filter.type}:${filter.citationIds.join(" ")}`;
    }
    default: {
      filter satisfies never;
      return panic(`Unhandled margin filter: ${String(filter)}`);
    }
  }
};

/**
 * The citations the selected words touch: a citation counts once any of its
 * characters is selected, so a selection that starts or ends inside a
 * citation still finds it, and one that stops where a citation begins does
 * not. Ordered as the cards are, each id once.
 */
export const citationIdsInSelection = ({
  cards,
  spans,
}: {
  cards: readonly FilterableCard[];
  spans: readonly SelectionAnchor[];
}): string[] => {
  const ids = new Set<string>();
  for (const card of cards) {
    const selected = spans.filter(
      (span) => span.blockAnchorId === card.startAnchorId,
    );
    for (const range of card.ranges) {
      if (
        selected.some(
          (span) =>
            range.start < span.endOffset && span.startOffset < range.end,
        )
      ) {
        ids.add(range.citationId);
      }
    }
  }
  return [...ids];
};

/** Nothing anchored in the decision's words is selected: no filter. */
export const selectionCitationFilter = ({
  cards,
  spans,
}: {
  cards: readonly FilterableCard[];
  spans: readonly SelectionAnchor[];
}): SelectionCitationFilter | null =>
  spans.length === 0
    ? null
    : {
        type: MARGIN_CITATION_FILTER.selection,
        citationIds: citationIdsInSelection({ cards, spans }),
      };

/** A selection speaks for the words the reader is on; a focused paragraph
 * is what remains once it is cleared. */
export const resolveMarginCitationFilter = ({
  paragraph,
  selection,
}: {
  paragraph: ParagraphCitationFilter | null;
  selection: SelectionCitationFilter | null;
}): MarginCitationFilter => selection ?? paragraph ?? ALL_CITATIONS;

export const visibleProvisionCards = <TCard extends FilterableCard>(
  cards: readonly TCard[],
  filter: MarginCitationFilter,
): readonly TCard[] => {
  switch (filter.type) {
    case MARGIN_CITATION_FILTER.all: {
      return cards;
    }
    case MARGIN_CITATION_FILTER.paragraph: {
      return cards.filter((card) => card.startAnchorId === filter.paragraphId);
    }
    case MARGIN_CITATION_FILTER.selection: {
      const selected = new Set(filter.citationIds);
      return cards.filter((card) =>
        card.citationIds.some((id) => selected.has(id)),
      );
    }
    default: {
      filter satisfies never;
      return panic(`Unhandled margin filter: ${String(filter)}`);
    }
  }
};
