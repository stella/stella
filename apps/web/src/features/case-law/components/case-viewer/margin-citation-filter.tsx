import { useState } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { DecisionProvisionCard } from "@stll/decision-reader/decision-text";
import type { Block } from "@stll/legal-ast/document-ast";
import { Button } from "@stll/ui/button";

import type { SelectionAnchor } from "@/components/legal-reader/annotations/selection-anchor";

import {
  MARGIN_CITATION_FILTER,
  marginCitationFilterKey,
  resolveMarginCitationFilter,
  selectionCitationFilter,
  visibleProvisionCards,
} from "./margin-citation-filter.logic";
import type {
  MarginCitationFilter,
  ParagraphCitationFilter,
  SelectionCitationFilter,
} from "./margin-citation-filter.logic";

/**
 * The decision block a click landed in. The innermost anchored element can
 * be a part of a block (a table cell); the margin's cards belong to blocks.
 */
const blockAnchorAt = (
  target: EventTarget,
  blockAnchorIds: ReadonlySet<string>,
): string | null => {
  let element: Element | null = null;
  if (target instanceof Element) {
    element = target;
  } else if (target instanceof Node) {
    element = target.parentElement;
  }
  for (
    let anchored = element?.closest<HTMLElement>("[data-anchor]") ?? null;
    anchored !== null;
    anchored =
      anchored.parentElement?.closest<HTMLElement>("[data-anchor]") ?? null
  ) {
    const anchorId = anchored.dataset["anchor"];
    if (anchorId !== undefined && blockAnchorIds.has(anchorId)) {
      return anchorId;
    }
  }
  return null;
};

const paragraphFilterOf = (
  paragraphId: string | undefined,
): ParagraphCitationFilter | null =>
  paragraphId === undefined
    ? null
    : { type: MARGIN_CITATION_FILTER.paragraph, paragraphId };

type UseMarginCitationFilterOptions<TCard> = {
  /** The decision's blocks, as the cards were prepared from them. */
  blocks: readonly Block[];
  cards: readonly TCard[];
  /** Changes whenever the reader lands anew: another decision or address. */
  landingKey: string;
  /** The paragraph the address names, focused on arrival. */
  landingParagraphId: string | undefined;
};

/**
 * The margin's filter and the cards it leaves. A selection is stored as the
 * citations it touches, and only when that set changes: the bar reports the
 * selection on every selection change, scroll and resize, and the margin
 * re-renders only when what it lists differs.
 */
export const useMarginCitationFilter = <TCard extends DecisionProvisionCard>({
  blocks,
  cards,
  landingKey,
  landingParagraphId,
}: UseMarginCitationFilterOptions<TCard>) => {
  const [paragraph, setParagraph] = useState(() =>
    paragraphFilterOf(landingParagraphId),
  );
  const [paragraphFor, setParagraphFor] = useState(landingKey);
  if (paragraphFor !== landingKey) {
    setParagraphFor(landingKey);
    setParagraph(paragraphFilterOf(landingParagraphId));
  }
  const [selection, setSelection] = useState<SelectionCitationFilter | null>(
    null,
  );
  const filter = resolveMarginCitationFilter({ paragraph, selection });
  const blockAnchorIds = new Set(blocks.map((block) => block.anchorId));

  /** A plain click in a paragraph focuses it; a drag selects instead. */
  const focusParagraphAt = (target: EventTarget) => {
    if (!(target instanceof Node)) {
      return;
    }
    if (target.ownerDocument?.getSelection()?.isCollapsed === false) {
      return;
    }
    const paragraphId = blockAnchorAt(target, blockAnchorIds);
    if (paragraphId === null || paragraph?.paragraphId === paragraphId) {
      return;
    }
    setParagraph(paragraphFilterOf(paragraphId));
  };

  // Compared before setting: an updater returning the same state still costs
  // the reader a render before React bails out.
  const selectSpans = (spans: readonly SelectionAnchor[]) => {
    const next = selectionCitationFilter({ cards, spans });
    if (marginCitationFilterKey(selection) !== marginCitationFilterKey(next)) {
      setSelection(next);
    }
  };

  /** Clears both: the focused paragraph and the words selected in the text. */
  const showAll = (readerSelection: Selection | null) => {
    setParagraph(null);
    setSelection(null);
    readerSelection?.removeAllRanges();
  };

  const focusedBlock =
    filter.type === MARGIN_CITATION_FILTER.paragraph
      ? blocks.find((block) => block.anchorId === filter.paragraphId)
      : undefined;

  return {
    filter,
    focusParagraphAt,
    /** The court's own number for the focused paragraph, when it has one. */
    paragraphNumber:
      focusedBlock?.type === "paragraph" ? focusedBlock.number : undefined,
    selectSpans,
    showAll,
    visibleCards: visibleProvisionCards(cards, filter),
  };
};

type MarginCitationFilterBarProps = {
  /** Cards the filter leaves. */
  count: number;
  filter: MarginCitationFilter;
  onShowAll: (readerSelection: Selection | null) => void;
  paragraphNumber: number | undefined;
};

/**
 * What the margin is narrowed to, pinned to the top of the margin while the
 * reader scrolls, with the way back to every card. An unfiltered margin is
 * today's list and needs no bar.
 */
export const MarginCitationFilterBar = ({
  count,
  filter,
  onShowAll,
  paragraphNumber,
}: MarginCitationFilterBarProps) => {
  const t = useTranslations();
  const summary = (() => {
    switch (filter.type) {
      case MARGIN_CITATION_FILTER.all: {
        return null;
      }
      case MARGIN_CITATION_FILTER.paragraph: {
        return paragraphNumber === undefined
          ? t("caseLaw.marginFilter.unnumberedParagraph", { count })
          : t("caseLaw.marginFilter.paragraph", {
              count,
              paragraph: String(paragraphNumber),
            });
      }
      case MARGIN_CITATION_FILTER.selection: {
        return t("caseLaw.marginFilter.selection", { count });
      }
      default: {
        filter satisfies never;
        return panic(`Unhandled margin filter: ${String(filter)}`);
      }
    }
  })();
  if (summary === null) {
    return null;
  }

  return (
    <div
      className="sticky top-(--reader-controls-clearance) z-20 px-2 pb-2"
      data-slot="margin-citation-filter"
    >
      <div
        aria-label={t("caseLaw.marginFilter.label")}
        className="bg-background/80 supports-[backdrop-filter]:bg-background/55 shadow-floating reader-chrome flex items-center gap-1 rounded-lg border py-0.5 ps-2.5 pe-0.5 backdrop-blur-xl"
        role="group"
      >
        <span
          aria-live="polite"
          className="text-foreground-strong-muted min-w-0 flex-1 text-xs text-pretty tabular-nums"
        >
          {summary}
        </span>
        <Button
          onClick={(event) =>
            onShowAll(event.currentTarget.ownerDocument.getSelection())
          }
          size="xs"
          type="button"
          variant="ghost"
        >
          {t("common.showAll")}
        </Button>
      </div>
    </div>
  );
};
