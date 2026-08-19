import { useTranslations } from "use-intl";

import type { Block } from "@stll/legal-ast/document-ast";

import {
  BlockRenderer,
  FulltextFallback,
} from "@/components/legal-reader/document-ast-text";

type StatuteTextProps = {
  /** Parsed blocks. The route owns the parse: it also builds the outline. */
  blocks: readonly Block[];
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
  fulltext,
  language,
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
          <BlockRenderer
            activeMatchIndex={NO_ACTIVE_MATCH}
            block={block}
            key={block.id}
            rangesByPieceId={NO_RANGES}
            variant="statute"
          />
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
