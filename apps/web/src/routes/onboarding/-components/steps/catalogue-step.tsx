import { useEffect, useMemo, useState } from "react";

import {
  CheckIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  GlobeIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import {
  EU_MEMBER_STATES,
  isToggleableNativeToolBackendSlug,
  loadCatalogue,
  recommendedSlugsForJurisdictions,
  type LoadedCatalogueEntry,
} from "@stll/catalogue";
import { Button } from "@stll/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/components/input-group";
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from "@stll/ui/components/popover";
import { cn } from "@stll/ui/lib/utils";

import {
  CatalogueRow,
  type CatalogueRowDisplay,
} from "@/components/catalogue/catalogue-row";
import type { ContextMenuAction } from "@/components/context-menu";
import type { PracticeJurisdiction } from "@/lib/jurisdictions";
import {
  createCatalogueAutoSelectionPlan,
  isCatalogueEntryAvailableDuringOnboarding,
} from "@/routes/onboarding/-components/onboarding-catalogue-setup.logic";

const toRowDisplay = (entry: LoadedCatalogueEntry): CatalogueRowDisplay => ({
  slug: entry.slug,
  displayName: entry.displayName,
  description: entry.description,
  author: entry.author,
  cost: entry.cost,
  setup: entry.setup,
  icon: entry.icon,
  iconUrl: entry.iconUrl,
  jurisdictions: entry.jurisdictions,
});

type CatalogueStepProps = {
  practiceJurisdictions: readonly PracticeJurisdiction[];
  selectedSlugs: readonly string[];
  removedSlugs: readonly string[];
  focusedSlug: string | null;
  onFocusChange: (slug: string | null) => void;
  onChange: (slugs: readonly string[]) => void;
  onAdd: (slug: string) => void;
  onRemove: (slug: string) => void;
  onNext: () => void;
  onSkip: () => void;
  unavailableNativeToolBackendSlugs?: ReadonlySet<string> | undefined;
};

const PROPOSE_TOOL_URL =
  "https://github.com/stella/stella/issues/new?template=feature-request.yml";

export const CatalogueStep = ({
  practiceJurisdictions,
  selectedSlugs,
  removedSlugs,
  focusedSlug,
  onFocusChange,
  onChange,
  onAdd,
  onRemove,
  onNext,
  onSkip,
  unavailableNativeToolBackendSlugs,
}: CatalogueStepProps) => {
  const t = useTranslations();
  const [query, setQuery] = useState("");
  const [filterQuery, setFilterQuery] = useState("");
  // Multi-select jurisdiction chips. Pre-populated from the user's
  // practice + "EU" when at least one practice country is an EU-27
  // member, so the catalogue opens already filtered to relevant
  // entries. Universal entries (no jurisdictions) always pass.
  const [jurisdictionFilter, setJurisdictionFilter] = useState<Set<string>>(
    () => {
      const initial = new Set<string>();
      let touchesEu = false;
      for (const jurisdiction of practiceJurisdictions) {
        const code = jurisdiction.countryCode.toUpperCase();
        initial.add(code);
        if (EU_MEMBER_STATES.has(code)) {
          touchesEu = true;
        }
      }
      if (touchesEu) {
        initial.add("EU");
      }
      return initial;
    },
  );

  const entries = useMemo(
    () =>
      loadCatalogue().filter((entry) =>
        isCatalogueEntryAvailableDuringOnboarding(entry, {
          unavailableNativeToolBackendSlugs,
        }),
      ),
    [unavailableNativeToolBackendSlugs],
  );
  const selectableEntries = useMemo(
    () =>
      entries.filter(
        (entry) =>
          entry.kind !== "native-tool" ||
          isToggleableNativeToolBackendSlug(entry.backendSlug),
      ),
    [entries],
  );
  const pinnedEntries = useMemo(
    () =>
      entries.filter((entry) => entry.kind === "native-tool" && entry.pinned),
    [entries],
  );
  const pinnedSlugSet = useMemo(
    () => new Set(pinnedEntries.map((entry) => entry.slug)),
    [pinnedEntries],
  );

  const practiceCountryCodes = useMemo(
    () =>
      new Set(
        practiceJurisdictions.map((jurisdiction) =>
          jurisdiction.countryCode.toUpperCase(),
        ),
      ),
    [practiceJurisdictions],
  );
  const recommendedSet = useMemo(
    () => recommendedSlugsForJurisdictions(practiceCountryCodes),
    [practiceCountryCodes],
  );
  const selectedSet = useMemo(() => new Set(selectedSlugs), [selectedSlugs]);

  const recommendedEntries = useMemo(
    () =>
      selectableEntries
        .filter(
          (entry) =>
            recommendedSet.has(entry.slug) && !pinnedSlugSet.has(entry.slug),
        )
        .sort((left, right) =>
          left.displayName.localeCompare(right.displayName),
        ),
    [selectableEntries, recommendedSet, pinnedSlugSet],
  );

  const otherEntries = useMemo(
    () =>
      selectableEntries.filter(
        (entry) =>
          !recommendedSet.has(entry.slug) && !pinnedSlugSet.has(entry.slug),
      ),
    [selectableEntries, recommendedSet, pinnedSlugSet],
  );

  const matchesSearch = (entry: LoadedCatalogueEntry) => {
    const normalised = query.trim().toLowerCase();
    // Jurisdiction filter: pass if no filter active, or entry has
    // any matching jurisdiction, or entry is universal (no
    // jurisdictions). Universal entries surface in any filter scope.
    if (jurisdictionFilter.size > 0 && entry.jurisdictions.length > 0) {
      const hasMatch = entry.jurisdictions.some((code) =>
        jurisdictionFilter.has(code),
      );
      if (!hasMatch) {
        return false;
      }
    }
    if (normalised === "") {
      return true;
    }
    return (
      entry.displayName.toLowerCase().includes(normalised) ||
      entry.description.toLowerCase().includes(normalised) ||
      entry.tags.some((tag) => tag.toLowerCase().includes(normalised))
    );
  };

  // Single flat list of all non-pinned entries that pass the search +
  // jurisdiction filters. Recommended entries are no longer in a
  // separate section — they're just regular entries in this list, and
  // "Vybrat vše doporučené" bulk-adds the ones in `recommendedSet`.
  const filteredEntries = useMemo(
    () =>
      [...recommendedEntries, ...otherEntries]
        .filter(matchesSearch)
        .sort((left, right) =>
          left.displayName.localeCompare(right.displayName),
        ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recommendedEntries, otherEntries, query, jurisdictionFilter],
  );

  const allJurisdictionCodes = useMemo(() => {
    const set = new Set<string>();
    for (const entry of [...recommendedEntries, ...otherEntries]) {
      for (const code of entry.jurisdictions) {
        set.add(code);
      }
    }
    return [...set].sort();
  }, [recommendedEntries, otherEntries]);

  // Clicking a row focuses it on the left and surfaces the iOS
  // Privacy-Nutritional-Label-style detail panel on the right. The
  // user commits (add/remove) from the detail panel — adding never
  // happens directly from the row click. Clicking the same row again
  // collapses focus back to the stack preview.
  const handleRowClick = (entry: LoadedCatalogueEntry) => {
    if (pinnedSlugSet.has(entry.slug)) {
      return;
    }
    onFocusChange(focusedSlug === entry.slug ? null : entry.slug);
  };

  // Auto-select first-party recommended entries on first reach of
  // this step. Third-party entries always require the per-entry
  // acknowledgement via the detail panel and are never auto-added.
  // Explicit removals are tracked by the parent wizard so remounting
  // this step cannot re-add a recommendation the user removed.
  useEffect(() => {
    const autoSelectionPlan = createCatalogueAutoSelectionPlan({
      recommendedEntries,
      removedSlugs,
      selectedSlugs,
    });

    if (autoSelectionPlan.addedSlugs.length > 0) {
      onChange(autoSelectionPlan.selectedSlugs);
    }
  }, [onChange, recommendedEntries, removedSlugs, selectedSlugs]);

  return (
    <>
      <h1 className="text-foreground text-3xl font-light tracking-tight">
        {t("onboarding.catalogueTitle")}
      </h1>
      <p className="text-muted-foreground mt-2 text-sm">
        {t("onboarding.catalogueSubtitle")}
      </p>

      {/* Search input + jurisdiction filter inline on the same row.
          The dropdown trigger summarises the current selection;
          clicking opens a multi-select checklist with an explicit
          "Vše" reset at the top. */}
      <div className="mt-6 flex items-center gap-2">
        <InputGroup className="flex-1">
          <InputGroupAddon>
            <SearchIcon className="text-muted-foreground" />
          </InputGroupAddon>
          <InputGroupInput
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("onboarding.catalogueSearchPlaceholder")}
            value={query}
          />
          {query.length > 0 && (
            <InputGroupAddon align="inline-end">
              <Button
                aria-label={t("onboarding.catalogueClearSearch")}
                onClick={() => setQuery("")}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </InputGroupAddon>
          )}
        </InputGroup>
        <Popover>
          <PopoverTrigger
            render={
              <Button className="shrink-0" type="button" variant="outline" />
            }
          >
            <GlobeIcon className="size-3.5" />
            {jurisdictionFilter.size === 0
              ? t("common.all")
              : [...jurisdictionFilter].sort().join(", ")}
            <ChevronDownIcon className="size-3.5" />
          </PopoverTrigger>
          <PopoverPopup align="end" className="w-60" side="bottom">
            <div className="border-border border-b p-2">
              <InputGroup>
                <InputGroupAddon>
                  <SearchIcon className="text-muted-foreground" />
                </InputGroupAddon>
                <InputGroupInput
                  autoFocus
                  onChange={(e) => setFilterQuery(e.target.value)}
                  placeholder={t("common.search")}
                  size="sm"
                  value={filterQuery}
                />
              </InputGroup>
            </div>
            <div className="flex max-h-[260px] flex-col overflow-y-auto p-1">
              {/* "ALL" — only shown when not filtering, so the user
                  can quickly reset to the unfiltered view. */}
              {filterQuery.trim() === "" && (
                <>
                  <button
                    aria-pressed={jurisdictionFilter.size === 0}
                    className="hover:bg-muted flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors"
                    onClick={() => setJurisdictionFilter(new Set())}
                    type="button"
                  >
                    <span
                      className={cn(
                        "border-border flex size-4 items-center justify-center rounded-sm border",
                        jurisdictionFilter.size === 0 &&
                          "border-foreground bg-foreground",
                      )}
                    >
                      {jurisdictionFilter.size === 0 && (
                        <CheckIcon className="text-background size-3" />
                      )}
                    </span>
                    <span className="text-foreground font-medium">
                      {t("common.all")}
                    </span>
                  </button>
                  <div className="bg-border my-1 h-px" />
                </>
              )}
              {(() => {
                const filtered = allJurisdictionCodes.filter((code) =>
                  code.toLowerCase().includes(filterQuery.trim().toLowerCase()),
                );
                if (filtered.length === 0) {
                  return (
                    <p className="text-muted-foreground px-2 py-3 text-center text-xs">
                      {t("common.noResults")}
                    </p>
                  );
                }
                return filtered.map((code) => {
                  const active = jurisdictionFilter.has(code);
                  return (
                    <button
                      aria-pressed={active}
                      className="hover:bg-muted flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors"
                      key={code}
                      onClick={() =>
                        setJurisdictionFilter((prev) => {
                          const next = new Set(prev);
                          if (next.has(code)) {
                            next.delete(code);
                          } else {
                            next.add(code);
                          }
                          return next;
                        })
                      }
                      type="button"
                    >
                      <span
                        className={cn(
                          "border-border flex size-4 items-center justify-center rounded-sm border",
                          active && "border-foreground bg-foreground",
                        )}
                      >
                        {active && (
                          <CheckIcon className="text-background size-3" />
                        )}
                      </span>
                      <span className="text-foreground">{code}</span>
                    </button>
                  );
                });
              })()}
            </div>
          </PopoverPopup>
        </Popover>
      </div>

      {/* Split list: recommended first, hairline divider with
          "From the community" heading, then everything else. */}
      <div className="mt-3 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pe-1">
        {filteredEntries.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <p className="text-muted-foreground text-xs">
              {t("common.noResults")}
            </p>
            <a
              className="border-border bg-background hover:bg-muted text-foreground inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors"
              href={PROPOSE_TOOL_URL}
              rel="noreferrer"
              target="_blank"
            >
              {t("onboarding.catalogueProposeTool")}
              <ExternalLinkIcon className="size-3" />
            </a>
          </div>
        ) : (
          <>
            {filteredEntries
              .filter((entry) => recommendedSet.has(entry.slug))
              .map((entry) => (
                <OnboardingCatalogueRow
                  addLabel={t("common.add")}
                  entry={entry}
                  focused={focusedSlug === entry.slug}
                  key={`${entry.kind}-${entry.slug}`}
                  onClick={() => handleRowClick(entry)}
                  onToggleSelection={
                    pinnedSlugSet.has(entry.slug)
                      ? undefined
                      : () => {
                          if (selectedSet.has(entry.slug)) {
                            onRemove(entry.slug);
                          } else {
                            onAdd(entry.slug);
                          }
                        }
                  }
                  removeLabel={t("common.remove")}
                  selected={selectedSet.has(entry.slug)}
                />
              ))}
            {filteredEntries.some((entry) => !recommendedSet.has(entry.slug)) &&
              filteredEntries.some((entry) =>
                recommendedSet.has(entry.slug),
              ) && (
                <div className="my-2 flex items-center gap-3">
                  <div className="bg-border h-px flex-1" />
                  <span className="text-muted-foreground text-[10px] font-medium tracking-wider uppercase">
                    {t("onboarding.catalogueCommunityHeading")}
                  </span>
                  <div className="bg-border h-px flex-1" />
                </div>
              )}
            {filteredEntries
              .filter((entry) => !recommendedSet.has(entry.slug))
              .map((entry) => (
                <OnboardingCatalogueRow
                  addLabel={t("common.add")}
                  entry={entry}
                  focused={focusedSlug === entry.slug}
                  key={`${entry.kind}-${entry.slug}`}
                  onClick={() => handleRowClick(entry)}
                  onToggleSelection={
                    pinnedSlugSet.has(entry.slug)
                      ? undefined
                      : () => {
                          if (selectedSet.has(entry.slug)) {
                            onRemove(entry.slug);
                          } else {
                            onAdd(entry.slug);
                          }
                        }
                  }
                  removeLabel={t("common.remove")}
                  selected={selectedSet.has(entry.slug)}
                />
              ))}
            {jurisdictionFilter.size > 0 && (
              <div className="flex justify-center py-2">
                <Button
                  onClick={() => setJurisdictionFilter(new Set())}
                  size="sm"
                  type="button"
                  variant="link"
                >
                  {t("common.showAll")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <p className="text-muted-foreground mt-4 text-xs">
        {t.rich("onboarding.catalogueFootnote", {
          link: (chunks) => (
            <a
              className="hover:text-foreground underline"
              href={PROPOSE_TOOL_URL}
              rel="noreferrer"
              target="_blank"
            >
              {chunks}
            </a>
          ),
        })}
      </p>

      <div className="mt-auto flex items-center justify-between gap-3 pt-8">
        <Button onClick={onSkip} type="button" variant="ghost">
          {t("onboarding.skipStep")}
        </Button>
        <Button onClick={onNext} type="button">
          {selectedSet.size === 0
            ? t("onboarding.continue")
            : t("onboarding.catalogueContinueWithCount", {
                count: selectedSet.size,
              })}
        </Button>
      </div>
    </>
  );
};

type OnboardingCatalogueRowProps = {
  entry: LoadedCatalogueEntry;
  selected: boolean;
  focused: boolean;
  onClick: () => void;
  onToggleSelection?: (() => void) | undefined;
  addLabel: string;
  removeLabel: string;
};

/**
 * Adapter that maps the onboarding-specific `LoadedCatalogueEntry` and
 * selection semantics onto the shared `CatalogueRow`. Direct Add stays
 * limited to first-party entries; third-party additions still flow
 * through the detail-panel acknowledgement.
 */
const OnboardingCatalogueRow = ({
  entry,
  selected,
  focused,
  onClick,
  onToggleSelection,
  addLabel,
  removeLabel,
}: OnboardingCatalogueRowProps) => {
  const isFirstParty = entry.author === "stella";

  const contextActions: readonly ContextMenuAction[] =
    onToggleSelection && selected
      ? [
          {
            label: removeLabel,
            onClick: onToggleSelection,
            variant: "destructive",
          },
        ]
      : [];

  let actions: React.ReactNode = null;
  if (focused && onToggleSelection && (selected || isFirstParty)) {
    actions = (
      <Button
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelection();
        }}
        size="xs"
        type="button"
        variant={selected ? "destructive-outline" : "outline"}
      >
        {selected ? removeLabel : addLabel}
      </Button>
    );
  } else if (selected) {
    actions = <CheckIcon className="text-foreground size-4 shrink-0" />;
  }

  return (
    <CatalogueRow
      accentWhenUnfocused={selected}
      actions={actions}
      contextActions={contextActions}
      display={toRowDisplay(entry)}
      focused={focused}
      onFocus={onClick}
    />
  );
};
