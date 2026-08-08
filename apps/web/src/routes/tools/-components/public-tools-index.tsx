import { useRef, useState } from "react";
import type { ReactNode } from "react";

import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import {
  ArrowRightIcon,
  Building2Icon,
  CircleHelpIcon,
  FileOutputIcon,
  FileSearchIcon,
  GavelIcon,
  PlusIcon,
  SearchIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type { LoadedCatalogueEntry } from "@stll/catalogue";
import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import { DirectionalIcon } from "@stll/ui/components/directional-icon";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/components/input-group";
import { cn } from "@stll/ui/lib/utils";

import Tooltip from "@/components/tooltip";
import type { TranslationKey } from "@/i18n/types";
import { loadPublicToolsIndexData } from "@/lib/public-tools-data";
import {
  PRACTICE_AREA_LABEL_KEY,
  sortToolEntries,
  TOOLS_KIND_FILTERS,
  type ToolsKindFilter,
} from "@/lib/tools-catalogue";
import {
  filterPublicToolEntries,
  groupPublicToolEntries,
  PUBLIC_TOOL_GROUPS,
  PUBLIC_TOOL_TASKS,
  type PublicToolGroup,
  type PublicToolTask,
} from "@/routes/tools/-components/public-tools-index.logic";
import { ToggleChip } from "@/routes/tools/-components/toggle-chip";
import { ToolCatalogueCard } from "@/routes/tools/-components/tool-catalogue-card";

const KIND_LABEL_KEY = {
  all: "common.all",
  skill: "catalogue.filter.skills",
  mcp: "catalogue.filter.mcps",
  "native-tool": "catalogue.filter.nativeTools",
} as const satisfies Record<ToolsKindFilter, TranslationKey>;

const TASK_LABEL_KEY = {
  "prepare-documents": "publicTools.discovery.tasks.prepareDocuments",
  "protect-client-data": "publicTools.discovery.tasks.protectClientData",
  "research-precedents": "publicTools.discovery.tasks.researchPrecedents",
  "review-agreements": "publicTools.discovery.tasks.reviewAgreements",
  "verify-organizations": "publicTools.discovery.tasks.verifyOrganizations",
} as const satisfies Record<PublicToolTask, TranslationKey>;

const TASK_ICON = {
  "prepare-documents": FileOutputIcon,
  "protect-client-data": ShieldCheckIcon,
  "research-precedents": GavelIcon,
  "review-agreements": FileSearchIcon,
  "verify-organizations": Building2Icon,
} as const satisfies Record<PublicToolTask, LucideIcon>;

const GROUP_LABEL_KEY = {
  "data-sources": "publicTools.discovery.groups.dataSources",
  included: "publicTools.discovery.groups.included",
  skills: "catalogue.filter.skills",
} as const satisfies Record<PublicToolGroup, TranslationKey>;

const GROUP_BODY_KEY = {
  "data-sources": "publicTools.discovery.groups.dataSourcesBody",
  included: "publicTools.discovery.groups.includedBody",
  skills: "publicTools.discovery.groups.skillsBody",
} as const satisfies Record<PublicToolGroup, TranslationKey>;

const {
  entries: catalogueEntries,
  jurisdictions,
  practiceAreas,
} = loadPublicToolsIndexData();

const featuredEntry = (slug: string): LoadedCatalogueEntry => {
  const entry = catalogueEntries.find((candidate) => candidate.slug === slug);
  if (!entry) {
    panic(`Missing featured catalogue entry: ${slug}`);
  }
  return entry;
};

const contractReview = featuredEntry("contract-review");
const jurisRank = featuredEntry("jurisrank-csjn-analysis");
const ares = featuredEntry("ares");

type PublicToolsIndexProps = {
  kind: ToolsKindFilter;
  onKindChange: (kind: ToolsKindFilter) => void;
};

export function PublicToolsIndex({
  kind,
  onKindChange,
}: PublicToolsIndexProps) {
  const t = useTranslations();
  const resultsRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [activeTask, setActiveTask] = useState<PublicToolTask | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [selectedTags, setSelectedTags] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [selectedJurisdictions, setSelectedJurisdictions] = useState<
    ReadonlySet<string>
  >(new Set());

  const entries = sortToolEntries(
    filterPublicToolEntries(catalogueEntries, {
      jurisdictions: selectedJurisdictions,
      kind,
      query,
      tags: selectedTags,
      task: activeTask,
    }),
  );
  const groups = groupPublicToolEntries(entries);

  const hasActiveFilters =
    query.trim().length > 0 ||
    activeTask !== null ||
    selectedTags.size > 0 ||
    selectedJurisdictions.size > 0 ||
    kind !== "all";
  const showDiscovery = !hasActiveFilters;

  const toggle = (
    set: ReadonlySet<string>,
    value: string,
  ): ReadonlySet<string> => {
    const next = new Set(set);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    return next;
  };

  const resetBrowse = () => {
    setQuery("");
    setActiveTask(null);
    setSelectedTags(new Set());
    setSelectedJurisdictions(new Set());
    onKindChange("all");
  };

  const browseTask = (task: PublicToolTask) => {
    setQuery("");
    setActiveTask(task);
    setSelectedTags(new Set());
    setSelectedJurisdictions(new Set());
    onKindChange("all");
    resultsRef.current?.scrollIntoView({ block: "start" });
  };

  const changeQuery = (value: string) => {
    setQuery(value);
    setActiveTask(null);
  };

  const changeKind = (nextKind: ToolsKindFilter) => {
    setActiveTask(null);
    onKindChange(nextKind);
  };

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
        <section className="pb-4">
          <div className="max-w-3xl">
            <h1 className="text-foreground max-w-2xl text-3xl leading-tight font-semibold tracking-tight text-balance">
              {t("publicTools.discovery.heroTitle")}
            </h1>
            <p className="text-muted-foreground mt-2 max-w-2xl text-sm leading-6 text-pretty sm:text-base">
              {t("publicTools.discovery.heroBody")}
            </p>
          </div>

          <InputGroup className="mt-6 min-h-12 max-w-3xl shadow-xs">
            <InputGroupAddon>
              <SearchIcon className="text-muted-foreground" />
            </InputGroupAddon>
            <InputGroupInput
              aria-label={t("publicTools.discovery.searchPlaceholder")}
              className="text-base"
              onChange={(event) => changeQuery(event.target.value)}
              placeholder={t("publicTools.discovery.searchPlaceholder")}
              type="search"
              value={query}
            />
            {query.length > 0 && (
              <InputGroupAddon align="inline-end">
                <Button
                  aria-label={t("onboarding.catalogueClearSearch")}
                  onClick={() => setQuery("")}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <XIcon />
                </Button>
              </InputGroupAddon>
            )}
          </InputGroup>

          <TaskBrowser onSelect={browseTask} />
        </section>

        {showDiscovery && <FeaturedTools />}

        <section
          aria-labelledby="all-tools-heading"
          className="scroll-mt-4 pt-10 lg:pt-12"
          ref={resultsRef}
        >
          <div className="flex flex-col gap-5">
            <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <h2
                  className="text-foreground text-2xl font-semibold tracking-tight"
                  id="all-tools-heading"
                >
                  {t("publicTools.discovery.allTitle")}
                </h2>
                <p className="text-muted-foreground mt-1 max-w-2xl text-sm leading-6">
                  {t("publicTools.discovery.allBody")}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div
                  className="text-muted-foreground text-sm tabular-nums"
                  aria-live="polite"
                >
                  {t("search.resultCount", { count: entries.length })}
                </div>
                <Button
                  className="min-h-11"
                  render={<Link from="/tools/" to="/tools/contribute" />}
                  variant="ghost"
                >
                  <PlusIcon />
                  {t("publicTools.addSkill")}
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                aria-expanded={showFilters}
                className="min-h-11"
                onClick={() => setShowFilters((visible) => !visible)}
                type="button"
                variant={showFilters ? "secondary" : "ghost"}
              >
                <SlidersHorizontalIcon />
                {t("common.filter")}
              </Button>
              {activeTask !== null && (
                <Button
                  className="min-h-11"
                  onClick={() => setActiveTask(null)}
                  type="button"
                  variant="secondary"
                >
                  {t(TASK_LABEL_KEY[activeTask])}
                  <XIcon />
                </Button>
              )}
              {hasActiveFilters && (
                <Button
                  className="min-h-11"
                  onClick={resetBrowse}
                  type="button"
                  variant="ghost"
                >
                  {t("common.showAll")}
                </Button>
              )}
            </div>

            {showFilters && (
              <div className="bg-muted/35 flex flex-col gap-5 rounded-xl p-4 sm:p-5">
                <nav
                  aria-label={t("common.kind")}
                  className="flex flex-wrap gap-2"
                >
                  {TOOLS_KIND_FILTERS.map((option) => (
                    <ToggleChip
                      active={kind === option}
                      className="min-h-9 px-3 font-medium"
                      key={option}
                      onClick={() => changeKind(option)}
                      variant="ghost"
                    >
                      {t(KIND_LABEL_KEY[option])}
                    </ToggleChip>
                  ))}
                </nav>

                {practiceAreas.length > 0 && (
                  <FacetChips
                    label={t("publicTools.practiceArea")}
                    onToggle={(value) => {
                      setActiveTask(null);
                      setSelectedTags((previous) => toggle(previous, value));
                    }}
                    options={practiceAreas.map((tag) => ({
                      label: t(PRACTICE_AREA_LABEL_KEY[tag]),
                      value: tag,
                    }))}
                    selected={selectedTags}
                  />
                )}

                {jurisdictions.length > 0 && (
                  <FacetChips
                    label={t("onboarding.stepJurisdiction")}
                    onToggle={(value) => {
                      setActiveTask(null);
                      setSelectedJurisdictions((previous) =>
                        toggle(previous, value),
                      );
                    }}
                    options={jurisdictions.map((code) => ({
                      label: <bdi>{code}</bdi>,
                      value: code,
                    }))}
                    selected={selectedJurisdictions}
                  />
                )}
              </div>
            )}
          </div>

          {entries.length === 0 && (
            <div className="bg-muted/35 mt-8 rounded-xl px-6 py-12 text-center">
              <p className="text-foreground text-sm font-medium">
                {t("publicTools.discovery.noResults")}
              </p>
              <Button
                className="mt-2"
                onClick={resetBrowse}
                type="button"
                variant="link"
              >
                {t("common.showAll")}
              </Button>
            </div>
          )}

          {entries.length > 0 && (
            <div className="mt-8 flex flex-col gap-10">
              {PUBLIC_TOOL_GROUPS.map((group) => (
                <CatalogueGroup
                  entries={groups[group]}
                  group={group}
                  key={group}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function FeaturedTools() {
  const t = useTranslations();

  return (
    <section aria-labelledby="featured-tools-heading" className="pt-8 lg:pt-10">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
        <h2
          className="text-foreground text-2xl font-semibold tracking-tight text-balance"
          id="featured-tools-heading"
        >
          {t("publicTools.discovery.featuredTitle")}
        </h2>
        <Tooltip
          className="max-w-72 whitespace-normal"
          content={t("publicTools.discovery.howBody")}
          render={
            <Button
              className="text-muted-foreground min-h-11"
              type="button"
              variant="ghost"
            />
          }
        >
          <CircleHelpIcon />
          {t("publicTools.discovery.howTitle")}
        </Tooltip>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,0.85fr)_minmax(0,0.85fr)]">
        <Link
          className="bg-background group flex min-w-0 flex-col gap-5 rounded-2xl p-5 text-start shadow-[0_1px_2px_rgb(0_0_0/0.04),0_10px_30px_rgb(0_0_0/0.055)] transition-transform duration-150 hover:-translate-y-0.5 hover:shadow-[0_2px_5px_rgb(0_0_0/0.05),0_14px_36px_rgb(0_0_0/0.07)] sm:col-span-2 sm:p-6 xl:col-span-1"
          from="/tools/"
          params={{ slug: contractReview.slug }}
          to="/tools/$slug"
        >
          <div className="flex min-w-0 flex-col">
            <div className="bg-muted/60 flex size-11 items-center justify-center rounded-xl">
              <FileSearchIcon className="text-foreground size-5" />
            </div>
            <h3 className="text-foreground mt-5 text-xl font-semibold text-balance">
              {t(TASK_LABEL_KEY["review-agreements"])}
            </h3>
            <BidiText
              as="p"
              className="text-muted-foreground mt-1 text-sm font-medium"
            >
              {contractReview.displayName}
            </BidiText>
            <p className="text-muted-foreground mt-2 text-sm leading-6 text-pretty">
              {t("publicTools.discovery.contractReviewBody")}
            </p>
            <p className="text-muted-foreground mt-4 text-xs">
              {t("catalogue.by", { author: contractReview.author })}
            </p>
          </div>

          <PreviewFrame label={t("publicTools.discovery.exampleReview")}>
            <div className="flex flex-col gap-2">
              <ReviewClause
                label={t("publicTools.discovery.review.liabilityCap")}
                status={t("publicTools.discovery.review.outsidePlaybook")}
                tone="attention"
              />
              <ReviewClause
                label={t("publicTools.discovery.review.termination")}
                status={t("publicTools.discovery.review.aligned")}
                tone="clear"
              />
              <ReviewClause
                label={t("publicTools.discovery.review.governingLaw")}
                status={t("publicTools.discovery.review.missing")}
                tone="attention"
              />
            </div>
          </PreviewFrame>
          <span className="text-foreground inline-flex items-center gap-2 text-sm font-medium">
            {t("publicTools.discovery.openSkill")}
            <DirectionalIcon
              className="transition-opacity group-hover:opacity-70"
              icon={ArrowRightIcon}
            />
          </span>
        </Link>

        <OutcomeToolCard
          body={t("publicTools.discovery.jurisRankBody")}
          entry={jurisRank}
          icon={GavelIcon}
          task="research-precedents"
        >
          <PreviewFrame label={t("common.preview")}>
            <div aria-hidden="true" className="flex flex-col gap-2.5">
              <RankPreviewRow rank="1" widthClassName="w-full" />
              <RankPreviewRow rank="2" widthClassName="w-4/5" />
              <RankPreviewRow rank="3" widthClassName="w-3/5" />
            </div>
          </PreviewFrame>
        </OutcomeToolCard>

        <OutcomeToolCard
          body={t("publicTools.discovery.aresBody")}
          entry={ares}
          icon={Building2Icon}
          task="verify-organizations"
        >
          <PreviewFrame label={t("common.preview")}>
            <div aria-hidden="true" className="flex items-center gap-3">
              <div className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
                <Building2Icon className="text-muted-foreground size-4" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <span className="bg-foreground/10 h-2 w-3/4 rounded-full" />
                <span className="bg-foreground/5 h-2 w-1/2 rounded-full" />
              </div>
              {ares.jurisdictions.map((code) => (
                <span
                  className="bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 text-xs"
                  key={code}
                >
                  <bdi>{code}</bdi>
                </span>
              ))}
            </div>
          </PreviewFrame>
        </OutcomeToolCard>
      </div>
    </section>
  );
}

function OutcomeToolCard({
  body,
  children,
  entry,
  icon: Icon,
  task,
}: {
  body: string;
  children: ReactNode;
  entry: LoadedCatalogueEntry;
  icon: LucideIcon;
  task: PublicToolTask;
}) {
  const t = useTranslations();

  return (
    <Link
      className="bg-background group hover:bg-muted/20 flex min-w-0 flex-col rounded-2xl p-5 text-start shadow-[0_1px_2px_rgb(0_0_0/0.035),0_8px_26px_rgb(0_0_0/0.045)] transition-transform duration-150 hover:-translate-y-0.5"
      from="/tools/"
      params={{ slug: entry.slug }}
      to="/tools/$slug"
    >
      <div className="flex items-start gap-3">
        <div className="bg-muted/60 flex size-10 shrink-0 items-center justify-center rounded-xl">
          <Icon className="text-foreground size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-foreground font-semibold text-balance">
            {t(TASK_LABEL_KEY[task])}
          </h3>
          <BidiText
            as="p"
            className="text-muted-foreground mt-1 line-clamp-2 text-sm font-medium"
          >
            {entry.displayName}
          </BidiText>
        </div>
      </div>
      {(entry.author !== "stella" || entry.jurisdictions.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {entry.author !== "stella" && (
            <span className="text-muted-foreground text-xs">
              {t("publicTools.discovery.fromCommunity")}
            </span>
          )}
          {entry.jurisdictions.map((code) => (
            <span
              className="bg-muted/50 text-muted-foreground rounded-md px-1.5 py-0.5 text-xs"
              key={code}
            >
              <bdi>{code}</bdi>
            </span>
          ))}
        </div>
      )}
      <BidiText
        as="p"
        className="text-muted-foreground mt-3 line-clamp-2 text-sm leading-6 text-pretty"
      >
        {body}
      </BidiText>
      <div className="mt-4">{children}</div>
      <span className="text-foreground mt-auto inline-flex items-center gap-2 pt-4 text-sm font-medium">
        {t("publicTools.discovery.openSkill")}
        <DirectionalIcon
          className="transition-opacity group-hover:opacity-70"
          icon={ArrowRightIcon}
        />
      </span>
    </Link>
  );
}

function RankPreviewRow({
  rank,
  widthClassName,
}: {
  rank: string;
  widthClassName: "w-3/5" | "w-4/5" | "w-full";
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-muted-foreground w-4 text-xs tabular-nums">
        {rank}
      </span>
      <span
        className={cn("bg-foreground/10 h-2 rounded-full", widthClassName)}
      />
    </div>
  );
}

function PreviewFrame({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="bg-background/75 self-stretch rounded-xl p-4 shadow-[inset_0_0_0_1px_rgb(0_0_0/0.025)]">
      <p className="text-muted-foreground mb-3 text-xs font-medium tracking-wide uppercase">
        {label}
      </p>
      {children}
    </div>
  );
}

function ReviewClause({
  label,
  status,
  tone,
}: {
  label: string;
  status: string;
  tone: "attention" | "clear";
}) {
  return (
    <div className="bg-muted/45 flex items-center justify-between gap-3 rounded-lg px-3 py-2.5">
      <span className="text-foreground text-xs font-medium">{label}</span>
      <span
        className={
          tone === "clear"
            ? "text-success text-xs"
            : "text-warning-foreground text-xs"
        }
      >
        {status}
      </span>
    </div>
  );
}

function TaskBrowser({
  onSelect,
}: {
  onSelect: (task: PublicToolTask) => void;
}) {
  const t = useTranslations();

  return (
    <div className="mt-5">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {t("publicTools.discovery.tasksTitle")}
      </p>
      <div className="mt-2 flex flex-nowrap gap-2 overflow-x-auto pb-2 sm:flex-wrap sm:overflow-visible sm:pb-0">
        {PUBLIC_TOOL_TASKS.map((task) => {
          const Icon = TASK_ICON[task];
          return (
            <Button
              className="bg-muted/45 hover:bg-muted/70 min-h-11 shrink-0 justify-start"
              key={task}
              onClick={() => onSelect(task)}
              type="button"
              variant="ghost"
            >
              <Icon className="text-muted-foreground" />
              {t(TASK_LABEL_KEY[task])}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

function CatalogueGroup({
  entries,
  group,
}: {
  entries: readonly LoadedCatalogueEntry[];
  group: PublicToolGroup;
}) {
  const t = useTranslations();
  if (entries.length === 0) {
    return null;
  }

  return (
    <section aria-labelledby={`catalogue-group-${group}`}>
      <div className="mb-4 max-w-2xl">
        <h3
          className="text-foreground text-lg font-semibold"
          id={`catalogue-group-${group}`}
        >
          {t(GROUP_LABEL_KEY[group])}
        </h3>
        <p className="text-muted-foreground mt-1 text-sm leading-6">
          {t(GROUP_BODY_KEY[group])}
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {entries.map((entry) => (
          <ToolCatalogueCard
            entry={entry}
            key={`${entry.kind}-${entry.slug}`}
          />
        ))}
      </div>
    </section>
  );
}

type FacetOption = {
  value: string;
  label: ReactNode;
};

function FacetChips({
  label,
  onToggle,
  options,
  selected,
}: {
  label: string;
  onToggle: (value: string) => void;
  options: readonly FacetOption[];
  selected: ReadonlySet<string>;
}) {
  return (
    <section aria-label={label}>
      <h2 className="text-muted-foreground mb-2 text-xs font-medium tracking-wider uppercase">
        {label}
      </h2>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <ToggleChip
            active={selected.has(option.value)}
            className="font-normal"
            key={option.value}
            onClick={() => onToggle(option.value)}
          >
            {option.label}
          </ToggleChip>
        ))}
      </div>
    </section>
  );
}
