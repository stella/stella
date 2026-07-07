import { useState } from "react";

import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { loadCatalogue, loadRecommended } from "@stll/catalogue";
import { Button } from "@stll/ui/components/button";

import { getTranslator } from "@/i18n/i18n-store";
import type { TranslationKey } from "@/i18n/types";
import { pageTitle } from "@/lib/page-title";
import { createPublicToolsHead } from "@/lib/public-tools-seo";
import { ToggleChip } from "@/routes/tools/-components/toggle-chip";
import { ToolCatalogueCard } from "@/routes/tools/-components/tool-catalogue-card";
import {
  collectJurisdictions,
  collectPracticeAreas,
  filterToolEntries,
  invertRecommendedMap,
  prettifyPracticeArea,
  sortToolEntries,
  TOOLS_KIND_FILTERS,
  type ToolsKindFilter,
} from "@/routes/tools/-components/tools-catalogue.logic";

// Static bundle from the catalogue package: no auth, no API, no
// filesystem — the generated manifest is imported at build time and
// lands in this route's chunk, not the main client chunk.
const CATALOGUE_ENTRIES = loadCatalogue();
const RECOMMENDED_BY_SLUG = invertRecommendedMap(loadRecommended());
const RECOMMENDED_SLUGS: ReadonlySet<string> = new Set(
  RECOMMENDED_BY_SLUG.keys(),
);
const PRACTICE_AREAS = collectPracticeAreas(CATALOGUE_ENTRIES);
const JURISDICTIONS = collectJurisdictions(CATALOGUE_ENTRIES);

const KIND_LABEL_KEY = {
  all: "common.all",
  skill: "catalogue.filter.skills",
  mcp: "catalogue.filter.mcps",
  "native-tool": "catalogue.filter.nativeTools",
} as const satisfies Record<ToolsKindFilter, TranslationKey>;

const searchSchema = v.object({
  kind: v.optional(v.picklist(TOOLS_KIND_FILTERS), "all"),
});

export const Route = createFileRoute("/tools/")({
  validateSearch: searchSchema,
  head: () => {
    const t = getTranslator();
    return createPublicToolsHead({
      description: t("publicTools.metaDescription"),
      path: "/tools",
      title: pageTitle("knowledge.sections.tools.title"),
      type: "website",
    });
  },
  component: PublicToolsIndex,
});

function PublicToolsIndex() {
  const t = useTranslations();
  const kind = Route.useSearch({ select: (s) => s.kind });
  const navigate = Route.useNavigate();
  const [selectedTags, setSelectedTags] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [selectedJurisdictions, setSelectedJurisdictions] = useState<
    ReadonlySet<string>
  >(new Set());

  const entries = sortToolEntries(
    filterToolEntries(CATALOGUE_ENTRIES, {
      kind,
      tags: selectedTags,
      jurisdictions: selectedJurisdictions,
    }),
    RECOMMENDED_SLUGS,
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
    void navigate({ search: { kind: "all" } });
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">
            {t("knowledge.sections.tools.title")}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t("publicTools.metaDescription")}
          </p>
        </div>
        <Button
          className="shrink-0"
          render={<Link to="/tools/contribute" />}
          size="sm"
          variant="outline"
        >
          {t("publicTools.contribute.cta")}
        </Button>
      </div>

      <nav aria-label={t("common.kind")} className="flex flex-wrap gap-1.5">
        {TOOLS_KIND_FILTERS.map((option) => (
          <ToggleChip
            active={kind === option}
            className="px-2.5 py-1 font-medium"
            key={option}
            onClick={() => void navigate({ search: { kind: option } })}
            variant="ghost"
          >
            {t(KIND_LABEL_KEY[option])}
          </ToggleChip>
        ))}
      </nav>

      {PRACTICE_AREAS.length > 0 && (
        <FacetChips
          label={t("publicTools.practiceArea")}
          onToggle={(value) => setSelectedTags((prev) => toggle(prev, value))}
          options={PRACTICE_AREAS.map((tag) => ({
            value: tag,
            label: prettifyPracticeArea(tag),
          }))}
          selected={selectedTags}
        />
      )}

      {JURISDICTIONS.length > 0 && (
        <FacetChips
          label={t("onboarding.stepJurisdiction")}
          onToggle={(value) =>
            setSelectedJurisdictions((prev) => toggle(prev, value))
          }
          options={JURISDICTIONS.map((code) => ({ value: code, label: code }))}
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
            recommendedIn={RECOMMENDED_BY_SLUG.get(entry.slug)}
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
  label: string;
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
