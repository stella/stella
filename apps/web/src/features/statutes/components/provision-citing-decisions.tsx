import { useState } from "react";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Popover, PopoverPanel, PopoverTrigger } from "@stll/ui/popover";
import { Skeleton } from "@stll/ui/skeleton";

import { citingDecisionsInfiniteOptions } from "@/features/statutes/queries/citing-decisions";
import { formatValidityDate } from "@/features/statutes/statute-format";
import { useFormatter } from "@/i18n/formatting-context";
import { optionalArray } from "@/lib/arrays";
import { createCaseLawDecisionRouteParams } from "@/lib/case-law-route";
import { detached } from "@/lib/detached";

type ProvisionCitingDecisionsProps = {
  /** The provision's anchor, the key its incoming citations are filed under. */
  anchorId: string;
  eli: string;
  jurisdiction: string;
};

/**
 * The case law citing one provision, opened from the provision itself.
 *
 * A consolidated code renders thousands of provisions at once, so the read is
 * deliberately not started until a reader opens this one: the affordance costs
 * no request, and the answer is paged from there.
 */
export const ProvisionCitingDecisions = ({
  anchorId,
  eli,
  jurisdiction,
}: ProvisionCitingDecisionsProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const [open, setOpen] = useState(false);

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    isPending,
    refetch,
  } = useInfiniteQuery({
    ...citingDecisionsInfiniteOptions({
      anchor: anchorId,
      eli,
      jurisdiction,
    }),
    enabled: open,
  });

  const decisions = optionalArray(data?.pages).flatMap((page) => page.items);
  const isLoading = open && isPending;

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger className="text-muted-foreground hover:text-foreground hover:border-foreground-disabled focus-visible:ring-ring mx-auto mb-[var(--reader-heading-gap-bottom)] block rounded-full border px-2 py-0.5 font-sans text-[0.7rem] font-normal tracking-normal transition-colors focus-visible:ring-2 focus-visible:outline-none print:hidden">
        {t("caseLaw.viewer.citedBy")}
      </PopoverTrigger>
      <PopoverPanel className="w-80" contentClassName="gap-1">
        {isLoading && <CitingDecisionsLoader />}
        {/* A failed read is not an answer: saying "no results" here would
            state as legal fact that nothing cites this provision. */}
        {isError && (
          <div className="flex flex-col items-center gap-1 py-2">
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
        )}
        {!isLoading && !isError && decisions.length === 0 && (
          <p className="text-muted-foreground py-2 text-center text-xs">
            {t("common.noResults")}
          </p>
        )}
        <ul className="m-0 flex list-none flex-col p-0">
          {decisions.map((decision) => {
            const params = createCaseLawDecisionRouteParams({
              caseNumber: decision.caseNumber,
              country: decision.country,
              court: decision.court,
              slug: decision.slug,
            });
            const decided = formatValidityDate(decision.decisionDate, format);

            return (
              <li key={`${decision.decisionId}-${decision.spanStart}`}>
                <Link
                  className="hover:bg-accent flex flex-col gap-0.5 rounded-md px-2 py-1.5 no-underline"
                  params={{
                    country: params.country,
                    court: params.court,
                    slug: params.slug,
                  }}
                  to="/law/$country/cases/$court/$slug"
                >
                  <BidiText
                    as="span"
                    className="text-foreground text-xs font-medium"
                  >
                    {decision.caseNumber}
                  </BidiText>
                  <span className="text-muted-foreground text-[0.7rem]">
                    {decided === null
                      ? decision.court
                      : `${decision.court} · ${decided}`}
                  </span>
                  <span className="text-foreground-strong-muted line-clamp-3 text-[0.72rem] leading-snug">
                    {decision.sentenceText}
                  </span>
                </Link>
              </li>
            );
          })}
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
      </PopoverPanel>
    </Popover>
  );
};

const CitingDecisionsLoader = () => (
  <div className="flex flex-col gap-2 py-1">
    {[0, 1, 2].map((row) => (
      <Skeleton className="h-8 w-full" key={row} />
    ))}
  </div>
);
