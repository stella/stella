import { useState } from "react";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { Skeleton } from "@stll/ui/skeleton";

import { CitedDecisionLink } from "@/components/legal-reader/cited-decision-link";
import { filterCitingDecisions } from "@/features/statutes/provision-inspector.logic";
import { citingDecisionsInfiniteOptions } from "@/features/statutes/queries/citing-decisions";
import { formatValidityDate } from "@/features/statutes/statute-format";
import { useFormatter } from "@/i18n/formatting-context";
import { optionalArray } from "@/lib/arrays";
import { detached } from "@/lib/detached";

export type CitingDecisionRow = {
  caseNumber: string;
  country: string;
  court: string;
  decisionDate: string | null;
  decisionId: string;
  sentenceText: string;
  slug: string | null;
};

/** One citing decision with the passage that applies the provision. */
export const CitingDecisionItem = ({
  decision,
}: {
  decision: CitingDecisionRow;
}) => {
  const format = useFormatter();
  const decided = formatValidityDate(decision.decisionDate, format);

  return (
    <CitedDecisionLink
      className="hover:bg-accent -mx-2 flex flex-col gap-0.5 rounded-md px-2 py-1.5 no-underline"
      decision={{
        caseNumber: decision.caseNumber,
        country: decision.country,
        court: decision.court,
        decisionDate: decision.decisionDate,
        id: decision.decisionId,
        slug: decision.slug,
      }}
    >
      <BidiText as="span" className="text-foreground text-xs font-medium">
        {decision.caseNumber}
      </BidiText>
      <span className="text-muted-foreground text-[0.7rem]">
        {decided === null ? decision.court : `${decision.court} · ${decided}`}
      </span>
      <span className="text-foreground-strong-muted line-clamp-3 text-[0.72rem] leading-snug">
        {decision.sentenceText}
      </span>
    </CitedDecisionLink>
  );
};

type ProvisionCitingDecisionsProps = {
  /** The provision's anchor, the key its incoming citations are filed under. */
  anchorId: string;
  eli: string;
  jurisdiction: string;
};

/**
 * The case law citing one provision, newest application first.
 *
 * Mounted only inside the provision's inspector tab, so the read starts when
 * a reader asks about this one provision and is paged from there. The filter
 * narrows what has been loaded; it does not ask the server for more.
 */
export const ProvisionCitingDecisions = ({
  anchorId,
  eli,
  jurisdiction,
}: ProvisionCitingDecisionsProps) => {
  const t = useTranslations();
  const [filter, setFilter] = useState("");

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    isPending,
    refetch,
  } = useInfiniteQuery(
    citingDecisionsInfiniteOptions({
      anchor: anchorId,
      eli,
      jurisdiction,
    }),
  );

  const decisions = optionalArray(data?.pages).flatMap((page) => page.items);
  const visible = filterCitingDecisions(decisions, filter);

  if (isPending) {
    return <CitingDecisionsLoader />;
  }

  // A failed read is not an answer: saying "no results" here would state as
  // legal fact that nothing cites this provision.
  if (isError) {
    return (
      <div className="flex flex-col items-start gap-1">
        <p className="text-muted-foreground text-xs">
          {t("errors.actionFailed")}
        </p>
        <Button
          className="text-xs"
          onClick={() => {
            detached(refetch(), "statutes.citing-decisions-retry");
          }}
          size="sm"
          variant="ghost"
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  if (decisions.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">{t("common.noResults")}</p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Input
        aria-label={t("common.filter")}
        className="h-7 text-xs"
        onChange={(event) => setFilter(event.target.value)}
        placeholder={t("statutes.citingDecisionsFilterPlaceholder")}
        type="search"
        value={filter}
      />
      {visible.length === 0 && (
        <p className="text-muted-foreground text-xs">{t("common.noResults")}</p>
      )}
      <ul className="m-0 flex list-none flex-col p-0">
        {visible.map((decision) => (
          <li key={`${decision.decisionId}-${decision.spanStart}`}>
            <CitingDecisionItem decision={decision} />
          </li>
        ))}
      </ul>
      {hasNextPage && (
        <Button
          className="w-full text-xs"
          disabled={isFetchingNextPage}
          onClick={() => {
            detached(fetchNextPage(), "statutes.citing-decisions-more");
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

const CitingDecisionsLoader = () => (
  <div className="flex flex-col gap-2">
    {[0, 1, 2].map((row) => (
      <Skeleton className="h-8 w-full" key={row} />
    ))}
  </div>
);
