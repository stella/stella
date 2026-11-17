import { separateOpinionStartAnchorId } from "@stll/legal-ast/case-law-reader";
import type { Block } from "@stll/legal-ast/document-ast";
import type { OutlineItem } from "@stll/ui/outline-rail";

import {
  decisionBenchSeats,
  dissentingJudges,
  portraitAttributions,
} from "@/features/case-law/decision-judges";
import type { DecisionJudge } from "@/features/case-law/decision-judges";

/** The reader's rail: its entries and the block each one points at. */
export type DecisionOutline = {
  anchorById: ReadonlyMap<string, string>;
  items: readonly OutlineItem[];
};

const SEPARATE_OPINION_ITEM_ID = "separate-opinion";

type WithSeparateOpinionOptions = {
  blocks: readonly Block[];
  /** Says where the portraits come from, given their sources. */
  formatPortraitCredit: (source: string) => string;
  judges: readonly DecisionJudge[];
  /** Names the entry's kind after the judges it names. */
  opinionLabel: string;
  outline: DecisionOutline;
  /** Where the browser fetches a portrait the read gave a path for. */
  portraitSrc: (path: string) => string;
};

/**
 * The rail with an entry for whoever wrote separately, where their opinions
 * start in the text. One entry whatever their number: the AST marks where the
 * separate opinions begin, not whose each one is, so a place per judge would
 * be a guess. Without both the people and the place the rail stays as it was.
 *
 * The entry takes its place in reading order, so the rail's list reads as the
 * decision does.
 */
export const withSeparateOpinion = ({
  blocks,
  formatPortraitCredit,
  judges,
  opinionLabel,
  outline,
  portraitSrc,
}: WithSeparateOpinionOptions): DecisionOutline => {
  const startAnchorId = separateOpinionStartAnchorId(blocks);
  const dissenters = dissentingJudges(judges);
  const writers = decisionBenchSeats(dissenters);
  if (startAnchorId === null || writers.length === 0) {
    return outline;
  }

  const positionByAnchor = new Map(
    blocks.map((block, index) => [block.anchorId, index]),
  );
  const start = positionByAnchor.get(startAnchorId) ?? blocks.length;
  const followingIndex = outline.items.findIndex((item) => {
    const anchorId = outline.anchorById.get(item.id);
    const position =
      anchorId === undefined ? undefined : positionByAnchor.get(anchorId);
    return position !== undefined && position > start;
  });
  const insertAt =
    followingIndex === -1 ? outline.items.length : followingIndex;

  const sources = portraitAttributions(dissenters);
  const entry: OutlineItem = {
    id: SEPARATE_OPINION_ITEM_ID,
    label: writers.map((writer) => writer.name).join(", "),
    level: 0,
    portraits: writers.map((writer) => ({
      image: writer.portrait === null ? null : portraitSrc(writer.portrait.url),
      name: writer.name,
    })),
    title: opinionLabel,
    ...(sources.length === 0
      ? {}
      : { portraitCredit: formatPortraitCredit(sources.join(", ")) }),
  };

  return {
    anchorById: new Map([
      ...outline.anchorById,
      [SEPARATE_OPINION_ITEM_ID, startAnchorId],
    ]),
    items: outline.items.toSpliced(insertAt, 0, entry),
  };
};
