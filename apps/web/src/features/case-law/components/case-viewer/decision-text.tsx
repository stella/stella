import { Fragment, useRef, useState } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  DECISION_TEXT_FIELD,
  TEXT_FIELD_TYPE,
  type ReadDecisionTextFields,
  type TextField,
} from "@stll/api-contract/case-law-text-field";
import type { Block } from "@stll/legal-ast/document-ast";
import { parseDocumentAst } from "@stll/legal-ast/document-ast";
import { cn } from "@stll/ui/utils";

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
  rangesForPiece,
} from "@/components/legal-reader/document-ast-text";
import type { TextAnchor } from "@/components/legal-reader/document-ast-text";
import type {
  SearchMatchRange,
  SearchPiece,
} from "@/components/legal-reader/reader-search";
import { buildSearchResults } from "@/components/legal-reader/reader-search";
import {
  dropOverlappingSpans,
  locateCitationAnchors,
} from "@/features/case-law/citation-anchors";
import type { CitationAnchorSource } from "@/features/case-law/citation-anchors";
import {
  annotationsOverlappingTextSpan,
  apparatusBlockIds,
  editorialSupplementBlocks,
  footnoteParts,
  visibleDecisionBlocks,
} from "@/features/case-law/components/case-viewer/decision-text.logic";
import type { DecisionProvisionAnchor } from "@/features/case-law/components/case-viewer/use-decision-provision-anchors";
import type { DecisionStatuteCitationAnchor } from "@/features/case-law/components/case-viewer/use-decision-statute-citation-anchors";
import { locateExternalCjeuCitations } from "@/features/case-law/fallback-legal-anchors";
import { locateProvisionAnchors } from "@/features/case-law/provision-anchors";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useHydrated } from "@/hooks/use-hydrated";
import { optionalArray } from "@/lib/arrays";

type Decision = {
  caseNumber: string;
  court: string;
  language: string;
  fulltext: string | null;
  documentAst?: unknown;
  textFields: ReadDecisionTextFields;
};

/** A reader's highlight or comment, as a span to draw over the text. */
export type AnnotationAnchorSource = {
  blockAnchorId: string;
  color: string | null;
  endOffset: number;
  id: string;
  kind: "highlight" | "comment";
  startOffset: number;
  /** How a highlight is drawn; null for a comment. */
  style: "highlight" | "underline" | "squiggly" | "strikethrough" | null;
};

type DecisionTextProps = {
  activeMatchIndex: number;
  /** The reader's own marks and what colleagues shared. */
  annotationAnchors?: readonly AnnotationAnchorSource[] | undefined;
  /** Resolved citations whose mentions in the text become links. */
  citationAnchors?: readonly CitationAnchorSource[] | undefined;
  decision: Decision;
  onAnnotationActivate?: ((annotationId: string) => void) | undefined;
  onMatchCountChange?: ((count: number) => void) | undefined;
  /** Applied provisions whose statute is held, for inline links. */
  provisionAnchors?: readonly DecisionProvisionAnchor[] | undefined;
  searchQuery: string;
  sectionMap?: Map<string, { cssVar: string; headingId: string }> | undefined;
  /** Work citations, including references with no provision locator. */
  statuteCitationAnchors?: readonly DecisionStatuteCitationAnchor[] | undefined;
};

const SUPPLEMENT_LEGAL_SENTENCE_ID = "supplement-legal-sentence";
const SUPPLEMENT_ABSTRACT_ID = "supplement-abstract";
const DECISION_REFERENCE_ID = "decision-reference";

const supplementBlockAnchorId = (pieceId: string, start: number): string =>
  `${pieceId}:${String(start)}`;

const DecisionReference = ({
  activeMatchIndex,
  ranges,
  text,
}: {
  activeMatchIndex: number;
  ranges: SearchMatchRange[];
  text: string;
}) => (
  <p className="text-muted-foreground mb-4 text-end font-sans text-xs italic">
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

const supplementText = (field: TextField): string | null => {
  switch (field.type) {
    case TEXT_FIELD_TYPE.ABSENT:
      return null;
    case TEXT_FIELD_TYPE.PRESENT:
      return field.text;
    default: {
      field satisfies never;
      return panic(`Unhandled decision text field: ${String(field)}`);
    }
  }
};

/**
 * A mark on the text, drawn the way PDF readers draw mark-up: a colour and a
 * style. A comment is a dotted underline in the margin colour; the words
 * stay readable under every style, including a strike, since the reader's
 * own mark must never hide the court's text.
 */
const annotationClassName = ({
  kind,
  style,
}: AnnotationAnchorSource): string => {
  if (kind === "comment") {
    return "cursor-pointer bg-transparent text-inherit underline decoration-dotted decoration-2 underline-offset-4";
  }
  switch (style) {
    case "underline": {
      return "cursor-pointer bg-transparent text-inherit underline decoration-2 underline-offset-3";
    }
    case "squiggly": {
      return "cursor-pointer bg-transparent text-inherit underline decoration-wavy decoration-2 underline-offset-3";
    }
    case "strikethrough": {
      return "cursor-pointer bg-transparent text-inherit line-through decoration-2";
    }
    case "highlight":
    case null: {
      // No padding or rounding: a mark over several inline runs is several
      // elements, and only a flat background reads as one continuous mark.
      return "cursor-pointer text-inherit";
    }
    default: {
      style satisfies never;
      return panic(`Unhandled style: ${String(style)}`);
    }
  }
};

const annotationStyle = ({
  color,
  kind,
  style,
}: AnnotationAnchorSource): CSSProperties => {
  if (kind === "comment") {
    return { textDecorationColor: "var(--option-sky)" };
  }
  const swatch = `var(--option-${color ?? "yellow"})`;
  return style === "highlight" || style === null
    ? { backgroundColor: `color-mix(in srgb, ${swatch} 32%, transparent)` }
    : { textDecorationColor: swatch };
};

const renderAnnotation = (
  annotation: AnnotationAnchorSource,
  children: ReactNode,
): ReactElement => (
  <mark
    className={cn(annotationClassName(annotation))}
    data-annotation-id={annotation.id}
    style={annotationStyle(annotation)}
  >
    {children}
  </mark>
);

const annotationTextAnchor = (
  annotation: AnnotationAnchorSource,
  offset = 0,
): TextAnchor => ({
  end: offset + annotation.endOffset,
  key: `annotation:${annotation.id}`,
  render: (children): ReactElement => renderAnnotation(annotation, children),
  start: offset + annotation.startOffset,
});

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
      const anchors = annotationAnchors
        .filter((annotation) => annotation.blockAnchorId === blockAnchorId)
        .map((annotation) => annotationTextAnchor(annotation, block.start));
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

const EditorialSupplement = ({
  activeMatchIndex,
  annotationAnchors,
  rangesByPieceId,
  textFields,
}: {
  activeMatchIndex: number;
  annotationAnchors: readonly AnnotationAnchorSource[];
  rangesByPieceId: Record<string, SearchMatchRange[]>;
  textFields: ReadDecisionTextFields;
}) => {
  const t = useTranslations();
  const abstract = supplementText(textFields[DECISION_TEXT_FIELD.ABSTRACT]);
  const legalSentence = supplementText(
    textFields[DECISION_TEXT_FIELD.LEGAL_SENTENCE],
  );
  const abstractRanges = rangesForPiece(
    rangesByPieceId,
    SUPPLEMENT_ABSTRACT_ID,
  );
  const legalSentenceRanges = rangesForPiece(
    rangesByPieceId,
    SUPPLEMENT_LEGAL_SENTENCE_ID,
  );
  const [abstractOpenByUser, setAbstractOpenByUser] = useState(false);
  const abstractOpen = abstractRanges.length > 0 || abstractOpenByUser;

  if (!abstract && !legalSentence) {
    return null;
  }

  return (
    <div className="bg-muted/30 border-border/50 mb-8 rounded-lg border px-5 py-4 font-sans text-[0.88rem] leading-relaxed">
      {legalSentence && (
        <section>
          <h4
            className="text-muted-foreground mb-2 text-[0.75rem] font-semibold tracking-wide uppercase"
            data-reader-chrome=""
          >
            {t("caseLaw.viewer.legalSentence")}
          </h4>
          <EditorialSupplementBody
            activeMatchIndex={activeMatchIndex}
            annotationAnchors={annotationAnchors}
            pieceId={SUPPLEMENT_LEGAL_SENTENCE_ID}
            ranges={legalSentenceRanges}
            text={legalSentence}
            variant="legal-sentence"
          />
        </section>
      )}
      {abstract && (
        <details
          className={cn(legalSentence ? "mt-4" : "")}
          onToggle={(event) => setAbstractOpenByUser(event.currentTarget.open)}
          open={abstractOpen}
        >
          <summary
            className="text-muted-foreground cursor-pointer text-[0.75rem] font-semibold tracking-wide uppercase select-none marker:text-current"
            data-reader-chrome=""
          >
            {t("caseLaw.viewer.abstract")}
          </summary>
          <div className="mt-3">
            <EditorialSupplementBody
              activeMatchIndex={activeMatchIndex}
              annotationAnchors={annotationAnchors}
              pieceId={SUPPLEMENT_ABSTRACT_ID}
              ranges={abstractRanges}
              text={abstract}
              variant="abstract"
            />
          </div>
        </details>
      )}
    </div>
  );
};

/**
 * Every inline link in the text, by block: cited decisions and applied
 * provisions, located separately and merged so the two kinds never nest. A
 * decision citation and a provision reference cannot share characters in
 * honest text, so whichever starts first simply wins.
 */
const buildStandaloneAnnotationAnchors = (
  annotations: readonly AnnotationAnchorSource[],
): Record<string, TextAnchor[]> => {
  const anchorsByPieceId: Record<string, TextAnchor[]> = {};
  for (const annotation of annotations) {
    const anchors = anchorsByPieceId[annotation.blockAnchorId];
    if (anchors === undefined) {
      anchorsByPieceId[annotation.blockAnchorId] = [
        annotationTextAnchor(annotation),
      ];
      continue;
    }
    anchors.push(annotationTextAnchor(annotation));
  }
  return anchorsByPieceId;
};

const renderLinkAnnotations = ({
  annotations,
  children,
}: {
  annotations: readonly AnnotationAnchorSource[];
  children: ReactNode;
}): ReactNode => {
  let marked = children;
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const annotation = annotations.at(index);
    if (annotation !== undefined) {
      marked = renderAnnotation(annotation, marked);
    }
  }
  return marked;
};

/** The pieces of a mark left once the links inside it are cut out. */
const splitAroundLinks = (
  mark: TextAnchor,
  links: readonly TextAnchor[],
): TextAnchor[] => {
  const cuts = links
    .filter((link) => mark.start < link.end && link.start < mark.end)
    .sort((a, b) => a.start - b.start);
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
  const citationSpans = locateCitationAnchors({ blocks, citations });
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
    for (const annotation of optionalArray(blockAnnotations)) {
      // Plain inline markup keeps the paragraph's own wrapping and
      // justification. The toolbar handles clicks on the mark by id.
      anchors.push(annotationTextAnchor(annotation));
    }
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
            <CitedDecisionLink decision={span.source.decision}>
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
          return (
            <ExternalCitationLink href={span.href}>
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

const renderBlocksWithHoldingZone = ({
  activeMatchIndex,
  anchorsByPieceId,
  apparatusLabel,
  blocks,
  rangesByPieceId,
  sectionMap,
}: {
  activeMatchIndex: number;
  anchorsByPieceId: Record<string, TextAnchor[]>;
  /** Translated label for the folded reporter-apparatus disclosure. */
  apparatusLabel: string;
  blocks: Block[];
  rangesByPieceId: Record<string, SearchMatchRange[]>;
  sectionMap?: Map<string, { cssVar: string; headingId: string }> | undefined;
}): ReactNode[] => {
  const result: ReactNode[] = [];

  // Publisher head matter (counsel appearances, syllabus, headnotes) folds
  // behind a disclosure: not the court's words, one click away rather than
  // gone.
  const apparatusIds = apparatusBlockIds(blocks);

  // A footnote printed over several paragraphs shows its mark on the first
  // and its return arrow on the last.
  const { headIds: footnoteHeadIds, backJumpAnchorByLastId } =
    footnoteParts(blocks);

  // Group consecutive blocks by heading ID for continuous lines.
  // Same category but different heading = separate groups.
  type Group = {
    cssVar: string | null;
    headingId: string | null;
    blocks: Block[];
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
        key={`section-${group.blocks.at(0)?.id}`}
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
                noteBackJumpTo={backJumpAnchorByLastId.get(block.id)}
                noteHead={footnoteHeadIds.has(block.id)}
                rangesByPieceId={rangesByPieceId}
                variant="case-law"
              />
            );
            return isHoldingBlock(block) ? (
              <div className="font-[520]" key={block.id}>
                {rendered}
              </div>
            ) : (
              rendered
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
  annotationAnchors = NO_ANNOTATION_ANCHORS,
  citationAnchors = NO_CITATION_ANCHORS,
  decision,
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
  const articleRef = useRef<HTMLElement>(null);
  // Inline links come from prefetches that do not block the route, so the
  // server pass and the client's hydration pass may not agree on them. The
  // text hydrates bare and the links are laid over it right after.
  const hydrated = useHydrated();

  const caseNumberBlock = ast?.blocks.find(
    (block) => block.type === "paragraph" && block.role === "case-number",
  );
  const displayRef = caseNumberBlock?.plainText ?? decision.caseNumber;

  const searchPieces: SearchPiece[] = (() => {
    // If the render falls through to the empty-state message
    // (no visible blocks AND no fulltext) nothing gets drawn on
    // the page, so indexing the reference + supplement would
    // surface matches with no scroll target. Keep pieces aligned
    // with what actually renders.
    const hasRenderableBody =
      visibleBlocks.length > 0 ||
      (decision.fulltext !== null && decision.fulltext !== "");
    if (!hasRenderableBody) {
      return [];
    }

    const pieces: SearchPiece[] = [
      {
        id: DECISION_REFERENCE_ID,
        text: `${decision.court}, ${displayRef}`,
      },
    ];

    const legalSentence = supplementText(
      decision.textFields[DECISION_TEXT_FIELD.LEGAL_SENTENCE],
    );
    const abstract = supplementText(
      decision.textFields[DECISION_TEXT_FIELD.ABSTRACT],
    );

    if (legalSentence) {
      pieces.push({
        id: SUPPLEMENT_LEGAL_SENTENCE_ID,
        text: legalSentence,
      });
    }

    if (abstract) {
      pieces.push({
        id: SUPPLEMENT_ABSTRACT_ID,
        text: abstract,
      });
    }

    if (visibleBlocks.length > 0) {
      pieces.push(...buildDocumentAstSearchPieces(visibleBlocks));
    } else if (decision.fulltext) {
      pieces.push(...buildFulltextSearchPieces(decision.fulltext));
    }

    return pieces;
  })();

  const searchResults = buildSearchResults({
    pieces: searchPieces,
    query: searchQuery,
  });

  useExternalSyncEffect(() => {
    onMatchCountChange?.(searchResults.matchCount);
  }, [onMatchCountChange, searchResults.matchCount]);

  useExternalSyncEffect(() => {
    if (searchQuery.trim().length === 0 || searchResults.matchCount === 0) {
      return;
    }

    const activeMatch = articleRef.current?.querySelector<HTMLElement>(
      `[data-reader-match-index="${activeMatchIndex}"]`,
    );
    if (!activeMatch) {
      return;
    }

    // A match inside the folded reporter apparatus is invisible while its
    // <details> stays closed, and scrolling to a hidden descendant reveals
    // nothing: open every enclosing disclosure first.
    for (
      let disclosure = activeMatch.closest("details");
      disclosure !== null;
      disclosure = disclosure.parentElement?.closest("details") ?? null
    ) {
      disclosure.open = true;
    }

    activeMatch.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
  }, [activeMatchIndex, searchQuery, searchResults.matchCount]);

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
                  : t("caseLaw.annotations.highlight")}
              </button>
            ))}
          </div>
        )}
        <DecisionReference
          activeMatchIndex={activeMatchIndex}
          ranges={rangesForPiece(
            searchResults.rangesByPieceId,
            DECISION_REFERENCE_ID,
          )}
          text={`${decision.court}, ${displayRef}`}
        />
        <EditorialSupplement
          activeMatchIndex={activeMatchIndex}
          annotationAnchors={
            hydrated ? annotationAnchors : NO_ANNOTATION_ANCHORS
          }
          rangesByPieceId={searchResults.rangesByPieceId}
          textFields={decision.textFields}
        />
        {renderBlocksWithHoldingZone({
          activeMatchIndex,
          apparatusLabel: t("caseLaw.reader.headMatter"),
          anchorsByPieceId: buildAnchorsByPieceId({
            annotations: hydrated ? annotationAnchors : NO_ANNOTATION_ANCHORS,
            blocks: visibleBlocks,
            citations: hydrated ? citationAnchors : NO_CITATION_ANCHORS,
            provisions: hydrated ? provisionAnchors : NO_PROVISION_ANCHORS,
            statutes: hydrated
              ? statuteCitationAnchors
              : NO_STATUTE_CITATION_ANCHORS,
          }),
          blocks: visibleBlocks,
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
          activeMatchIndex={activeMatchIndex}
          ranges={rangesForPiece(
            searchResults.rangesByPieceId,
            DECISION_REFERENCE_ID,
          )}
          text={`${decision.court}, ${displayRef}`}
        />
        <EditorialSupplement
          activeMatchIndex={activeMatchIndex}
          annotationAnchors={
            hydrated ? annotationAnchors : NO_ANNOTATION_ANCHORS
          }
          rangesByPieceId={searchResults.rangesByPieceId}
          textFields={decision.textFields}
        />
        <FulltextFallback
          activeMatchIndex={activeMatchIndex}
          anchorsByPieceId={buildStandaloneAnnotationAnchors(
            hydrated ? annotationAnchors : NO_ANNOTATION_ANCHORS,
          )}
          rangesByPieceId={searchResults.rangesByPieceId}
          text={decision.fulltext}
        />
      </article>
    );
  }

  return (
    <div className="flex items-center justify-center py-16">
      <p className="text-muted-foreground text-sm">{t("caseLaw.emptyState")}</p>
    </div>
  );
};
