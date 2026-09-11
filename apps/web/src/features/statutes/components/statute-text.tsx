import { useTranslations } from "use-intl";

import type { Block } from "@stll/legal-ast/document-ast";

import { useInspectorView } from "@/components/inspector/use-inspector-view";
import {
  BlockRenderer,
  FulltextFallback,
} from "@/components/legal-reader/document-ast-text";
import { parseProvisionDesignation } from "@/components/legal-reader/reader-outline";
import { createProvisionViewTab } from "@/features/statutes/provision-inspector.logic";
import type { StatuteMasthead as StatuteMastheadData } from "@/features/statutes/statute-reader-blocks";

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
  /** Parsed blocks. The route owns the parse: it also builds the outline. */
  blocks: readonly Block[];
  citationWork: StatuteCitationWork | null;
  /** The consolidation on screen; a provision's history is read from it. */
  documentId: string;
  fulltext: string | null;
  language: string;
  masthead: StatuteMastheadData | null;
  provisionCitationCounts: ReadonlyMap<string, number>;
  statuteTitle: string;
  /** A Work with a single consolidation has no history to offer. */
  versionCount: number;
  versionValidFrom: string | null;
};

/**
 * A heading that opens a provision. It is the unit case law cites and the
 * unit a drafting history is about, so the affordance keys off the one
 * designation parser rather than guessing at the shape of a heading.
 */
const isProvisionHeading = (block: Block): boolean =>
  block.type === "heading" &&
  parseProvisionDesignation(block.plainText) !== null;

const READER_STYLE = {
  fontFamily: "var(--reader-body-font)",
  fontSize: "var(--reader-body-size)",
  lineHeight: "var(--reader-body-line-height)",
} as const;

// The statutes reader carries no in-page find bar yet, so every block renders
// with an empty highlight set.
const NO_RANGES = {};
const NO_ACTIVE_MATCH = -1;

const StatuteMasthead = ({ masthead }: { masthead: StatuteMastheadData }) => (
  <header
    className="group relative mx-auto mb-12 max-w-5xl scroll-mt-[var(--reader-anchor-offset)] text-center"
    data-anchor={masthead.anchorId}
    id={masthead.anchorId}
  >
    <p className="mb-4 font-sans text-[1.55rem] leading-tight font-bold">
      {masthead.citation}
    </p>
    <p className="font-sans text-[1.35rem] leading-tight font-bold tracking-wide">
      {masthead.instrument}
    </p>
    {masthead.issuer !== null && (
      <p className="mt-2 font-sans text-[1.25rem] leading-snug font-semibold">
        {masthead.issuer}
      </p>
    )}
    {masthead.date !== null && (
      <p className="mt-3 font-sans text-[1.05rem] leading-relaxed">
        {masthead.date}
      </p>
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
  blocks,
  citationWork,
  documentId,
  fulltext,
  language,
  masthead,
  provisionCitationCounts,
  statuteTitle,
  versionCount,
  versionValidFrom,
}: StatuteTextProps) => {
  const t = useTranslations();
  const { open } = useInspectorView();

  if (blocks.length > 0) {
    return (
      <article
        className="reader-statute text-card-foreground text-start"
        lang={language}
        style={READER_STYLE}
      >
        {masthead !== null && <StatuteMasthead masthead={masthead} />}
        {blocks.map((block) => {
          const provisionHeading = isProvisionHeading(block);
          const detailsAction =
            provisionHeading && citationWork !== null ? (
              <ProvisionDetailsAction
                citationCount={provisionCitationCounts.get(block.anchorId)}
                onOpen={() => {
                  open(
                    createProvisionViewTab({
                      anchorId: block.anchorId,
                      documentId,
                      eli: citationWork.eli,
                      jurisdiction: citationWork.jurisdiction,
                      provisionLabel: block.plainText,
                      statuteTitle,
                      versionCount,
                      versionValidFrom,
                    }),
                  );
                }}
                provision={block.plainText}
              />
            ) : undefined;

          return (
            <BlockRenderer
              activeMatchIndex={NO_ACTIVE_MATCH}
              block={block}
              headingPresentation={
                provisionHeading
                  ? { accessory: detailsAction, type: "provision" }
                  : undefined
              }
              key={block.id}
              noteBackJumpTo={
                block.type === "paragraph" && block.note?.type === "footnote"
                  ? block.anchorId
                  : undefined
              }
              rangesByPieceId={NO_RANGES}
              variant="statute"
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
        <h1 className="mb-10 text-center font-sans text-xl font-semibold text-balance">
          {statuteTitle}
        </h1>
        <FulltextFallback
          activeMatchIndex={NO_ACTIVE_MATCH}
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
      className="border-border text-foreground hover:bg-muted hover:border-foreground-disabled focus-visible:ring-ring hidden h-8 items-center rounded-sm border px-3 font-sans text-sm font-normal tracking-normal transition-colors focus-visible:ring-2 focus-visible:outline-none md:inline-flex print:hidden"
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
