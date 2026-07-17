import { useState } from "react";
import type { ReactNode } from "react";

import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";

import type { TranslationKey } from "@/i18n/types";
import { loadPublicToolsIndexData } from "@/lib/public-tools-data";
import {
  filterToolEntries,
  PRACTICE_AREA_LABEL_KEY,
  sortToolEntries,
  TOOLS_KIND_FILTERS,
  type ToolsKindFilter,
} from "@/lib/tools-catalogue";
import { ToggleChip } from "@/routes/tools/-components/toggle-chip";
import { ToolCatalogueCard } from "@/routes/tools/-components/tool-catalogue-card";

const KIND_LABEL_KEY = {
  all: "common.all",
  skill: "catalogue.filter.skills",
  mcp: "catalogue.filter.mcps",
  "native-tool": "catalogue.filter.nativeTools",
} as const satisfies Record<ToolsKindFilter, TranslationKey>;

const {
  entries: catalogueEntries,
  jurisdictions,
  practiceAreas,
  recommendedInBySlug,
  recommendedSlugs,
  stats,
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
  const [selectedTags, setSelectedTags] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [selectedJurisdictions, setSelectedJurisdictions] = useState<
    ReadonlySet<string>
  >(new Set());

  const entries = sortToolEntries(
    filterToolEntries(catalogueEntries, {
      kind,
      tags: selectedTags,
      jurisdictions: selectedJurisdictions,
    }),
    recommendedSlugs,
  );

  const hasActiveFilters =
    selectedTags.size > 0 || selectedJurisdictions.size > 0 || kind !== "all";

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

  const resetFilters = () => {
    setSelectedTags(new Set());
    setSelectedJurisdictions(new Set());
    onKindChange("all");
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">
            {t("knowledge.sections.tools.title")}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t("publicTools.metaDescription")}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("publicTools.stats", {
              toolCount: stats.toolCount,
              contributorCount: stats.contributorCount,
            })}
          </p>
        </div>
        <Button
          className="shrink-0"
          render={<Link from="/tools/" to="/tools/contribute" />}
          size="sm"
          variant="outline"
        >
          <PlusIcon />
          {t("publicTools.addSkill")}
        </Button>
      </div>

      <nav aria-label={t("common.kind")} className="flex flex-wrap gap-1.5">
        {TOOLS_KIND_FILTERS.map((option) => (
          <ToggleChip
            active={kind === option}
            className="px-2.5 py-1 font-medium"
            key={option}
            onClick={() => onKindChange(option)}
            variant="ghost"
          >
            {t(KIND_LABEL_KEY[option])}
          </ToggleChip>
        ))}
      </nav>

      {practiceAreas.length > 0 && (
        <FacetChips
          label={t("publicTools.practiceArea")}
          onToggle={(value) => setSelectedTags((prev) => toggle(prev, value))}
          options={practiceAreas.map((tag) => ({
            value: tag,
            label: t(PRACTICE_AREA_LABEL_KEY[tag]),
          }))}
          selected={selectedTags}
        />
      )}

      {jurisdictions.length > 0 && (
        <FacetChips
          label={t("onboarding.stepJurisdiction")}
          onToggle={(value) =>
            setSelectedJurisdictions((prev) => toggle(prev, value))
          }
          options={jurisdictions.map((code) => ({
            value: code,
            label: <bdi>{code}</bdi>,
          }))}
          selected={selectedJurisdictions}
        />
      )}

      <div className="flex flex-col gap-2">
        {entries.length === 0 && (
          <p className="text-muted-foreground text-sm">
            {t("catalogue.empty")}
          </p>
        )}
        {entries.map((entry) => (
          <ToolCatalogueCard
            entry={entry}
            key={`${entry.kind}-${entry.slug}`}
            recommendedIn={recommendedInBySlug[entry.slug]}
          />
        ))}
      </div>

      {hasActiveFilters && (
        <div className="flex justify-center pt-2">
          <Button onClick={resetFilters} size="sm" type="button" variant="link">
            {t("common.showAll")}
          </Button>
        </div>
      )}
    </main>
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
      <h2 className="text-muted-foreground mb-1.5 text-xs font-medium tracking-wider uppercase">
        {label}
      </h2>
      <div className="flex flex-wrap gap-1.5">
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
