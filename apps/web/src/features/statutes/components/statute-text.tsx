import { Fragment } from "react";

import { useTranslations } from "use-intl";

import type { Block } from "@stll/legal-ast/document-ast";

import {
  BlockRenderer,
  FulltextFallback,
} from "@/components/legal-reader/document-ast-text";
import { parseProvisionDesignation } from "@/components/legal-reader/reader-outline";
import { ProvisionCitingDecisions } from "@/features/statutes/components/provision-citing-decisions";
import { ProvisionHistory } from "@/features/statutes/components/provision-history";

/**
 * What a provision's incoming citations are filed under: the work's own
 * identifier, which is what a statute knows itself by. Absent when the
 * document states none, in which case the reader offers no citation
 * affordance at all.
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
  /** A Work with a single consolidation has no history to offer. */
  versionCount: number;
};

/**
 * A heading that opens a provision. It is the unit case law cites and the
 * unit a drafting history is about, so both affordances key off the one
 * designation parser rather than each guessing at the shape of a heading.
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
  versionCount,
}: StatuteTextProps) => {
  const t = useTranslations();

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
            {isProvisionHeading(block) && versionCount > 1 && (
              <ProvisionHistory
                anchorId={block.anchorId}
                documentId={documentId}
                provision={block.plainText}
              />
            )}
            {isProvisionHeading(block) && citationWork !== null && (
              <ProvisionCitingDecisions
                anchorId={block.anchorId}
                eli={citationWork.eli}
                jurisdiction={citationWork.jurisdiction}
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
