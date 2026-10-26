import { Fragment } from "react";

import { useTranslations } from "use-intl";

import { HeadnoteBlock } from "@stll/decision-reader/headnote-block";
import type { HeadnoteOrigin } from "@stll/decision-reader/headnote-block";
import type {
  AnalysisCitedSpan,
  DecisionAnalysis,
} from "@stll/legal-ast/analysis";
import { analysisLayersOf } from "@stll/legal-ast/analysis";
import type { Block } from "@stll/legal-ast/document-ast";
import { BidiText } from "@stll/ui/bidi-text";

import { useFormatter } from "@/i18n/formatting-context";

import {
  ParagraphReference,
  useUnresolvedCitationTelemetry,
} from "../paragraph-reference";
import { resolveParagraphReference } from "../paragraph-reference.logic";

/** Every block here was written by a model, and says so on each block. */
const AI_ORIGIN = { type: "ai" } as const satisfies HeadnoteOrigin;

type AiHeadnotesProps = {
  analysis: DecisionAnalysis;
  blocks: Block[];
  /** The decision's language, for the cited text a reference previews. */
  language: string;
  /** Scrolls the text to a paragraph a claim rests on. */
  onAnchorClick: (startAnchorId: string, endAnchorId: string) => void;
};

/**
 * Whether an analysis carries either block. A stored analysis from before
 * these layers existed carries neither, and then the reader is given nothing
 * to draw: an absent layer is absent, never an empty box above the text.
 */
export const hasAiHeadnotes = (analysis: DecisionAnalysis): boolean => {
  const { abstract, holding } = analysisLayersOf(analysis);
  return holding !== null || abstract !== null;
};

/**
 * The model's headnote and abstract, drawn in the decision's top matter under
 * the court's own: the same block, the same labels, the same folds. A reader
 * tells the two apart by the mark, which is the point — not by a shape that
 * would also rank one above the other.
 */
export const AiHeadnotes = ({
  analysis,
  blocks,
  language,
  onAnchorClick,
}: AiHeadnotesProps) => {
  const t = useTranslations();
  const { abstract, holding } = analysisLayersOf(analysis);
  useUnresolvedCitationTelemetry({
    blocks,
    ranges: [holding, abstract]
      .flatMap((layer) => (layer === null ? [] : layer.spans))
      .flatMap(({ anchors }) => anchors),
    source: analysis.inputFingerprint,
  });

  return (
    <>
      {holding !== null && (
        <HeadnoteBlock
          defaultOpen
          label={t("caseLaw.viewer.legalSentence")}
          origin={AI_ORIGIN}
        >
          <p className="reader-justify">
            <BidiText as="span" lang={holding.language}>
              <CitedSpans
                blocks={blocks}
                language={language}
                onAnchorClick={onAnchorClick}
                spans={holding.spans}
              />
            </BidiText>
          </p>
        </HeadnoteBlock>
      )}

      {/* Open, unlike the court's abstract: the model's summary is the
          reader's way into a decision the court did not abstract. */}
      {abstract !== null && (
        <HeadnoteBlock
          defaultOpen
          label={t("caseLaw.viewer.abstract")}
          origin={AI_ORIGIN}
        >
          <BidiText
            as="p"
            className="reader-justify text-foreground-strong-muted"
            lang={abstract.language}
          >
            <CitedSpans
              blocks={blocks}
              language={language}
              onAnchorClick={onAnchorClick}
              spans={abstract.spans}
            />
          </BidiText>
        </HeadnoteBlock>
      )}
    </>
  );
};

type CitedSpansProps = {
  blocks: Block[];
  language: string;
  onAnchorClick: (startAnchorId: string, endAnchorId: string) => void;
  spans: readonly AnalysisCitedSpan[];
};

/**
 * A passage with each claim's citations drawn where the claim ends: after
 * the span's last word, before the space that follows it, so a citation
 * never lands at the start of the next claim.
 */
function CitedSpans({
  blocks,
  language,
  onAnchorClick,
  spans,
}: CitedSpansProps) {
  const format = useFormatter();
  return spanOffsets(spans).map(({ span, start }) => {
    const claim = span.text.trimEnd();
    return (
      <Fragment key={start}>
        {claim}
        {span.anchors
          .map((range) =>
            resolveParagraphReference({
              blocks,
              formatNumber: format.number,
              range,
            }),
          )
          .filter((anchor) => anchor !== null)
          // Both endpoints, so equal ranges sit side by side for the
          // dedupe below however the span listed them.
          .toSorted(
            (left, right) =>
              left.startIndex - right.startIndex ||
              left.endIndex - right.endIndex,
          )
          .filter(
            (anchor, index, anchors) =>
              index === 0 ||
              anchor.startAnchorId !== anchors[index - 1]?.startAnchorId ||
              anchor.endAnchorId !== anchors[index - 1]?.endAnchorId,
          )
          .map((anchor) => (
            <Fragment key={`${anchor.startAnchorId}-${anchor.endAnchorId}`}>
              {" "}
              <ParagraphReference
                language={language}
                onAnchorClick={onAnchorClick}
                reference={anchor}
              />
            </Fragment>
          ))}
        {span.text.slice(claim.length)}
      </Fragment>
    );
  });
}

/** Each span with its offset in the passage: a stable key for a fixed text. */
function spanOffsets(
  spans: readonly AnalysisCitedSpan[],
): { span: AnalysisCitedSpan; start: number }[] {
  let start = 0;
  return spans.map((span) => {
    const entry = { span, start };
    start += span.text.length;
    return entry;
  });
}
