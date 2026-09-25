import { useRef } from "react";
import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import type { Block } from "@stll/legal-ast/document-ast";
import { cn } from "@stll/ui/utils";

import { useInspectorView } from "@/components/inspector/use-inspector-view";
import { buildAnnotationAnchors } from "@/components/legal-reader/annotations/annotation-anchors";
import type { AnnotationAnchorSource } from "@/components/legal-reader/annotations/annotation-anchors";
import {
  BlockRenderer,
  FulltextFallback,
  READER_BLOCK_CHROME_REVEAL_CLASS,
} from "@/components/legal-reader/document-ast-text";
import type {
  AnchorPresentation,
  TextAnchor,
} from "@/components/legal-reader/document-ast-text";
import {
  holdLanding,
  readerBlockByAnchor,
} from "@/components/legal-reader/reader-landing";
import { provisionHeadingLine } from "@/components/legal-reader/reader-outline";
import type { ProvisionHeadingLine } from "@/components/legal-reader/reader-outline";
import type { ReaderMarkRange } from "@/components/legal-reader/reader-search";
import { createProvisionViewTab } from "@/features/statutes/provision-inspector.logic";
import type { StatuteMasthead as StatuteMastheadData } from "@/features/statutes/statute-reader-blocks";
import { useExternalSyncEffect } from "@/hooks/use-effect";

/**
 * What a provision's incoming citations are filed under: the work's own
 * identifier, which is what a statute knows itself by. Absent when the
 * document states none, in which case the reader offers no provision tab at
 * all: the tab is keyed by it.
 */
export type StatuteCitationWork = {
  eli: string;
  jurisdiction: string;
};

type StatuteTextProps = {
  /** The reader's own marks and what colleagues shared. */
  annotationAnchors: readonly AnnotationAnchorSource[];
  /** Parsed blocks. The route owns the parse: it also builds the outline. */
  blocks: readonly Block[];
  citationWork: StatuteCitationWork | null;
  /** The consolidation on screen; a provision's history is read from it. */
  documentId: string;
  fulltext: string | null;
  language: string;
  /**
   * The rendered block the reader was sent to. It keeps a marker, and the
   * text lands on it once it is shown.
   */
  landingAnchorId?: string | undefined;
  masthead: StatuteMastheadData | null;
  provisionCitationCounts: ReadonlyMap<string, number>;
  statuteTitle: string;
  /** A Work with a single consolidation has no history to offer. */
  versionCount: number;
  versionValidFrom: string | null;
};

const READER_STYLE = {
  fontFamily: "var(--reader-body-font)",
  fontSize: "var(--reader-body-size)",
  lineHeight: "var(--reader-body-line-height)",
} as const;

// The statutes reader carries no in-page find bar yet, so every block renders
// with an empty highlight set.
const NO_RANGES = {};
const NO_ACTIVE_MATCH = -1;

/**
 * The act's own front matter. It carries an `id` so a deep link lands on it,
 * but no `data-anchor`: that attribute marks a block the renderer can lay
 * anchors over, and the masthead is lifted out of the block list, so a
 * highlight left here would have nowhere to be drawn.
 */
export const StatuteMasthead = ({
  masthead,
}: {
  masthead: StatuteMastheadData;
}) => (
  <header
    className="group relative mb-12 scroll-mt-[var(--reader-anchor-offset)] text-center"
    id={masthead.anchorId}
  >
    <p className="mb-4 text-[1.55rem] leading-tight font-bold">
      {masthead.citation}
    </p>
    <p className="text-[1.35rem] leading-tight font-bold tracking-wide">
      {masthead.instrument}
    </p>
    {masthead.issuer !== null && (
      <p className="mt-2 text-[1.25rem] leading-snug font-semibold">
        {masthead.issuer}
      </p>
    )}
    {masthead.date !== null && (
      <p className="mt-3 text-[1.05rem] leading-relaxed">{masthead.date}</p>
    )}
    <h1 className="mt-2 text-[1.15rem] leading-relaxed font-semibold text-balance">
      {masthead.title}
    </h1>
  </header>
);

/**
 * Reading column for one consolidated statute version. Renders the same
 * `DocumentAst` blocks as the case-law viewer, so a provision's `anchorId`
 * is a stable deep-link target (`#<anchorId>`) that the router scrolls to.
 */
export const StatuteText = ({
  annotationAnchors,
  blocks,
  citationWork,
  documentId,
  fulltext,
  landingAnchorId,
  language,
  masthead,
  provisionCitationCounts,
  statuteTitle,
  versionCount,
  versionValidFrom,
}: StatuteTextProps) => {
  const t = useTranslations();
  const { open } = useInspectorView();
  const articleRef = useRef<HTMLElement | null>(null);

  // The same arrival the decision reader makes: straight onto the block, held
  // there while the page around it settles.
  useExternalSyncEffect(() => {
    const article = articleRef.current;
    if (article === null || landingAnchorId === undefined) {
      return undefined;
    }
    const target = readerBlockByAnchor(article, landingAnchorId);
    return target === null ? undefined : holdLanding({ article, target });
  }, [landingAnchorId]);

  if (blocks.length > 0) {
    const anchorsByPieceId = buildAnnotationAnchors(annotationAnchors, blocks);
    return (
      <article
        className="reader-statute text-card-foreground text-start"
        lang={language}
        ref={articleRef}
        style={READER_STYLE}
      >
        {masthead !== null && <StatuteMasthead masthead={masthead} />}
        {blocks.map((block) => {
          // The unit case law cites and a drafting history is about: the
          // designation the heading states, wherever the publisher put it.
          const detailsAction = (provision: ProvisionHeadingLine) =>
            citationWork === null ? undefined : (
              <ProvisionDetailsAction
                citationCount={provisionCitationCounts.get(block.anchorId)}
                onOpen={() => {
                  open(
                    createProvisionViewTab({
                      anchorId: block.anchorId,
                      documentId,
                      eli: citationWork.eli,
                      jurisdiction: citationWork.jurisdiction,
                      provisionLabel: provision.text,
                      statuteTitle,
                      versionCount,
                      versionValidFrom,
                    }),
                  );
                }}
                provision={provision.text}
              />
            );

          return (
            <StatuteBlock
              anchorPresentation="document"
              anchorsByPieceId={anchorsByPieceId}
              block={block}
              key={block.id}
              landing={block.anchorId === landingAnchorId}
              provisionAccessory={detailsAction}
              rangesByPieceId={NO_RANGES}
            />
          );
        })}
      </article>
    );
  }

  if (fulltext) {
    return (
      <article
        className="reader-statute text-card-foreground text-start"
        lang={language}
        style={READER_STYLE}
      >
        <h1 className="mb-10 text-center text-xl font-semibold text-balance">
          {statuteTitle}
        </h1>
        <FulltextFallback
          activeMatchIndex={NO_ACTIVE_MATCH}
          anchorsByPieceId={buildAnnotationAnchors(annotationAnchors)}
          rangesByPieceId={NO_RANGES}
          text={fulltext}
        />
      </article>
    );
  }

  return (
    <div className="flex items-center justify-center py-16">
      <p className="text-muted-foreground text-sm">
        {t("statutes.emptyDocument")}
      </p>
    </div>
  );
};

type StatuteBlockProps = {
  /** A comparison cell is an excerpt: `embedded`. */
  anchorPresentation: AnchorPresentation;
  anchorsByPieceId?: Record<string, TextAnchor[]> | undefined;
  block: Block;
  landing?: boolean | undefined;
  /** What a provision heading offers beside its designation. */
  provisionAccessory?:
    | ((provision: ProvisionHeadingLine) => ReactNode)
    | undefined;
  rangesByPieceId: Record<string, ReaderMarkRange[]>;
};

/**
 * One block as the statute reader prints it: a provision's designation on a
 * row of its own, the containers centred above it. The comparison renders
 * its cells through this too, so the two cannot set a statute differently.
 */
export const StatuteBlock = ({
  anchorPresentation,
  anchorsByPieceId,
  block,
  landing = false,
  provisionAccessory,
  rangesByPieceId,
}: StatuteBlockProps) => {
  // The unit case law cites and a drafting history is about: the
  // designation the heading states, wherever the publisher put it.
  const provision =
    block.type === "heading" ? provisionHeadingLine(block) : null;

  return (
    <BlockRenderer
      activeMatchIndex={NO_ACTIVE_MATCH}
      anchorPresentation={anchorPresentation}
      anchorsByPieceId={anchorsByPieceId}
      block={block}
      landing={landing}
      headingPresentation={
        provision === null
          ? undefined
          : {
              accessory: provisionAccessory?.(provision),
              designationLine: provision.index,
              type: "provision",
            }
      }
      noteBackJumpTo={
        anchorPresentation === "document" &&
        block.type === "paragraph" &&
        block.note?.type === "footnote"
          ? block.anchorId
          : undefined
      }
      rangesByPieceId={rangesByPieceId}
      variant="statute"
    />
  );
};

type ProvisionDetailsActionProps = {
  citationCount: number | undefined;
  onOpen: () => void;
  /** The heading's own text, so the control names the provision it opens. */
  provision: string;
};

/**
 * Opens the provision's inspector tab. The inspector docks beside the reader
 * on wide screens only, so the control is offered there only.
 */
const ProvisionDetailsAction = ({
  citationCount,
  onOpen,
  provision,
}: ProvisionDetailsActionProps) => {
  const t = useTranslations();

  return (
    <button
      aria-label={t("statutes.provisionDetailsFor", { provision })}
      className={cn(
        "reader-chrome border-border text-foreground hover:bg-muted hover:border-foreground-disabled focus-visible:ring-ring hidden h-8 items-center rounded-sm border px-3 text-sm font-normal tracking-normal transition-[color,background-color,border-color,opacity] focus-visible:ring-2 focus-visible:outline-none md:inline-flex print:hidden",
        // Revealed with the heading's ¶, by the same rule.
        READER_BLOCK_CHROME_REVEAL_CLASS,
      )}
      onClick={onOpen}
      type="button"
    >
      <span>{t("common.details")}</span>
      {citationCount !== undefined && citationCount > 0 && (
        <span className="text-muted-foreground ms-2 tabular-nums">
          {t("caseLaw.citation.decisionCount", { count: citationCount })}
        </span>
      )}
    </button>
  );
};
