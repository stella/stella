import { useRef } from "react";
import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import type { Block } from "@stll/legal-ast/document-ast";
import { parseDocumentAst } from "@stll/legal-ast/document-ast";
import { cn } from "@stll/ui/utils";

import { CitedDecisionLink } from "@/components/legal-reader/cited-decision-link";
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
import { locateCitationAnchors } from "@/features/case-law/citation-anchors";
import type { CitationAnchorSource } from "@/features/case-law/citation-anchors";
import { visibleDecisionBlocks } from "@/features/case-law/components/case-viewer/decision-text.logic";
import { useExternalSyncEffect } from "@/hooks/use-effect";

type Decision = {
  caseNumber: string;
  court: string;
  language: string;
  fulltext: string | null;
  documentAst?: unknown;
  metadata?: Record<string, unknown> | null;
};

type DecisionTextProps = {
  activeMatchIndex: number;
  /** Resolved citations whose mentions in the text become links. */
  citationAnchors?: readonly CitationAnchorSource[] | undefined;
  decision: Decision;
  onMatchCountChange?: ((count: number) => void) | undefined;
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

const buildAnchorsByPieceId = ({
  blocks,
  citations,
}: {
  blocks: readonly Block[];
  citations: readonly CitationAnchorSource[];
}): Record<string, TextAnchor[]> => {
  const located = locateCitationAnchors({ blocks, citations });
  const anchorsByPieceId: Record<string, TextAnchor[]> = {};
  for (const [blockId, spans] of Object.entries(located)) {
    anchorsByPieceId[blockId] = spans.map((span) => ({
      end: span.end,
      key: span.source.id,
      render: (children) => (
        <CitedDecisionLink decision={span.source.decision}>
          {children}
        </CitedDecisionLink>
      ),
      start: span.start,
    }));
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

export const DecisionText = ({
  activeMatchIndex,
  citationAnchors = NO_CITATION_ANCHORS,
  decision,
  onMatchCountChange,
  searchQuery,
  sectionMap,
}: DecisionTextProps) => {
  const t = useTranslations();

  const ast = parseDocumentAst(decision.documentAst);
  const visibleBlocks = visibleDecisionBlocks(ast);
  const articleRef = useRef<HTMLElement>(null);

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
            blocks: visibleBlocks,
            citations: citationAnchors,
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
