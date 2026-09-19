import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { COMPOSER_PICKER_TRIGGER_CLASS } from "@stll/ui/composer";
import {
  Popover,
  PopoverPanel,
  PopoverTitle,
  PopoverTrigger,
} from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import { caseLawCountryName } from "@/features/case-law/components/case-law-search";
import { CourtName } from "@/features/case-law/components/court-name";
import {
  courtTierRowKey,
  groupCourtRowsByTier,
} from "@/features/case-law/court-tier-rows.logic";
import {
  COURT_TIER_LABEL_KEYS,
  type CourtTier,
} from "@/features/case-law/decision-filter-facets.logic";
import { caseLawCorpusStatusOptions } from "@/features/case-law/queries/decisions";
import { useFormatter } from "@/i18n/formatting-context";
import {
  formatFullTimestamp,
  formatRelativeTime,
  isWithinLast,
} from "@/lib/relative-time";

/**
 * How recent the newest change may be for the corpus to count as current:
 * the courts publish daily and ingestion follows within the day, so a week
 * of silence is a stalled feed, not a quiet week.
 */
const UP_TO_DATE_WINDOW_SECONDS = 7 * 24 * 60 * 60;

type CorpusStatus = Awaited<
  ReturnType<
    NonNullable<ReturnType<typeof caseLawCorpusStatusOptions>["queryFn"]>
  >
>;
/** One line of the breakdown: a named court, or a whole tier of them. */
type CourtRow = CorpusStatus["courts"][number];

/**
 * The corpus's freshness, where the chat's status row keeps its meter: a
 * dot and one phrase. Pressing it opens the numbers the phrase stands for:
 * how much of this jurisdiction the corpus holds, when it last changed, and
 * which courts that is. They were a hover tooltip, which a touch reader never
 * sees. The dot is green only while the newest change is inside the window; a
 * stale corpus says when it last changed instead of claiming to be current.
 * Nothing is shown until the status is known; a dot that cannot say when
 * would be a decoration.
 */
export const LawDatabaseStatus = ({ country }: { country: string }) => {
  const t = useTranslations();
  const format = useFormatter();
  const { data: status } = useQuery(caseLawCorpusStatusOptions(country));

  const updatedAt = status?.updatedAt ?? null;
  if (status === undefined || updatedAt === null) {
    return null;
  }
  const upToDate = isWithinLast(updatedAt, UP_TO_DATE_WINDOW_SECONDS);

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          COMPOSER_PICKER_TRIGGER_CLASS,
          // The row's type is 11px, so the badge is half a touch target tall.
          // A coarse pointer gets the button's own 44px box, as `Button` does.
          "relative gap-1.5 pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11",
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 rounded-full",
            upToDate ? "bg-success" : "bg-foreground-muted",
          )}
        />
        {upToDate
          ? t("caseLaw.coverage.healthCurrent")
          : t("caseLaw.research.updated", {
              date: formatRelativeTime(updatedAt),
            })}
      </PopoverTrigger>
      <PopoverPanel
        align="end"
        className="max-w-[min(28rem,90vw)]"
        side="bottom"
      >
        <PopoverTitle className="text-sm font-medium">
          {caseLawCountryName(format, country)}
        </PopoverTitle>
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">{t("common.decisions")}</dt>
          <dd className="text-end tabular-nums">
            {format.number(status.decisions)}
          </dd>
          <dt className="text-muted-foreground">{t("common.lastUpdated")}</dt>
          <dd className="text-end">
            {formatFullTimestamp(updatedAt)}
            <span className="text-muted-foreground block">
              {formatRelativeTime(updatedAt)}
            </span>
          </dd>
        </dl>
        {status.courts.length > 0 && <CourtBreakdown courts={status.courts} />}
        {/* This panel answers for one jurisdiction; the coverage page answers
            for the corpus, source by source, including the countries the
            public search cannot reach yet. */}
        <Link
          className="text-muted-foreground hover:text-foreground mt-3 block text-xs underline underline-offset-2"
          to="/law/coverage"
        >
          {t("caseLaw.coverage.title")}
        </Link>
      </PopoverPanel>
    </Popover>
  );
};

/**
 * The same corpus court by court, grouped under the tier headings the facet
 * rail already uses, so the two read as one classification of the same courts.
 * Apex courts arrive by name; the API groups the wide tiers into one row each,
 * because a jurisdiction has dozens of regional and district courts and a list
 * of them is not what a reader came to the badge for.
 */
const CourtBreakdown = ({ courts }: { courts: readonly CourtRow[] }) => {
  const t = useTranslations();
  const byTier = groupCourtRowsByTier(courts);

  return (
    <div className="-mx-1 mt-3 overflow-x-auto">
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th className="px-1 pb-1 text-start font-normal" scope="col">
              {t("common.court")}
            </th>
            <th className="px-1 pb-1 text-end font-normal" scope="col">
              {t("common.decisions")}
            </th>
            <th className="px-1 pb-1 text-end font-normal" scope="col">
              {t("caseLaw.corpusStatus.newLast7Days")}
            </th>
            <th className="px-1 pb-1 text-end font-normal" scope="col">
              {t("common.lastUpdated")}
            </th>
          </tr>
        </thead>
        {byTier.map(({ rows, tier }) => (
          <tbody key={tier}>
            <tr>
              {/* `rowgroup`, not `colgroup`: the heading labels the court rows
                  of its own `<tbody>`, and the table declares no column
                  groups for a `colgroup` header to name. */}
              <th
                className="text-muted-foreground border-border border-t px-1 pt-2 pb-1 text-start font-medium"
                colSpan={4}
                scope="rowgroup"
              >
                {t(COURT_TIER_LABEL_KEYS[tier])}
              </th>
            </tr>
            {rows.map((row) => (
              <CourtRowCells key={courtTierRowKey(row)} row={row} tier={tier} />
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
};

const CourtRowCells = ({ row, tier }: { row: CourtRow; tier: CourtTier }) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <tr>
      <th className="max-w-56 px-1 py-0.5 text-start font-normal" scope="row">
        {row.type === "court" ? (
          <CourtName
            abbreviation={row.courtAbbreviation}
            court={row.court}
            tier={tier}
          />
        ) : (
          <span className="text-muted-foreground">
            {t("caseLaw.corpusStatus.courtCount", { count: row.courts })}
          </span>
        )}
      </th>
      <td className="px-1 py-0.5 text-end tabular-nums">
        {format.number(row.decisions)}
      </td>
      <td
        className={cn(
          "px-1 py-0.5 text-end tabular-nums",
          // A quiet week is a fact, not an absence, so the zero stays on the
          // row; it recedes instead of competing with the courts that moved.
          row.addedLastWeek === 0 && "text-muted-foreground",
        )}
      >
        {/* Signed, so the column reads as a delta rather than a second
            total; a quiet week shows a plain 0 rather than "+0". */}
        {format.number(row.addedLastWeek, { signDisplay: "exceptZero" })}
        {row.addedLastDay > 0 && (
          <span className="text-muted-foreground block">
            {t("caseLaw.corpusStatus.newLast24Hours", {
              count: format.number(row.addedLastDay),
            })}
          </span>
        )}
      </td>
      <td className="text-muted-foreground px-1 py-0.5 text-end whitespace-nowrap">
        {row.updatedAt === null ? "—" : formatRelativeTime(row.updatedAt)}
      </td>
    </tr>
  );
};
