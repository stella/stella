import type { ReactNode } from "react";
import { useState } from "react";

import { SlidersHorizontalIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Popover,
  PopoverPanel,
  PopoverTitle,
  PopoverTrigger,
} from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import {
  FACET_SECTION_LIMIT,
  facetSectionView,
} from "@/components/public-law-table/public-law-facets.logic";
import type {
  FacetItem,
  FacetSourceBucket,
} from "@/components/public-law-table/public-law-facets.logic";
import { useFormatter } from "@/i18n/formatting-context";

type PublicLawFilterPopoverProps = {
  /** How many filters are on; drawn on the button, so a short list is explained. */
  activeFilterCount: number;
  /** The sections, drawn in order: a table's own facets. */
  children: ReactNode;
};

/**
 * Refinement behind one button, so the results keep the width and the search
 * box keeps the page. Every section shows what the corpus actually holds, and
 * the reader's own choice stays visible even once the counts stop reporting
 * it.
 *
 * Nothing here is only in the popover: the button carries the count and the
 * chips under the box name each filter and take it back out, so a reader who
 * never opens this still knows what narrows the list.
 */
export const PublicLawFilterPopover = ({
  activeFilterCount,
  children,
}: PublicLawFilterPopoverProps) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <Popover>
      <PopoverTrigger
        render={<Button className="shrink-0" size="sm" variant="outline" />}
      >
        <SlidersHorizontalIcon aria-hidden="true" className="size-3.5" />
        {t("common.filters")}
        {activeFilterCount > 0 && (
          <span className="bg-primary text-primary-foreground text-3xs inline-flex min-w-4 items-center justify-center rounded-full px-1 leading-4 font-medium tabular-nums">
            {format.number(activeFilterCount)}
          </span>
        )}
      </PopoverTrigger>
      <PopoverPanel
        align="start"
        className="w-72 max-w-[calc(100vw-2rem)]"
        contentClassName="gap-5"
      >
        {/* The trigger names the button, not the portaled popup. */}
        <PopoverTitle className="sr-only">{t("common.filters")}</PopoverTitle>
        {children}
      </PopoverPanel>
    </Popover>
  );
};

export const FilterSectionHeading = ({ children }: { children: ReactNode }) => (
  <h3 className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
    {children}
  </h3>
);

type FacetSectionProps = {
  buckets: readonly FacetSourceBucket[];
  /**
   * Already translated. A `TranslationKey` prop would hand `t()` the whole
   * key union at this call site, which costs more to instantiate than the
   * section is worth.
   */
  heading: string;
  /** How many items show before "Show all"; the shared default otherwise. */
  limit?: number | undefined;
  /** The radio group's name: unique per popover. */
  name: string;
  onSelect: (value: string | undefined) => void;
  selectedValue: string | undefined;
};

/** One facet as a single-choice section; drawn only while it has a choice. */
export const FacetSection = ({
  buckets,
  heading,
  limit = FACET_SECTION_LIMIT,
  name,
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
      <FilterSectionHeading>{heading}</FilterSectionHeading>
      <FacetOptions
        groupLabel={heading}
        items={items}
        name={name}
        onSelect={onSelect}
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

export const ShowAllButton = ({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) => (
  <button
    className="text-muted-foreground hover:text-foreground -mx-1 min-h-11 px-1 py-1.5 text-xs transition-colors"
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
export const FacetOptions = ({
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
            <label className="hover:bg-muted/60 has-[:focus-visible]:ring-ring flex min-h-11 cursor-pointer items-center gap-2 rounded-sm py-1.5 ps-1 pe-1 text-xs transition-colors has-[:focus-visible]:ring-2">
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
                <span className="text-muted-foreground text-2xs shrink-0 tabular-nums">
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
