import { Fragment } from "react";

import { useTranslations } from "use-intl";

import type { Block } from "@stll/legal-ast/document-ast";

import { useInspectorView } from "@/components/inspector/use-inspector-view";
import {
  BlockRenderer,
  FulltextFallback,
} from "@/components/legal-reader/document-ast-text";
import { parseProvisionDesignation } from "@/components/legal-reader/reader-outline";
import { createProvisionViewTab } from "@/features/statutes/provision-inspector.logic";

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
        {blocks.map((block) => (
          <Fragment key={block.id}>
            <BlockRenderer
              activeMatchIndex={NO_ACTIVE_MATCH}
              block={block}
              rangesByPieceId={NO_RANGES}
              variant="statute"
            />
            {isProvisionHeading(block) && citationWork !== null && (
              <ProvisionDetailsAction
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
            )}
          </Fragment>
        ))}
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
  onOpen: () => void;
  /** The heading's own text, so the control names the provision it opens. */
  provision: string;
};

/**
 * Opens the provision's inspector tab. The inspector docks beside the reader
 * on wide screens only, so the control is offered there only.
 */
const ProvisionDetailsAction = ({
  onOpen,
  provision,
}: ProvisionDetailsActionProps) => {
  const t = useTranslations();

  return (
    <button
      aria-label={t("statutes.provisionDetailsFor", { provision })}
      className="text-muted-foreground hover:text-foreground hover:border-foreground-disabled focus-visible:ring-ring mx-auto mb-[var(--reader-heading-gap-bottom)] hidden rounded-full border px-2 py-0.5 font-sans text-[0.7rem] font-normal tracking-normal transition-colors focus-visible:ring-2 focus-visible:outline-none md:block print:hidden"
      onClick={onOpen}
      type="button"
    >
      {t("common.details")}
    </button>
  );
};
