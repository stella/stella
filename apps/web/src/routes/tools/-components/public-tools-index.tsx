import { useRef, useState } from "react";
import type { ReactNode } from "react";

import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import {
  ArrowRightIcon,
  Building2Icon,
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/components/input-group";

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
      <div className="mx-auto flex w-full max-w-7xl flex-col px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
        <section className="pb-8 lg:pb-10">
          <div className="flex flex-col items-start justify-between gap-6 lg:flex-row lg:gap-12">
            <div className="max-w-3xl">
              <h1 className="text-foreground max-w-2xl text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">
                {t("publicTools.discovery.heroTitle")}
              </h1>
              <p className="text-muted-foreground mt-3 max-w-2xl text-base leading-7">
                {t("publicTools.discovery.heroBody")}
              </p>
            </div>
            <Button
              className="min-h-11 shrink-0"
              render={<Link from="/tools/" to="/tools/contribute" />}
              variant="outline"
            >
              <PlusIcon />
              {t("publicTools.addSkill")}
            </Button>
          </div>

          <InputGroup className="mt-7 min-h-12 max-w-2xl shadow-xs">
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
        </section>

        {showDiscovery && (
          <>
            <FeaturedTools />
            <TaskBrowser onSelect={browseTask} />
          </>
        )}

        <section
          aria-labelledby="all-tools-heading"
          className="scroll-mt-4 pt-10 lg:pt-14"
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
              <div className="text-muted-foreground text-sm" aria-live="polite">
                {t("search.resultCount", { count: entries.length })}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                aria-expanded={showFilters}
                className="min-h-11"
                onClick={() => setShowFilters((visible) => !visible)}
                type="button"
                variant={showFilters ? "secondary" : "outline"}
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
    <section
      aria-labelledby="featured-tools-heading"
      className="pt-10 lg:pt-14"
    >
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <p className="text-primary text-xs font-semibold tracking-wider uppercase">
            {t("publicTools.discovery.editorsPick")}
          </p>
          <h2
            className="text-foreground mt-1 text-2xl font-semibold tracking-tight"
            id="featured-tools-heading"
          >
            {t("publicTools.discovery.featuredTitle")}
          </h2>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(19rem,0.75fr)]">
        <Link
          className="bg-muted/45 hover:bg-muted/65 group grid min-w-0 gap-6 rounded-2xl p-5 text-start transition-colors sm:p-6 md:grid-cols-[minmax(0,1fr)_minmax(15rem,0.72fr)]"
          from="/tools/"
          params={{ slug: contractReview.slug }}
          to="/tools/$slug"
        >
          <div className="flex min-w-0 flex-col">
            <div className="bg-background/80 flex size-11 items-center justify-center rounded-lg">
              <FileSearchIcon className="text-foreground size-5" />
            </div>
            <h3 className="text-foreground mt-5 text-xl font-semibold">
              <BidiText as="span">{contractReview.displayName}</BidiText>
            </h3>
            <p className="text-muted-foreground mt-2 text-sm leading-6">
              {t("publicTools.discovery.contractReviewBody")}
            </p>
            <p className="text-muted-foreground mt-4 text-xs">
              {t("catalogue.by", { author: contractReview.author })}
            </p>
            <span className="text-foreground mt-6 inline-flex items-center gap-2 text-sm font-medium">
              {t("publicTools.discovery.openSkill")}
              <ArrowRightIcon className="transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5" />
            </span>
          </div>

          <div className="bg-background/65 self-stretch rounded-xl p-4">
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {t("publicTools.discovery.exampleReview")}
            </p>
            <div className="mt-4 flex flex-col gap-2">
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
          </div>
        </Link>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
          <Link
            className="bg-muted/35 hover:bg-muted/60 group flex min-w-0 flex-col rounded-2xl p-5 text-start transition-colors"
            from="/tools/"
            params={{ slug: jurisRank.slug }}
            to="/tools/$slug"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="bg-background/80 flex size-10 items-center justify-center rounded-lg">
                <GavelIcon className="text-foreground size-5" />
              </div>
              <span className="bg-muted text-muted-foreground rounded-md px-2 py-1 text-xs font-medium">
                {t("publicTools.discovery.fromCommunity")}
              </span>
            </div>
            <h3 className="text-foreground mt-4 font-semibold">
              <BidiText as="span">{jurisRank.displayName}</BidiText>
            </h3>
            <p className="text-muted-foreground mt-2 line-clamp-3 text-sm leading-6">
              {t("publicTools.discovery.jurisRankBody")}
            </p>
            <span className="text-foreground mt-5 inline-flex items-center gap-2 text-sm font-medium">
              {t("publicTools.discovery.openSkill")}
              <ArrowRightIcon className="transition-transform group-hover:translate-x-0.5 rtl:rotate-180 rtl:group-hover:-translate-x-0.5" />
            </span>
          </Link>

          <aside className="bg-muted/45 rounded-2xl p-5">
            <h3 className="text-foreground font-semibold">
              {t("publicTools.discovery.howTitle")}
            </h3>
            <p className="text-muted-foreground mt-2 text-sm leading-6">
              {t("publicTools.discovery.howBody")}
            </p>
          </aside>
        </div>
      </div>
    </section>
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
    <div className="bg-background/80 flex items-center justify-between gap-3 rounded-md px-3 py-2.5">
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
    <section aria-labelledby="task-browser-heading" className="pt-10 lg:pt-14">
      <h2
        className="text-foreground text-xl font-semibold tracking-tight"
        id="task-browser-heading"
      >
        {t("publicTools.discovery.tasksTitle")}
      </h2>
      <div className="mt-4 flex flex-wrap gap-2.5">
        {PUBLIC_TOOL_TASKS.map((task) => {
          const Icon = TASK_ICON[task];
          return (
            <Button
              className="min-h-11 justify-start"
              key={task}
              onClick={() => onSelect(task)}
              type="button"
              variant="outline"
            >
              <Icon className="text-muted-foreground" />
              {t(TASK_LABEL_KEY[task])}
            </Button>
          );
        })}
      </div>
    </section>
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
