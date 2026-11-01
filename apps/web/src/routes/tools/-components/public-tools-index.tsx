import { useRef, useState } from "react";
import type { ReactNode } from "react";

import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import type { LoadedCatalogueEntry } from "@stll/catalogue";
import { Button } from "@stll/ui/button";
import {
  Building2Icon,
  CaseLawIcon,
  FileOutputIcon,
  FileSearchIcon,
  type LucideIcon,
  PlusIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "@stll/ui/icons";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/input-group";
import { Prose } from "@stll/ui/prose";

import {
  nativeToolDescriptionKey,
  nativeToolLabelKey,
} from "@/components/catalogue/native-tool-label";
import { ToggleChip } from "@/features/knowledge/public/tools/toggle-chip";
import type { TranslationKey } from "@/i18n/types";
import { loadPublicToolsIndexData } from "@/lib/public-tools-data";
import {
  PRACTICE_AREA_LABEL_KEY,
  sortToolEntries,
  TOOLS_KIND_FILTERS,
  type ToolsKindFilter,
} from "@/lib/tools-catalogue";
import { PublicToolsFeatured } from "@/routes/tools/-components/public-tools-featured";
import {
  filterPublicToolEntries,
  groupPublicToolEntries,
  PUBLIC_TOOL_GROUPS,
  PUBLIC_TOOL_TASK_LABEL_KEY,
  PUBLIC_TOOL_TASKS,
  type PublicToolGroup,
  type PublicToolTask,
} from "@/routes/tools/-components/public-tools-index.logic";
import { PublicToolsTaskGrid } from "@/routes/tools/-components/public-tools-task-grid";
import { ToolCatalogueCard } from "@/routes/tools/-components/tool-catalogue-card";

const KIND_LABEL_KEY = {
  all: "common.all",
  skill: "catalogue.filter.skills",
  mcp: "catalogue.filter.mcps",
  "native-tool": "catalogue.filter.nativeTools",
} as const satisfies Record<ToolsKindFilter, TranslationKey>;

const TASK_ICON = {
  "prepare-documents": FileOutputIcon,
  "protect-client-data": ShieldCheckIcon,
  "research-precedents": CaseLawIcon,
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

  // Search and order follow what the reader sees on each card.
  const localizedEntries = catalogueEntries.map((entry) => {
    const identity = { slug: entry.slug, kind: entry.kind };
    const labelKey = nativeToolLabelKey(identity);
    const descriptionKey = nativeToolDescriptionKey(identity);
    return {
      ...entry,
      displayName: labelKey ? t(labelKey) : entry.displayName,
      description: descriptionKey ? t(descriptionKey) : entry.description,
    };
  });

  const entries = sortToolEntries(
    filterPublicToolEntries(localizedEntries, {
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
            <Prose tone="muted" size="lede" className="mt-2">
              {t("publicTools.discovery.heroBody")}
            </Prose>
          </div>

          <InputGroup className="mt-6 min-h-12 max-w-3xl shadow-xs">
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
                  aria-label={t("common.clearSearch")}
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

        {showDiscovery && <PublicToolsFeatured />}

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
                <Prose tone="muted" size="sm" className="mt-1">
                  {t("publicTools.discovery.allBody")}
                </Prose>
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
                  {t(PUBLIC_TOOL_TASK_LABEL_KEY[activeTask])}
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
              <p className="text-foreground text-sm font-medium" role="status">
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
      <PublicToolsTaskGrid>
        {PUBLIC_TOOL_TASKS.map((task) => {
          const Icon = TASK_ICON[task];
          return (
            <Button
              className="bg-muted/45 hover:bg-muted/70 h-11 min-w-0 justify-start"
              key={task}
              onClick={() => onSelect(task)}
              type="button"
              variant="ghost"
            >
              <Icon className="text-muted-foreground" />
              <span className="truncate">
                {t(PUBLIC_TOOL_TASK_LABEL_KEY[task])}
              </span>
            </Button>
          );
        })}
      </PublicToolsTaskGrid>
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
        <Prose tone="muted" size="sm" className="mt-1">
          {t(GROUP_BODY_KEY[group])}
        </Prose>
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
