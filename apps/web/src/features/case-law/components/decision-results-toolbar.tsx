import type { ReactNode } from "react";
import { useState } from "react";

import { SearchIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { DECISION_SORT_ORDERS } from "@/features/case-law/case-law-index-search.logic";
import type { DecisionSortOrder } from "@/features/case-law/case-law-index-search.logic";
import { DecisionColumnChooser } from "@/features/case-law/components/decision-table";
import type { TranslationKey } from "@/i18n/types";

const SORT_LABEL_KEYS = {
  relevance: "caseLaw.sort.relevance",
  newest: "caseLaw.sort.newest",
} as const satisfies Record<DecisionSortOrder, TranslationKey>;

type DecisionResultsToolbarProps = {
  /**
   * What the reader can do with the whole result set, drawn last. A node
   * rather than props, so the toolbar owes nothing to the research slice.
   */
  actions?: ReactNode;
  hiddenColumnIds: readonly string[];
  onHiddenColumnIdsChange: (hiddenColumnIds: string[]) => void;
  /** Adds the entry to the query as one more thing every hit must say. */
  onRefine: (entry: string) => void;
  onSortChange: (sort: DecisionSortOrder) => void;
  /** Null while browsing, where the list is newest-first by definition. */
  sort: DecisionSortOrder | null;
  /** What the list is: a count, or what the query matched. */
  summary: ReactNode;
};

/**
 * What the reader does to the result set: read how large it is, narrow it,
 * order it, and choose what each row shows. One scrolling row, so a narrow
 * viewport drops nothing.
 */
export const DecisionResultsToolbar = ({
  actions,
  hiddenColumnIds,
  onHiddenColumnIdsChange,
  onRefine,
  onSortChange,
  sort,
  summary,
}: DecisionResultsToolbarProps) => {
  const t = useTranslations();

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      <div className="text-muted-foreground min-w-0 flex-1 text-xs">
        {summary}
      </div>
      <div className="flex min-w-0 shrink-0 [scrollbar-width:none] items-center gap-1 [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        <RefineWithinResults onRefine={onRefine} />
        {sort !== null && (
          <>
            <span className="bg-border mx-1 h-4 w-px" />
            <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
              {t("common.sort")}
            </span>
            <Select
              onValueChange={(value: string | null) => {
                const next = DECISION_SORT_ORDERS.find(
                  (order) => order === value,
                );
                if (next !== undefined) {
                  onSortChange(next);
                }
              }}
              value={sort}
            >
              <SelectTrigger
                aria-label={t("common.sort")}
                className="h-7 min-h-0 w-auto min-w-28 text-xs"
                size="sm"
              >
                <SelectValue>{t(SORT_LABEL_KEYS[sort])}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {DECISION_SORT_ORDERS.map((order) => (
                  <SelectItem key={order} value={order}>
                    {t(SORT_LABEL_KEYS[order])}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </>
        )}
        <span className="bg-border mx-1 h-4 w-px" />
        <DecisionColumnChooser
          hiddenColumnIds={hiddenColumnIds}
          onHiddenColumnIdsChange={onHiddenColumnIdsChange}
        />
        {actions}
      </div>
    </div>
  );
};

/**
 * One more word every hit has to carry. It is written into the query itself,
 * because the query is the only text the search reads; the chips below say
 * which words came from here, and take them back out.
 */
const RefineWithinResults = ({
  onRefine,
}: {
  onRefine: (entry: string) => void;
}) => {
  const t = useTranslations();
  const [entry, setEntry] = useState("");

  return (
    <form
      className="relative"
      onSubmit={(event) => {
        event.preventDefault();
        onRefine(entry);
        setEntry("");
      }}
    >
      <SearchIcon
        aria-hidden="true"
        className="text-muted-foreground pointer-events-none absolute start-2 top-1/2 size-3.5 -translate-y-1/2"
      />
      <Input
        aria-label={t("caseLaw.refineWithinResults")}
        className="h-7 min-h-0 w-40 ps-7 text-xs sm:w-52"
        onChange={(event) => setEntry(event.target.value)}
        placeholder={t("caseLaw.refineWithinResults")}
        type="search"
        value={entry}
      />
    </form>
  );
};

export type DecisionFilterChip = {
  /** Stable within the row, so removing one does not remount the rest. */
  id: string;
  /**
   * Which facet the value came from, already translated. Absent for a value
   * that names its own kind, such as a quoted phrase.
   */
  kind?: string;
  value: string;
  onRemove: () => void;
};

/**
 * What the result set is narrowed by, and the way back out of each one. The
 * row exists only while something is on it.
 */
export const DecisionFilterChips = ({
  chips,
  onClearAll,
}: {
  chips: readonly DecisionFilterChip[];
  onClearAll: () => void;
}) => {
  const t = useTranslations();
  if (chips.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <span
          className="border-border/70 bg-muted/40 inline-flex max-w-full items-center gap-1.5 rounded-md border py-0.5 ps-2 pe-0.5 text-xs"
          key={chip.id}
        >
          {chip.kind !== undefined && (
            <span className="text-muted-foreground shrink-0">{chip.kind}</span>
          )}
          <BidiText as="span" className="min-w-0 truncate">
            {chip.value}
          </BidiText>
          <Button
            aria-label={t("caseLaw.filters.remove", { filter: chip.value })}
            className="text-muted-foreground hover:text-foreground size-5 min-h-0 shrink-0 p-0"
            onClick={chip.onRemove}
            size="icon-xs"
            type="button"
            variant="ghost"
          >
            <XIcon aria-hidden="true" className="size-3" />
          </Button>
        </span>
      ))}
      <Button
        className="text-muted-foreground h-6 min-h-0 text-xs"
        onClick={onClearAll}
        size="sm"
        type="button"
        variant="ghost"
      >
        {t("workspaces.views.clearFilters")}
      </Button>
    </div>
  );
};
