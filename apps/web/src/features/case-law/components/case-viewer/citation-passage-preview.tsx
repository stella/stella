import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { findCitationPassage } from "@stll/legal-ast/citation-passage";
import type { CitationPassageMatch } from "@stll/legal-ast/citation-passage";
import { parseDocumentAst } from "@stll/legal-ast/document-ast";
import { BidiText } from "@stll/ui/bidi-text";
import { Skeleton } from "@stll/ui/skeleton";

import type { CitationAnchorSource } from "@/features/case-law/citation-anchors";
import { decisionOptions } from "@/features/case-law/queries/decisions";

/** Words shown on either side of the citation. */
const CONTEXT_CHARS = 220;

type CitationPassageRead =
  | { passage: CitationPassageMatch; status: "found" }
  /** The text does not carry the citation the row recorded. */
  | { passage: null; status: "absent" }
  | { passage: null; status: "failed" }
  | { passage: null; status: "pending" };

type CitationPassageQuery = {
  /** How the citing text names the cited decision, and which one it is. */
  citation: CitationAnchorSource;
  /** The decision whose text holds the citation. */
  textDecisionId: string;
};

/**
 * The paragraph in which one decision cites another.
 *
 * The citing decision is read in full: the same read opening it needs, so
 * the passage costs nothing the reader was not about to pay anyway.
 */
export const useCitationPassage = ({
  citation,
  textDecisionId,
}: CitationPassageQuery): CitationPassageRead => {
  const {
    data: decision,
    isError,
    isPending,
  } = useQuery(decisionOptions(textDecisionId));

  if (isPending) {
    return { passage: null, status: "pending" };
  }
  if (isError) {
    return { passage: null, status: "failed" };
  }

  const ast = parseDocumentAst(decision.documentAst);
  const passage =
    ast === null
      ? null
      : findCitationPassage({
          blocks: ast.blocks,
          citationText: citation.citationText,
          sectionText:
            citation.sectionIndex === undefined || decision.sections === null
              ? undefined
              : decision.sections.find(
                  (section) => section.index === citation.sectionIndex,
                )?.text,
        });

  return passage === null
    ? { passage: null, status: "absent" }
    : { passage, status: "found" };
};

/**
 * The citing paragraph with the citation itself set off, or a line saying
 * why it is not shown. The action that opens the decision belongs to the
 * surface around the quote, not to the quote.
 */
export const CitationPassageQuote = ({
  read,
}: {
  read: CitationPassageRead;
}) => {
  const t = useTranslations();

  switch (read.status) {
    case "pending": {
      return (
        <div className="flex flex-col gap-1.5 py-1">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      );
    }
    case "failed": {
      return (
        <p className="text-muted-foreground py-1 text-xs">
          {t("errors.actionFailed")}
        </p>
      );
    }
    case "absent": {
      return (
        <p className="text-muted-foreground py-1 text-xs">
          {t("caseLaw.citation.passageNotFound")}
        </p>
      );
    }
    case "found": {
      const { passage } = read;
      const from = Math.max(0, passage.start - CONTEXT_CHARS);
      const to = Math.min(passage.text.length, passage.end + CONTEXT_CHARS);

      return (
        <blockquote
          className="text-foreground-strong-muted border-border/60 m-0 border-s-2 ps-2 text-xs leading-snug"
          style={{ fontFamily: "var(--reader-body-font)" }}
        >
          <BidiText as="span">
            {from > 0 ? "… " : ""}
            {passage.text.slice(from, passage.start)}
            <span className="bg-primary/15 text-foreground rounded-xs font-medium">
              {passage.text.slice(passage.start, passage.end)}
            </span>
            {passage.text.slice(passage.end, to)}
            {to < passage.text.length ? " …" : ""}
          </BidiText>
        </blockquote>
      );
    }
    default: {
      read satisfies never;
      return panic(`Unhandled citation passage read: ${String(read)}`);
    }
  }
};
