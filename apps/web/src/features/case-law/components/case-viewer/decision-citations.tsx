import { useState } from "react";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import { CitedDecisionLink } from "@/components/legal-reader/cited-decision-link";
import {
  CITATION_TREATMENT_DOT,
  CITATION_TREATMENT_LABEL,
  CITATION_TREATMENT_ORDER,
  totalCitations,
} from "@/features/case-law/citation-treatment";
import type {
  CitationTreatment,
  CitationTreatmentCounts,
  DecisionCitation,
} from "@/features/case-law/citation-treatment";
import {
  decisionCitationsInfiniteOptions,
  decisionCitationSummaryOptions,
} from "@/features/case-law/queries/citations";
import type { CitationDirection } from "@/features/case-law/queries/citations";
import { useHydrated } from "@/hooks/use-hydrated";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { optionalArray } from "@/lib/arrays";
import { citedDecisionLabel } from "@/lib/cited-decision-label";
import { formatDecisionDate } from "@/lib/decision-date";
import { detached } from "@/lib/detached";
import type { SafeId } from "@/lib/safe-id";

const DIRECTION_TITLE = {
  incoming: "caseLaw.viewer.citedBy",
  outgoing: "caseLaw.viewer.cites",
} as const satisfies Record<CitationDirection, TranslationKey>;

type DecisionCitationsProps = {
  decisionId: SafeId<"caseLawDecision">;
};

/**
 * The decisions that cite this one and the decisions it cites, each side
 * headed by how many and how they treat it.
 *
 * Incoming first, because "is this still good law" is the question a reader
 * brings; negative treatment leads every list for the same reason.
 */
export const DecisionCitations = ({ decisionId }: DecisionCitationsProps) => {
  const t = useTranslations();
  const {
    data: summary,
    isError,
    refetch,
  } = useQuery(decisionCitationSummaryOptions(decisionId));
  // The summary is prefetched without blocking the route, so whether it is
  // known differs between the server pass and the client's hydration pass.
  // Rendering nothing until hydrated keeps the two passes identical.
  const hydrated = useHydrated();

  // Absent is the answer for a decision nobody cites. A failed read is not
  // that answer, so it says so and offers a retry instead of disappearing.
  if (!hydrated || summary === undefined) {
    if (!hydrated || !isError) {
      return null;
    }
    return (
      <section className="border-border/60 mb-6 rounded-lg border px-3 py-2 font-sans print:hidden">
        <div className="flex items-center gap-2">
          <p className="text-muted-foreground text-xs">
            {t("errors.actionFailed")}
          </p>
          <Button
            className="text-xs"
            onClick={() => {
              detached(refetch(), "case-law.citations-retry");
            }}
            size="sm"
            variant="ghost"
          >
            {t("common.retry")}
          </Button>
        </div>
      </section>
    );
  }

  const incomingTotal = totalCitations(summary.incoming);
  const outgoingTotal = totalCitations(summary.outgoing);
  if (incomingTotal === 0 && outgoingTotal === 0 && !isError) {
    return null;
  }

  return (
    <>
      {incomingTotal > 0 && (
        <CitationDirectionSection
          counts={summary.incoming}
          decisionId={decisionId}
          direction="incoming"
        />
      )}
      {outgoingTotal > 0 && (
        <CitationDirectionSection
          counts={summary.outgoing}
          decisionId={decisionId}
          direction="outgoing"
        />
      )}
    </>
  );
};

const CitationDirectionSection = ({
  counts,
  decisionId,
  direction,
}: {
  counts: CitationTreatmentCounts;
  decisionId: SafeId<"caseLawDecision">;
  direction: CitationDirection;
}) => {
  const t = useTranslations();
  const [open, setOpen] = useState(direction === "incoming");

  return (
    <section className="border-border/60 mb-6 rounded-lg border font-sans print:hidden">
      <button
        aria-expanded={open}
        className="text-foreground-strong-muted hover:text-foreground flex w-full items-center gap-1.5 px-3 py-2 text-start text-xs font-medium"
        onClick={() => setOpen(!open)}
        type="button"
      >
        <ChevronRightIcon
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        <span>{t(DIRECTION_TITLE[direction])}</span>
        <span className="text-muted-foreground font-normal">
          {t("caseLaw.citation.decisionCount", {
            count: totalCitations(counts),
          })}
        </span>
      </button>
      <TreatmentRollup counts={counts} />
      {open && <CitationList decisionId={decisionId} direction={direction} />}
    </section>
  );
};

const TreatmentRollup = ({ counts }: { counts: CitationTreatmentCounts }) => {
  const t = useTranslations();
  const present = CITATION_TREATMENT_ORDER.filter(
    (treatment) => counts[treatment] > 0,
  );

  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 px-3 ps-8 pb-2">
      {present.map((treatment) => (
        <li
          className="text-muted-foreground flex items-center gap-1.5 text-[0.7rem]"
          key={treatment}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full",
              CITATION_TREATMENT_DOT[treatment],
            )}
          />
          <span className="text-foreground-strong-muted tabular-nums">
            {counts[treatment]}
          </span>
          {t(CITATION_TREATMENT_LABEL[treatment])}
        </li>
      ))}
    </ul>
  );
};

type TreatmentGroup = {
  items: DecisionCitation[];
  treatment: CitationTreatment;
};

const groupByTreatment = (
  items: readonly DecisionCitation[],
): TreatmentGroup[] => {
  const groups = new Map<CitationTreatment, DecisionCitation[]>();
  for (const item of items) {
    const group = groups.get(item.treatment);
    if (group === undefined) {
      groups.set(item.treatment, [item]);
      continue;
    }
    group.push(item);
  }

  const ordered: TreatmentGroup[] = [];
  for (const treatment of CITATION_TREATMENT_ORDER) {
    const grouped = groups.get(treatment);
    if (grouped !== undefined) {
      ordered.push({ items: grouped, treatment });
    }
  }
  return ordered;
};

const CitationList = ({
  decisionId,
  direction,
}: {
  decisionId: SafeId<"caseLawDecision">;
  direction: CitationDirection;
}) => {
  const t = useTranslations();
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    refetch,
  } = useInfiniteQuery(decisionCitationsInfiniteOptions(decisionId, direction));

  const groups = groupByTreatment(
    optionalArray(data?.pages).flatMap((page) => page.items),
  );

  return (
    <div className="flex flex-col gap-3 px-3 pb-3">
      {isError && (
        <div className="flex items-center gap-2">
          <p className="text-muted-foreground text-xs">
            {t("errors.actionFailed")}
          </p>
          <Button
            className="text-xs"
            onClick={() => {
              detached(refetch(), "case-law.citations-retry");
            }}
            size="sm"
            variant="ghost"
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
      {groups.map((group) => (
        <div className="flex flex-col gap-1" key={group.treatment}>
          <p className="text-muted-foreground flex items-center gap-1.5 text-[0.7rem] tracking-wide uppercase">
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full",
                CITATION_TREATMENT_DOT[group.treatment],
              )}
            />
            {t(CITATION_TREATMENT_LABEL[group.treatment])}
          </p>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {group.items.map((item) => (
              <CitationRow item={item} key={item.id} />
            ))}
          </ul>
        </div>
      ))}
      {hasNextPage && (
        <Button
          className="w-fit text-xs"
          disabled={isFetchingNextPage}
          onClick={() => {
            detached(fetchNextPage(), "case-law.citations-more");
          }}
          size="sm"
          variant="ghost"
        >
          {t("common.loadMore")}
        </Button>
      )}
    </div>
  );
};

const CitationRow = ({ item }: { item: DecisionCitation }) => {
  const t = useTranslations();
  const format = useFormatter();

  if (item.decision === null) {
    return (
      <li className="text-foreground-strong-muted flex items-baseline gap-2 text-xs">
        <BidiText as="span">{item.citationText}</BidiText>
        <span className="text-muted-foreground text-[0.7rem]">
          {t("caseLaw.citation.unresolved")}
        </span>
      </li>
    );
  }

  const decided = formatDecisionDate(item.decision.decisionDate, format);

  return (
    <li className="flex flex-wrap items-baseline gap-x-2 text-xs">
      <CitedDecisionLink decision={item.decision}>
        <BidiText as="span">{citedDecisionLabel(item.decision)}</BidiText>
      </CitedDecisionLink>
      <span className="text-muted-foreground text-[0.7rem]">
        {decided === null
          ? item.decision.court
          : `${item.decision.court} · ${decided}`}
      </span>
    </li>
  );
};
