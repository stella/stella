import { useRef } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import { useTranslations } from "use-intl";

import type { Block } from "@stll/legal-ast/document-ast";
import { parseDocumentAst } from "@stll/legal-ast/document-ast";
import { cn } from "@stll/ui/utils";

import { CitedDecisionLink } from "@/components/legal-reader/cited-decision-link";
import { CitedProvisionLink } from "@/components/legal-reader/cited-provision-link";
import {
  BlockRenderer,
  FulltextFallback,
  HighlightedText,
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
import { visibleDecisionBlocks } from "@/features/case-law/components/case-viewer/decision-text.logic";
import type { DecisionProvisionAnchor } from "@/features/case-law/components/case-viewer/use-decision-provision-anchors";
import { locateProvisionAnchors } from "@/features/case-law/provision-anchors";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useHydrated } from "@/hooks/use-hydrated";

type Decision = {
  caseNumber: string;
  court: string;
  language: string;
  fulltext: string | null;
  documentAst?: unknown;
  metadata?: Record<string, unknown> | null;
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
  onMatchCountChange?: ((count: number) => void) | undefined;
  /** Applied provisions whose statute is held, for inline links. */
  provisionAnchors?: readonly DecisionProvisionAnchor[] | undefined;
  searchQuery: string;
  sectionMap?: Map<string, { cssVar: string; headingId: string }> | undefined;
};

const SUPPLEMENT_LEGAL_SENTENCE_ID = "supplement-legal-sentence";
const SUPPLEMENT_ABSTRACT_ID = "supplement-abstract";
const DECISION_REFERENCE_ID = "decision-reference";

const isHoldingBlock = (block: Block): boolean =>
  block.type === "paragraph" && block.role === "holding";

/**
 * Source-level placeholder strings emitted by courts when an
 * editorial field is empty. We hide these at render time and
 * must also exclude them from search pieces so the find bar
 * doesn't report matches with no visible target.
 */
const SUPPLEMENT_PLACEHOLDER_RE =
  /\b(?:není k dispozici|nie je k dispozícii|niedostępn[ay])\b/iu;

const cleanSupplement = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "" || SUPPLEMENT_PLACEHOLDER_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
};

const EditorialSupplement = ({
  activeMatchIndex,
  metadata,
  rangesByPieceId,
}: {
  activeMatchIndex: number;
  metadata: Record<string, unknown>;
  rangesByPieceId: Record<string, SearchMatchRange[]>;
}) => {
  const t = useTranslations();
  const abstract = cleanSupplement(metadata["abstract"]);
  const legalSentence = cleanSupplement(metadata["legalSentence"]);

  if (!abstract && !legalSentence) {
    return null;
  }

  return (
    <div className="bg-muted/30 border-border/50 mb-8 rounded-lg border px-5 py-4 font-sans text-[0.88rem] leading-relaxed">
      {legalSentence && (
        <section>
          <h4 className="text-muted-foreground mb-2 text-[0.75rem] font-semibold tracking-wide uppercase">
            {t("caseLaw.viewer.legalSentence")}
          </h4>
          <p className="reader-justify">
            <HighlightedText
              activeMatchIndex={activeMatchIndex}
              pieceId={SUPPLEMENT_LEGAL_SENTENCE_ID}
              ranges={rangesForPiece(
                rangesByPieceId,
                SUPPLEMENT_LEGAL_SENTENCE_ID,
              )}
              text={legalSentence}
            />
          </p>
        </section>
      )}
      {abstract && (
        <section className={cn(legalSentence ? "mt-4" : "")}>
          <h4 className="text-muted-foreground mb-2 text-[0.75rem] font-semibold tracking-wide uppercase">
            {t("caseLaw.viewer.abstract")}
          </h4>
          <p className="text-foreground-strong-muted reader-justify">
            <HighlightedText
              activeMatchIndex={activeMatchIndex}
              pieceId={SUPPLEMENT_ABSTRACT_ID}
              ranges={rangesForPiece(rangesByPieceId, SUPPLEMENT_ABSTRACT_ID)}
              text={abstract}
            />
          </p>
        </section>
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
      const unreachable: never = style;
      return unreachable;
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
    onKeyDown={() => undefined}
    style={annotationStyle(annotation)}
    tabIndex={0}
  >
    {children}
  </mark>
);

const renderExactAnnotations = ({
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
}: {
  annotations: readonly AnnotationAnchorSource[];
  blocks: readonly Block[];
  citations: readonly CitationAnchorSource[];
  provisions: readonly DecisionProvisionAnchor[];
}): Record<string, TextAnchor[]> => {
  const citationSpans = locateCitationAnchors({ blocks, citations });
  const provisionSpans = locateProvisionAnchors({ blocks, provisions });
  const blockIdByAnchor = new Map(
    blocks.map((block) => [block.anchorId, block.id] as const),
  );
  const annotationsByBlock = new Map<string, AnnotationAnchorSource[]>();
  for (const annotation of annotations) {
    const blockId = blockIdByAnchor.get(annotation.blockAnchorId);
    if (blockId === undefined) {
      continue;
    }
    const list = annotationsByBlock.get(blockId) ?? [];
    list.push(annotation);
    annotationsByBlock.set(blockId, list);
  }
  const anchorsByPieceId: Record<string, TextAnchor[]> = {};
  const blockIds = new Set([
    ...Object.keys(citationSpans),
    ...Object.keys(provisionSpans),
    ...annotationsByBlock.keys(),
  ]);
  for (const blockId of blockIds) {
    const anchors: TextAnchor[] = [];
    // A reader's mark over a link keeps the link: links are the text's own
    // structure, and the mark is still visible in the margin.
    for (const annotation of annotationsByBlock.get(blockId) ?? []) {
      anchors.push({
        end: annotation.endOffset,
        key: `annotation:${annotation.id}`,
        // Plain inline markup so the words keep wrapping and justifying as
        // the paragraph's own; an inline button cannot break across lines. A click
        // on a mark is handled by the toolbar, which listens on the document
        // and reads the id off the element.
        render: (children): ReactElement =>
          renderAnnotation(annotation, children),
        start: annotation.startOffset,
      });
    }
    for (const span of citationSpans[blockId] ?? []) {
      const exactAnnotations = (annotationsByBlock.get(blockId) ?? []).filter(
        (annotation) =>
          annotation.startOffset === span.start &&
          annotation.endOffset === span.end,
      );
      anchors.push({
        end: span.end,
        key: `decision:${span.source.id}`,
        render: (children): ReactElement => {
          const marked = renderExactAnnotations({
            annotations: exactAnnotations,
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
    for (const span of provisionSpans[blockId] ?? []) {
      const exactAnnotations = (annotationsByBlock.get(blockId) ?? []).filter(
        (annotation) =>
          annotation.startOffset === span.start &&
          annotation.endOffset === span.end,
      );
      anchors.push({
        end: span.end,
        key: `provision:${span.source.id}`,
        render: (children): ReactElement => {
          const marked = renderExactAnnotations({
            annotations: exactAnnotations,
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
    // Links first: a link and a mark on the same words keep the link, since
    // the mark still reads in the margin while a lost link is gone. The mark
    // continues on either side of the link, so a sentence with a citation
    // in it is still visibly marked.
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
  blocks,
  rangesByPieceId,
  sectionMap,
}: {
  activeMatchIndex: number;
  anchorsByPieceId: Record<string, TextAnchor[]>;
  blocks: Block[];
  rangesByPieceId: Record<string, SearchMatchRange[]>;
  sectionMap?: Map<string, { cssVar: string; headingId: string }> | undefined;
}): ReactNode[] => {
  const result: ReactNode[] = [];

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
        {group.blocks.map((block) =>
          isHoldingBlock(block) ? (
            <div className="font-[520]" key={block.id}>
              <BlockRenderer
                activeMatchIndex={activeMatchIndex}
                anchorsByPieceId={anchorsByPieceId}
                block={block}
                rangesByPieceId={rangesByPieceId}
                variant="case-law"
              />
            </div>
          ) : (
            <BlockRenderer
              activeMatchIndex={activeMatchIndex}
              anchorsByPieceId={anchorsByPieceId}
              block={block}
              key={block.id}
              rangesByPieceId={rangesByPieceId}
              variant="case-law"
            />
          ),
        )}
      </div>,
    );
  }

  return result;
};

const NO_CITATION_ANCHORS: readonly CitationAnchorSource[] = [];
const NO_PROVISION_ANCHORS: readonly DecisionProvisionAnchor[] = [];
const NO_ANNOTATION_ANCHORS: readonly AnnotationAnchorSource[] = [];

export const DecisionText = ({
  activeMatchIndex,
  annotationAnchors = NO_ANNOTATION_ANCHORS,
  citationAnchors = NO_CITATION_ANCHORS,
  decision,
  onMatchCountChange,
  provisionAnchors = NO_PROVISION_ANCHORS,
  searchQuery,
  sectionMap,
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

    const metadata = decision.metadata;
    if (metadata !== null && metadata !== undefined) {
      // Skip placeholder boilerplate ("není k dispozici" etc.)
      // so the counter can't report matches in text the
      // supplement renderer hides.
      const legalSentence = cleanSupplement(metadata["legalSentence"]);
      const abstract = cleanSupplement(metadata["abstract"]);

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

    activeMatch?.scrollIntoView({
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
        <p className="text-muted-foreground mb-4 text-end font-sans text-xs italic">
          <HighlightedText
            activeMatchIndex={activeMatchIndex}
            pieceId={DECISION_REFERENCE_ID}
            ranges={rangesForPiece(
              searchResults.rangesByPieceId,
              DECISION_REFERENCE_ID,
            )}
            text={`${decision.court}, ${displayRef}`}
          />
        </p>
        {decision.metadata !== null && decision.metadata !== undefined && (
          <EditorialSupplement
            activeMatchIndex={activeMatchIndex}
            metadata={decision.metadata}
            rangesByPieceId={searchResults.rangesByPieceId}
          />
        )}
        {renderBlocksWithHoldingZone({
          activeMatchIndex,
          anchorsByPieceId: buildAnchorsByPieceId({
            annotations: hydrated ? annotationAnchors : NO_ANNOTATION_ANCHORS,
            blocks: visibleBlocks,
            citations: hydrated ? citationAnchors : NO_CITATION_ANCHORS,
            provisions: hydrated ? provisionAnchors : NO_PROVISION_ANCHORS,
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
        <p className="text-muted-foreground mb-4 text-end font-sans text-xs italic">
          <HighlightedText
            activeMatchIndex={activeMatchIndex}
            pieceId={DECISION_REFERENCE_ID}
            ranges={rangesForPiece(
              searchResults.rangesByPieceId,
              DECISION_REFERENCE_ID,
            )}
            text={`${decision.court}, ${displayRef}`}
          />
        </p>
        {decision.metadata !== null && decision.metadata !== undefined && (
          <EditorialSupplement
            activeMatchIndex={activeMatchIndex}
            metadata={decision.metadata}
            rangesByPieceId={searchResults.rangesByPieceId}
          />
        )}
        <FulltextFallback
          activeMatchIndex={activeMatchIndex}
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
