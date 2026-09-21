import { type PropsWithChildren, type ReactNode, useId } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { ReviewStatusDot } from "@stll/ui/review-severity-dot";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";
import { cn } from "@stll/ui/utils";

import { caseLawCountryName } from "@/features/case-law/components/case-law-search";
import { CourtRowLabel } from "@/features/case-law/components/court-row-label";
import {
  courtTierRowKey,
  groupCourtRowsByTier,
} from "@/features/case-law/court-tier-rows.logic";
import {
  caseLawCompletenessExceedsReported,
  caseLawCompletenessPercent,
} from "@/features/case-law/coverage-completeness";
import {
  COURT_TIER_LABEL_KEYS,
  type CourtTier,
} from "@/features/case-law/decision-filter-facets.logic";
import {
  useFormatter,
  useLocale,
  useRelativeTime,
} from "@/i18n/formatting-context";
import { parseDeterministicDate } from "@/lib/deterministic-date";
import {
  CALENDAR_DATE_FORMAT,
  MEDIUM_DATE_SHORT_TIME_FORMAT,
} from "@/lib/relative-time";
import { sanitizeHref } from "@/lib/sanitize-href";
import {
  CASE_LAW_COMPLETENESS_NOTE_KIND,
  CASE_LAW_COVERAGE_AVAILABILITY_LABEL_KEYS,
  CASE_LAW_COVERAGE_AVAILABILITY_TONES,
  CASE_LAW_COVERAGE_HEALTH_LABEL_KEYS,
  CASE_LAW_COVERAGE_HEALTH_TONES,
  CASE_LAW_TOTAL_REPORTER_LABEL_KEYS,
  type CaseLawCompletenessNoteKind,
  type CaseLawCoverageCountry,
  type CaseLawCoverageHealth,
  type CaseLawCoverageResponse,
  type CaseLawCoverageSource,
  type CaseLawMeasuredCompleteness,
  type CaseLawSourceCompleteness,
  type CaseLawStoredCount,
  caseLawCoverageCompletenessNotes,
  orderCoverageCountriesByName,
} from "@/routes/law/-law-coverage/coverage.logic";

/** Where a figure stands that the corpus states no number for. */
const NO_VALUE = "—";

const PERCENT_FORMAT = {
  style: "percent",
} as const satisfies Intl.NumberFormatOptions;

/** A year is an identifier, not a quantity: 2026, never 2,026. */
const YEAR_FORMAT = {
  useGrouping: false,
} as const satisfies Intl.NumberFormatOptions;

/**
 * Signed, so the column reads as a delta rather than as a second total; a
 * quiet week shows a plain 0 rather than "+0".
 */
const DELTA_FORMAT = {
  signDisplay: "exceptZero",
} as const satisfies Intl.NumberFormatOptions;

/** Column headers on a tight row, one line each. */
const HEAD_CLASS = "h-8 text-xs";

/** Source, status, last sync, new in seven days, completeness. */
const SOURCE_COLUMN_COUNT = 5;

/** Court, decisions, new in seven days, last updated. */
const COURT_COLUMN_COUNT = 4;

/** Stable keys so the rows held open while the figures load never key by index. */
const PENDING_ROW_KEYS = ["a", "b", "c", "d"] as const;
const PENDING_SECTION_KEYS = ["first", "second"] as const;

/**
 * What the corpus holds, country by country and source by source.
 *
 * The page keeps the two populations apart everywhere it prints them: what a
 * search can find, and what is held. Summing them would count a searchable
 * decision twice and imply that a country still in preparation can be
 * searched, so they are never one figure.
 */
export const CaseLawCoveragePage = ({
  coverage,
}: {
  coverage: CaseLawCoverageResponse;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const locale = useLocale();

  // Not a discriminated union: the endpoint answers either the figures or a
  // message saying it cannot state them.
  if (!("countries" in coverage)) {
    return (
      <CoverageLayout>
        <CoverageHeading />
        <p className="text-muted-foreground text-sm">
          {t("caseLaw.coverage.unavailable")}
        </p>
      </CoverageLayout>
    );
  }

  const countries = orderCoverageCountriesByName({
    countries: coverage.countries,
    locale,
    nameOf: ({ country }) => caseLawCountryName(format, country),
  });

  return (
    <CoverageLayout>
      <CoverageHeading>
        <p className="text-muted-foreground text-xs">
          {t("caseLaw.coverage.generatedAt", {
            date: observedInstant(coverage.generatedAt, format),
          })}
        </p>
      </CoverageHeading>

      <dl className="grid max-w-md grid-cols-2 gap-3">
        <Total
          hint={t("caseLaw.coverage.searchableHint")}
          label={t("caseLaw.coverage.searchable")}
        >
          {format.number(coverage.totals.searchable)}
        </Total>
        <Total
          hint={t("caseLaw.coverage.storedHint")}
          label={t("caseLaw.coverage.stored")}
        >
          <StoredDecisions stored={coverage.totals.stored} />
        </Total>
      </dl>

      {countries.map((country) => (
        <CountrySection country={country} key={country.country} />
      ))}
    </CoverageLayout>
  );
};

/**
 * The page's own chrome while the figures are in flight. The title and the
 * lead read immediately; only the numbers and the rows shimmer, so the layout
 * the reader lands on is the one that stays.
 */
export const CaseLawCoveragePending = () => {
  const t = useTranslations();

  return (
    <CoverageLayout>
      <CoverageHeading>
        <Skeleton className="h-3 w-48" />
      </CoverageHeading>

      <dl className="grid max-w-md grid-cols-2 gap-3">
        <Total
          hint={t("caseLaw.coverage.searchableHint")}
          label={t("caseLaw.coverage.searchable")}
        >
          <Skeleton className="h-7 w-28" />
        </Total>
        <Total
          hint={t("caseLaw.coverage.storedHint")}
          label={t("caseLaw.coverage.stored")}
        >
          <Skeleton className="h-7 w-28" />
        </Total>
      </dl>

      {PENDING_SECTION_KEYS.map((section) => (
        <CountryCard
          header={
            <>
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-5 w-20 rounded-full" />
            </>
          }
          key={section}
        >
          <TableBlock title={t("caseLaw.coverage.sourcesHeading")}>
            <SourcesTableHead />
            <TableBody>
              {PENDING_ROW_KEYS.map((row) => (
                <TableRow key={row}>
                  <TableCell colSpan={SOURCE_COLUMN_COUNT}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </TableBlock>
          <TableBlock title={t("caseLaw.coverage.courtsHeading")}>
            <CourtsTableHead />
            <TableBody>
              {PENDING_ROW_KEYS.map((row) => (
                <TableRow key={row}>
                  <TableCell colSpan={COURT_COLUMN_COUNT}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </TableBlock>
        </CountryCard>
      ))}
    </CoverageLayout>
  );
};

// The shell bounds the page's height, so the content scrolls inside it rather
// than moving the document. `ScrollArea` owns that scrollbar: a raw overflow
// utility would hand it to the platform and put a macOS overlay bar beside a
// Windows gutter in the same shell.
const CoverageLayout = ({ children }: PropsWithChildren) => (
  <main className="flex min-h-0 flex-1 flex-col">
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex w-full max-w-7xl flex-col gap-6 p-4 sm:p-6">
        {children}
      </div>
    </ScrollArea>
  </main>
);

const CoverageHeading = ({ children }: PropsWithChildren) => {
  const t = useTranslations();

  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold text-balance">
          {t("caseLaw.coverage.title")}
        </h1>
        <p className="text-muted-foreground max-w-prose text-sm text-pretty">
          {t("caseLaw.coverage.description")}
        </p>
      </div>
      {children}
    </header>
  );
};

/** One of the two populations, with the one line that says what it counts. */
const Total = ({
  children,
  hint,
  label,
}: PropsWithChildren<{ hint: string; label: string }>) => (
  <div className="bg-background flex flex-col gap-1 rounded-xl border px-4 py-3 shadow-xs/5">
    <dt className="text-muted-foreground text-xs">{label}</dt>
    <dd className="flex flex-col gap-0.5">
      <span className="text-2xl font-semibold tabular-nums">{children}</span>
      <span className="text-muted-foreground text-xs">{hint}</span>
    </dd>
  </div>
);

/**
 * A stored count with the instant it was taken. The count is made on the
 * ingestion side, so the figure on the page is as old as its last sweep; a
 * number printed without that date invites the reader to take it for live.
 *
 * With no sweep on record the count is zero by construction, not by
 * observation, and a zero there would read as a corpus holding nothing.
 */
const StoredDecisions = ({ stored }: { stored: CaseLawStoredCount }) => {
  const t = useTranslations();
  const format = useFormatter();

  if (stored.asOf === null) {
    return (
      <span className="text-muted-foreground text-sm font-normal">
        {t("caseLaw.coverage.notCountedYet")}
      </span>
    );
  }
  return (
    <>
      {format.number(stored.decisions)}
      <CountedOn asOf={stored.asOf} />
    </>
  );
};

/**
 * A week's arrivals. A quiet week is a fact and stays on the row, receding
 * rather than competing with the rows that moved; a week the read did not
 * answer for is not a fact, and prints as none.
 */
const Delta = ({ value }: { value: number | null }) => {
  const format = useFormatter();

  if (value === null) {
    return <span className="text-muted-foreground">{NO_VALUE}</span>;
  }
  return (
    <span
      className={cn("tabular-nums", value === 0 && "text-muted-foreground")}
    >
      {format.number(value, DELTA_FORMAT)}
    </span>
  );
};

/** Freshness as a word, with the dot as its second reading and never its only one. */
const HealthSignal = ({ health }: { health: CaseLawCoverageHealth }) => {
  const t = useTranslations();

  return (
    <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap">
      <ReviewStatusDot tone={CASE_LAW_COVERAGE_HEALTH_TONES[health]} />
      {t(CASE_LAW_COVERAGE_HEALTH_LABEL_KEYS[health])}
    </span>
  );
};

type TableBlockProps = PropsWithChildren<{
  /** One line under the title: what the table's figures rest on. */
  subtitle?: ReactNode;
  title: string;
}>;

/**
 * A table under its own heading. The heading is outside the table rather
 * than a caption, so it can carry a second line without restyling the
 * caption the table primitive owns.
 */
const TableBlock = ({ children, subtitle, title }: TableBlockProps) => {
  const headingId = useId();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium" id={headingId}>
          {title}
        </h3>
        {subtitle}
      </div>
      <Table aria-labelledby={headingId}>{children}</Table>
    </div>
  );
};

type CountryCardProps = PropsWithChildren<{
  header: ReactNode;
  headingId?: string;
}>;

/**
 * One country: its name and state on the rim, its tables inside, one under
 * the other. Side by side, a source's name wraps to three lines and the
 * newest court's date is cut off before the width they would need.
 */
const CountryCard = ({ children, header, headingId }: CountryCardProps) => (
  <section
    aria-labelledby={headingId}
    className="bg-background flex flex-col rounded-xl border shadow-xs/5"
  >
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
      {header}
    </header>
    <div className="flex flex-col gap-6 px-4 py-4">{children}</div>
  </section>
);

const CountrySection = ({ country }: { country: CaseLawCoverageCountry }) => {
  const t = useTranslations();
  const format = useFormatter();
  const headingId = useId();

  return (
    <CountryCard
      header={
        <>
          <h2 className="text-base font-semibold" id={headingId}>
            {caseLawCountryName(format, country.country)}
          </h2>
          <ReviewStatusBadge
            tone={CASE_LAW_COVERAGE_AVAILABILITY_TONES[country.availability]}
          >
            {t(CASE_LAW_COVERAGE_AVAILABILITY_LABEL_KEYS[country.availability])}
          </ReviewStatusBadge>
          <HealthSignal health={country.health} />
          <dl className="ms-auto flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
            {country.availability === "searchable" && (
              <Figure label={t("caseLaw.coverage.searchable")}>
                <span className="font-medium tabular-nums">
                  {format.number(country.searchable)}
                </span>
              </Figure>
            )}
            {country.availability === "searchable" && (
              <DecisionYearsFigure
                from={country.decisionYearFrom}
                to={country.decisionYearTo}
              />
            )}
            <Figure label={t("caseLaw.corpusStatus.newLast7Days")}>
              <Delta value={country.addedLastWeek} />
            </Figure>
            <Figure label={t("caseLaw.coverage.stored")}>
              <StoredDecisions stored={country.stored} />
            </Figure>
          </dl>
        </>
      }
      headingId={headingId}
    >
      <SourcesTable
        completeness={country.completeness}
        sources={country.sources}
      />
      {country.availability === "searchable" && (
        <CourtsTable courts={country.courts} />
      )}
    </CountryCard>
  );
};

const Figure = ({ children, label }: PropsWithChildren<{ label: string }>) => (
  <div className="flex items-baseline gap-1.5">
    <dt className="text-muted-foreground text-xs">{label}</dt>
    <dd>{children}</dd>
  </div>
);

/** The span the index covers, omitted where the index states no year at all. */
const DecisionYearsFigure = ({
  from,
  to,
}: {
  from: number | null;
  to: number | null;
}) => {
  const t = useTranslations();
  const format = useFormatter();

  if (from === null || to === null) {
    return null;
  }
  const fromYear = format.number(from, YEAR_FORMAT);
  const toYear = format.number(to, YEAR_FORMAT);

  return (
    <Figure label={t("caseLaw.coverage.decisionYears")}>
      <bdi className="font-medium tabular-nums">
        {from === to ? fromYear : `${fromYear}–${toYear}`}
      </bdi>
    </Figure>
  );
};

/**
 * A country's completeness on one line under the sources heading: the ratio,
 * the two numbers it was computed from, and a count of every source it could
 * not be computed over.
 *
 * The counts sit beside the ratio rather than inside it. Folding an unmeasured
 * source into the percentage would make a corpus nobody has checked read
 * exactly like one that has been. With no source measured, both sums are zero
 * by construction rather than by observation, so only the withheld ratio and
 * the reasons print; a labelled zero would read as a publisher stating it
 * holds nothing.
 */
const CountryCompleteness = ({
  completeness,
}: {
  completeness: CaseLawCoverageCountry["completeness"];
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const counts = {
    reported: completeness.reported,
    stored: completeness.stored,
  };
  const percent = caseLawCompletenessPercent(counts);
  const notes = caseLawCoverageCompletenessNotes(completeness);
  const measured = completeness.measuredSources > 0;

  return (
    <dl className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-0.5 text-xs font-normal">
      <div className="flex gap-1.5">
        <dt>{t("caseLaw.coverage.completeness")}</dt>
        <dd className="text-foreground tabular-nums">
          {percent === null
            ? NO_VALUE
            : format.number(percent / 100, PERCENT_FORMAT)}
        </dd>
      </div>
      {measured && (
        <div className="flex gap-1.5">
          <dt>{t("caseLaw.coverage.stored")}</dt>
          <dd className="text-foreground tabular-nums">
            {format.number(completeness.stored)}
            {completeness.storedAsOf !== null && (
              <span className="text-muted-foreground">
                {" "}
                (
                {t("caseLaw.coverage.countedOn", {
                  date: observedDate(completeness.storedAsOf, format),
                })}
                )
              </span>
            )}
          </dd>
        </div>
      )}
      {measured && (
        <div className="flex gap-1.5">
          <dt>{t("caseLaw.coverage.publisherTotal")}</dt>
          <dd className="text-foreground tabular-nums">
            {format.number(completeness.reported)}
          </dd>
        </div>
      )}
      {notes.map(({ count, kind }) => (
        <div key={kind}>
          <CompletenessNote count={count} kind={kind} />
        </div>
      ))}
    </dl>
  );
};

const CompletenessNote = ({
  count,
  kind,
}: {
  count: number;
  kind: CaseLawCompletenessNoteKind;
}) => {
  const t = useTranslations();

  switch (kind) {
    case CASE_LAW_COMPLETENESS_NOTE_KIND.NOT_MEASURED:
      return <>{t("caseLaw.coverage.notMeasuredSources", { count })}</>;
    case CASE_LAW_COMPLETENESS_NOTE_KIND.STALE:
      return <>{t("caseLaw.coverage.staleSources", { count })}</>;
    case CASE_LAW_COMPLETENESS_NOTE_KIND.NOT_COUNTED:
      return <>{t("caseLaw.coverage.notCountedSources", { count })}</>;
    default: {
      kind satisfies never;
      return panic("Unhandled case-law completeness note kind");
    }
  }
};

/** Shared by the real table and its pending twin, so a column cannot drift. */
const SourcesTableHead = () => {
  const t = useTranslations();

  return (
    <TableHeader>
      <TableRow>
        <TableHead className={HEAD_CLASS} scope="col">
          {t("common.source")}
        </TableHead>
        <TableHead className={HEAD_CLASS} scope="col">
          {t("common.status")}
        </TableHead>
        <TableHead className={cn(HEAD_CLASS, "text-end")} scope="col">
          {t("caseLaw.coverage.lastSync")}
        </TableHead>
        <TableHead className={cn(HEAD_CLASS, "text-end")} scope="col">
          {t("caseLaw.corpusStatus.newLast7Days")}
        </TableHead>
        <TableHead className={HEAD_CLASS} scope="col">
          {t("caseLaw.coverage.completeness")}
        </TableHead>
      </TableRow>
    </TableHeader>
  );
};

const SourcesTable = ({
  completeness,
  sources,
}: {
  completeness: CaseLawCoverageCountry["completeness"];
  sources: readonly CaseLawCoverageSource[];
}) => {
  const t = useTranslations();
  const relativeTime = useRelativeTime();

  return (
    <TableBlock
      subtitle={<CountryCompleteness completeness={completeness} />}
      title={t("caseLaw.coverage.sourcesHeading")}
    >
      <SourcesTableHead />
      <TableBody>
        {sources.map((source) => (
          <TableRow key={source.adapterKey}>
            <TableHead
              className={"text-foreground h-auto font-normal whitespace-normal"}
              scope="row"
            >
              <a
                className="underline-offset-2 hover:underline"
                href={sanitizeHref(source.publicHomeUrl)}
                rel="noreferrer"
              >
                <bdi>{source.name}</bdi>
              </a>
            </TableHead>
            <TableCell>
              <HealthSignal health={source.health} />
            </TableCell>
            <TableCell className={"text-muted-foreground text-end"}>
              {source.lastSyncAt === null
                ? NO_VALUE
                : relativeTime(source.lastSyncAt)}
            </TableCell>
            <TableCell className={"text-end"}>
              <Delta value={source.addedLastWeek} />
            </TableCell>
            <TableCell className={"whitespace-normal"}>
              <SourceCompleteness completeness={source.completeness} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableBlock>
  );
};

const SourceCompleteness = ({
  completeness,
}: {
  completeness: CaseLawSourceCompleteness;
}) => {
  const t = useTranslations();

  switch (completeness.state) {
    case "not-measured-yet":
      return (
        <span className="text-muted-foreground">
          {t("caseLaw.coverage.notMeasuredYet")}
        </span>
      );
    case "not-counted-yet":
      return (
        <span className="text-muted-foreground">
          {t("caseLaw.coverage.notCountedYet")}
        </span>
      );
    case "measured":
    case "stale":
      return <MeasuredCompleteness completeness={completeness} />;
    default: {
      completeness satisfies never;
      return panic("Unhandled case-law source completeness state");
    }
  }
};

/**
 * A measured source's ratio, the warranty its denominator carries, and when
 * each half of the ratio was observed.
 *
 * The two halves are observed independently, so they get their own dates. The
 * count's date is always shown, because the numerator is never live. The
 * publisher's total states its date only where it is out of date or already
 * smaller than what is held: on a current total the date is noise, on a
 * lagging one it is the explanation.
 */
const MeasuredCompleteness = ({
  completeness,
}: {
  completeness: CaseLawMeasuredCompleteness;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const counts = {
    reported: completeness.reported,
    stored: completeness.stored,
  };
  const percent = caseLawCompletenessPercent(counts);

  return (
    <div className="flex flex-col gap-0.5 leading-tight">
      <span className="tabular-nums">
        {percent === null
          ? NO_VALUE
          : format.number(percent / 100, PERCENT_FORMAT)}
      </span>
      <span className="text-muted-foreground text-xs">
        {t(CASE_LAW_TOTAL_REPORTER_LABEL_KEYS[completeness.reportedBy])}
      </span>
      <CountedOn asOf={completeness.storedAsOf} />
      {completeness.state === "stale" && (
        <ObservedOn asOf={completeness.reportedAsOf} />
      )}
      {caseLawCompletenessExceedsReported(counts) && (
        <span className="text-muted-foreground text-xs text-pretty">
          {t("caseLaw.coverage.exceedsReportedTotal", {
            date: observedDate(completeness.reportedAsOf, format),
          })}
        </span>
      )}
    </div>
  );
};

/** When the publisher's total was read, which is not when the corpus was counted. */
const ObservedOn = ({ asOf }: { asOf: string }) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <span className="text-muted-foreground text-xs">
      {t("caseLaw.coverage.totalFrom", { date: observedDate(asOf, format) })}
    </span>
  );
};

/**
 * When the corpus itself was counted. Kept apart from `ObservedOn` in wording
 * as well as in data: one date is our own sweep, the other is the publisher's
 * statement, and reading them as one number would hide a months-wide gap.
 */
const CountedOn = ({ asOf }: { asOf: string }) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <span className="text-muted-foreground block text-xs font-normal">
      {t("caseLaw.coverage.countedOn", { date: observedDate(asOf, format) })}
    </span>
  );
};

/** An observation instant as a calendar day; the hour it was read is nobody's fact. */
const observedDate = (
  value: string,
  format: ReturnType<typeof useFormatter>,
): string => {
  const date = parseDeterministicDate(value);
  return date === null ? value : format.dateTime(date, CALENDAR_DATE_FORMAT);
};

/** An instant with its time of day: when this page's figures were taken. */
const observedInstant = (
  value: string,
  format: ReturnType<typeof useFormatter>,
): string => {
  const date = parseDeterministicDate(value);
  return date === null
    ? value
    : format.dateTime(date, MEDIUM_DATE_SHORT_TIME_FORMAT);
};

type SearchableCountry = Extract<
  CaseLawCoverageCountry,
  { availability: "searchable" }
>;
type CourtRow = NonNullable<SearchableCountry["courts"]>[number];

/** Shared by the real table and its pending twin, so a column cannot drift. */
const CourtsTableHead = () => {
  const t = useTranslations();

  return (
    <TableHeader>
      <TableRow>
        <TableHead className={HEAD_CLASS} scope="col">
          {t("common.court")}
        </TableHead>
        <TableHead className={cn(HEAD_CLASS, "text-end")} scope="col">
          {t("common.decisions")}
        </TableHead>
        <TableHead className={cn(HEAD_CLASS, "text-end")} scope="col">
          {t("caseLaw.corpusStatus.newLast7Days")}
        </TableHead>
        <TableHead className={cn(HEAD_CLASS, "text-end")} scope="col">
          {t("common.lastUpdated")}
        </TableHead>
      </TableRow>
    </TableHeader>
  );
};

/**
 * The searchable index by court, under the tier headings the facet rail uses.
 * Apex courts arrive by name; the wide tiers arrive as one row each, because a
 * jurisdiction has dozens of regional courts and a list of them is not what a
 * reader came to this page for.
 *
 * A breakdown the endpoint could not read says so in the table's place. An
 * empty table would claim the index names no court.
 */
const CourtsTable = ({ courts }: { courts: SearchableCountry["courts"] }) => {
  const t = useTranslations();

  if (courts === null) {
    return (
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">
          {t("caseLaw.coverage.courtsHeading")}
        </h3>
        <p className="text-muted-foreground text-xs">
          {t("caseLaw.coverage.courtsUnavailable")}
        </p>
      </div>
    );
  }
  const byTier = groupCourtRowsByTier(courts);

  return (
    <TableBlock title={t("caseLaw.coverage.courtsHeading")}>
      <CourtsTableHead />
      {byTier.map(({ rows, tier }) => (
        <TableBody key={tier}>
          <TableRow>
            {/* `rowgroup`, not `colgroup`: the heading labels the court rows
                of its own `<tbody>`, and the table declares no column groups
                for a `colgroup` header to name. */}
            <TableHead
              className="text-muted-foreground text-2xs h-7 font-medium tracking-wide uppercase"
              colSpan={COURT_COLUMN_COUNT}
              scope="rowgroup"
            >
              {t(COURT_TIER_LABEL_KEYS[tier])}
            </TableHead>
          </TableRow>
          {rows.map((row) => (
            <CourtRowCells key={courtTierRowKey(row)} row={row} tier={tier} />
          ))}
        </TableBody>
      ))}
    </TableBlock>
  );
};

const CourtRowCells = ({ row, tier }: { row: CourtRow; tier: CourtTier }) => {
  const format = useFormatter();
  const relativeTime = useRelativeTime();
  // The row for the courts beyond the listed ones carries no activity: none
  // was read for courts the facets do not name.
  const activity = row.type === "unlisted" ? null : row;

  return (
    <TableRow>
      <TableHead
        className="text-foreground h-auto max-w-56 font-normal"
        scope="row"
      >
        <CourtRowLabel row={row} tier={tier} />
      </TableHead>
      <TableCell className="text-end tabular-nums">
        {format.number(row.decisions)}
      </TableCell>
      <TableCell className="text-end">
        <Delta value={activity === null ? null : activity.addedLastWeek} />
      </TableCell>
      <TableCell className="text-muted-foreground text-end">
        {activity === null || activity.updatedAt === null
          ? NO_VALUE
          : relativeTime(activity.updatedAt)}
      </TableCell>
    </TableRow>
  );
};
