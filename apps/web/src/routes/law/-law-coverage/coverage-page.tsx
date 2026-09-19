import { type PropsWithChildren, useId } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { ReviewStatusDot } from "@stll/ui/review-severity-dot";
import { ReviewStatusBadge } from "@stll/ui/review-status-badge";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";

import { caseLawCountryName } from "@/features/case-law/components/case-law-search";
import { CourtName } from "@/features/case-law/components/court-name";
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
import { useFormatter, useLocale } from "@/i18n/formatting-context";
import { parseDeterministicDate } from "@/lib/deterministic-date";
import {
  CALENDAR_DATE_FORMAT,
  formatFullTimestamp,
  formatRelativeTime,
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

/** The caption is the table's heading, so it sits above it rather than under. */
const CAPTION_CLASS = "caption-top mt-0 mb-2 text-start";

/** Source, status, last sync, new in seven days, completeness. */
const SOURCE_COLUMN_COUNT = 5;

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
            date: formatFullTimestamp(coverage.generatedAt),
          })}
        </p>
      </CoverageHeading>

      <dl className="flex flex-wrap gap-x-12 gap-y-4">
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

      <dl className="flex flex-wrap gap-x-12 gap-y-4">
        <Total
          hint={t("caseLaw.coverage.searchableHint")}
          label={t("caseLaw.coverage.searchable")}
        >
          <Skeleton className="h-6 w-24" />
        </Total>
        <Total
          hint={t("caseLaw.coverage.storedHint")}
          label={t("caseLaw.coverage.stored")}
        >
          <Skeleton className="h-6 w-24" />
        </Total>
      </dl>

      {PENDING_SECTION_KEYS.map((section) => (
        <section className="flex flex-col gap-4" key={section}>
          <Skeleton className="h-5 w-40" />
          <Table>
            <TableCaption className={CAPTION_CLASS}>
              {t("caseLaw.coverage.sourcesHeading")}
            </TableCaption>
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
          </Table>
        </section>
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
      <div className="flex w-full max-w-4xl flex-col gap-8 p-4">{children}</div>
    </ScrollArea>
  </main>
);

const CoverageHeading = ({ children }: PropsWithChildren) => {
  const t = useTranslations();

  return (
    <header className="flex flex-col gap-2">
      <h1 className="text-lg font-semibold text-balance">
        {t("caseLaw.coverage.title")}
      </h1>
      <p className="text-muted-foreground max-w-prose text-sm text-pretty">
        {t("caseLaw.coverage.description")}
      </p>
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
  <div className="flex flex-col gap-1">
    <dt className="text-muted-foreground text-xs">{label}</dt>
    <dd className="flex flex-col gap-0.5">
      <span className="text-xl font-semibold tabular-nums">{children}</span>
      <span className="text-muted-foreground text-xs">{hint}</span>
    </dd>
  </div>
);

/**
 * A stored count with the instant it was taken. The count is made on the
 * ingestion side, so the figure on the page is as old as its last sweep; a
 * number printed without that date invites the reader to take it for live.
 */
const StoredDecisions = ({ stored }: { stored: CaseLawStoredCount }) => {
  const format = useFormatter();

  return (
    <>
      {format.number(stored.decisions)}
      {stored.asOf !== null && <CountedOn asOf={stored.asOf} />}
    </>
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

const CountrySection = ({ country }: { country: CaseLawCoverageCountry }) => {
  const t = useTranslations();
  const format = useFormatter();
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h2 className="text-base font-medium" id={headingId}>
          {caseLawCountryName(format, country.country)}
        </h2>
        <ReviewStatusBadge
          tone={CASE_LAW_COVERAGE_AVAILABILITY_TONES[country.availability]}
        >
          {t(CASE_LAW_COVERAGE_AVAILABILITY_LABEL_KEYS[country.availability])}
        </ReviewStatusBadge>
        <HealthSignal health={country.health} />
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        {country.availability === "searchable" && (
          <Figure label={t("caseLaw.coverage.searchable")}>
            <span className="tabular-nums">
              {format.number(country.searchable)}
            </span>
          </Figure>
        )}
        <Figure label={t("caseLaw.coverage.stored")}>
          <span className="tabular-nums">
            <StoredDecisions stored={country.stored} />
          </span>
        </Figure>
        {country.availability === "searchable" && (
          <DecisionYearsFigure
            from={country.decisionYearFrom}
            to={country.decisionYearTo}
          />
        )}
        <Figure label={t("caseLaw.corpusStatus.newLast7Days")}>
          <span className="tabular-nums">
            {format.number(country.addedLastWeek, DELTA_FORMAT)}
          </span>
        </Figure>
      </dl>

      <CountryCompleteness completeness={country.completeness} />

      <SourcesTable sources={country.sources} />

      {country.availability === "searchable" && country.courts.length > 0 && (
        <CourtsTable courts={country.courts} />
      )}
    </section>
  );
};

const Figure = ({ children, label }: PropsWithChildren<{ label: string }>) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-muted-foreground text-xs">{label}</dt>
    <dd className="text-sm">{children}</dd>
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
      <bdi className="tabular-nums">
        {from === to ? fromYear : `${fromYear}–${toYear}`}
      </bdi>
    </Figure>
  );
};

/**
 * A country's completeness: the ratio, the two numbers it was computed from,
 * and a count of every source it could not be computed over.
 *
 * The counts sit beside the ratio rather than inside it. Folding an unmeasured
 * source into the percentage would make a corpus nobody has checked read
 * exactly like one that has been.
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

  return (
    <div className="border-border flex flex-col gap-1.5 border-s ps-3">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="text-muted-foreground text-xs">
          {t("caseLaw.coverage.completeness")}
        </span>
        <span className="text-sm font-medium tabular-nums">
          {percent === null
            ? NO_VALUE
            : format.number(percent / 100, PERCENT_FORMAT)}
        </span>
      </div>
      <dl className="text-muted-foreground flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <div className="flex gap-1.5">
          <dt>{t("caseLaw.coverage.stored")}</dt>
          <dd className="text-foreground tabular-nums">
            {/* Both figures are sums over the measured sources alone, so with
                none measured they are zero by construction rather than by
                observation. The ratio already withholds itself there; these
                have to withhold themselves too, or the row reads as a
                publisher stating it holds nothing. */}
            {completeness.measuredSources === 0 ? (
              NO_VALUE
            ) : (
              <StoredDecisions
                stored={{
                  decisions: completeness.stored,
                  asOf: completeness.storedAsOf,
                }}
              />
            )}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt>{t("caseLaw.coverage.publisherTotal")}</dt>
          <dd className="text-foreground tabular-nums">
            {completeness.measuredSources === 0
              ? NO_VALUE
              : format.number(completeness.reported)}
          </dd>
        </div>
      </dl>
      {notes.length > 0 && (
        <ul className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {notes.map(({ count, kind }) => (
            <li key={kind}>
              <CompletenessNote count={count} kind={kind} />
            </li>
          ))}
        </ul>
      )}
    </div>
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
        <TableHead scope="col">{t("common.source")}</TableHead>
        <TableHead scope="col">{t("common.status")}</TableHead>
        <TableHead className="text-end" scope="col">
          {t("caseLaw.coverage.lastSync")}
        </TableHead>
        <TableHead className="text-end" scope="col">
          {t("caseLaw.corpusStatus.newLast7Days")}
        </TableHead>
        <TableHead scope="col">{t("caseLaw.coverage.completeness")}</TableHead>
      </TableRow>
    </TableHeader>
  );
};

const SourcesTable = ({
  sources,
}: {
  sources: readonly CaseLawCoverageSource[];
}) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <Table>
      <TableCaption className={CAPTION_CLASS}>
        {t("caseLaw.coverage.sourcesHeading")}
      </TableCaption>
      <SourcesTableHead />
      <TableBody>
        {sources.map((source) => (
          <TableRow key={source.adapterKey}>
            <TableHead
              className="text-foreground h-auto font-normal whitespace-normal"
              scope="row"
            >
              <a
                className="underline underline-offset-2"
                href={sanitizeHref(source.publicHomeUrl)}
                rel="noreferrer"
              >
                <bdi>{source.name}</bdi>
              </a>
            </TableHead>
            <TableCell>
              <HealthSignal health={source.health} />
            </TableCell>
            <TableCell className="text-muted-foreground text-end">
              {source.lastSyncAt === null
                ? NO_VALUE
                : formatRelativeTime(source.lastSyncAt)}
            </TableCell>
            <TableCell className="text-end tabular-nums">
              {format.number(source.addedLastWeek, DELTA_FORMAT)}
            </TableCell>
            <TableCell className="whitespace-normal">
              <SourceCompleteness completeness={source.completeness} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
    <div className="flex flex-col gap-0.5">
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

type CourtRow = Extract<
  CaseLawCoverageCountry,
  { availability: "searchable" }
>["courts"][number];

/**
 * The searchable index by court, under the tier headings the facet rail uses.
 * Apex courts arrive by name; the wide tiers arrive as one row each, because a
 * jurisdiction has dozens of regional courts and a list of them is not what a
 * reader came to this page for.
 */
const CourtsTable = ({ courts }: { courts: readonly CourtRow[] }) => {
  const t = useTranslations();
  const byTier = groupCourtRowsByTier(courts);

  return (
    <Table>
      <TableCaption className={CAPTION_CLASS}>
        {t("common.decisions")}
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{t("common.court")}</TableHead>
          <TableHead className="text-end" scope="col">
            {t("common.decisions")}
          </TableHead>
          <TableHead className="text-end" scope="col">
            {t("caseLaw.corpusStatus.newLast7Days")}
          </TableHead>
          <TableHead className="text-end" scope="col">
            {t("common.lastUpdated")}
          </TableHead>
        </TableRow>
      </TableHeader>
      {byTier.map(({ rows, tier }) => (
        <TableBody key={tier}>
          <TableRow>
            {/* `rowgroup`, not `colgroup`: the heading labels the court rows
                of its own `<tbody>`, and the table declares no column groups
                for a `colgroup` header to name. */}
            <TableHead
              className="text-muted-foreground h-auto"
              colSpan={4}
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
    </Table>
  );
};

const CourtRowCells = ({ row, tier }: { row: CourtRow; tier: CourtTier }) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <TableRow>
      <TableHead
        className="text-foreground h-auto max-w-56 font-normal"
        scope="row"
      >
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
      </TableHead>
      <TableCell className="text-end tabular-nums">
        {format.number(row.decisions)}
      </TableCell>
      <TableCell className="text-end tabular-nums">
        {format.number(row.addedLastWeek, DELTA_FORMAT)}
      </TableCell>
      <TableCell className="text-muted-foreground text-end">
        {row.updatedAt === null ? NO_VALUE : formatRelativeTime(row.updatedAt)}
      </TableCell>
    </TableRow>
  );
};
