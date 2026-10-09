import { useId, useRef, useState, useSyncExternalStore } from "react";
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
import {
  parseDecisionParagraphFragment,
  formatDecisionParagraphRange,
} from "@stll/api-contract/decision-paragraph-range";
import { parseLegalCitationHttpUrl } from "@stll/api-contract/legal-citation-links";
import {
  Accordion,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
} from "@stll/ui/accordion";
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
import { StellaMark } from "@stll/ui/stella-mark";
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
import { containedEventHandler } from "@stll/ui/use-contained-handler";

import { createReaderController } from "../decision-reader/controller";
import { createEmbeddedReaderBridge } from "../decision-reader/embedded-bridge";
import { ReaderView } from "../decision-reader/view";
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
const embeddedReaderBridge = createEmbeddedReaderBridge(caseLawBridge);
const embeddedReader = createReaderController(embeddedReaderBridge);
type CaseLawBridge = typeof caseLawBridge;
type OpenReader = (row: ResultRow, trigger: HTMLElement) => void;
type SearchPage = Extract<CaseLawView, { type: "search" }>;

const ResultTableRow = ({
  row,
  bridge,
  onOpen,
}: {
  row: ResultRow;
  bridge: CaseLawBridge;
  onOpen: OpenReader;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const headnoteText = (() => {
    if (row.type === "lookup") {
      return null;
    }
    const { headnote } = row;
    switch (headnote.type) {
      case "present":
        return headnote.text;
      case "omitted":
        return t("headnoteOmitted");
      case "not_stated":
        return t("headnoteNotStated");
      default:
        return panic("Unknown headnote state", headnote satisfies never);
    }
  })();
  const url = row.appUrl;
  const sourceUrl = row.source_url;
  const openWeb = () => {
    if (url !== null) {
      bridge.detached(bridge.openLink(url), "open case-law decision");
    }
  };
  return (
    <TableRow
      className="max-[480px]:flex max-[480px]:flex-wrap"
      onClick={containedEventHandler((event) => {
        if (row.type === "lookup" || !(event.target instanceof Element)) {
          return;
        }
        if (
          event.target.closest("button, a, input, [data-slot=tooltip-trigger]")
        ) {
          return;
        }
        setExpanded(!expanded);
      })}
    >
      <TableCell className="py-3 ps-4 max-[480px]:w-full">
        <div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
          {row.courtAbbreviation !== null && (
            <Tooltip>
              <TooltipTrigger
                render={<span className="inline-flex min-w-8 shrink-0" />}
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
                  disabled={!bridge.supportsTools() && url === null}
                  onClick={(event) => onOpen(row, event.currentTarget)}
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
              <p className="text-muted-foreground text-xs">{row.court}</p>
              {row.snippet !== null && (
                <p className="text-sm leading-relaxed">{row.snippet}</p>
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
                <Button variant="outline" size="sm" onClick={openWeb}>
                  <StellaMark />
                  {t("openInStella")}
                </Button>
              )}
            </PreviewCardPopup>
          </PreviewCard>
        </div>
      </TableCell>
      <TableCell className="py-3 max-[480px]:order-last max-[480px]:w-full max-[480px]:pt-0">
        {row.type === "search" && (
          <Accordion
            value={expanded ? [row.decisionId] : []}
            onValueChange={(value) => setExpanded(value.length > 0)}
          >
            <AccordionItem value={row.decisionId} className="border-0">
              <div className="flex min-w-0 items-center gap-2">
                <p className="snippet text-muted-foreground min-w-0 flex-1 truncate text-sm">
                  {row.snippet ?? headnoteText}
                </p>
                <AccordionTrigger
                  aria-controls={panelId}
                  aria-label={t(
                    expanded ? "collapsePassages" : "expandPassages",
                  )}
                  className="size-[44px] flex-none items-center justify-center gap-0 p-0 [&_[data-slot=accordion-indicator]]:transition-none"
                />
              </div>
              <AccordionPanel
                id={panelId}
                style={{ height: "auto", transition: "none" }}
                className="space-y-3 pt-2 pb-0"
              >
                {row.snippet === null ? null : (
                  <div className="space-y-1">
                    <p className="text-foreground text-xs font-medium">
                      {t("matchedPassages")}
                    </p>
                    <p
                      dir="auto"
                      className="text-sm leading-relaxed break-words whitespace-pre-wrap"
                    >
                      {row.snippet}
                    </p>
                  </div>
                )}
                <div className="space-y-1">
                  <p className="text-foreground text-xs font-medium">
                    {t("headnote")}
                  </p>
                  <p
                    dir="auto"
                    className="text-sm leading-relaxed break-words whitespace-pre-wrap"
                  >
                    {headnoteText}
                  </p>
                  {row.headnote.type === "present" &&
                    row.headnote.truncated && (
                      <p className="text-xs">{t("headnoteExcerpt")}</p>
                    )}
                </div>
                {row.keywords !== null && (
                  <div className="space-y-1">
                    <p className="text-foreground text-xs font-medium">
                      {t("keywords")}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {row.keywords.items.map((keyword) => (
                        <span
                          key={keyword}
                          className="bg-muted max-w-full rounded-md px-2 py-1 text-xs break-words whitespace-normal"
                        >
                          <bdi>{keyword}</bdi>
                        </span>
                      ))}
                      {row.keywords.omitted > 0 && (
                        <span className="text-xs">
                          {t("keywordsOmitted", {
                            count: format.number(row.keywords.omitted),
                          })}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </AccordionPanel>
            </AccordionItem>
          </Accordion>
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
        <div className="flex justify-end gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("open")}
            tooltip={t("open")}
            disabled={!bridge.supportsTools() && url === null}
            onClick={(event) => onOpen(row, event.currentTarget)}
          >
            <ChevronRightIcon />
          </Button>
          {url !== null && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("openInStella")}
                    onClick={openWeb}
                  />
                }
              >
                <StellaMark />
              </TooltipTrigger>
              <TooltipPopup>{t("openInStella")}</TooltipPopup>
            </Tooltip>
          )}
          {sourceUrl !== undefined && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("openOriginalSource")}
                    onClick={() => {
                      bridge.detached(
                        bridge.openLink(sourceUrl),
                        "open original case-law source",
                      );
                    }}
                  />
                }
              >
                <ExternalLinkIcon />
              </TooltipTrigger>
              <TooltipPopup>{t("openOriginalSource")}</TooltipPopup>
            </Tooltip>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
};

const ResultsTable = ({
  rows,
  bridge,
  onOpen,
}: {
  rows: readonly ResultRow[];
  bridge: CaseLawBridge;
  onOpen: OpenReader;
}) => {
  const t = useTranslations();
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
          <TableHead className="w-20">
            <span className="sr-only">{t("open")}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {[...new Map(rows.map((row) => [row.decisionId, row])).values()].map(
          (row) => (
            <ResultTableRow
              key={row.decisionId}
              row={row}
              bridge={bridge}
              onOpen={onOpen}
            />
          ),
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
type CourtFilterState = { value: string; selection: CourtSelection };

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
  const originalQuery = initialQueries.ok ? initialQueries.value.join(" ") : "";
  const [query, setQuery] = useState(originalQuery);
  const [country, setCountry] = useState(defaults.country);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [court, setCourt] = useState((): CourtFilterState => {
    if (defaults.courts.length > 0) {
      return {
        value: "current",
        selection: { type: "courts", names: defaults.courts },
      };
    }
    if (defaults.court === "") {
      return { value: "all", selection: { type: "all" } };
    }
    return {
      value: `court:${defaults.court}`,
      selection: { type: "court", name: defaults.court },
    };
  });
  const facets = page.facets;
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
                court: court.selection,
                from,
                to,
              }),
              queries: query === originalQuery ? input["queries"] : [query],
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
          <FieldLabel className="text-muted-foreground text-xs">
            {t("country")}
          </FieldLabel>
          <Select
            value={country}
            onValueChange={(value) => {
              if (value !== null && value !== country) {
                setCountry(value);
                setCourt({ value: "all", selection: { type: "all" } });
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
          <FieldLabel className="text-muted-foreground text-xs">
            {t("court")}
          </FieldLabel>
          <Select
            value={court.value}
            onValueChange={(value) => {
              if (value === null) {
                return;
              }
              let selection: CourtSelection;
              if (value === "all") {
                selection = { type: "all" };
              } else if (value === "current") {
                selection = { type: "courts", names: defaults.courts };
              } else if (value.startsWith("court:")) {
                selection = {
                  type: "court",
                  name: value.slice("court:".length),
                };
              } else {
                const tier = facets?.court.find(
                  (entry) => value === `tier:${entry.tierLabel}`,
                );
                if (tier === undefined) {
                  return;
                }
                selection = {
                  type: "courts",
                  names: tier.courts.map(({ value: name }) => name),
                };
              }
              setCourt({ value, selection });
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
                (facets === null ||
                  !facets.court.some((tier) =>
                    tier.courts.some(({ value }) => value === defaults.court),
                  )) && (
                  <SelectItem value={`court:${defaults.court}`}>
                    {defaults.court}
                  </SelectItem>
                )}
              {court.value.startsWith("tier:") &&
                !facets?.court.some(
                  ({ tierLabel }) => court.value === `tier:${tierLabel}`,
                ) && (
                  <SelectItem value={court.value}>
                    {t(court.value.slice("tier:".length))}
                  </SelectItem>
                )}
              {facets?.court.map(({ tierLabel, courts }) => (
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
          <FieldLabel id={fromId} className="text-muted-foreground text-xs">
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
          <FieldLabel id={toId} className="text-muted-foreground text-xs">
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
  onOpen,
}: {
  bridge: CaseLawBridge;
  page: SearchPage;
  input: Record<string, unknown>;
  onOpen: OpenReader;
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
        <ResultsTable rows={sorted} bridge={bridge} onOpen={onOpen} />
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
const ResultContent = ({
  bridge,
  onOpen,
}: {
  bridge: CaseLawBridge;
  onOpen: OpenReader;
}) => {
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
    case "ready": {
      const { view } = result;
      switch (view.type) {
        case "unavailable":
          return (
            <p role="status" className="bg-muted rounded-lg p-5 text-sm">
              {view.message} {view.hint}
            </p>
          );
        case "search":
          return (
            <SearchResults
              bridge={bridge}
              page={view}
              input={input}
              onOpen={onOpen}
            />
          );
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
                <ResultsTable
                  rows={view.rows}
                  bridge={bridge}
                  onOpen={onOpen}
                />
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
  const [screen, setScreen] = useState<"results" | "reader">("results");
  const returnLocation = useRef<{
    trigger: HTMLElement;
    scrollX: number;
    scrollY: number;
  } | null>(null);
  const onOpen: OpenReader = (row, trigger) => {
    if (!bridge.supportsTools()) {
      if (row.appUrl !== null) {
        bridge.detached(bridge.openLink(row.appUrl), "open case-law decision");
      }
      return;
    }
    returnLocation.current = {
      trigger,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    };
    const appUrl =
      row.appUrl === null ? null : parseLegalCitationHttpUrl(row.appUrl);
    const paragraphs =
      appUrl === null ? null : parseDecisionParagraphFragment(appUrl.hash);
    setScreen("reader");
    window.scrollTo(0, 0);
    embeddedReaderBridge.detached(
      embeddedReaderBridge.call({
        name: "open_case_law_decision",
        arguments: {
          decision_id: row.decisionId,
          ...(paragraphs === null
            ? {}
            : { paragraphs: formatDecisionParagraphRange(paragraphs) }),
        },
      }),
      "open decision reader",
    );
  };
  const onBack = () => {
    embeddedReaderBridge.reset();
    setScreen("results");
    embeddedReaderBridge.detached(
      embeddedReaderBridge.requestInline(),
      "restore results display mode",
    );
  };
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
            hidden={screen !== "results"}
            ref={(element) => {
              if (
                element === null ||
                screen !== "results" ||
                returnLocation.current === null
              ) {
                return;
              }
              const location = returnLocation.current;
              returnLocation.current = null;
              location.trigger.focus({ preventScroll: true });
              window.scrollTo(location.scrollX, location.scrollY);
            }}
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
            <ResultContent bridge={bridge} onOpen={onOpen} />
          </main>
          {screen === "reader" && (
            <ReaderView host={embeddedReader} onBack={onBack} />
          )}
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
