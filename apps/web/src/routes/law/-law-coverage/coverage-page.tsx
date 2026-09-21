import { type PropsWithChildren, type ReactNode, useId } from "react";

import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
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

import { Globe, type GlobeMarker } from "@/components/globe";
import { toCaseLawCountryParam } from "@/features/case-law/case-law-jurisdiction";
import { caseLawCountryName } from "@/features/case-law/components/case-law-search";
import { CourtRowLabel } from "@/features/case-law/components/court-row-label";
import { courtTierRowKey } from "@/features/case-law/court-tier-rows.logic";
import {
  caseLawCompletenessExceedsReported,
  caseLawCompletenessPercent,
} from "@/features/case-law/coverage-completeness";
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
  CASE_LAW_COVERAGE_AVAILABILITY_LABEL_KEYS,
  CASE_LAW_COVERAGE_AVAILABILITY_TONES,
  CASE_LAW_COVERAGE_HEALTH_LABEL_KEYS,
  CASE_LAW_COVERAGE_HEALTH_TONES,
  CASE_LAW_TOTAL_REPORTER_LABEL_KEYS,
  type CaseLawCoverageCountry,
  type CaseLawCoverageHealth,
  type CaseLawCoverageResponse,
  type CaseLawCoverageSource,
  type CaseLawMeasuredCompleteness,
  type CaseLawSourceCompleteness,
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

/**
 * Source, status, last sync, new in seven days, completeness. Fixed widths,
 * shared by every country's table: sized to their own content, the same
 * column would sit at a different place under each country and the eye
 * would have to find it again.
 */
const SOURCE_COLUMNS = [
  { key: "source", width: "40%" },
  { key: "status", width: "14%" },
  { key: "lastSync", width: "16%" },
  { key: "newLastWeek", width: "14%" },
  { key: "completeness", width: "16%" },
] as const satisfies readonly TableColumn[];

/** Court, decisions, new in seven days, last updated. */
const COURT_COLUMNS = [
  { key: "court", width: "46%" },
  { key: "decisions", width: "18%" },
  { key: "newLastWeek", width: "18%" },
  { key: "lastUpdated", width: "18%" },
] as const satisfies readonly TableColumn[];

const SOURCE_COLUMN_COUNT = SOURCE_COLUMNS.length;
const COURT_COLUMN_COUNT = COURT_COLUMNS.length;

/** The fixed column layout every table on the page shares. */
const TABLE_CLASS = "table-fixed";

type TableColumn = { key: string; width: string };

/** The columns' widths, declared once for the real table and its pending twin. */
const TableColumns = ({ columns }: { columns: readonly TableColumn[] }) => (
  <colgroup>
    {columns.map(({ key, width }) => (
      <col key={key} style={{ width }} />
    ))}
  </colgroup>
);

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

      <Hero>
        <Headline>{format.number(coverage.totals.searchable)}</Headline>
        <CoverageGlobe
          countries={coverage.countries}
          total={coverage.totals.searchable}
        />
      </Hero>

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

      <Hero>
        <Headline>
          <Skeleton className="h-16 w-80" />
        </Headline>
        <Skeleton
          className="rounded-full"
          style={{ width: GLOBE_SIZE, height: GLOBE_SIZE }}
        />
        <div className="flex flex-col gap-2">
          {PENDING_ROW_KEYS.map((row) => (
            <Skeleton className="h-4 w-44" key={row} />
          ))}
        </div>
      </Hero>

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
          <Table className={TABLE_CLASS}>
            <TableColumns columns={SOURCE_COLUMNS} />
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
          <TableBlock title={t("caseLaw.coverage.courtsHeading")}>
            <TableColumns columns={COURT_COLUMNS} />
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
    // The breadcrumb names the page, so the heading is for the document
    // outline and a screen reader; what shows is when the figures were taken.
    <header className="flex justify-end">
      <h1 className="sr-only">{t("caseLaw.coverage.title")}</h1>
      {children}
    </header>
  );
};

/** The disc's side, beside the legend and the number. */
const GLOBE_SIZE = 280;

/** Zoomed on Central Europe; the disc clip hides the cropped rim. */
const GLOBE_SCALE = 1.6;

/** The longitude the sphere holds, so every capital faces the reader. */
const EUROPE_LONGITUDE = 17;

/** Leaned so Central Europe sits at the centre of the disc. */
const EUROPE_TILT = 0.85;

/** One pin per capital; the legend beside the globe carries the figures. */
const CAPITAL_MARKER_SIZE = 0.05;

/**
 * Each case-law jurisdiction's capital, or the seat of its court, on the
 * globe. Total over the jurisdictions, so a new one has to be placed here
 * before this compiles and cannot arrive unpinned.
 */
const CAPITAL_BY_JURISDICTION = {
  AUT: [48.21, 16.37],
  CZE: [50.08, 14.44],
  EU: [49.62, 6.13],
  HUN: [47.5, 19.04],
  POL: [52.23, 21.01],
  SVK: [48.15, 17.11],
} as const satisfies Record<CaseLawJurisdiction, readonly [number, number]>;

/**
 * Each jurisdiction's colour, on the pin and in the legend, taken from its
 * flag: the EU's blue, the Czech red, the Slovak blue, the Hungarian green,
 * the Polish and Austrian reds. Flags in this region are red, white and blue,
 * so the reds cannot be told apart by colour alone; the legend's names and
 * the capitals' places on the sphere carry the identity where the hue does
 * not. Fixed per jurisdiction, so a country keeps its colour when another
 * arrives.
 */
const COLOR_BY_JURISDICTION = {
  AUT: "#ed2939",
  CZE: "#d7141a",
  EU: "#003399",
  HUN: "#477050",
  POL: "#dc143c",
  SVK: "#0b4ea2",
} as const satisfies Record<CaseLawJurisdiction, string>;

/**
 * A country's name as the way into its case list, where a search can reach
 * it; a country in preparation has no list to open, so its name stays text.
 */
const CountryLink = ({
  children,
  country,
}: {
  /** The name alone: a string, so returning it as is returns no promise. */
  children: string;
  country: CaseLawCoverageCountry;
}) => {
  if (country.availability !== "searchable") {
    return children;
  }
  return (
    <Link
      className="decoration-border underline underline-offset-2 hover:decoration-current"
      search={{ country: toCaseLawCountryParam(country.country) }}
      to="/law/cases"
    >
      {children}
    </Link>
  );
};

/** The number, the globe and its legend in one row; nothing wraps under the globe. */
const Hero = ({ children }: PropsWithChildren) => (
  <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-x-10 gap-y-4">
    {children}
  </div>
);

/**
 * Where the corpus holds case law: a pin on each capital, and beside the
 * globe a legend naming each country with, where a search can find it, its
 * count and share of everything searchable. The figures sit in the legend
 * rather than on the pins: the capitals lie a few hundred kilometres apart,
 * so labels on the sphere land on top of one another.
 */
const CoverageGlobe = ({
  countries,
  total,
}: {
  countries: readonly CaseLawCoverageCountry[];
  total: number;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const markers = countries.map((country): GlobeMarker => ({
    color: COLOR_BY_JURISDICTION[country.country],
    location: [...CAPITAL_BY_JURISDICTION[country.country]],
    size: CAPITAL_MARKER_SIZE,
  }));

  return (
    <>
      <Globe
        className="overflow-hidden rounded-full"
        focusLongitude={EUROPE_LONGITUDE}
        label={t("caseLaw.coverage.globeLabel")}
        markers={markers}
        scale={GLOBE_SCALE}
        size={GLOBE_SIZE}
        tilt={EUROPE_TILT}
      />
      <ul className="flex flex-col gap-1.5 text-sm">
        {countries.map((country) => (
          <li className="flex items-baseline gap-2" key={country.country}>
            <span
              aria-hidden="true"
              className="size-2 shrink-0 self-center rounded-full"
              style={{
                backgroundColor: COLOR_BY_JURISDICTION[country.country],
              }}
            />
            <span className="font-medium">
              <CountryLink country={country}>
                {caseLawCountryName(format, country.country)}
              </CountryLink>
            </span>
            {country.availability === "searchable" ? (
              <span className="text-muted-foreground tabular-nums">
                {format.number(country.searchable)}
                {total > 0 && (
                  <>
                    {" · "}
                    {format.number(country.searchable / total, PERCENT_FORMAT)}
                  </>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground">
                {t("caseLaw.coverage.inPreparation")}
              </span>
            )}
          </li>
        ))}
      </ul>
    </>
  );
};

/**
 * The one number the page is about: decisions a search can find. The title
 * says what the page covers, so the number carries no caption. What is held
 * but not yet searchable stays with the source it belongs to, in the
 * completeness column; summed here it would compete with this figure and
 * overlap it.
 */
const Headline = ({ children }: PropsWithChildren) => (
  <p className="text-7xl font-semibold tracking-tight tabular-nums">
    {children}
  </p>
);

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
  title: string;
}>;

/** A table under its own heading, outside the caption the primitive owns. */
const TableBlock = ({ children, title }: TableBlockProps) => {
  const headingId = useId();

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium" id={headingId}>
        {title}
      </h3>
      <Table aria-labelledby={headingId} className={TABLE_CLASS}>
        {children}
      </Table>
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
            <CountryLink country={country}>
              {caseLawCountryName(format, country.country)}
            </CountryLink>
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
          </dl>
        </>
      }
      headingId={headingId}
    >
      <SourcesTable sources={country.sources} />
      {country.availability === "searchable" && (
        <CourtsTable country={country.country} courts={country.courts} />
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
  sources,
}: {
  sources: readonly CaseLawCoverageSource[];
}) => {
  const relativeTime = useRelativeTime();

  return (
    <Table className={TABLE_CLASS}>
      <TableColumns columns={SOURCE_COLUMNS} />
      <SourcesTableHead />
      <TableBody>
        {sources.map((source) => (
          <TableRow key={source.adapterKey}>
            <TableHead
              className={"text-foreground h-auto font-normal whitespace-normal"}
              scope="row"
            >
              <a
                className="decoration-border underline underline-offset-2 hover:decoration-current"
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
 * The searchable index by court, in the order the API ranks them: apex courts
 * by name, the wide tiers as one row each naming their tier, and the courts
 * beyond the listed ones as the closing row. No heading rows between them: a
 * dozen rows read better as one list than as four lists of three.
 *
 * A breakdown the endpoint could not read says so in the table's place. An
 * empty table would claim the index names no court.
 */
const CourtsTable = ({
  country,
  courts,
}: {
  country: CaseLawJurisdiction;
  courts: SearchableCountry["courts"];
}) => {
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
  return (
    <TableBlock title={t("caseLaw.coverage.courtsHeading")}>
      <TableColumns columns={COURT_COLUMNS} />
      <CourtsTableHead />
      <TableBody>
        {courts.map((row) => (
          <CourtRowCells
            country={country}
            key={courtTierRowKey(row)}
            row={row}
          />
        ))}
      </TableBody>
    </TableBlock>
  );
};

const CourtRowCells = ({
  country,
  row,
}: {
  country: CaseLawJurisdiction;
  row: CourtRow;
}) => {
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
        {row.type === "court" ? (
          <Link
            className="decoration-border underline underline-offset-2 hover:decoration-current"
            search={{
              country: toCaseLawCountryParam(country),
              court: row.court,
            }}
            to="/law/cases"
          >
            <CourtRowLabel row={row} />
          </Link>
        ) : (
          <CourtRowLabel row={row} />
        )}
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
