import { Fragment, useRef } from "react";
import type { ReactElement, ReactNode } from "react";

import { useTranslations } from "use-intl";

import { locateCitationSpans } from "@stll/legal-ast/citation-passage";
import type { Block } from "@stll/legal-ast/document-ast";
import { parseDocumentAst } from "@stll/legal-ast/document-ast";
import { dropOverlappingSpans } from "@stll/legal-ast/text-spans";
import { BidiText } from "@stll/ui/bidi-text";
import { cn } from "@stll/ui/utils";

import {
  annotationTextAnchors,
  buildAnnotationAnchors,
  renderLinkAnnotations,
} from "@/components/legal-reader/annotations/annotation-anchors";
import type { AnnotationAnchorSource } from "@/components/legal-reader/annotations/annotation-anchors";
import { ExternalCitationLink } from "@/components/legal-reader/citation-link";
import { CitedDecisionLink } from "@/components/legal-reader/cited-decision-link";
import { CitedProvisionLink } from "@/components/legal-reader/cited-provision-link";
import { CitedStatuteLink } from "@/components/legal-reader/cited-statute-link";
import {
  BlockRenderer,
  FulltextFallback,
  HighlightedText,
  InlineContent,
  buildDocumentAstSearchPieces,
  buildFulltextSearchPieces,
  firstMatchIndexInPassage,
  rangesForPiece,
} from "@/components/legal-reader/document-ast-text";
import type { TextAnchor } from "@/components/legal-reader/document-ast-text";
import {
  holdLanding,
  readerBlockByAnchor,
} from "@/components/legal-reader/reader-landing";
import type {
  SearchMatchRange,
  SearchPiece,
} from "@/components/legal-reader/reader-search";
import { buildSearchResults } from "@/components/legal-reader/reader-search";
import { SourceLinkPolicyProvider } from "@/components/legal-reader/source-link-policy";
import type { CitationAnchorSource } from "@/features/case-law/citation-anchors";
import { decisionReferenceTintClassName } from "@/features/case-law/citation-treatment";
import { DecisionBodyUnavailable } from "@/features/case-law/components/case-viewer/decision-body-state";
import { missingBodyReason } from "@/features/case-law/components/case-viewer/decision-body-state.logic";
import type { DecisionDocumentState } from "@/features/case-law/components/case-viewer/decision-body-state.logic";
import { DissentByline } from "@/features/case-law/components/case-viewer/decision-judges";
import {
  annotationsOverlappingTextSpan,
  apparatusBlockIds,
  courtHeadnoteOrigin,
  decisionDisplayReference,
  decisionTopMatter,
  editorialSupplementBlocks,
  footnoteParts,
  topMatterBlocks,
  visibleDecisionBlocks,
} from "@/features/case-law/components/case-viewer/decision-text.logic";
import type {
  DecisionTopMatter,
  FootnoteParts,
  TopMatterSource,
} from "@/features/case-law/components/case-viewer/decision-text.logic";
import { HeadnoteBlock } from "@/features/case-law/components/case-viewer/headnote-block";
import type { HeadnoteOrigin } from "@/features/case-law/components/case-viewer/headnote-block";
import type { DecisionProvisionAnchor } from "@/features/case-law/components/case-viewer/use-decision-provision-anchors";
import type { DecisionStatuteCitationAnchor } from "@/features/case-law/components/case-viewer/use-decision-statute-citation-anchors";
import { dissentingJudges } from "@/features/case-law/decision-judges";
import { locateExternalCjeuCitations } from "@/features/case-law/fallback-legal-anchors";
import { locateProvisionAnchors } from "@/features/case-law/provision-anchors";
import type { PublicCaseLawDecision } from "@/features/case-law/public-decision";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useHydrated } from "@/hooks/use-hydrated";
import { optionalArray } from "@/lib/arrays";
import { sanitizeHref } from "@/lib/sanitize-href";

type Decision = Pick<
  PublicCaseLawDecision,
  | keyof DecisionDocumentState
  | "caseNumber"
  | "caseNumberType"
  | "court"
  | "courtAbbreviation"
  | "courtTier"
  | "documentAst"
  | "fulltext"
  | "id"
  | "judges"
  | "language"
  | "sourceAttributionUrl"
  | "textFields"
>;

type DecisionTextProps = {
  activeMatchIndex: number;
  /**
   * The model's headnote and abstract, drawn in the top matter under the
   * court's own. A node rather than the analysis itself: the order the two
   * origins are read in belongs to the decision, and nothing else about an
   * analysis does.
   */
  aiHeadnotes?: ReactNode | undefined;
  /** The reader's own marks and what colleagues shared. */
  annotationAnchors?: readonly AnnotationAnchorSource[] | undefined;
  /** Resolved citations whose mentions in the text become links. */
  citationAnchors?: readonly CitationAnchorSource[] | undefined;
  decision: Decision;
  /**
   * The decision on screen. The top matter's disclosures are mounted under
   * it, so a route that swaps one decision for another opens the new
   * headnote instead of inheriting the last reader's fold.
   */
  decisionId: string;
  /**
   * The block the reader was sent to, from a results row or a citation. It
   * keeps a marker while the reader is on it, and the find lands on its first
   * match rather than on the document's first.
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
  onMatchCountChange?: ((count: number) => void) | undefined;
  /** Applied provisions whose statute is held, for inline links. */
  provisionAnchors?: readonly DecisionProvisionAnchor[] | undefined;
  searchQuery: string;
  sectionMap?: Map<string, { cssVar: string; headingId: string }> | undefined;
  /** Work citations, including references with no provision locator. */
  statuteCitationAnchors?: readonly DecisionStatuteCitationAnchor[] | undefined;
};

/** No match is the find's own: nothing carries the active mark. */
const NO_ACTIVE_MATCH = -1;

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
  const t = useTranslations();
  const href = sanitizeHref(url);

  if (href === undefined) {
    return null;
  }

  return (
    <footer
      className="reader-chrome text-muted-foreground border-border/50 mt-10 border-t pt-3 text-[calc(0.6875rem*var(--reader-text-scale))] leading-snug"
      data-reader-chrome=""
    >
      {t.rich("caseLaw.reader.sourceAttribution", {
        link: (chunks) => (
          <a
            className="hover:text-foreground underline underline-offset-2"
            href={sanitizeHref(href)}
            rel="noopener noreferrer"
            target="_blank"
          >
            <BidiText>{chunks}</BidiText>
          </a>
        ),
        source: attributionLabel(href),
      })}
    </footer>
  );
};

const DecisionReference = ({
  activeMatchIndex,
  ranges,
  text,
}: {
  activeMatchIndex: number;
  ranges: SearchMatchRange[];
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
  ranges: SearchMatchRange[];
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
  rangesByPieceId: Record<string, SearchMatchRange[]>;
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
  rangesByPieceId: Record<string, SearchMatchRange[]>,
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
  rangesByPieceId: Record<string, SearchMatchRange[]>;
  topMatter: DecisionTopMatter;
}) => {
  const t = useTranslations();
  const { abstract, legalSentence } = topMatter;
  const hasAi = aiHeadnotes !== null && aiHeadnotes !== undefined;

  if (legalSentence === null && abstract === null && !hasAi) {
    return null;
  }

  return (
    // The text is read like the decision it belongs to: the article's serif,
    // size and line-height, inherited. Only the labels are chrome.
    <div className="bg-muted/30 border-border/50 mb-8 rounded-lg border px-5 py-4">
      {legalSentence !== null && (
        <HeadnoteBlock
          defaultOpen
          forceOpen={sourceHasMatch(legalSentence, rangesByPieceId)}
          label={t("caseLaw.viewer.legalSentence")}
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
          label={t("caseLaw.viewer.abstract")}
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
    </div>
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
const buildAnchorsByPieceId = ({
  annotations,
  blocks,
  citations,
  provisions,
  statutes,
}: {
  annotations: readonly AnnotationAnchorSource[];
  blocks: readonly Block[];
  citations: readonly CitationAnchorSource[];
  provisions: readonly DecisionProvisionAnchor[];
  statutes: readonly DecisionStatuteCitationAnchor[];
}): Record<string, TextAnchor[]> => {
  const citationSpans = locateCitationSpans({ blocks, citations });
  const provisionSpans = locateProvisionAnchors({ blocks, provisions });
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
    anchors.push(...annotationTextAnchors(optionalArray(blockAnnotations)));
    for (const span of optionalArray(citationSpans[blockId])) {
      const linkAnnotations = annotationsOverlappingTextSpan(
        optionalArray(blockAnnotations),
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
          return (
            <CitedDecisionLink
              className={cn(
                decisionReferenceTintClassName(span.source.treatment),
              )}
              decision={span.source.decision}
              treatment={span.source.treatment}
            >
              {marked}
            </CitedDecisionLink>
          );
        },
        start: span.start,
      });
    }
    for (const span of optionalArray(provisionSpans[blockId])) {
      const linkAnnotations = annotationsOverlappingTextSpan(
        optionalArray(blockAnnotations),
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
          return (
            <CitedProvisionLink provision={span.source.target}>
              {marked}
            </CitedProvisionLink>
          );
        },
        start: span.start,
      });
    }
    for (const span of optionalArray(statuteSpans.get(blockId))) {
      const linkAnnotations = annotationsOverlappingTextSpan(
        optionalArray(blockAnnotations),
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
          return (
            <CitedStatuteLink target={span.target}>{marked}</CitedStatuteLink>
          );
        },
        start: span.start,
      });
    }
    for (const span of optionalArray(externalCjeuSpansByBlock.get(blockId))) {
      const linkAnnotations = annotationsOverlappingTextSpan(
        optionalArray(blockAnnotations),
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
    const links = dropOverlappingSpans(
      anchors.filter((anchor) => !anchor.key.startsWith("annotation:")),
    );
    const marks = anchors
      .filter((anchor) => anchor.key.startsWith("annotation:"))
      .flatMap((mark) => splitAroundLinks(mark, links));
    anchorsByPieceId[blockId] = dropOverlappingSpans([...links, ...marks]);
  }
  return anchorsByPieceId;
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
  dissent,
  footnotes,
  landingAnchorId,
  notesByAnchorId,
  rangesByPieceId,
  sectionMap,
}: {
  activeMatchIndex: number;
  anchorsByPieceId: Record<string, TextAnchor[]>;
  /** Translated label for the folded reporter-apparatus disclosure. */
  apparatusLabel: string;
  blocks: Block[];
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
  rangesByPieceId: Record<string, SearchMatchRange[]>;
  sectionMap?: Map<string, { cssVar: string; headingId: string }> | undefined;
}): ReactNode[] => {
  const result: ReactNode[] = [];

  // Publisher head matter (counsel appearances, syllabus, headnotes) folds
  // behind a disclosure: not the court's words, one click away rather than
  // gone.
  const apparatusIds = apparatusBlockIds(blocks);

  const { headIds: footnoteHeadIds, backJumpAnchorByLastId } = footnotes;

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
            // One renderer for every block: a footnote can carry any role,
            // holding included, so its grouping travels with it either way.
            const rendered = (
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
            const body = isHoldingBlock(block) ? (
              <div className="font-[520]" key={block.id}>
                {rendered}
              </div>
            ) : (
              rendered
            );
            const notes = notesByAnchorId?.get(block.anchorId);
            const byline =
              dissent !== null && dissent.blockId === block.id
                ? dissent.byline
                : null;
            if (notes === undefined && byline === null) {
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

const NO_CITATION_ANCHORS: readonly CitationAnchorSource[] = [];
const NO_PROVISION_ANCHORS: readonly DecisionProvisionAnchor[] = [];
const NO_ANNOTATION_ANCHORS: readonly AnnotationAnchorSource[] = [];
const NO_STATUTE_CITATION_ANCHORS: readonly DecisionStatuteCitationAnchor[] =
  [];

export const DecisionText = ({
  activeMatchIndex,
  aiHeadnotes = null,
  annotationAnchors = NO_ANNOTATION_ANCHORS,
  citationAnchors = NO_CITATION_ANCHORS,
  decision,
  decisionId,
  landingAnchorId,
  notesByAnchorId,
  onAnnotationActivate,
  onMatchCountChange,
  provisionAnchors = NO_PROVISION_ANCHORS,
  searchQuery,
  sectionMap,
  statuteCitationAnchors = NO_STATUTE_CITATION_ANCHORS,
}: DecisionTextProps) => {
  const t = useTranslations();

  const ast = parseDocumentAst(decision.documentAst);
  const visibleBlocks = visibleDecisionBlocks(ast);
  const topMatter = decisionTopMatter({
    blocks: visibleBlocks,
    textFields: decision.textFields,
  });
  const courtOrigin = courtHeadnoteOrigin(decision);
  // The document renders what the top matter did not take. Anchors still come
  // from every visible block, wherever it ends up drawn; match numbering,
  // note grouping and the landing passage follow the order the page renders,
  // which is the top matter first.
  const bodyBlocks = visibleBlocks.filter(
    (block) => !topMatter.liftedBlockIds.has(block.id),
  );
  const renderedBlocks = [
    ...topMatterBlocks(topMatter),
    ...bodyBlocks,
  ] satisfies Block[];
  const footnotes = footnoteParts(renderedBlocks);
  const articleRef = useRef<HTMLElement>(null);
  // Inline links come from prefetches that do not block the route, so the
  // server pass and the client's hydration pass may not agree on them. The
  // text hydrates bare and the links are laid over it right after.
  const hydrated = useHydrated();

  const displayRef = decisionDisplayReference({
    ast,
    caseNumber: decision.caseNumber,
    caseNumberType: decision.caseNumberType,
  });

  const hasRenderableBody =
    visibleBlocks.length > 0 ||
    (decision.fulltext !== null && decision.fulltext !== "");

  const searchPieces: SearchPiece[] = (() => {
    // A match needs something on screen to scroll to, so each piece is
    // indexed exactly where its own element renders. The reference line
    // belongs to the body; the supplement is published separately from the
    // text and stands even where the text did not resolve.
    const pieces: SearchPiece[] = hasRenderableBody
      ? [
          {
            id: DECISION_REFERENCE_ID,
            text: `${decision.court}, ${displayRef}`,
          },
        ]
      : [];

    // Section by section, then the document: `buildSearchResults` numbers the
    // matches in piece order, and a find that walks the page backwards is the
    // bug that order prevents. A field the top matter does not render is not
    // indexed at all — a match in text drawn nowhere has nothing to scroll to.
    for (const source of [topMatter.legalSentence, topMatter.abstract]) {
      if (source === null) {
        continue;
      }
      if (source.type === "text") {
        pieces.push({ id: source.pieceId, text: source.text });
        continue;
      }
      pieces.push(...buildDocumentAstSearchPieces(source.blocks));
    }

    if (visibleBlocks.length > 0) {
      pieces.push(...buildDocumentAstSearchPieces(bodyBlocks));
    } else if (decision.fulltext) {
      pieces.push(...buildFulltextSearchPieces(decision.fulltext));
    }

    return pieces;
  })();

  const searchResults = buildSearchResults({
    pieces: searchPieces,
    query: searchQuery,
  });

  // Where the reader is sent: the landing passage's own first match while
  // they are still on it, the find's position once they move. The two can
  // never disagree, because the caller drops the landing the moment the
  // reader jumps anywhere else.
  //
  // A landing passage the query does not reach activates nothing rather than
  // falling back to the find's position. The anchor a question's source chip
  // carries was chosen by the answer, not by the query, so the query may well
  // match somewhere else entirely; pulling the reader there would answer a
  // question they did not ask.
  const landingMatchIndex =
    landingAnchorId === undefined
      ? null
      : firstMatchIndexInPassage({
          anchorId: landingAnchorId,
          blocks: renderedBlocks,
          rangesByPieceId: searchResults.rangesByPieceId,
        });
  const shownMatchIndex =
    landingAnchorId === undefined
      ? activeMatchIndex
      : (landingMatchIndex ?? NO_ACTIVE_MATCH);

  useExternalSyncEffect(() => {
    onMatchCountChange?.(searchResults.matchCount);
  }, [onMatchCountChange, searchResults.matchCount]);

  useExternalSyncEffect(() => {
    const article = articleRef.current;
    if (!article) {
      return undefined;
    }

    // The match wins where there is one; a landing passage the query does not
    // reach is still where the reader asked to be.
    const match =
      shownMatchIndex === NO_ACTIVE_MATCH
        ? null
        : article.querySelector<HTMLElement>(
            `[data-reader-match-index="${String(shownMatchIndex)}"]`,
          );
    const target =
      match ??
      (landingAnchorId === undefined
        ? null
        : readerBlockByAnchor(article, landingAnchorId));
    if (!target) {
      return undefined;
    }

    // A match inside the folded reporter apparatus is invisible while its
    // <details> stays closed, and scrolling to a hidden descendant reveals
    // nothing: open every enclosing disclosure first.
    for (
      let disclosure = target.closest("details");
      disclosure !== null;
      disclosure = disclosure.parentElement?.closest("details") ?? null
    ) {
      disclosure.open = true;
    }

    // Stepping between matches is a move the reader makes, so it glides.
    // Landing is arrival: the passage may be screens away while the page is
    // still settling, and an animation over that distance is a wait.
    if (landingAnchorId === undefined) {
      target.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "nearest",
      });
      return undefined;
    }
    return holdLanding({ article, target });
  }, [landingAnchorId, searchQuery, searchResults.matchCount, shownMatchIndex]);

  // A separate opinion is bylined where the court's own text does not say
  // whose it is: the names come from the read, the place from the AST, and
  // the byline is drawn only where both are there.
  const dissenters = dissentingJudges(decision.judges);
  const dissentBlockId = firstDissentBlockId(bodyBlocks);
  const dissent =
    dissenters.length === 0 || dissentBlockId === null
      ? null
      : {
          blockId: dissentBlockId,
          byline: <DissentByline judges={dissenters} />,
        };

  // Inline links for every visible block, wherever it is drawn: the top
  // matter and the document below share one map.
  const anchorsByPieceId = buildAnchorsByPieceId({
    annotations: hydrated ? annotationAnchors : NO_ANNOTATION_ANCHORS,
    blocks: visibleBlocks,
    citations: hydrated ? citationAnchors : NO_CITATION_ANCHORS,
    provisions: hydrated ? provisionAnchors : NO_PROVISION_ANCHORS,
    statutes: hydrated ? statuteCitationAnchors : NO_STATUTE_CITATION_ANCHORS,
  });

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
                    ? t("folio.comment")
                    : t("legalReader.annotations.highlight")}
                </button>
              ))}
            </div>
          )}
          <DecisionReference
            activeMatchIndex={shownMatchIndex}
            ranges={rangesForPiece(
              searchResults.rangesByPieceId,
              DECISION_REFERENCE_ID,
            )}
            text={`${decision.court}, ${displayRef}`}
          />
          <DecisionTopMatterSections
            activeMatchIndex={shownMatchIndex}
            aiHeadnotes={aiHeadnotes}
            anchorsByPieceId={anchorsByPieceId}
            courtOrigin={courtOrigin}
            annotationAnchors={
              hydrated ? annotationAnchors : NO_ANNOTATION_ANCHORS
            }
            footnotes={footnotes}
            key={decisionId}
            notesByAnchorId={notesByAnchorId}
            rangesByPieceId={searchResults.rangesByPieceId}
            topMatter={topMatter}
          />
          {renderBlocksWithHoldingZone({
            activeMatchIndex: shownMatchIndex,
            apparatusLabel: t("caseLaw.reader.headMatter"),
            anchorsByPieceId,
            blocks: bodyBlocks,
            dissent,
            footnotes,
            landingAnchorId,
            notesByAnchorId,
            rangesByPieceId: searchResults.rangesByPieceId,
            sectionMap,
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
            activeMatchIndex={shownMatchIndex}
            ranges={rangesForPiece(
              searchResults.rangesByPieceId,
              DECISION_REFERENCE_ID,
            )}
            text={`${decision.court}, ${displayRef}`}
          />
          <DecisionTopMatterSections
            activeMatchIndex={shownMatchIndex}
            aiHeadnotes={aiHeadnotes}
            anchorsByPieceId={anchorsByPieceId}
            courtOrigin={courtOrigin}
            annotationAnchors={
              hydrated ? annotationAnchors : NO_ANNOTATION_ANCHORS
            }
            footnotes={footnotes}
            key={decisionId}
            notesByAnchorId={notesByAnchorId}
            rangesByPieceId={searchResults.rangesByPieceId}
            topMatter={topMatter}
          />
          <FulltextFallback
            activeMatchIndex={shownMatchIndex}
            anchorsByPieceId={buildAnnotationAnchors(
              hydrated ? annotationAnchors : NO_ANNOTATION_ANCHORS,
            )}
            rangesByPieceId={searchResults.rangesByPieceId}
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
          activeMatchIndex={shownMatchIndex}
          aiHeadnotes={aiHeadnotes}
          anchorsByPieceId={anchorsByPieceId}
          courtOrigin={courtOrigin}
          annotationAnchors={
            hydrated ? annotationAnchors : NO_ANNOTATION_ANCHORS
          }
          footnotes={footnotes}
          key={decisionId}
          notesByAnchorId={notesByAnchorId}
          rangesByPieceId={searchResults.rangesByPieceId}
          topMatter={topMatter}
        />
        <DecisionBodyUnavailable
          decisionId={decision.id}
          reason={missingBodyReason(decision)}
        />
      </article>
    );
  })();

  // A note whose paragraph the flow above did not draw — a decision that only
  // resolved to fulltext, or an anchor the text no longer carries — follows
  // the text rather than going with its anchor. Counted over the blocks the
  // page renders, top matter included, so a note on a lifted headnote draws
  // under it instead of at the end.
  const drawnAnchorIds = new Set(renderedBlocks.map((block) => block.anchorId));
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
