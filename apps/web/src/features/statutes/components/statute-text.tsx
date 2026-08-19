import { Fragment } from "react";

import { useTranslations } from "use-intl";

import type { Block } from "@stll/legal-ast/document-ast";

import {
  BlockRenderer,
  FulltextFallback,
} from "@/components/legal-reader/document-ast-text";
import { parseProvisionDesignation } from "@/components/legal-reader/reader-outline";
import { ProvisionCitingDecisions } from "@/features/statutes/components/provision-citing-decisions";

/**
 * What a provision's incoming citations are filed under. Absent when the
 * work's own identifier cannot be stated, in which case the reader offers no
 * citation affordance rather than one that asks about a different act.
 */
export type StatuteCitationWork = {
  jurisdiction: string;
  work: string;
};

type StatuteTextProps = {
  /** Parsed blocks. The route owns the parse: it also builds the outline. */
  blocks: readonly Block[];
  citationWork: StatuteCitationWork | null;
  fulltext: string | null;
  language: string;
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
 * Reading column for one consolidated statute version. Renders the same
 * `DocumentAst` blocks as the case-law viewer, so a provision's `anchorId`
 * is a stable deep-link target (`#<anchorId>`) that the router scrolls to.
 */
export const StatuteText = ({
  blocks,
  citationWork,
  fulltext,
  language,
}: StatuteTextProps) => {
  const t = useTranslations();

  /** A heading that opens a provision is the unit case law cites. */
  const isProvisionHeading = (block: Block): boolean =>
    block.type === "heading" &&
    parseProvisionDesignation(block.plainText) !== null;

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
            {citationWork !== null && isProvisionHeading(block) && (
              <ProvisionCitingDecisions
                anchorId={block.anchorId}
                jurisdiction={citationWork.jurisdiction}
                work={citationWork.work}
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
