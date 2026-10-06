import { useId, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { DirectionProvider } from "@base-ui/react/direction-provider";
import { panic } from "better-result";
import {
  IntlProvider,
  useFormatter,
  useLocale,
  useTranslations,
} from "use-intl";

import { normalizeStringList } from "@stll/agent-input";
import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import { Button } from "@stll/ui/button";
import { CourtBadge } from "@stll/ui/court-badge";
import { DatePickerPopover } from "@stll/ui/date-picker-popover";
import { Field, FieldLabel } from "@stll/ui/field";
import {
  CaseLawIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  SearchIcon,
} from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
} from "@stll/ui/pagination";
import {
  PreviewCard,
  PreviewCardPopup,
  PreviewCardTrigger,
} from "@stll/ui/preview-card";
import { SearchField } from "@stll/ui/search-field";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Skeleton } from "@stll/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";
import {
  Tooltip,
  TooltipPopup,
  TooltipProvider,
  TooltipTrigger,
} from "@stll/ui/tooltip";

import { CASE_LAW_RESULTS_APP } from "../manifest";
import { createPresentationBridge } from "../shared/bridge";
import { appLocale } from "../shared/locale";
import { filterDefaults, searchFilterInput, sortResultRows } from "./model";
import type {
  CaseLawView,
  CourtSelection,
  ResultRow,
  ResultSort,
} from "./model";
import { createCaseLawParser } from "./parse";
import "../shared/generated/style.css";

const caseLawBridge = createPresentationBridge({
  manifest: CASE_LAW_RESULTS_APP,
  parse: createCaseLawParser(),
});
type CaseLawBridge = typeof caseLawBridge;
type SearchPage = Extract<CaseLawView, { type: "search" }>;

const ResultsTable = ({
  rows,
  bridge,
}: {
  rows: readonly ResultRow[];
  bridge: CaseLawBridge;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  if (rows.length === 0) {
    return (
      <div
        className="bg-muted/40 flex flex-col items-center gap-3 rounded-xl px-6 py-12 text-center"
        role="status"
      >
        <SearchIcon className="text-muted-foreground size-6" />
        <p className="font-medium">{t("noResults")}</p>
      </div>
    );
  }
  return (
    <Table className="table-fixed">
      <TableHeader className="max-[480px]:hidden">
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-72 ps-4">{t("reference")}</TableHead>
          <TableHead>{t("summary")}</TableHead>
          <TableHead className="w-28 whitespace-nowrap">{t("date")}</TableHead>
          <TableHead className="w-12">
            <span className="sr-only">{t("open")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {[...new Map(rows.map((row) => [row.decisionId, row])).values()].map(
          (row) => {
            const url = row.appUrl ?? row.url;
            const open = () => {
              if (url !== null) {
                bridge.detached(bridge.openLink(url), "open case-law decision");
              }
            };
            return (
              <TableRow
                key={row.decisionId}
                className="max-[480px]:flex max-[480px]:flex-wrap"
              >
                <TableCell className="py-3 ps-4 max-[480px]:w-full">
                  <div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
                    {row.courtAbbreviation !== null && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span className="inline-flex min-w-8 shrink-0" />
                          }
                        >
                          <CourtBadge
                            abbreviation={row.courtAbbreviation}
                            weight="outline"
                          />
                        </TooltipTrigger>
                        <TooltipPopup>{row.court}</TooltipPopup>
                      </Tooltip>
                    )}
                    <PreviewCard>
                      <PreviewCardTrigger
                        render={
                          <Button
                            type="button"
                            variant="link"
                            className="h-auto min-w-0 p-0 text-start font-semibold tabular-nums"
                            onClick={open}
                          />
                        }
                      >
                        <bdi className="truncate" title={row.caseNumber}>
                          {row.caseNumber}
                        </bdi>
                      </PreviewCardTrigger>
                      <PreviewCardPopup align="start" className="w-80 flex-col">
                        <p className="font-semibold">
                          <bdi>{row.caseNumber}</bdi>
                        </p>
                        <p className="text-muted-foreground text-xs">
                          {row.court}
                        </p>
                        {row.snippet !== null && (
                          <p className="text-sm leading-relaxed">
                            {row.snippet}
                          </p>
                        )}
                        {row.ecli !== null && (
                          <Input
                            readOnly
                            value={row.ecli}
                            aria-label={`${t("copy")} ECLI`}
                            className="font-mono text-xs"
                            onFocus={(event) => event.currentTarget.select()}
                          />
                        )}
                        {url !== null && (
                          <Button variant="outline" size="sm" onClick={open}>
                            {t("open")}
                            <ExternalLinkIcon />
                          </Button>
                        )}
                      </PreviewCardPopup>
                    </PreviewCard>
                  </div>
                </TableCell>
                <TableCell className="py-3 max-[480px]:order-last max-[480px]:w-full max-[480px]:pt-0">
                  {row.snippet !== null && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <p className="snippet text-muted-foreground truncate text-sm" />
                        }
                      >
                        {row.snippet}
                      </TooltipTrigger>
                      <TooltipPopup className="max-w-lg">
                        {row.snippet}
                      </TooltipPopup>
                    </Tooltip>
                  )}
                </TableCell>
                <TableCell className="py-3 text-xs whitespace-nowrap tabular-nums max-[480px]:ps-4">
                  {row.decisionDate !== null && (
                    <bdi>
                      {format.dateTime(new Date(row.decisionDate), {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                        timeZone: "UTC",
                      })}
                    </bdi>
                  )}
                </TableCell>
                <TableCell className="py-2 max-[480px]:ms-auto">
                  {url !== null && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("open")}
                            onClick={open}
                          />
                        }
                      >
                        <ExternalLinkIcon />
                      </TooltipTrigger>
                      <TooltipPopup>{t("open")}</TooltipPopup>
                    </Tooltip>
                  )}
                </TableCell>
              </TableRow>
            );
          },
        )}
      </TableBody>
    </Table>
  );
};

type SearchControlsProps = {
  bridge: CaseLawBridge;
  page: SearchPage;
  input: Record<string, unknown>;
  defaults: Extract<ReturnType<typeof filterDefaults>, { status: "ready" }>;
};
const SearchControls = ({
  bridge,
  page,
  input,
  defaults,
}: SearchControlsProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const fromId = useId();
  const toId = useId();
  const initialQueries = normalizeStringList(input["queries"], {
    split: "never",
  });
  const [query, setQuery] = useState(
    initialQueries.ok ? initialQueries.value.join(" ") : "",
  );
  const [country, setCountry] = useState(defaults.country);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [court, setCourt] = useState(() => {
    if (defaults.courts.length > 0) {
      return "current";
    }
    return defaults.court === "" ? "all" : `court:${defaults.court}`;
  });
  const facets = page.facets?.court ?? [];
  const courtSelection = (): CourtSelection => {
    if (court === "all") {
      return { type: "all" };
    }
    if (court === "current") {
      return { type: "courts", names: defaults.courts };
    }
    if (court.startsWith("court:")) {
      return { type: "court", name: court.slice("court:".length) };
    }
    const tier = facets.find((entry) => court === `tier:${entry.tierLabel}`);
    if (tier === undefined) {
      return panic("Selected court tier is missing");
    }
    return { type: "courts", names: tier.courts.map(({ value }) => value) };
  };
  const dateLabels = {
    locale,
    placeholderLabel: t("selectDate"),
    clearLabel: t("clearDate"),
    todayLabel: t("today"),
    dialogLabel: t("datePicker"),
    previousMonthLabel: t("previousMonth"),
    nextMonthLabel: t("nextMonth"),
    previousYearLabel: t("previousYear"),
    nextYearLabel: t("nextYear"),
    previousDecadeLabel: t("previousDecade"),
    nextDecadeLabel: t("nextDecade"),
  };
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        bridge.detached(
          bridge.call({
            name: "search_case_law",
            arguments: {
              ...searchFilterInput({
                input,
                country,
                court: courtSelection(),
                from,
                to,
              }),
              queries: [query],
            },
          }),
          "filter case-law results",
        );
      }}
    >
      <div className="flex gap-2">
        <SearchField
          value={query}
          onValueChange={setQuery}
          clearLabel={t("reset")}
          aria-label={t("search")}
          placeholder={t("searchPlaceholder")}
          groupClassName="flex-1"
        />
        <Button type="submit" variant="outline">
          <SearchIcon />
          <span className="max-sm:sr-only">{t("search")}</span>
        </Button>
      </div>
      <div className="grid grid-cols-2 items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1.2fr)_minmax(0,1.2fr)_auto]">
        <Field className="gap-1.5">
          <FieldLabel className="text-muted-foreground ps-3 text-xs">
            {t("country")}
          </FieldLabel>
          <Select
            value={country}
            onValueChange={(value) => {
              if (value !== null) {
                setCountry(value);
              }
            }}
          >
            <SelectTrigger aria-label={t("country")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {PUBLIC_CASE_LAW_COUNTRIES.map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
        <Field className="gap-1.5">
          <FieldLabel className="text-muted-foreground ps-3 text-xs">
            {t("court")}
          </FieldLabel>
          <Select
            value={court}
            onValueChange={(value) => {
              if (value !== null) {
                setCourt(value);
              }
            }}
          >
            <SelectTrigger aria-label={t("court")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">{t("all")}</SelectItem>
              {defaults.courts.length > 0 && (
                <SelectItem value="current">
                  {defaults.courts.join(", ")}
                </SelectItem>
              )}
              {defaults.court !== "" &&
                !facets.some((tier) =>
                  tier.courts.some(({ value }) => value === defaults.court),
                ) && (
                  <SelectItem value={`court:${defaults.court}`}>
                    {defaults.court}
                  </SelectItem>
                )}
              {facets.map(({ tierLabel, courts }) => (
                <SelectGroup key={tierLabel}>
                  <SelectGroupLabel>{t(tierLabel)}</SelectGroupLabel>
                  <SelectItem
                    value={`tier:${tierLabel}`}
                    disabled={courts.length === 0}
                  >
                    {t(tierLabel)}
                  </SelectItem>
                  {courts.map(({ value }) => (
                    <SelectItem key={value} value={`court:${value}`}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectPopup>
          </Select>
        </Field>
        <Field className="gap-1.5">
          <FieldLabel
            id={fromId}
            className="text-muted-foreground ps-3 text-xs"
          >
            {t("from")}
          </FieldLabel>
          <DatePickerPopover
            {...dateLabels}
            variant="field"
            value={from === "" ? null : from}
            onChange={(value) => setFrom(value ?? "")}
            labelledBy={fromId}
            className="w-full"
          />
        </Field>
        <Field className="gap-1.5">
          <FieldLabel id={toId} className="text-muted-foreground ps-3 text-xs">
            {t("to")}
          </FieldLabel>
          <DatePickerPopover
            {...dateLabels}
            variant="field"
            value={to === "" ? null : to}
            onChange={(value) => setTo(value ?? "")}
            labelledBy={toId}
            className="w-full"
          />
        </Field>
        <Button type="submit" variant="outline" className="max-sm:col-span-2">
          {t("filter")}
        </Button>
      </div>
    </form>
  );
};

const SearchResults = ({
  bridge,
  page,
  input,
}: {
  bridge: CaseLawBridge;
  page: SearchPage;
  input: Record<string, unknown>;
}) => {
  const t = useTranslations();
  const locale = useLocale();
  const [sort, setSort] = useState<ResultSort>("relevance");
  const defaults = filterDefaults(input);
  const sorted = sortResultRows(page.results, sort, locale);
  return (
    <div className="space-y-5">
      {defaults.status === "invalid" ? (
        <p role="alert">{defaults.message}</p>
      ) : (
        <SearchControls
          bridge={bridge}
          page={page}
          input={input}
          defaults={defaults}
        />
      )}
      {[
        ...new Map(
          page.searches
            .flatMap(({ warnings }) => warnings)
            .map((warning) => [`${warning.message}-${warning.hint}`, warning]),
        ).values(),
      ].map((warning) => (
        <p
          role="status"
          className="bg-muted/60 text-muted-foreground rounded-lg p-3 text-xs"
          key={`${warning.message}-${warning.hint}`}
        >
          {warning.message} {warning.hint}
        </p>
      ))}
      {page.nextStep !== undefined && (
        <p role="status" className="text-muted-foreground text-xs">
          {page.nextStep}
        </p>
      )}
      <div className="bg-background overflow-hidden rounded-xl border shadow-xs">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <p className="text-muted-foreground shrink-0 text-xs font-medium whitespace-nowrap">
            {t("decisions")}{" "}
            <span className="bg-muted ms-1 rounded-md px-1.5 py-0.5 tabular-nums">
              {page.results.length}
            </span>
          </p>
          <div className="ms-auto grid">
            {[t("relevance"), t("court"), t("newest")].map((label) => (
              <span
                key={label}
                aria-hidden="true"
                className="invisible col-start-1 row-start-1 px-9 text-xs whitespace-nowrap"
              >
                {label}
              </span>
            ))}
            <Select
              value={sort}
              onValueChange={(value) => {
                switch (value) {
                  case "court":
                  case "date":
                  case "relevance":
                    setSort(value);
                    break;
                  case null:
                    break;
                  default:
                    panic("Unknown result sort", value satisfies never);
                }
              }}
            >
              <SelectTrigger
                aria-label={t("sort")}
                size="sm"
                className="col-start-1 row-start-1 w-auto min-w-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="relevance">{t("relevance")}</SelectItem>
                <SelectItem value="court">{t("court")}</SelectItem>
                <SelectItem value="date">{t("newest")}</SelectItem>
              </SelectPopup>
            </Select>
          </div>
        </div>
        <ResultsTable rows={sorted} bridge={bridge} />
        <div className="border-t px-4 py-3">
          <Pagination aria-label={t("next")} className="justify-end">
            <PaginationContent>
              <PaginationItem>
                <PaginationLink
                  render={
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={page.nextCursor === null}
                      onClick={() =>
                        bridge.detached(
                          bridge.call({
                            name: "search_case_law",
                            arguments: { ...input, cursor: page.nextCursor },
                          }),
                          "page case-law results",
                        )
                      }
                    />
                  }
                >
                  {t("next")}
                  <ChevronRightIcon className="size-3.5 rtl:rotate-180" />
                </PaginationLink>
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      </div>
    </div>
  );
};

const LoadingResults = () => {
  const t = useTranslations();
  return (
    <div role="status" aria-label={t("loading")} className="space-y-4">
      <Skeleton className="h-9 w-full" />
      {["first", "second", "third"].map((id) => (
        <div key={id} className="flex items-center gap-4 rounded-lg border p-4">
          <Skeleton className="h-10 w-10" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-3/4" />
          </div>
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
};
const ResultContent = ({ bridge }: { bridge: CaseLawBridge }) => {
  const { result, input } = useSyncExternalStore(
    bridge.subscribe,
    bridge.getSnapshot,
  );
  const t = useTranslations();
  switch (result.status) {
    case "idle":
    case "loading":
      return <LoadingResults />;
    case "error":
      return (
        <div role="alert" className="space-y-3 rounded-lg border p-4">
          <p className="text-sm">{result.message ?? t("error")}</p>
          <Button
            variant="outline"
            onClick={() =>
              bridge.detached(bridge.retry(), "retry case-law read")
            }
          >
            {t("retry")}
          </Button>
        </div>
      );
    case "success": {
      const { view } = result;
      switch (view.type) {
        case "unavailable":
          return (
            <p role="status" className="bg-muted rounded-lg p-5 text-sm">
              {view.message} {view.hint}
            </p>
          );
        case "search":
          return <SearchResults bridge={bridge} page={view} input={input} />;
        case "lookup":
          return (
            <div className="space-y-4">
              {[...new Set(view.notices)].map((message) => (
                <p
                  role="status"
                  className="text-muted-foreground text-sm"
                  key={message}
                >
                  {message}
                </p>
              ))}
              <div className="bg-background overflow-hidden rounded-xl border shadow-xs">
                <ResultsTable rows={view.rows} bridge={bridge} />
              </div>
            </div>
          );
        default:
          return panic("Unknown case-law result view", view satisfies never);
      }
    }
    default:
      return panic("Unknown app result state", result satisfies never);
  }
};
const App = ({ bridge }: { bridge: CaseLawBridge }) => {
  const { context } = useSyncExternalStore(
    bridge.subscribe,
    bridge.getSnapshot,
  );
  const { formattingLocale, direction, messages } = appLocale(context.locale);
  return (
    <IntlProvider locale={formattingLocale} messages={messages}>
      <DirectionProvider direction={direction}>
        <TooltipProvider>
          <main
            dir={direction}
            className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6"
          >
            <header className="flex items-center gap-2.5">
              <div className="bg-muted flex size-8 items-center justify-center rounded-lg">
                <CaseLawIcon className="size-4" />
              </div>
              <h1 className="text-base font-semibold tracking-tight">
                {messages.title}
              </h1>
            </header>
            <ResultContent bridge={bridge} />
          </main>
        </TooltipProvider>
      </DirectionProvider>
    </IntlProvider>
  );
};
const root = document.querySelector("#app");
if (root === null) {
  panic("Case-law app mount is missing");
}
createRoot(root).render(<App bridge={caseLawBridge} />);
caseLawBridge.detached(caseLawBridge.connect(), "connect case-law app");
