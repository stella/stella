import { Fragment } from "react";
import type { ReactElement, ReactNode, Ref } from "react";

import type { ProvisionPlacementFailure } from "@stll/api-contract/provision-placement";
import { locateCitationSpans } from "@stll/legal-ast/citation-passage";
import type { DecisionCaption } from "@stll/legal-ast/decision-caption";
import type { Block } from "@stll/legal-ast/document-ast";
import {
  hasBlockInlines,
  parseDocumentAst,
} from "@stll/legal-ast/document-ast";
import { dropOverlappingSpans } from "@stll/legal-ast/text-spans";
import { BidiText } from "@stll/ui/bidi-text";
import { cn } from "@stll/ui/utils";

import {
  annotationTextAnchors,
  renderLinkAnnotations,
} from "./annotation-anchors";
import type { AnnotationAnchorSource } from "./annotation-anchors";
import { ExternalCitationLink } from "./citation-link";
import { decisionReferenceTintClassName } from "./citation-treatment";
import { missingBodyReason } from "./decision-body-state.logic";
import {
  annotationsOverlappingTextSpan,
  apparatusBlockIds,
  courtHeadnoteOrigin,
  decisionCaption,
  decisionDisplayReference,
  decisionTopMatter,
  editorialSupplementBlocks,
  footnoteParts,
  resolveDecisionLinkOverlaps,
  topMatterBlocks,
  visibleDecisionBlocks,
  wrappedParagraphRuns,
} from "./decision-text.logic";
import type {
  DecisionTopMatter,
  FootnoteParts,
  TopMatterSource,
  WrappedParagraphRuns,
} from "./decision-text.logic";
import {
  BlockRenderer,
  DecisionCaptionHeader,
  FulltextFallback,
  HighlightedText,
  InlineContent,
  WrappedParagraphRun,
  rangesForPiece,
} from "./document-ast-text";
import type { TextAnchor } from "./document-ast-text";
import { locateExternalCjeuCitations } from "./fallback-legal-anchors";
import { HeadnoteBlock } from "./headnote-block";
import type { HeadnoteOrigin } from "./headnote-block";
import type { ProvisionAnchorSpan } from "./provision-anchors";
import { locateProvisionAnchors } from "./provision-anchors";
import { provisionCardsOf } from "./provision-card.logic";
import type { DecisionReaderAdapters } from "./reader-adapters";
import { useReaderAdapters, useReaderMessages } from "./reader-adapters";
import { ReaderInsetBox } from "./reader-inset-box";
import type { ReaderSearchMatchRange } from "./reader-search";
import type {
  CitationAnchorSource,
  CitedProvisionTarget,
  DecisionProvisionAnchor,
  DecisionStatuteCitationAnchor,
  ReaderDecision,
} from "./reader-types";
import { sanitizeHref } from "./sanitize-href";
import { SourceLinkPolicyProvider } from "./source-link-policy";

type Decision = ReaderDecision;

export type DecisionTextProps = {
  articleRef?: Ref<HTMLElement> | undefined;
  placements: DecisionTextAnchorPlacements;
  /**
   * The model's headnote and abstract, drawn in the top matter under the
   * court's own. A node rather than the analysis itself: the order the two
   * origins are read in belongs to the decision, and nothing else about an
   * analysis does.
   */
  aiHeadnotes?: ReactNode | undefined;
  /** The reader's own marks and what colleagues shared. */
  annotationAnchors?: readonly AnnotationAnchorSource[] | undefined;
  decision: Decision;
  /**
   * The decision on screen. The top matter's disclosures are mounted under
   * it, so a route that swaps one decision for another opens the new
   * headnote instead of inheriting the last reader's fold.
   */
  decisionId: string;
  isHydrated?: boolean | undefined;
  /**
   * The block the reader was sent to, from a results row or a citation. It
   * keeps a marker while the reader is on it.
   */
  landingAnchorId?: string | undefined;
  /**
   * Notes drawn in the text's own flow, under the block they belong to: what
   * a reader gets in a pane too narrow for a margin to put them in. A note
   * whose anchor this text does not draw follows the text instead, so a
   * comment is never silently lost with its paragraph.
   */
  notesByAnchorId?: ReadonlyMap<string, ReactNode> | undefined;
  onAnnotationActivate?: ((annotationId: string) => void) | undefined;
  expandProvisions?: boolean | undefined;
  sectionMap?: Map<string, { cssVar: string; headingId: string }> | undefined;
};

/** No match is the find's own: nothing carries the active mark. */
const NO_ACTIVE_MATCH = -1;
const NO_SEARCH_RANGES: Record<string, ReaderSearchMatchRange[]> = {};

const DECISION_REFERENCE_ID = "decision-reference";

const supplementBlockAnchorId = (pieceId: string, start: number): string =>
  `${pieceId}:${String(start)}`;

/** The host a reader recognises, rather than a permalink nobody reads. */
const attributionLabel = (href: string): string =>
  URL.canParse(href) ? new URL(href).host.replace(/^www\./u, "") : href;

/**
 * Where the decision's data is freely available, as the reader's last line.
 *
 * Part of the decision rather than page chrome: some courts make the
 * attribution a condition of republishing, so every surface that renders a
 * decision renders it. It is not part of the *text*, though — it sits outside
 * the `<article>`, so it carries no `data-anchor` to highlight or cite, and
 * `data-reader-chrome` keeps it out of a quotation taken from the last
 * paragraph. Find matches come from the search pieces, which it is not in.
 */
const DecisionSourceAttribution = ({ url }: { url: string | null }) => {
  const messages = useReaderMessages();
  const href = sanitizeHref(url);

  if (href === undefined) {
    return null;
  }

  return (
    <footer
      className="reader-chrome text-muted-foreground border-border/50 mt-10 border-t pt-3 text-[calc(0.6875rem*var(--reader-text-scale))] leading-snug"
      data-reader-chrome=""
    >
      {messages.sourceAttribution(attributionLabel(href), (chunks) => (
        <a
          className="hover:text-foreground underline underline-offset-2"
          href={sanitizeHref(href)}
          rel="noopener noreferrer"
          target="_blank"
        >
          <BidiText>{chunks}</BidiText>
        </a>
      ))}
    </footer>
  );
};

const DecisionReference = ({
  activeMatchIndex,
  ranges,
  text,
}: {
  activeMatchIndex: number;
  ranges: ReaderSearchMatchRange[];
  text: string;
}) => (
  <p className="reader-chrome text-muted-foreground mb-4 text-end text-xs italic">
    <HighlightedText
      activeMatchIndex={activeMatchIndex}
      pieceId={DECISION_REFERENCE_ID}
      ranges={ranges}
      text={text}
    />
  </p>
);

/**
 * Wrap runs of apparatus blocks in one collapsed disclosure while leaving
 * every other block inline. The callback renders a single block exactly as
 * the caller always did.
 */
const groupApparatusWrap = (
  blocks: readonly Block[],
  apparatusIds: ReadonlySet<string>,
  apparatusLabel: string,
  renderBlock: (block: Block) => ReactNode,
): ReactNode[] => {
  const out: ReactNode[] = [];
  let run: Block[] = [];
  const flush = () => {
    if (run.length === 0) {
      return;
    }
    const runBlocks = run;
    run = [];
    out.push(
      <details
        className="reader-apparatus"
        key={`apparatus-${runBlocks[0]?.id ?? String(out.length)}`}
      >
        <summary className="reader-apparatus-summary">{apparatusLabel}</summary>
        {runBlocks.map((block) => (
          <Fragment key={block.id}>{renderBlock(block)}</Fragment>
        ))}
      </details>,
    );
  };
  for (const block of blocks) {
    if (apparatusIds.has(block.id)) {
      run.push(block);
      continue;
    }
    flush();
    out.push(<Fragment key={block.id}>{renderBlock(block)}</Fragment>);
  }
  flush();
  return out;
};

const isHoldingBlock = (block: Block): boolean =>
  block.type === "paragraph" && block.role === "holding";

const EditorialSupplementBody = ({
  activeMatchIndex,
  annotationAnchors,
  pieceId,
  ranges,
  text,
  variant,
}: {
  activeMatchIndex: number;
  annotationAnchors: readonly AnnotationAnchorSource[];
  pieceId: string;
  ranges: ReaderSearchMatchRange[];
  text: string;
  variant: "abstract" | "legal-sentence";
}) => (
  <div className="space-y-3">
    {editorialSupplementBlocks(text).map((block) => {
      const blockAnchorId = supplementBlockAnchorId(pieceId, block.start);
      const anchors = annotationTextAnchors(
        annotationAnchors.filter(
          (annotation) => annotation.blockAnchorId === blockAnchorId,
        ),
        block.start,
      );
      const content = (
        <InlineContent
          activeMatchIndex={activeMatchIndex}
          anchors={anchors}
          initialOffset={block.start}
          inlines={[{ text: block.text, type: "text" }]}
          pieceId={pieceId}
          ranges={ranges}
        />
      );

      return block.type === "heading" ? (
        <h5
          className="text-foreground text-sm leading-snug font-semibold"
          data-anchor={blockAnchorId}
          key={block.start}
        >
          {content}
        </h5>
      ) : (
        <p
          className={cn(
            "reader-justify",
            variant === "abstract" && "text-foreground-strong-muted",
          )}
          data-anchor={blockAnchorId}
          key={block.start}
        >
          {content}
        </p>
      );
    })}
  </div>
);

/**
 * One section's text, from whichever source it resolved to: paragraphs the
 * parser marked, rendered as the document's own blocks so their ids, marks
 * and permalinks survive the move up here, or a publisher field, split into
 * blocks of its own.
 */
const TopMatterBody = ({
  activeMatchIndex,
  anchorsByPieceId,
  annotationAnchors,
  footnotes,
  notesByAnchorId,
  rangesByPieceId,
  source,
  variant,
}: {
  activeMatchIndex: number;
  anchorsByPieceId: Record<string, TextAnchor[]>;
  annotationAnchors: readonly AnnotationAnchorSource[];
  footnotes: FootnoteParts;
  notesByAnchorId: ReadonlyMap<string, ReactNode> | undefined;
  rangesByPieceId: Record<string, ReaderSearchMatchRange[]>;
  source: TopMatterSource;
  variant: "abstract" | "legal-sentence";
}) => {
  if (source.type === "text") {
    return (
      <EditorialSupplementBody
        activeMatchIndex={activeMatchIndex}
        annotationAnchors={annotationAnchors}
        pieceId={source.pieceId}
        ranges={rangesForPiece(rangesByPieceId, source.pieceId)}
        text={source.text}
        variant={variant}
      />
    );
  }

  return (
    <div className="space-y-3">
      {source.blocks.map((block) => (
        <Fragment key={block.id}>
          <BlockRenderer
            activeMatchIndex={activeMatchIndex}
            anchorsByPieceId={anchorsByPieceId}
            block={block}
            noteBackJumpTo={footnotes.backJumpAnchorByLastId.get(block.id)}
            noteHead={footnotes.headIds.has(block.id)}
            rangesByPieceId={rangesByPieceId}
            variant="case-law"
          />
          {notesByAnchorId?.get(block.anchorId)}
        </Fragment>
      ))}
    </div>
  );
};

/** Whether the reader's find landed inside this section. */
const sourceHasMatch = (
  source: TopMatterSource | null,
  rangesByPieceId: Record<string, ReaderSearchMatchRange[]>,
): boolean => {
  if (source === null) {
    return false;
  }
  if (source.type === "text") {
    return rangesForPiece(rangesByPieceId, source.pieceId).length > 0;
  }
  return source.blocks.some(
    (block) => rangesForPiece(rangesByPieceId, block.id).length > 0,
  );
};

/**
 * What a decision opens with: the headnote it is cited by, the publisher's
 * abstract of it, and — under them, in the same blocks — what a model made of
 * the two.
 *
 * All of it sits above the court's own text, where a reader looks for it,
 * instead of folded into the document at the place the publisher happened to
 * print it. A headnote is open — it is the reason most readers came — and an
 * abstract is folded, because it repeats the decision at length; the fold
 * follows the section, not its author, so neither author's headnote is
 * ranked above the other by shape. A find match opens the section it is in
 * for as long as it is inside.
 */
const DecisionTopMatterSections = ({
  activeMatchIndex,
  aiHeadnotes,
  anchorsByPieceId,
  annotationAnchors,
  courtOrigin,
  footnotes,
  notesByAnchorId,
  rangesByPieceId,
  topMatter,
}: {
  activeMatchIndex: number;
  aiHeadnotes: ReactNode;
  anchorsByPieceId: Record<string, TextAnchor[]>;
  annotationAnchors: readonly AnnotationAnchorSource[];
  courtOrigin: HeadnoteOrigin;
  footnotes: FootnoteParts;
  notesByAnchorId: ReadonlyMap<string, ReactNode> | undefined;
  rangesByPieceId: Record<string, ReaderSearchMatchRange[]>;
  topMatter: DecisionTopMatter;
}) => {
  const messages = useReaderMessages();
  const { abstract, legalSentence } = topMatter;
  const hasAi = aiHeadnotes !== null && aiHeadnotes !== undefined;

  if (legalSentence === null && abstract === null && !hasAi) {
    return null;
  }

  return (
    // The text is read like the decision it belongs to: the article's serif,
    // size and line-height, inherited. Only the labels are chrome.
    <ReaderInsetBox className="mb-8" density="roomy">
      {legalSentence !== null && (
        <HeadnoteBlock
          defaultOpen
          forceOpen={sourceHasMatch(legalSentence, rangesByPieceId)}
          label={messages["caseLaw.viewer.legalSentence"]}
          origin={courtOrigin}
        >
          <TopMatterBody
            activeMatchIndex={activeMatchIndex}
            anchorsByPieceId={anchorsByPieceId}
            annotationAnchors={annotationAnchors}
            footnotes={footnotes}
            notesByAnchorId={notesByAnchorId}
            rangesByPieceId={rangesByPieceId}
            source={legalSentence}
            variant="legal-sentence"
          />
        </HeadnoteBlock>
      )}
      {abstract !== null && (
        <HeadnoteBlock
          defaultOpen={false}
          forceOpen={sourceHasMatch(abstract, rangesByPieceId)}
          label={messages["caseLaw.viewer.abstract"]}
          origin={courtOrigin}
        >
          <TopMatterBody
            activeMatchIndex={activeMatchIndex}
            anchorsByPieceId={anchorsByPieceId}
            annotationAnchors={annotationAnchors}
            footnotes={footnotes}
            notesByAnchorId={notesByAnchorId}
            rangesByPieceId={rangesByPieceId}
            source={abstract}
            variant="abstract"
          />
        </HeadnoteBlock>
      )}
      {aiHeadnotes}
    </ReaderInsetBox>
  );
};

/** The pieces of a mark left once the links inside it are cut out. */
const splitAroundLinks = (
  mark: TextAnchor,
  links: readonly TextAnchor[],
): TextAnchor[] => {
  const cuts = links
    .filter((link) => mark.start < link.end && link.start < mark.end)
    .toSorted((a, b) => a.start - b.start);
  const pieces: TextAnchor[] = [];
  let cursor = mark.start;
  for (const cut of cuts) {
    if (cut.start > cursor) {
      pieces.push({
        ...mark,
        end: cut.start,
        key: `${mark.key}:${pieces.length}`,
        start: cursor,
      });
    }
    cursor = Math.max(cursor, cut.end);
  }
  if (cursor < mark.end) {
    pieces.push({
      ...mark,
      key: pieces.length === 0 ? mark.key : `${mark.key}:${pieces.length}`,
      start: cursor,
    });
  }
  return pieces;
};

/**
 * Every inline link in the text, by block: cited decisions and applied
 * provisions, located separately and merged so the two kinds never nest. A
 * decision citation and a provision reference cannot share characters in
 * honest text, so whichever starts first simply wins.
 */
export type DecisionTextAnchorPlacements = {
  anchorsByPieceId: Record<string, TextAnchor[]>;
  failures: ProvisionPlacementFailure[];
  provisionsByAnchorId: Map<string, ReactNode>;
};

const buildAnchorsByPieceId = ({
  adapters,
  annotations,
  blocks,
  citations,
  provisionSpans,
  statutes,
}: {
  adapters: Pick<
    DecisionReaderAdapters,
    "renderDecisionLink" | "renderStatuteLink"
  >;
  annotations: readonly AnnotationAnchorSource[];
  blocks: readonly Block[];
  citations: readonly CitationAnchorSource[];
  provisionSpans: Record<string, ProvisionAnchorSpan<CitedProvisionTarget>[]>;
  statutes: readonly DecisionStatuteCitationAnchor[];
}): DecisionTextAnchorPlacements => {
  const failures: ProvisionPlacementFailure[] = [];
  const citationSpans = locateCitationSpans({ blocks, citations });
  const statuteSpans = new Map<string, DecisionStatuteCitationAnchor[]>();
  for (const statute of statutes) {
    const spans = statuteSpans.get(statute.blockId);
    if (spans === undefined) {
      statuteSpans.set(statute.blockId, [statute]);
      continue;
    }
    spans.push(statute);
  }
  const externalCjeuSpansByBlock = new Map<
    string,
    ReturnType<typeof locateExternalCjeuCitations>
  >();
  for (const citation of locateExternalCjeuCitations(blocks)) {
    const spans = externalCjeuSpansByBlock.get(citation.blockId);
    if (spans === undefined) {
      externalCjeuSpansByBlock.set(citation.blockId, [citation]);
      continue;
    }
    spans.push(citation);
  }
  const blockIdByAnchor = new Map(
    blocks.map((block) => [block.anchorId, block.id] as const),
  );
  const annotationsByBlock = new Map<string, AnnotationAnchorSource[]>();
  for (const annotation of annotations) {
    const blockId = blockIdByAnchor.get(annotation.blockAnchorId);
    if (blockId === undefined) {
      continue;
    }
    const list = annotationsByBlock.get(blockId);
    if (list === undefined) {
      annotationsByBlock.set(blockId, [annotation]);
      continue;
    }
    list.push(annotation);
  }
  const anchorsByPieceId: Record<string, TextAnchor[]> = {};
  const blockIds = new Set([
    ...Object.keys(citationSpans),
    ...Object.keys(provisionSpans),
    ...statuteSpans.keys(),
    ...externalCjeuSpansByBlock.keys(),
    ...annotationsByBlock.keys(),
  ]);
  for (const blockId of blockIds) {
    const anchors: TextAnchor[] = [];
    const blockAnnotations = annotationsByBlock.get(blockId);
    // A reader's mark over a link keeps the link: links are the text's own
    // structure, and intersecting marks are repeated inside them below.
    // Plain inline markup keeps the paragraph's own wrapping and
    // justification, and overlapping marks are split into runs so no word is
    // printed twice. The toolbar handles clicks on the mark by id.
    anchors.push(...annotationTextAnchors(blockAnnotations ?? []));
    for (const span of citationSpans[blockId] ?? []) {
      const linkAnnotations = annotationsOverlappingTextSpan(
        blockAnnotations ?? [],
        span,
      );
      anchors.push({
        end: span.end,
        key: `decision:${span.source.id}`,
        render: (children): ReactElement => {
          const marked = renderLinkAnnotations({
            annotations: linkAnnotations,
            children,
          });
          return adapters.renderDecisionLink({
            className: cn(
              decisionReferenceTintClassName(span.source.treatment),
            ),
            decision: span.source.decision,
            citation: span.source,
            treatment: span.source.treatment,
            children: marked,
          });
        },
        start: span.start,
      });
    }
    for (const span of provisionSpans[blockId] ?? []) {
      const linkAnnotations = annotationsOverlappingTextSpan(
        blockAnnotations ?? [],
        span,
      );
      anchors.push({
        end: span.end,
        key: `provision:${span.source.id}`,
        render: (children): ReactElement => {
          const marked = renderLinkAnnotations({
            annotations: linkAnnotations,
            children,
          });
          return adapters.renderStatuteLink({
            type: "provision",
            provision: span.source.target,
            children: marked,
          });
        },
        start: span.start,
      });
    }
    for (const span of statuteSpans.get(blockId) ?? []) {
      const linkAnnotations = annotationsOverlappingTextSpan(
        blockAnnotations ?? [],
        span,
      );
      anchors.push({
        end: span.end,
        key: `statute:${span.id}`,
        render: (children): ReactElement => {
          const marked = renderLinkAnnotations({
            annotations: linkAnnotations,
            children,
          });
          return adapters.renderStatuteLink({
            type: "statute",
            target: span.target,
            children: marked,
          });
        },
        start: span.start,
      });
    }
    for (const span of externalCjeuSpansByBlock.get(blockId) ?? []) {
      const linkAnnotations = annotationsOverlappingTextSpan(
        blockAnnotations ?? [],
        span,
      );
      anchors.push({
        end: span.end,
        key: `external-decision:${span.id}`,
        render: (children): ReactElement => {
          const marked = renderLinkAnnotations({
            annotations: linkAnnotations,
            children,
          });
          // A decision the corpus does not hold is still a decision the
          // reader is scanning for, so it carries the neutral wash.
          return (
            <ExternalCitationLink
              className={cn(decisionReferenceTintClassName())}
              href={span.href}
            >
              {marked}
            </ExternalCitationLink>
          );
        },
        start: span.start,
      });
    }
    // Links stay interactive, and every mark crossing them is painted inside
    // their text. The mark's remaining pieces continue on either side, so a
    // citation can never cut a white hole through a highlighted passage.
    const disposition = resolveDecisionLinkOverlaps(
      anchors.filter((anchor) => !anchor.key.startsWith("annotation:")),
    );
    const { links } = disposition;
    failures.push(...disposition.failures);
    const marks = anchors
      .filter((anchor) => anchor.key.startsWith("annotation:"))
      .flatMap((mark) => splitAroundLinks(mark, links));
    anchorsByPieceId[blockId] = dropOverlappingSpans([...links, ...marks]);
  }
  const provisionsByAnchorId = new Map<string, ReactNode>();
  for (const block of blocks) {
    if (!hasBlockInlines(block)) {
      continue;
    }
    const acceptedKeys = new Set(
      (anchorsByPieceId[block.id] ?? []).map(
        ({ key, start, end }) => `${key}:${String(start)}:${String(end)}`,
      ),
    );
    const spans = (provisionSpans[block.id] ?? [])
      .filter((span) =>
        acceptedKeys.has(
          `provision:${span.source.id}:${String(span.start)}:${String(span.end)}`,
        ),
      )
      .toSorted((left, right) => left.start - right.start);
    if (spans.length === 0) {
      continue;
    }
    provisionsByAnchorId.set(
      block.anchorId,
      provisionCardsOf(spans.map(({ source }) => source)).map((card) => (
        <Fragment key={card.id}>
          {adapters.renderStatuteLink({
            type: "provision-expansion",
            citations: card.citations,
          })}
        </Fragment>
      )),
    );
  }
  return { anchorsByPieceId, provisionsByAnchorId, failures };
};

export type PrepareDecisionTextPlacementsOptions = {
  adapters: Pick<
    DecisionReaderAdapters,
    "renderDecisionLink" | "renderStatuteLink"
  >;
  annotationAnchors: readonly AnnotationAnchorSource[];
  blocks: readonly Block[];
  citationAnchors: readonly CitationAnchorSource[];
  provisionAnchors: readonly DecisionProvisionAnchor[];
  statuteCitationAnchors: readonly DecisionStatuteCitationAnchor[];
};

export const prepareDecisionTextPlacements = ({
  adapters,
  annotationAnchors,
  blocks,
  citationAnchors,
  provisionAnchors,
  statuteCitationAnchors,
}: PrepareDecisionTextPlacementsOptions): DecisionTextAnchorPlacements => {
  const provisionPlacement = locateProvisionAnchors({
    blocks,
    provisions: provisionAnchors,
  });
  const placements = buildAnchorsByPieceId({
    adapters,
    annotations: annotationAnchors,
    blocks,
    citations: citationAnchors,
    provisionSpans: provisionPlacement.anchorsByPieceId,
    statutes: statuteCitationAnchors,
  });
  return {
    anchorsByPieceId: placements.anchorsByPieceId,
    provisionsByAnchorId: placements.provisionsByAnchorId,
    failures: [...provisionPlacement.failures, ...placements.failures],
  };
};

/**
 * Where a separate opinion starts: its byline is drawn above the first
 * paragraph the court gave the `dissent` role.
 */
const firstDissentBlockId = (blocks: readonly Block[]): string | null =>
  blocks.find((block) => block.type === "paragraph" && block.role === "dissent")
    ?.id ?? null;

const renderBlocksWithHoldingZone = ({
  activeMatchIndex,
  anchorsByPieceId,
  apparatusLabel,
  blocks,
  caption,
  dissent,
  footnotes,
  landingAnchorId,
  notesByAnchorId,
  rangesByPieceId,
  sectionMap,
  wrappedRuns,
}: {
  activeMatchIndex: number;
  anchorsByPieceId: Record<string, TextAnchor[]>;
  /** Translated label for the folded reporter-apparatus disclosure. */
  apparatusLabel: string;
  blocks: Block[];
  /** The caption the body opens with, where its blocks store it run on. */
  caption: DecisionCaption | null;
  /**
   * The separate opinion's byline and the block it is drawn above. Both or
   * neither: a byline with nobody to name, and names with no separate
   * opinion under them, are each nothing to draw.
   */
  dissent: { blockId: string; byline: ReactNode } | null;
  /** Note grouping for the whole decision, top matter included. */
  footnotes: FootnoteParts;
  landingAnchorId: string | undefined;
  notesByAnchorId: ReadonlyMap<string, ReactNode> | undefined;
  rangesByPieceId: Record<string, ReaderSearchMatchRange[]>;
  sectionMap?: Map<string, { cssVar: string; headingId: string }> | undefined;
  /** Line blocks of a hard-wrapped source, drawn as their paragraphs. */
  wrappedRuns: WrappedParagraphRuns;
}): ReactNode[] => {
  const result: ReactNode[] = [];

  // Publisher head matter (counsel appearances, syllabus, headnotes) folds
  // behind a disclosure: not the court's words, one click away rather than
  // gone.
  const apparatusIds = apparatusBlockIds(blocks);

  const { headIds: footnoteHeadIds, backJumpAnchorByLastId } = footnotes;

  const captionBlockIds = new Set(
    caption?.blocks.map((captionBlock) => captionBlock.block.id),
  );
  const captionHeadId = caption?.blocks[0].block.id;

  // Group consecutive blocks by heading ID for continuous lines.
  // Same category but different heading = separate groups.
  type Group = {
    cssVar: string | null;
    headingId: string | null;
    blocks: [Block, ...Block[]];
  };

  const groups: Group[] = [];

  for (const block of blocks) {
    const info = sectionMap?.get(block.anchorId) ?? null;
    const cssVar = info?.cssVar ?? null;
    const headingId = info?.headingId ?? null;
    const lastGroup = groups.at(-1);

    if (lastGroup?.headingId === headingId && lastGroup.cssVar === cssVar) {
      lastGroup.blocks.push(block);
      continue;
    }

    groups.push({ blocks: [block], cssVar, headingId });
  }

  for (const group of groups) {
    const hasPreviousGroup = result.length > 0;
    const borderStyle = group.cssVar
      ? {
          borderInlineStartColor: `color-mix(in srgb, var(${group.cssVar}) 25%, transparent)`,
        }
      : undefined;

    result.push(
      <div
        className={cn(
          "border-s-2 ps-3",
          !group.cssVar && "border-s-transparent",
          hasPreviousGroup && "mt-1.5",
        )}
        key={`section-${group.blocks[0].id}`}
        style={borderStyle}
      >
        {groupApparatusWrap(
          group.blocks,
          apparatusIds,
          apparatusLabel,
          (block) => {
            // Drawn inside the caption header or the run of an earlier block.
            if (
              (captionBlockIds.has(block.id) && block.id !== captionHeadId) ||
              wrappedRuns.continuationIds.has(block.id)
            ) {
              return null;
            }
            const run = wrappedRuns.byHeadId.get(block.id);
            const drawnBlocks =
              caption !== null && block.id === captionHeadId
                ? caption.blocks.map((captionBlock) => captionBlock.block)
                : (run?.blocks ?? [block]);
            // One renderer for every block: a footnote can carry any role,
            // holding included, so its grouping travels with it either way.
            const rendered = (() => {
              if (caption !== null && block.id === captionHeadId) {
                return (
                  <DecisionCaptionHeader
                    activeMatchIndex={activeMatchIndex}
                    anchorsByPieceId={anchorsByPieceId}
                    caption={caption}
                    key={block.id}
                    landingAnchorId={landingAnchorId}
                    rangesByPieceId={rangesByPieceId}
                  />
                );
              }
              if (run !== undefined) {
                return (
                  <WrappedParagraphRun
                    activeMatchIndex={activeMatchIndex}
                    anchorsByPieceId={anchorsByPieceId}
                    blocks={run.blocks}
                    key={block.id}
                    landingAnchorId={landingAnchorId}
                    rangesByPieceId={rangesByPieceId}
                    separators={run.separators}
                  />
                );
              }
              return (
                <BlockRenderer
                  activeMatchIndex={activeMatchIndex}
                  anchorsByPieceId={anchorsByPieceId}
                  block={block}
                  key={block.id}
                  landing={block.anchorId === landingAnchorId}
                  noteBackJumpTo={backJumpAnchorByLastId.get(block.id)}
                  noteHead={footnoteHeadIds.has(block.id)}
                  rangesByPieceId={rangesByPieceId}
                  variant="case-law"
                />
              );
            })();
            const body = isHoldingBlock(block) ? (
              <div className="font-[520]" key={block.id}>
                {rendered}
              </div>
            ) : (
              rendered
            );
            // The notes of every block drawn here follow it, in block order.
            const notes = drawnBlocks.flatMap(({ anchorId }) => {
              const note = notesByAnchorId?.get(anchorId);
              return note === undefined
                ? []
                : [<Fragment key={anchorId}>{note}</Fragment>];
            });
            const byline =
              dissent !== null && dissent.blockId === block.id
                ? dissent.byline
                : null;
            if (notes.length === 0 && byline === null) {
              return body;
            }
            return (
              <>
                {byline}
                {body}
                {notes}
              </>
            );
          },
        )}
      </div>,
    );
  }

  return result;
};

const NO_ANNOTATION_ANCHORS: readonly AnnotationAnchorSource[] = [];

export const DecisionText = ({
  aiHeadnotes = null,
  annotationAnchors = NO_ANNOTATION_ANCHORS,
  decision,
  decisionId,
  isHydrated,
  landingAnchorId,
  notesByAnchorId,
  expandProvisions = false,
  onAnnotationActivate,
  sectionMap,
  articleRef,
  placements,
}: DecisionTextProps) => {
  const messages = useReaderMessages();

  const ast = parseDocumentAst(decision.documentAst);
  const visibleBlocks = visibleDecisionBlocks(ast, decision.caseNumberType);
  const wrappedRuns = wrappedParagraphRuns(visibleBlocks);
  const topMatter = decisionTopMatter({
    blocks: visibleBlocks,
    textFields: decision.textFields,
  });
  const courtOrigin = courtHeadnoteOrigin(decision);
  // The document renders what the top matter did not take. Anchors still come
  // from every visible block, wherever it ends up drawn; note grouping and
  // the landing passage follow the order the page renders,
  // which is the top matter first.
  const bodyBlocks = visibleBlocks.filter(
    (block) => !topMatter.liftedBlockIds.has(block.id),
  );
  const renderedBlocks = [
    ...topMatterBlocks(topMatter),
    ...bodyBlocks,
  ] satisfies Block[];
  const footnotes = footnoteParts(renderedBlocks);
  const caption = decisionCaption({
    blocks: bodyBlocks,
    country: decision.country,
  });
  const hydrated = isHydrated ?? false;
  const adapters = useReaderAdapters();

  const displayRef = decisionDisplayReference({
    ast,
    caseNumber: decision.caseNumber,
    caseNumberType: decision.caseNumberType,
  });

  // A separate opinion is bylined where the court's own text does not say
  // whose it is: the names come from the read, the place from the AST, and
  // the byline is drawn only where both are there.
  const dissenters = decision.judges.filter(
    (judge) => judge.role === "dissenting",
  );
  const dissentBlockId = firstDissentBlockId(bodyBlocks);
  const dissent =
    dissenters.length === 0 || dissentBlockId === null
      ? null
      : {
          blockId: dissentBlockId,
          byline: <DissentByline judges={dissenters} />,
        };

  const { anchorsByPieceId, provisionsByAnchorId } = placements;

  // A block's note keeps its place in the tree whether the provision cards
  // above it are shown or not, so toggling them never remounts the note.
  const supplementsByAnchorId = new Map<string, ReactNode>();
  const supplementedAnchorIds = new Set(notesByAnchorId?.keys());
  if (expandProvisions) {
    for (const anchorId of provisionsByAnchorId.keys()) {
      supplementedAnchorIds.add(anchorId);
    }
  }
  for (const anchorId of supplementedAnchorIds) {
    supplementsByAnchorId.set(
      anchorId,
      <>
        {expandProvisions ? provisionsByAnchorId.get(anchorId) : null}
        {notesByAnchorId?.get(anchorId)}
      </>,
    );
  }

  // One return, so the attribution line cannot be forgotten on the branch
  // somebody adds next: it is required wherever a decision is rendered,
  // including the states where the text itself did not resolve.
  const body = ((): ReactElement => {
    if (visibleBlocks.length > 0) {
      return (
        <article
          className="text-card-foreground text-start"
          lang={decision.language}
          ref={articleRef}
          style={{
            fontFamily: "var(--reader-body-font)",
            fontSize: "var(--reader-body-size)",
            lineHeight: "var(--reader-body-line-height)",
          }}
        >
          {hydrated && onAnnotationActivate !== undefined && (
            <div className="sr-only">
              {annotationAnchors.map((annotation) => (
                <button
                  key={annotation.id}
                  onClick={() => onAnnotationActivate(annotation.id)}
                  type="button"
                >
                  {annotation.kind === "comment"
                    ? messages["folio.comment"]
                    : messages["legalReader.annotations.highlight"]}
                </button>
              ))}
            </div>
          )}
          <DecisionReference
            activeMatchIndex={NO_ACTIVE_MATCH}
            ranges={[]}
            text={`${decision.court}, ${displayRef}`}
          />
          <DecisionTopMatterSections
            activeMatchIndex={NO_ACTIVE_MATCH}
            aiHeadnotes={aiHeadnotes}
            anchorsByPieceId={anchorsByPieceId}
            courtOrigin={courtOrigin}
            annotationAnchors={
              hydrated ? annotationAnchors : NO_ANNOTATION_ANCHORS
            }
            footnotes={footnotes}
            key={decisionId}
            notesByAnchorId={supplementsByAnchorId}
            rangesByPieceId={NO_SEARCH_RANGES}
            topMatter={topMatter}
          />
          {renderBlocksWithHoldingZone({
            activeMatchIndex: NO_ACTIVE_MATCH,
            apparatusLabel: messages["caseLaw.reader.headMatter"],
            anchorsByPieceId,
            blocks: bodyBlocks,
            caption,
            dissent,
            footnotes,
            landingAnchorId,
            notesByAnchorId: supplementsByAnchorId,
            rangesByPieceId: NO_SEARCH_RANGES,
            sectionMap,
            wrappedRuns,
          })}
        </article>
      );
    }

    if (decision.fulltext) {
      return (
        <article
          className="text-card-foreground text-start"
          lang={decision.language}
          ref={articleRef}
          style={{
            fontFamily: "var(--reader-body-font)",
            fontSize: "var(--reader-body-size)",
            lineHeight: "var(--reader-body-line-height)",
          }}
        >
          <DecisionReference
            activeMatchIndex={NO_ACTIVE_MATCH}
            ranges={[]}
            text={`${decision.court}, ${displayRef}`}
          />
          <DecisionTopMatterSections
            activeMatchIndex={NO_ACTIVE_MATCH}
            aiHeadnotes={aiHeadnotes}
            anchorsByPieceId={anchorsByPieceId}
            courtOrigin={courtOrigin}
            annotationAnchors={
              hydrated ? annotationAnchors : NO_ANNOTATION_ANCHORS
            }
            footnotes={footnotes}
            key={decisionId}
            notesByAnchorId={supplementsByAnchorId}
            rangesByPieceId={NO_SEARCH_RANGES}
            topMatter={topMatter}
          />
          <FulltextFallback
            activeMatchIndex={NO_ACTIVE_MATCH}
            anchorsByPieceId={anchorsByPieceId}
            notesByAnchorId={supplementsByAnchorId}
            rangesByPieceId={NO_SEARCH_RANGES}
            text={decision.fulltext}
          />
        </article>
      );
    }

    // Never a bare empty pane: the read says whether the text failed, is
    // still coming, or was never offered, and the reader is told which. The
    // abstract and the legal sentence come from the decision record rather
    // than the document, so they survive a failed read and are what a lawyer
    // can still work from.
    return (
      <article
        className="text-card-foreground text-start"
        lang={decision.language}
        ref={articleRef}
        style={{
          fontFamily: "var(--reader-body-font)",
          fontSize: "var(--reader-body-size)",
          lineHeight: "var(--reader-body-line-height)",
        }}
      >
        <DecisionTopMatterSections
          activeMatchIndex={NO_ACTIVE_MATCH}
          aiHeadnotes={aiHeadnotes}
          anchorsByPieceId={anchorsByPieceId}
          courtOrigin={courtOrigin}
          annotationAnchors={
            hydrated ? annotationAnchors : NO_ANNOTATION_ANCHORS
          }
          footnotes={footnotes}
          key={decisionId}
          notesByAnchorId={supplementsByAnchorId}
          rangesByPieceId={NO_SEARCH_RANGES}
          topMatter={topMatter}
        />
        {adapters.renderBodyUnavailable({
          decisionId: decision.id,
          reason: missingBodyReason(decision),
        })}
      </article>
    );
  })();

  // A note whose paragraph the flow above did not draw (an anchor the text no
  // longer carries, or a document anchor on a decision that only resolved to
  // fulltext) follows the text rather than going with its anchor. Counted
  // over the blocks the page renders, top matter and fulltext paragraphs
  // included, so a note on a lifted headnote draws under it instead of at the
  // end.
  const placementBlocks = visibleDecisionBlocks(
    ast,
    decision.caseNumberType,
    decision.fulltext,
  );
  const drawnBlocks =
    visibleBlocks.length === 0 && decision.fulltext
      ? [...renderedBlocks, ...placementBlocks]
      : renderedBlocks;
  const drawnAnchorIds = new Set(drawnBlocks.map((block) => block.anchorId));
  const trailingNotes =
    notesByAnchorId === undefined
      ? []
      : [...notesByAnchorId].filter(
          ([anchorId]) => !drawnAnchorIds.has(anchorId),
        );

  // `reader-case-law` caps the measure: the decision and the attribution line
  // under it are read at a line length, not at the width of the pane.
  //
  // The publisher named here is the only host the court's own markup may link
  // to; every other link in the document renders as its own words. The
  // attribution URL is the sources registry's answer for this decision, and
  // the AST carries the publisher's own page and print URLs for it, so a
  // publisher serving its catalogue and its documents from sibling hosts
  // keeps its own links.
  return (
    <SourceLinkPolicyProvider
      urls={[
        decision.sourceAttributionUrl,
        ast?.source.webUrl,
        ast?.source.printUrl,
      ]}
    >
      <div className="reader-case-law">
        {body}
        {trailingNotes.map(([anchorId, note]) => (
          <Fragment key={anchorId}>{note}</Fragment>
        ))}
        <DecisionSourceAttribution url={decision.sourceAttributionUrl} />
      </div>
    </SourceLinkPolicyProvider>
  );
};

const DissentByline = ({ judges }: { judges: ReaderDecision["judges"] }) => {
  const messages = useReaderMessages();
  return (
    <p
      className="reader-chrome text-muted-foreground mt-6 mb-2 text-xs"
      data-reader-chrome=""
    >
      {messages.dissentByline(judges.map((judge) => judge.name))}
    </p>
  );
};
