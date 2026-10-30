import {
  type PropsWithChildren,
  type ReactNode,
  type Ref,
  useCallback,
  useId,
  useState,
} from "react";

import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import type { CaseLawJurisdiction } from "@stll/api-contract/case-law-jurisdictions";
import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ChevronRightIcon } from "@stll/ui/icons";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { cn } from "@stll/ui/utils";

import {
  caseLawCoverageAnchor,
  toCaseLawCountryParam,
} from "@/features/case-law/case-law-jurisdiction";
import { CaseLawHealthSignal } from "@/features/case-law/components/case-law-health-signal";
import { caseLawCompletenessPercent } from "@/features/case-law/coverage-completeness";
import {
  useFormatter,
  useFormattingLocale,
  useRelativeTime,
} from "@/i18n/formatting-context";
import { caseLawCountryName } from "@/lib/case-law-route";
import { detached } from "@/lib/detached";
import { parseDeterministicDate } from "@/lib/deterministic-date";
import {
  CALENDAR_DATE_FORMAT,
  MEDIUM_DATE_SHORT_TIME_FORMAT,
} from "@/lib/relative-time";
import {
  CASE_LAW_COVERAGE_AVAILABILITY_LABEL_KEYS,
  CASE_LAW_COVERAGE_AVAILABILITY_TONES,
  type CaseLawCoverageCountry,
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
const HEAD_CLASS = "h-8 text-xs whitespace-normal leading-snug wrap-break-word";

/**
 * Source, decisions, new in seven days, completeness.
 * Fixed widths, shared by every country's table: sized to their own content,
 * the same column would sit at a different place under each country and the
 * eye would have to find it again.
 */
const SOURCE_COLUMNS = [
  { key: "source", width: "40%" },
  { key: "decisions", width: "28%" },
  { key: "newLastWeek", width: "16%" },
  { key: "completeness", width: "16%" },
] as const satisfies readonly TableColumn[];

const SOURCE_COLUMN_COUNT = SOURCE_COLUMNS.length;

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

const COUNTRY_NAVIGATION_HEIGHT = "--coverage-country-navigation-height";

// A callback ref publishes geometry before country refs perform their hash scroll.
const measureCountryNavigation = (node: HTMLElement | null) => {
  if (node === null) {
    return undefined;
  }
  const container = node.parentElement;
  if (container === null) {
    panic("Country navigation requires a coverage container");
  }
  const measure = () => {
    container.style.setProperty(
      COUNTRY_NAVIGATION_HEIGHT,
      `${node.getBoundingClientRect().height}px`,
    );
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(node);
  return () => {
    observer.disconnect();
    container.style.removeProperty(COUNTRY_NAVIGATION_HEIGHT);
  };
};

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
  const locale = useFormattingLocale();
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const [collapsed, setCollapsed] = useState<ReadonlySet<CaseLawJurisdiction>>(
    new Set(),
  );
  const expandCountry = useCallback((country: CaseLawJurisdiction) => {
    setCollapsed((previous) => {
      if (!previous.has(country)) {
        return previous;
      }
      const next = new Set(previous);
      next.delete(country);
      return next;
    });
  }, []);

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
        <p className="text-muted-foreground text-xs wrap-break-word">
          {t("caseLaw.coverage.generatedAt", {
            date: observedInstant(coverage.generatedAt, format),
          })}
        </p>
      </CoverageHeading>

      <Hero>
        <div className="flex flex-col gap-5">
          <div>
            <Headline>
              {coverage.totals.searchable === null
                ? NO_VALUE
                : format.number(coverage.totals.searchable)}
            </Headline>
            <p className="text-muted-foreground mt-2 text-sm">
              {t("caseLaw.coverage.decisionsAcross", {
                count: countries.filter(
                  (country) => country.availability === "searchable",
                ).length,
              })}
            </p>
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-3">
            <HeaderFigure label={t("caseLaw.corpusStatus.newLast7Days")}>
              <Delta value={coverage.totals.addedLastWeek} />
            </HeaderFigure>
            <HeaderFigure label={t("caseLaw.coverage.sourcesCurrent")}>
              {t("common.stepProgress", {
                current: format.number(
                  countries
                    .flatMap((country) => country.sources)
                    .filter((source) => source.health === "current").length,
                ),
                total: format.number(
                  countries.flatMap((country) => country.sources).length,
                ),
              })}
            </HeaderFigure>
          </div>
        </div>
        <CoverageLegend countries={coverage.countries} />
      </Hero>

      <nav
        ref={measureCountryNavigation}
        aria-label={t("caseLaw.coverage.countryNavigation")}
        className="bg-background sticky top-0 z-10 border-b py-2"
      >
        <select
          aria-label={t("caseLaw.coverage.countryNavigation")}
          className="bg-background focus-visible:ring-ring min-h-11 w-full rounded-md border px-3 text-sm focus-visible:ring-2 sm:hidden"
          value={
            countries.some(
              (country) => caseLawCoverageAnchor(country.country) === hash,
            )
              ? hash
              : ""
          }
          onChange={(event) => {
            const country = countries.find(
              (candidate) =>
                caseLawCoverageAnchor(candidate.country) ===
                event.currentTarget.value,
            );
            if (country === undefined) {
              return;
            }
            expandCountry(country.country);
            detached(
              navigate({
                to: "/law/coverage",
                hash: caseLawCoverageAnchor(country.country),
              }),
              "law-coverage.navigate-country",
            );
          }}
        >
          <option value="" disabled>
            {t("caseLaw.coverage.countryNavigation")}
          </option>
          {countries.map((country) => (
            <option
              value={caseLawCoverageAnchor(country.country)}
              key={country.country}
            >
              {caseLawCountryName(format, country.country)}
            </option>
          ))}
        </select>
        <div className="hidden flex-wrap gap-x-1 sm:flex">
          {countries.map((country) => (
            <Link
              className="hover:bg-muted focus-visible:ring-ring inline-flex min-h-11 items-center rounded-md px-3 text-sm focus-visible:ring-2"
              hash={caseLawCoverageAnchor(country.country)}
              key={country.country}
              onClick={() => expandCountry(country.country)}
              to="/law/coverage"
            >
              {caseLawCountryName(format, country.country)}
            </Link>
          ))}
        </div>
      </nav>
      {countries.map((country) => (
        <CountrySection
          country={country}
          expanded={!collapsed.has(country.country)}
          onExpand={expandCountry}
          onToggle={() =>
            setCollapsed((previous) => {
              const next = new Set(previous);
              if (next.has(country.country)) {
                next.delete(country.country);
              } else {
                next.add(country.country);
              }
              return next;
            })
          }
          key={country.country}
        />
      ))}
    </CoverageLayout>
  );
};

/**
 * The page's own chrome while the figures are in flight. The title and the
 * lead read immediately; only the numbers and the rows shimmer, so the layout
 * the reader lands on is the one that stays.
 */
export const CaseLawCoveragePending = () => (
  <CoverageLayout>
    <CoverageHeading>
      <Skeleton className="h-3 w-48" />
    </CoverageHeading>

    <Hero>
      <div className="flex flex-col gap-4">
        <Headline>
          <Skeleton className="h-16 w-64" />
        </Headline>
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-4 w-72" />
      </div>

      <div className="flex flex-col gap-2">
        {PENDING_ROW_KEYS.map((row) => (
          <Skeleton className="h-4 w-44" key={row} />
        ))}
      </div>
    </Hero>

    <div className="flex gap-3 border-b py-2">
      {PENDING_ROW_KEYS.map((row) => (
        <Skeleton className="h-11 w-24" key={row} />
      ))}
    </div>
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
      </CountryCard>
    ))}
  </CoverageLayout>
);

// The shell bounds the page's height, so the content scrolls inside it rather
// than moving the document. `ScrollArea` owns that scrollbar: a raw overflow
// utility would hand it to the platform and put a macOS overlay bar beside a
// Windows gutter in the same shell.
const CoverageLayout = ({ children }: PropsWithChildren) => (
  <main className="flex min-h-0 flex-1 flex-col">
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-3 sm:p-6">
        {children}
      </div>
    </ScrollArea>
  </main>
);

const CoverageHeading = ({ children }: PropsWithChildren) => {
  const t = useTranslations();

  return (
    <header className="flex flex-wrap items-baseline justify-between gap-2">
      <h1 className="text-lg font-semibold">{t("caseLaw.coverage.title")}</h1>
      {children}
    </header>
  );
};

const COLOR_BY_JURISDICTION = {
  AUT: "var(--chart-1)",
  CZE: "var(--chart-2)",
  EU: "var(--chart-3)",
  GBR: "var(--chart-4)",
  HUN: "var(--chart-5)",
  POL: "var(--chart-6)",
  SVK: "var(--chart-7)",
  USA: "var(--chart-8)",
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

const Hero = ({ children }: PropsWithChildren) => (
  <div className="grid items-center gap-6 py-2 md:grid-cols-2">{children}</div>
);

const CoverageLegend = ({
  countries,
}: {
  countries: readonly CaseLawCoverageCountry[];
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const count = (country: CaseLawCoverageCountry) =>
    country.availability === "searchable" ? country.searchable : 0;
  const ordered = countries.toSorted((a, b) => count(b) - count(a));
  const maximum = Math.max(1, ...ordered.map(count));
  return (
    <ul className="flex flex-col gap-3 text-sm">
      {ordered.map((country) => (
        <li
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5"
          key={country.country}
        >
          <span className="font-medium">
            <CountryLink country={country}>
              {caseLawCountryName(format, country.country)}
            </CountryLink>
          </span>
          <span className="text-muted-foreground tabular-nums">
            {country.availability === "searchable"
              ? format.number(country.searchable)
              : t("caseLaw.coverage.inPreparation")}
          </span>
          <span
            aria-hidden="true"
            className="bg-muted col-span-2 h-1 overflow-hidden rounded-full"
          >
            <span
              className="block h-full rounded-full"
              style={{
                width: `${(count(country) / maximum) * 100}%`,
                backgroundColor: COLOR_BY_JURISDICTION[country.country],
              }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
};

const Headline = ({ children }: PropsWithChildren) => (
  <div className="text-5xl font-semibold tracking-tight tabular-nums sm:text-6xl">
    {children}
  </div>
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

type CountryCardProps = PropsWithChildren<{
  /** The section's fragment, so a link from elsewhere can land on one country. */
  anchor?: string;
  header: ReactNode;
  headingId?: string;
  expanded?: boolean;
  contentId?: string;
  ref?: Ref<HTMLElement>;
}>;

/**
 * One country, with its name and state above the source and court rows.
 */
const CountryCard = ({
  anchor,
  children,
  header,
  headingId,
  expanded = true,
  contentId,
  ref,
}: CountryCardProps) => (
  <section
    aria-labelledby={headingId}
    className="bg-background flex flex-col rounded-xl border shadow-xs/5"
    id={anchor}
    style={{ scrollMarginTop: `var(${COUNTRY_NAVIGATION_HEIGHT})` }}
    ref={ref}
  >
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
      {header}
    </header>
    <div hidden={!expanded} id={contentId} className="px-1 py-2 sm:px-3">
      {children}
    </div>
  </section>
);

type CountrySectionProps = {
  country: CaseLawCoverageCountry;
  expanded: boolean;
  onExpand: (country: CaseLawJurisdiction) => void;
  onToggle: () => void;
};
const CountrySection = ({
  country,
  expanded,
  onExpand,
  onToggle,
}: CountrySectionProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const headingId = useId();
  const contentId = useId();
  const anchor = caseLawCoverageAnchor(country.country);
  const isTarget = useLocation({ select: ({ hash }) => hash === anchor });
  // The figures arrive after the navigation, so the router's own hash scroll
  // finds no section yet: the section a link named brings itself into view
  // when it mounts. Stable per target, so a background refetch that
  // re-renders the page does not pull the reader back.
  const scrollIntoViewOnArrival = useCallback(
    (node: HTMLElement | null) => {
      if (isTarget && node !== null) {
        onExpand(country.country);
        node.scrollIntoView({ block: "start" });
      }
    },
    [isTarget, onExpand, country.country],
  );

  return (
    <CountryCard
      anchor={anchor}
      expanded={expanded}
      contentId={contentId}
      ref={scrollIntoViewOnArrival}
      header={
        <>
          <Button
            aria-controls={contentId}
            aria-expanded={expanded}
            aria-labelledby={headingId}
            onClick={onToggle}
            tooltip={caseLawCountryName(format, country.country)}
            size="icon"
            variant="ghost"
          >
            <DirectionalIcon
              icon={ChevronRightIcon}
              flip={!expanded}
              className={cn(expanded && "rotate-90")}
            />
          </Button>
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
          {country.availability === "searchable" && (
            <HeaderFigure label={t("caseLaw.coverage.searchable")}>
              <span className="tabular-nums">
                {format.number(country.searchable)}
              </span>
            </HeaderFigure>
          )}
          {country.availability === "searchable" && (
            <DecisionYearsFigure
              from={country.decisionYearFrom}
              to={country.decisionYearTo}
            />
          )}
          <CountryFreshness sources={country.sources} />
        </>
      }
      headingId={headingId}
    >
      <SourcesTable sources={country.sources} />
    </CountryCard>
  );
};

const CountryFreshness = ({
  sources,
}: {
  sources: readonly CaseLawCoverageSource[];
}) => {
  const t = useTranslations();
  const relativeTime = useRelativeTime();
  const exceptions = sources.filter(
    (source) => source.health !== "current",
  ).length;
  // The oldest source is the freshness of the entire group; a never-run source has no sync time.
  const oldest = sources.some((source) => source.lastSyncAt === null)
    ? null
    : sources
        .map((source) => source.lastSyncAt)
        .filter((value) => value !== null)
        .toSorted()
        .at(0);
  return (
    <span className="text-muted-foreground basis-full text-sm sm:ms-auto sm:basis-auto">
      {exceptions === 0
        ? t("caseLaw.coverage.allCurrent")
        : t("caseLaw.coverage.sourceExceptions", { count: exceptions })}
      {oldest && (
        <> · {t("caseLaw.coverage.syncedAt", { time: relativeTime(oldest) })}</>
      )}
    </span>
  );
};

/**
 * A figure on the card's rim, beside the name: the sources' rows below carry
 * each one's health, so the rim states only the country's totals.
 */
const HeaderFigure = ({
  children,
  label,
}: PropsWithChildren<{ label: string }>) => (
  <span className="inline-flex items-baseline gap-1.5 text-sm">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-medium tabular-nums">{children}</span>
  </span>
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
    <HeaderFigure label={t("caseLaw.coverage.decisionYears")}>
      <bdi className="tabular-nums">
        {from === to ? fromYear : `${fromYear}–${toYear}`}
      </bdi>
    </HeaderFigure>
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
        <TableHead className={cn(HEAD_CLASS, "text-end")} scope="col">
          {t("common.decisions")}
        </TableHead>
        <TableHead className={cn(HEAD_CLASS, "text-end")} scope="col">
          {t("caseLaw.corpusStatus.newLast7Days")}
        </TableHead>
        <TableHead className={HEAD_CLASS} scope="col">
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="focus-visible:ring-ring min-h-11 max-w-full whitespace-normal underline decoration-dotted underline-offset-4 focus-visible:ring-2"
                />
              }
            >
              {t("caseLaw.coverage.completeness")}
            </TooltipTrigger>
            <TooltipPopup>
              {t("caseLaw.coverage.completenessHelp")}
            </TooltipPopup>
          </Tooltip>
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
  const t = useTranslations();

  return (
    // No heading above it, so the table names itself for a screen reader.
    <Table aria-label={t("common.source")} className={TABLE_CLASS}>
      <TableColumns columns={SOURCE_COLUMNS} />
      <SourcesTableHead />
      {sources.map((source) => (
        <SourceRows key={source.adapterKey} source={source} />
      ))}
    </Table>
  );
};

const SourceRows = ({ source }: { source: CaseLawCoverageSource }) => {
  const t = useTranslations();
  const format = useFormatter();
  const [expanded, setExpanded] = useState(false);
  const courtsId = useId();
  const toggleId = useId();
  const sourceNameId = useId();

  return (
    <>
      <TableBody>
        <TableRow>
          <TableHead
            className={"text-foreground h-auto font-normal whitespace-normal"}
            scope="row"
          >
            <Button
              aria-expanded={expanded}
              aria-controls={courtsId}
              aria-label={t("common.court")}
              aria-labelledby={`${toggleId} ${sourceNameId}`}
              id={toggleId}
              className="me-1"
              onClick={() => setExpanded((value) => !value)}
              size="icon"
              variant="ghost"
            >
              <DirectionalIcon
                icon={ChevronRightIcon}
                flip={!expanded}
                className={cn(expanded && "rotate-90")}
              />
            </Button>
            <a
              className="decoration-border underline underline-offset-2 hover:decoration-current"
              href={sanitizeHref(source.publicHomeUrl)}
              id={sourceNameId}
              rel="noreferrer"
            >
              <bdi>{source.name}</bdi>
            </a>
            {source.health !== "current" && (
              <div className="mt-1 ps-1 text-xs">
                <CaseLawHealthSignal health={source.health} />
              </div>
            )}
          </TableHead>
          <TableCell className="text-end tabular-nums">
            {format.number(source.publishedDecisions)}
          </TableCell>
          <TableCell className={"text-end"}>
            <Delta value={source.addedLastWeek} />
          </TableCell>
          <TableCell className={"whitespace-normal"}>
            <SourceCompleteness completeness={source.completeness} />
          </TableCell>
        </TableRow>
      </TableBody>
      <TableBody hidden={!expanded} id={courtsId}>
        {source.courts.map((row) => (
          <TableRow key={row.court ?? "other-courts"}>
            <TableHead className="font-normal whitespace-normal" scope="row">
              <span className="ps-8">
                {row.court ?? t("caseLaw.corpusStatus.otherCourts")}
              </span>
            </TableHead>
            <TableCell className="text-end tabular-nums">
              {format.number(row.decisions)}
            </TableCell>
            <TableCell colSpan={SOURCE_COLUMN_COUNT - 2} />
          </TableRow>
        ))}
      </TableBody>
    </>
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
        <span className="text-muted-foreground text-xs wrap-break-word">
          {t("caseLaw.coverage.notMeasuredYet")}
        </span>
      );
    case "not-counted-yet":
      return (
        <span className="text-muted-foreground text-xs wrap-break-word">
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
 * A measured source's ratio and the warranty its denominator carries.
 *
 * The count's own date is not repeated on every row: the page states once,
 * at the top, when its figures were taken. The publisher's total states its
 * date only where it is out of date: on a current total the date is noise, on
 * a lagging one it is the explanation.
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
    <div className="flex flex-col gap-1">
      {percent === null ? (
        <span className="text-muted-foreground">{NO_VALUE}</span>
      ) : (
        <span
          role="meter"
          aria-label={t("caseLaw.coverage.completeness")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={format.number(percent / 100, PERCENT_FORMAT)}
          className="bg-muted block h-1.5 w-full overflow-hidden rounded-full"
        >
          <span
            className="bg-foreground-muted block h-full rounded-full"
            style={{ width: `${percent}%` }}
          />
        </span>
      )}
      {completeness.state === "stale" && (
        <ObservedOn asOf={completeness.reportedAsOf} />
      )}
    </div>
  );
};

/** When the publisher's total was read, which is not when the corpus was counted. */
const ObservedOn = ({ asOf }: { asOf: string }) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <span className="text-muted-foreground text-xs wrap-break-word">
      {t("caseLaw.coverage.totalFrom", { date: observedDate(asOf, format) })}
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
