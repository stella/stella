import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { buttonVariants } from "@stll/ui/button";
import { COMPOSER_PICKER_TRIGGER_CLASS } from "@stll/ui/composer";
import { DetailsGrid, DetailsItem } from "@stll/ui/details-grid";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ArrowRightIcon } from "@stll/ui/icons";
import {
  Popover,
  PopoverPanel,
  PopoverTitle,
  PopoverTrigger,
} from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import { caseLawCoverageAnchor } from "@/features/case-law/case-law-jurisdiction";
import { CaseLawHealthSignal } from "@/features/case-law/components/case-law-health-signal";
import { caseLawCorpusStatusOptions } from "@/features/case-law/queries/decisions";
import { useFormatter, useRelativeTime } from "@/i18n/formatting-context";
import { caseLawCountryName } from "@/lib/case-law-route";
import { parseDeterministicDate } from "@/lib/deterministic-date";
import { queryView } from "@/lib/query-view.logic";
import { FULL_DATE_MEDIUM_TIME_FORMAT } from "@/lib/relative-time";
import { useQueryViewError } from "@/lib/use-query-view";

/**
 * The corpus's freshness, where the chat's status row keeps its meter: the
 * country's health as one word with its dot, the same word the coverage page
 * gives the country, because the API derives both from the same sources.
 * Pressing it opens the two numbers a reader checks before trusting a search
 * (how much is searchable, when it last changed) and the way into the
 * coverage page, which lands on this country's section; the court-by-court
 * and source-by-source detail lives there, once.
 * Nothing is shown until the status is known; a dot that cannot say when
 * would be a decoration. Its box is held meanwhile: the badge is often the
 * row's only content, so an empty slot would collapse the row and push the
 * page down when a newly picked country's status arrives.
 */
export const LawDatabaseStatus = ({ country }: { country: string }) => {
  const t = useTranslations();
  const format = useFormatter();
  const relativeTime = useRelativeTime();
  const statusQuery = useQuery(caseLawCorpusStatusOptions(country));
  const statusView = queryView(statusQuery);
  useQueryViewError(statusView, "LawDatabaseStatus:query");
  const status = statusView.type === "items" ? statusView.items : undefined;

  const updatedAt = status?.updatedAt ?? null;
  if (status === undefined || updatedAt === null) {
    return (
      <span
        aria-hidden="true"
        className={cn(COMPOSER_PICKER_TRIGGER_CLASS, "invisible")}
      >
        {t("caseLaw.coverage.healthCurrent")}
      </span>
    );
  }
  const updatedAtDate = parseDeterministicDate(updatedAt);
  const countryName = caseLawCountryName(format, country);

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          COMPOSER_PICKER_TRIGGER_CLASS,
          // The row's type is 11px, so the badge is half a touch target tall.
          // A coarse pointer gets the button's own 44px box, as `Button` does.
          "relative pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11",
        )}
      >
        <CaseLawHealthSignal health={status.health} />
      </PopoverTrigger>
      <PopoverPanel
        align="end"
        className="max-w-[min(28rem,90vw)]"
        side="bottom"
      >
        <div className="flex items-center justify-between gap-4">
          <PopoverTitle className="text-sm font-medium">
            {countryName}
          </PopoverTitle>
          <CaseLawHealthSignal className="text-xs" health={status.health} />
        </div>
        <DetailsGrid>
          <DetailsItem label={t("caseLaw.coverage.searchable")}>
            <span className="tabular-nums">
              {format.number(status.decisions)}
            </span>
          </DetailsItem>
          <DetailsItem label={t("common.lastUpdated")}>
            {relativeTime(updatedAt)}
            {updatedAtDate !== null && (
              <span className="text-muted-foreground block">
                {format.dateTime(updatedAtDate, FULL_DATE_MEDIUM_TIME_FORMAT)}
              </span>
            )}
          </DetailsItem>
        </DetailsGrid>
        {/* This panel answers whether to trust a search here; the coverage
            page answers why, source by source and court by court, and opens
            on this country. */}
        <Link
          className={cn(
            buttonVariants({ size: "sm", variant: "outline" }),
            "justify-between",
          )}
          hash={caseLawCoverageAnchor(country)}
          to="/law/coverage"
        >
          {t("caseLaw.coverage.title")}
          <DirectionalIcon icon={ArrowRightIcon} />
        </Link>
      </PopoverPanel>
    </Popover>
  );
};
