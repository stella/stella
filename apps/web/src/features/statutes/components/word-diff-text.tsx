import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { WordDiffSegment } from "@stll/folio-core/ai-edits";
import {
  ReviewDiffDeletion,
  ReviewDiffInsertion,
} from "@stll/ui/review-diff-text";

type OffsetSegment = {
  offset: number;
  segment: WordDiffSegment;
};

/**
 * Segments carry no identity of their own, but their position in the
 * concatenated text is unique and stable for a given pair of wordings.
 */
const withOffsets = (segments: readonly WordDiffSegment[]): OffsetSegment[] => {
  const positioned: OffsetSegment[] = [];
  let offset = 0;

  for (const segment of segments) {
    positioned.push({ offset, segment });
    offset += segment.text.length;
  }

  return positioned;
};

type SurroundedText = { leading: string; core: string; trailing: string };

/**
 * The visible part of a changed run and the whitespace around it. A run often
 * carries the space or line break that joins it to its neighbour; marking
 * that draws an empty box (after a heading that gained a title, say), so only
 * the visible text is marked and the whitespace keeps its place unmarked.
 */
export const splitSurroundingWhitespace = (text: string): SurroundedText => {
  const leading = /^\s*/u.exec(text)?.[0] ?? "";
  const rest = text.slice(leading.length);
  const trailing = /\s*$/u.exec(rest)?.[0] ?? "";

  return {
    leading,
    core: rest.slice(0, rest.length - trailing.length),
    trailing,
  };
};

const WordDiffRun = ({ segment }: { segment: WordDiffSegment }) => {
  const t = useTranslations();
  const { core, leading, trailing } = splitSurroundingWhitespace(segment.text);

  // A change of whitespace alone has nothing visible to mark.
  if (segment.type === "equal" || core === "") {
    return <span>{segment.text}</span>;
  }

  switch (segment.type) {
    case "ins":
      return (
        <span>
          {leading}
          <ReviewDiffInsertion>
            <span className="sr-only">{t("statutes.diffInserted")}</span>
            {core}
          </ReviewDiffInsertion>
          {trailing}
        </span>
      );
    case "del":
      return (
        <span>
          {leading}
          <ReviewDiffDeletion>
            <span className="sr-only">{t("statutes.diffRemoved")}</span>
            {core}
          </ReviewDiffDeletion>
          {trailing}
        </span>
      );
    default:
      segment.type satisfies never;
      return panic("Unhandled provision diff segment");
  }
};

/**
 * A statute wording's word diff, inline: the one rendering both the
 * provision history and the side-by-side comparison use, so a deletion reads
 * the same in either place. The caller owns the paragraph around it.
 */
export const WordDiffText = ({
  segments,
}: {
  segments: readonly WordDiffSegment[];
}) =>
  withOffsets(segments).map(({ offset, segment }) => (
    <WordDiffRun key={offset} segment={segment} />
  ));
