import { useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { CitationPassageMatch } from "@stll/legal-ast/citation-passage";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { createCaseDecisionViewTab } from "@/components/inspector/case-decision-view";
import { useInspectorView } from "@/components/inspector/use-inspector-view";
import type { CitationAnchorSource } from "@/features/case-law/citation-anchors";
import {
  CITATION_TREATMENT_DOT,
  CITATION_TREATMENT_LABEL,
  CITATION_TREATMENT_ORDER,
  totalCitations,
} from "@/features/case-law/citation-treatment";
import type {
  CitationTreatment,
  CitedDecisionAddress,
} from "@/features/case-law/citation-treatment";
import {
  CitationPassageQuote,
  useCitationPassage,
} from "@/features/case-law/components/case-viewer/citation-passage-preview";
import {
  CitationList,
  DIRECTION_TITLE,
} from "@/features/case-law/components/case-viewer/decision-citations";
import { CitationTreatmentBar } from "@/features/case-law/components/citation-treatment-bar";
import {
  decisionCitationSummaryOptions,
  decisionLeadingCitationsOptions,
} from "@/features/case-law/queries/citations";
import type {
  CitationDirection,
  LeadingCitation,
} from "@/features/case-law/queries/citations";
import { useFormatter } from "@/i18n/formatting-context";
import { optionalArray } from "@/lib/arrays";
import { citedDecisionLabel } from "@/lib/cited-decision-label";
import { formatDecisionDate } from "@/lib/decision-date";
import type { SafeId } from "@/lib/safe-id";
import { forceReflow } from "@/lib/utils";

type LeadingCitationsProps = {
  /** The decision being read, as a citation names it. */
  decision: CitedDecisionAddress;
  decisionId: SafeId<"caseLawDecision">;
};

/**
 * Who cites the decision and what it cites, led by the decisions that
 * carry the most weight in each treatment. A row opens the passage where
 * the citation is made; from there the citing decision opens in the
 * inspector at that passage. The full list stays one click away.
 */
export const LeadingCitations = ({
  decision,
  decisionId,
}: LeadingCitationsProps) => {
  const { data: summary } = useQuery(
    decisionCitationSummaryOptions(decisionId),
  );
  if (summary === undefined) {
    return null;
  }
  return (
    <div className="flex flex-col gap-6">
      {(["incoming", "outgoing"] as const satisfies CitationDirection[]).map(
        (direction) =>
          totalCitations(summary[direction]) > 0 && (
            <DirectionSection
              counts={summary[direction]}
              decision={decision}
              decisionId={decisionId}
              direction={direction}
              key={direction}
            />
          ),
      )}
    </div>
  );
};

const DirectionSection = ({
  counts,
  decision,
  decisionId,
  direction,
}: LeadingCitationsProps & {
  counts: Record<CitationTreatment, number>;
  direction: CitationDirection;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const { data: leading } = useQuery(
    decisionLeadingCitationsOptions(decisionId, direction),
  );
  const [showingAll, setShowingAll] = useState(false);
  const total = totalCitations(counts);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <h3 className="text-foreground-strong-muted flex items-baseline gap-1.5 text-xs font-medium">
          {t(DIRECTION_TITLE[direction])}
          <span className="text-muted-foreground font-normal tabular-nums">
            {format.number(total)}
          </span>
        </h3>
        <CitationTreatmentBar counts={counts} total={total} />
      </div>
      {CITATION_TREATMENT_ORDER.map((treatment) => {
        const rows = optionalArray(leading).filter(
          (row) => row.treatment === treatment,
        );
        if (counts[treatment] === 0) {
          return null;
        }
        return (
          <div className="flex flex-col gap-1" key={treatment}>
            <p className="text-muted-foreground text-2xs flex items-center gap-1.5 tracking-wide uppercase">
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 rounded-full",
                  CITATION_TREATMENT_DOT[treatment],
                )}
              />
              {t(CITATION_TREATMENT_LABEL[treatment])}
              <span className="normal-case tabular-nums">
                {format.number(counts[treatment])}
              </span>
            </p>
            {leading === undefined ? (
              <LeadingRowsLoader count={Math.min(counts[treatment], 3)} />
            ) : (
              <ul className="m-0 flex list-none flex-col p-0">
                {rows.map((row) => (
                  <LeadingRow
                    decision={decision}
                    decisionId={decisionId}
                    direction={direction}
                    key={row.id}
                    row={row}
                  />
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {showingAll ? (
        <div className="border-border/60 -mx-3 border-t pt-2">
          <CitationList
            decision={decision}
            decisionId={decisionId}
            direction={direction}
          />
        </div>
      ) : (
        <Button
          className="text-muted-foreground hover:text-foreground h-auto w-fit p-0"
          onClick={() => setShowingAll(true)}
          size="sm"
          variant="link"
        >
          {t("caseLaw.citation.showAll", { count: total })}
        </Button>
      )}
    </section>
  );
};

/** The shape of the rows to come, so a heading never stands over nothing. */
const LeadingRowsLoader = ({ count }: { count: number }) => (
  <div className="flex flex-col gap-2 py-1 ps-4">
    {Array.from({ length: count }, (_, index) => (
      <div className="flex flex-col gap-1" key={index}>
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-2.5 w-28" />
      </div>
    ))}
  </div>
);

const LeadingRow = ({
  decision,
  decisionId,
  direction,
  row,
}: LeadingCitationsProps & {
  direction: CitationDirection;
  row: LeadingCitation;
}) => {
  const format = useFormatter();
  const inspector = useInspectorView();
  const rowRef = useRef<HTMLLIElement>(null);
  const [open, setOpen] = useState(false);
  const decided = formatDecisionDate(row.decision.decisionDate, format);
  // Incoming: the far decision's text names this one. Outgoing: this
  // decision's text names the far one. The passage is found in whichever
  // text does the naming.
  const textDecisionId =
    direction === "incoming" ? row.decision.id : decisionId;
  const cited = direction === "incoming" ? decision : row.decision;

  return (
    <li className="flex flex-col" ref={rowRef}>
      <button
        aria-expanded={open}
        className="hover:bg-muted/60 -mx-1.5 flex items-start gap-1.5 rounded-md px-1.5 py-1 text-start"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <ChevronRightIcon
          className={cn(
            "text-foreground-disabled mt-0.5 size-3 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="flex min-w-0 flex-col">
          <BidiText
            as="span"
            className="text-foreground-strong-muted text-xs font-medium"
          >
            {citedDecisionLabel(row.decision)}
          </BidiText>
          <span className="text-muted-foreground text-2xs">
            {decided === null
              ? row.decision.court
              : `${row.decision.court} · ${decided}`}
          </span>
        </span>
      </button>
      {open && (
        <div className="ps-4">
          <LeadingPassage
            citation={{
              citationText: row.citationText,
              decision: cited,
              id: row.id,
              sectionIndex: row.sectionIndex,
              treatment: row.treatment,
            }}
            onOpen={(passage) => {
              if (direction === "incoming") {
                inspector.open(
                  createCaseDecisionViewTab({
                    anchorId: passage.anchorId,
                    caseNumber: row.decision.caseNumber,
                    country: row.decision.country,
                    court: row.decision.court,
                    decisionId: row.decision.id,
                    language: row.decision.language,
                    languageAlternates: row.decision.languageAlternates,
                    slug: row.decision.slug,
                  }),
                );
                return;
              }
              // The passage is in the text being read, on the main view
              // beside this tab: go there.
              const element =
                rowRef.current?.ownerDocument.querySelector<HTMLElement>(
                  `#${CSS.escape(passage.anchorId)}`,
                ) ?? null;
              if (element === null) {
                return;
              }
              element.scrollIntoView({ block: "center" });
              delete element.dataset["highlight"];
              forceReflow(element);
              element.dataset["highlight"] = "";
            }}
            textDecisionId={textDecisionId}
          />
        </div>
      )}
    </li>
  );
};

/**
 * The passage where the citation is made, and — once it is located — the way
 * into the text at it. The read starts when the row is opened, so a list of
 * leading citations does not read every citing decision up front.
 */
const LeadingPassage = ({
  citation,
  onOpen,
  textDecisionId,
}: {
  citation: CitationAnchorSource;
  onOpen: (passage: CitationPassageMatch) => void;
  textDecisionId: string;
}) => {
  const t = useTranslations();
  const read = useCitationPassage({ citation, textDecisionId });

  return (
    <div className="flex flex-col items-start gap-1.5 py-1">
      <CitationPassageQuote read={read} />
      {read.status === "found" && (
        <Button
          className="h-6 px-2"
          onClick={() => onOpen(read.passage)}
          size="sm"
          variant="outline"
        >
          {t("caseLaw.citation.openAtCitation")}
        </Button>
      )}
    </div>
  );
};
