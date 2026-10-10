import { useState } from "react";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import type { CitedDecisionAddress } from "@/features/case-law/citation-treatment";
import {
  CITATION_TREATMENT_DOT,
  CITATION_TREATMENT_LABEL,
  CITATION_TREATMENT_ORDER,
  totalCitations,
} from "@/features/case-law/citation-treatment";
import { CitationHeader } from "@/features/case-law/components/case-viewer/citation-header";
import { DecisionCitations } from "@/features/case-law/components/case-viewer/decision-citations";
import { ProvisionsCited } from "@/features/case-law/components/case-viewer/provisions-cited";
import { decisionCitationSummaryOptions } from "@/features/case-law/queries/citations";
import { decisionProvisionsInfiniteOptions } from "@/features/case-law/queries/provisions";
import { useHydrated } from "@/hooks/use-hydrated";
import { useFormatter } from "@/i18n/formatting-context";
import { optionalArray } from "@/lib/arrays";
import { detached } from "@/lib/detached";
import type { SafeId } from "@/lib/safe-id";

type DecisionCitationBoxProps = {
  decision: CitedDecisionAddress;
  decisionDate: string | null;
  decisionId: SafeId<"caseLawDecision">;
};

const CountLabel = ({
  capped,
  count,
  format,
  label,
}: {
  capped: boolean;
  count: number | null;
  format: (value: number) => string;
  label: string;
}) => (
  <span>
    {label} {count === null ? "…" : format(count)}
    {capped ? "+" : ""}
  </span>
);

/** One compact summary and one disclosure for all three citation lists. */
export const DecisionCitationBox = ({
  decision,
  decisionDate,
  decisionId,
}: DecisionCitationBoxProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const [expanded, setExpanded] = useState(false);
  const hydrated = useHydrated();
  const {
    data: summary,
    isError: summaryError,
    refetch: refetchSummary,
  } = useQuery(decisionCitationSummaryOptions(decisionId));
  const { data: provisions, isError: provisionsError } = useInfiniteQuery(
    decisionProvisionsInfiniteOptions(decisionId),
  );

  if (!hydrated) {
    return null;
  }

  if (summary === undefined) {
    if (!summaryError) {
      return null;
    }
    return (
      <section className="reader-chrome border-border/60 mb-6 rounded-lg border px-3 py-2 print:hidden">
        <div className="flex items-center gap-2">
          <p className="text-muted-foreground text-xs">
            {t("errors.actionFailed")}
          </p>
          <Button
            onClick={() => {
              detached(refetchSummary(), "case-law.citations-retry");
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

  const provisionCount =
    provisions === undefined || provisionsError
      ? null
      : optionalArray(provisions.pages).reduce(
          (count, page) => count + page.items.length,
          0,
        );
  const lastProvisionPage = provisions?.pages.at(-1);
  const provisionCapped = typeof lastProvisionPage?.nextCursor === "string";

  return (
    <section className="reader-chrome border-border/60 mb-6 rounded-lg border print:hidden">
      <div className="flex flex-col items-center gap-1.5 px-3 pt-2">
        <CitationHeader
          compact
          decisionDate={decisionDate}
          decisionId={decisionId}
          target={{
            caseNumber: decision.caseNumber,
            country: decision.country,
            court: decision.court,
            decisionId,
            language: decision.language,
            languageAlternates: decision.languageAlternates,
            slug: decision.slug,
          }}
        />
        <p className="text-muted-foreground flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs tabular-nums">
          <CountLabel
            count={totalCitations(summary.incoming)}
            capped={summary.capped.incoming}
            label={t("caseLaw.viewer.citedBy")}
            format={format.number}
          />
          <span aria-hidden="true">·</span>
          <CountLabel
            count={totalCitations(summary.outgoing)}
            capped={summary.capped.outgoing}
            label={t("caseLaw.viewer.cites")}
            format={format.number}
          />
          <span aria-hidden="true">·</span>
          <CountLabel
            count={provisionCount}
            capped={provisionCount !== null && provisionCapped}
            label={t("caseLaw.viewer.provisionsCited")}
            format={format.number}
          />
          <span className="flex items-center gap-1.5">
            {CITATION_TREATMENT_ORDER.filter(
              (treatment) => summary.incoming[treatment] > 0,
            ).map((treatment) => (
              <span
                aria-label={t(CITATION_TREATMENT_LABEL[treatment])}
                className={cn(
                  "size-1.5 rounded-full",
                  CITATION_TREATMENT_DOT[treatment],
                )}
                key={treatment}
                role="img"
              />
            ))}
          </span>
        </p>
      </div>
      <button
        aria-expanded={expanded}
        className="text-foreground-strong-muted hover:text-foreground flex w-full items-center justify-center gap-1.5 px-3 py-2 text-start text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
        onClick={() => setExpanded(!expanded)}
        type="button"
      >
        <span>{t("common.citations")}</span>
        <span aria-hidden="true">{expanded ? "−" : "+"}</span>
      </button>
      {expanded && (
        <div className="border-border/60 flex flex-col gap-4 border-t px-3 py-3">
          <DecisionCitations
            decision={decision}
            decisionId={decisionId}
            expanded
          />
          <ProvisionsCited
            decisionDate={decisionDate}
            decisionId={decisionId}
            expanded
          />
        </div>
      )}
    </section>
  );
};
