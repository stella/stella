import type { ReactNode } from "react";
import { useId, useState } from "react";

import { ChevronRightIcon, SlidersHorizontalIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import {
  Sheet,
  SheetPanel,
  SheetPopup,
  SheetTitle,
  SheetTrigger,
} from "@stll/ui/sheet";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import type { CaseLawFilterKey } from "@/features/case-law/case-law-index-search.logic";
import {
  COLLAPSED_COURT_TIERS,
  COURT_TIER_LABEL_KEYS,
  FACET_SECTION_LIMIT,
  facetSectionView,
  YEAR_SECTION_LIMIT,
} from "@/features/case-law/facet-rail.logic";
import type {
  DecisionRailFacets,
  FacetItem,
  FacetSourceBucket,
} from "@/features/case-law/facet-rail.logic";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";

/** What the URL selects, one value per facet. */
type DecisionFacetSelection = Record<CaseLawFilterKey, string | undefined>;

type DecisionFacetRailProps = {
  facets: DecisionRailFacets;
  onSelect: (key: CaseLawFilterKey, value: string | undefined) => void;
  selection: DecisionFacetSelection;
};

/**
 * Refinement beside the results rather than in front of them: every section
 * shows what the current result set actually holds, so a filter can never
 * lead to an empty page, and the reader's own choice stays visible even once
 * the counts stop reporting it.
 *
 * One column on a wide screen, a sheet behind a button on a narrow one; both
 * draw the same sections from the same facets.
 */
export const DecisionFacetRail = ({
  facets,
  onSelect,
  selection,
}: DecisionFacetRailProps) => {
  const t = useTranslations();

  return (
    <>
      <aside
        aria-label={t("common.filter")}
        // Bounded inside the sticky context, so the rail scrolls on its own
        // instead of stranding its lower sections below the fold: the page's
        // scrollport is the results `main` under the 3rem top bar, and the
        // extra rem is the gap the rail keeps above `main`'s bottom padding.
        className="sticky top-0 hidden max-h-[calc(100dvh-4rem)] w-60 shrink-0 self-start overflow-y-auto pe-2 lg:block"
      >
        <FacetSections
          facets={facets}
          onSelect={onSelect}
          selection={selection}
        />
      </aside>
      <Sheet>
        <SheetTrigger
          render={<Button className="lg:hidden" size="sm" variant="outline" />}
        >
          <SlidersHorizontalIcon aria-hidden="true" className="size-3.5" />
          {t("common.filter")}
        </SheetTrigger>
        <SheetPopup side="inline-start">
          <SheetTitle className="p-6 pb-0 text-base">
            {t("common.filter")}
          </SheetTitle>
          <SheetPanel>
            <FacetSections
              facets={facets}
              onSelect={onSelect}
              selection={selection}
            />
          </SheetPanel>
        </SheetPopup>
      </Sheet>
    </>
  );
};

/** Sections the rail always has something to say about, for the pending shape. */
const SKELETON_SECTION_KEYS = [
  "common.court",
  "workspaces.views.calendar.year",
  "common.type",
] as const satisfies readonly TranslationKey[];

/** The rail's shape while the results are still loading. */
export const DecisionFacetRailSkeleton = () => {
  const t = useTranslations();

  return (
    <aside
      aria-label={t("common.filter")}
      className="hidden w-60 shrink-0 flex-col gap-5 self-start pe-2 lg:flex"
    >
      {SKELETON_SECTION_KEYS.map((key) => (
        <section key={key}>
          <SectionHeading>{t(key)}</SectionHeading>
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        </section>
      ))}
    </aside>
  );
};

const FacetSections = ({
  facets,
  onSelect,
  selection,
}: DecisionFacetRailProps) => {
  const t = useTranslations();

  return (
    <div className="flex flex-col gap-5">
      {facets.courtTiers.length > 0 && (
        <section>
          <SectionHeading>{t("common.court")}</SectionHeading>
          <div className="flex flex-col gap-3">
            {facets.courtTiers.map(({ courts, tier }) => (
              <CourtTierSection
                courts={courts}
                key={tier ?? "untiered"}
                onSelect={(value) => onSelect("court", value)}
                selectedValue={selection.court}
                tier={tier}
              />
            ))}
          </div>
        </section>
      )}
      <FacetSection
        buckets={facets.year}
        filterKey="year"
        heading={t("workspaces.views.calendar.year")}
        limit={YEAR_SECTION_LIMIT}
        onSelect={onSelect}
        selectedValue={selection.year}
      />
      <FacetSection
        buckets={facets.decisionType}
        filterKey="type"
        heading={t("common.type")}
        limit={FACET_SECTION_LIMIT}
        onSelect={onSelect}
        selectedValue={selection.type}
      />
      <FacetSection
        buckets={facets.source}
        filterKey="source"
        heading={t("common.source")}
        limit={FACET_SECTION_LIMIT}
        onSelect={onSelect}
        selectedValue={selection.source}
      />
      {/* One language is the corpus's language, not a choice. */}
      {facets.language.length > 1 && (
        <FacetSection
          buckets={facets.language}
          filterKey="lang"
          heading={t("common.language")}
          limit={FACET_SECTION_LIMIT}
          onSelect={onSelect}
          selectedValue={selection.lang}
        />
      )}
    </div>
  );
};

const SectionHeading = ({ children }: { children: ReactNode }) => (
  <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
    {children}
  </h3>
);

type FacetSectionProps = {
  buckets: readonly FacetSourceBucket[];
  filterKey: CaseLawFilterKey;
  /**
   * Already translated. A `TranslationKey` prop would hand `t()` the whole
   * key union at this call site, which costs more to instantiate than the
   * section is worth.
   */
  heading: string;
  limit: number;
  onSelect: (key: CaseLawFilterKey, value: string | undefined) => void;
  selectedValue: string | undefined;
};

const FacetSection = ({
  buckets,
  filterKey,
  heading,
  limit,
  onSelect,
  selectedValue,
}: FacetSectionProps) => {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);
  const { hiddenCount, items } = facetSectionView({
    buckets,
    expanded,
    limit,
    selectedValue,
  });
  if (items.length === 0) {
    return null;
  }

  return (
    <section>
      <SectionHeading>{heading}</SectionHeading>
      <FacetOptions
        groupLabel={heading}
        items={items}
        name={filterKey}
        onSelect={(value) => onSelect(filterKey, value)}
        selectedValue={selectedValue}
      />
      {hiddenCount > 0 && (
        <ShowAllButton onClick={() => setExpanded(true)}>
          {t("common.showAll")}
        </ShowAllButton>
      )}
    </section>
  );
};

const CourtTierSection = ({
  courts,
  onSelect,
  selectedValue,
  tier,
}: {
  courts: readonly FacetSourceBucket[];
  onSelect: (value: string | undefined) => void;
  selectedValue: string | undefined;
  tier: CourtTierBucketsTier;
}) => {
  const t = useTranslations();
  const panelId = useId();
  const collapsedByDefault =
    tier !== null && COLLAPSED_COURT_TIERS.includes(tier);
  const selectedHere = courts.some((court) => court.value === selectedValue);
  const [open, setOpen] = useState(!collapsedByDefault);
  const [showAll, setShowAll] = useState(false);
  const { hiddenCount, items } = facetSectionView({
    buckets: courts,
    expanded: showAll,
    limit: FACET_SECTION_LIMIT,
    // A tier the selection is not in must not pull the selection into itself.
    selectedValue: selectedHere ? selectedValue : undefined,
  });
  if (items.length === 0) {
    return null;
  }
  if (tier === null) {
    return (
      <div>
        <FacetOptions
          groupLabel={t("common.court")}
          items={items}
          name="court"
          onSelect={onSelect}
          selectedValue={selectedValue}
        />
        {hiddenCount > 0 && (
          <ShowAllButton onClick={() => setShowAll(true)}>
            {t("common.showAll")}
          </ShowAllButton>
        )}
      </div>
    );
  }

  // A tier holding the reader's own choice opens whatever its default was.
  const expanded = open || selectedHere;
  return (
    <div>
      <button
        aria-controls={panelId}
        aria-expanded={expanded}
        className="text-foreground-strong-muted hover:text-foreground flex w-full items-center gap-1 py-1 text-start text-xs font-medium transition-colors"
        onClick={() => setOpen(!expanded)}
        type="button"
      >
        <DirectionalIcon
          className={cn(
            "size-3 shrink-0 transition-transform",
            expanded && "rotate-90",
          )}
          flip={!expanded}
          icon={ChevronRightIcon}
        />
        {t(COURT_TIER_LABEL_KEYS[tier])}
      </button>
      <div hidden={!expanded} id={panelId}>
        <FacetOptions
          groupLabel={t(COURT_TIER_LABEL_KEYS[tier])}
          items={items}
          name={`court-${tier}`}
          onSelect={onSelect}
          selectedValue={selectedValue}
        />
        {hiddenCount > 0 && (
          <ShowAllButton onClick={() => setShowAll(true)}>
            {t("common.showAll")}
          </ShowAllButton>
        )}
      </div>
    </div>
  );
};

type CourtTierBucketsTier = DecisionRailFacets["courtTiers"][number]["tier"];

const ShowAllButton = ({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) => (
  <button
    className="text-muted-foreground hover:text-foreground -mx-1 px-1 py-1.5 text-xs transition-colors"
    onClick={onClick}
    type="button"
  >
    {children}
  </button>
);

/**
 * One choice out of a section. Native radios, so the group is a group to a
 * screen reader and arrow keys move through it without a roving-tabindex
 * imitation; clicking the chosen one again clears the filter, which a radio
 * group alone cannot express.
 */
const FacetOptions = ({
  groupLabel,
  items,
  name,
  onSelect,
  selectedValue,
}: {
  groupLabel: string;
  items: readonly FacetItem[];
  name: string;
  onSelect: (value: string | undefined) => void;
  selectedValue: string | undefined;
}) => {
  const format = useFormatter();

  return (
    <ul aria-label={groupLabel} className="flex flex-col">
      {items.map((item) => {
        const checked = item.value === selectedValue;
        return (
          <li key={item.value}>
            <label className="hover:bg-muted/60 has-[:focus-visible]:ring-ring flex cursor-pointer items-center gap-2 rounded-sm py-1.5 ps-1 pe-1 text-xs transition-colors has-[:focus-visible]:ring-2">
              <input
                checked={checked}
                className="accent-primary size-3.5 shrink-0"
                name={name}
                onChange={() => onSelect(item.value)}
                onClick={() => {
                  if (checked) {
                    onSelect(undefined);
                  }
                }}
                type="radio"
                value={item.value}
              />
              <BidiText
                as="span"
                className={cn(
                  "min-w-0 flex-1 truncate",
                  checked ? "text-foreground font-medium" : "text-foreground",
                )}
                title={item.label}
              >
                {item.label}
              </BidiText>
              {item.count !== null && (
                <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                  {format.number(item.count)}
                </span>
              )}
            </label>
          </li>
        );
      })}
    </ul>
  );
};
