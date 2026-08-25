import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { parseDocumentAst } from "@stll/legal-ast/document-ast";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";

import type { CitationAnchorSource } from "@/features/case-law/citation-anchors";
import { findCitationPassage } from "@/features/case-law/citation-passage";
import type { CitationPassage } from "@/features/case-law/citation-passage";
import { decisionOptions } from "@/features/case-law/queries/decisions";

/** Words shown on either side of the citation. */
const CONTEXT_CHARS = 220;

type CitationPassagePreviewProps = {
  /** How the citing text names the cited decision, and which one it is. */
  citation: CitationAnchorSource;
  onOpen: (passage: CitationPassage) => void;
  openLabel: string;
  /** The decision whose text holds the citation. */
  textDecisionId: string;
};

/**
 * The paragraph in which one decision cites another, with the citation
 * itself set off, and a way to open the text there. The citing decision is
 * read in full: the same read the open needs, so it is not paid twice.
 */
export const CitationPassagePreview = ({
  citation,
  onOpen,
  openLabel,
  textDecisionId,
}: CitationPassagePreviewProps) => {
  const t = useTranslations();
  const {
    data: decision,
    error,
    isPending,
  } = useQuery(decisionOptions(textDecisionId));
  if (isPending) {
    return (
      <div className="flex flex-col gap-1.5 py-1">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    );
  }
  if (error !== null) {
    throw error;
  }
  const ast =
    decision === undefined ? null : parseDocumentAst(decision.documentAst);
  const passage =
    ast === null
      ? null
      : findCitationPassage({
          blocks: ast.blocks,
          citation,
          sectionText:
            citation.sectionIndex === undefined || decision.sections === null
              ? undefined
              : decision.sections.find(
                  (section) => section.index === citation.sectionIndex,
                )?.text,
        });
  if (passage === null) {
    return (
      <p className="text-muted-foreground py-1 text-xs">
        {t("caseLaw.citation.passageNotFound")}
      </p>
    );
  }
  const from = Math.max(0, passage.start - CONTEXT_CHARS);
  const to = Math.min(passage.text.length, passage.end + CONTEXT_CHARS);

  return (
    <div className="flex flex-col items-start gap-1.5 py-1">
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
      <Button
        className="h-6 px-2 text-xs"
        onClick={() => onOpen(passage)}
        size="sm"
        variant="outline"
      >
        {openLabel}
      </Button>
    </div>
  );
};
