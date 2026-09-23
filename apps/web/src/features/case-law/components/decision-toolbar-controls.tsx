/**
 * The two toolbar choices only the decision table has: the order of a text
 * search, and how much of each matched passage a row carries.
 */

import { useTranslations } from "use-intl";

import type { SearchExcerpt, SearchSort } from "@stll/api-contract/search";

import { ToolbarSelect } from "@/components/public-law-table/public-law-results-toolbar";
import type { TranslationKey } from "@/i18n/types";

const SORT_OPTIONS = [
  { value: "relevance", labelKey: "caseLaw.sort.relevance" },
  { value: "newest", labelKey: "caseLaw.sort.newest" },
] as const satisfies readonly { value: SearchSort; labelKey: TranslationKey }[];

// Every order is offered, always: an order the control drops is one the reader
// cannot get back to.
type OfferedSort = (typeof SORT_OPTIONS)[number]["value"];
true satisfies SearchSort extends OfferedSort ? true : never;

export const DecisionSortControl = ({
  onSortChange,
  sort,
}: {
  onSortChange: (sort: SearchSort) => void;
  sort: SearchSort;
}) => {
  const t = useTranslations();

  return (
    <ToolbarSelect
      label={t("common.sort")}
      onValueChange={onSortChange}
      options={SORT_OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.labelKey),
      }))}
      value={sort}
    />
  );
};

/**
 * How much of the matched passage a row carries, shortest first: the reader
 * trades reading the hit in context against fitting more hits on the screen.
 */
const EXCERPT_OPTIONS = [
  { value: "short", labelKey: "caseLaw.results.excerpt.short" },
  { value: "medium", labelKey: "caseLaw.results.excerpt.medium" },
  { value: "long", labelKey: "caseLaw.results.excerpt.long" },
] as const satisfies readonly {
  value: SearchExcerpt;
  labelKey: TranslationKey;
}[];

// Every length is offered, always: a length the control drops is one the
// reader cannot get back to, and a stored preference nothing can undo.
type OfferedExcerpt = (typeof EXCERPT_OPTIONS)[number]["value"];
true satisfies SearchExcerpt extends OfferedExcerpt ? true : never;

export const DecisionExcerptControl = ({
  excerpt,
  onExcerptChange,
}: {
  excerpt: SearchExcerpt;
  onExcerptChange: (excerpt: SearchExcerpt) => void;
}) => {
  const t = useTranslations();

  return (
    <ToolbarSelect
      label={t("caseLaw.results.excerpt.label")}
      onValueChange={onExcerptChange}
      options={EXCERPT_OPTIONS.map((option) => ({
        value: option.value,
        label: t(option.labelKey),
      }))}
      value={excerpt}
    />
  );
};
