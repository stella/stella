import type { ComponentType, ReactNode } from "react";

import { AlignJustifyIcon, WrapTextIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { SEARCH_EXCERPTS, SEARCH_SORTS } from "@stll/api-contract/search";
import type { SearchExcerpt, SearchSort } from "@stll/api-contract/search";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { SegmentedIconToggle } from "@stll/ui/segmented-icon-toggle";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { DecisionColumnToggle } from "@/features/case-law/components/decision-column-toggle";
import type { DecisionTableLayout } from "@/features/case-law/decision-column-preferences.logic";
import type { DecisionContentMode } from "@/features/case-law/decision-columns.logic";
import type { QuestionColumnSurface } from "@/features/case-law/research/question-columns.logic";
import type { TranslationKey } from "@/i18n/types";

const SORT_LABEL_KEYS = {
  relevance: "caseLaw.sort.relevance",
  newest: "caseLaw.sort.newest",
} as const satisfies Record<SearchSort, TranslationKey>;

type DecisionResultsToolbarProps = {
  /**
   * What the reader can do with the whole result set, drawn last. A node
   * rather than props, so the toolbar owes nothing to the research slice.
   *
   * Outside the scrolling control row: these are the row's only write
   * affordances, and the row hides its scrollbar, so a narrow viewport used
   * to carry them off the end with nothing to say they were there.
   */
  actions?: ReactNode;
  /**
   * The excerpt length the rows are drawn at, or null where there are no
   * matched passages to widen. A browse listing shows each decision's own
   * headnote, so the control would be one the reader could move without
   * anything changing. Not `sort`'s nullness: an identifier lookup has no
   * order to choose either, and still shows passages.
   */
  excerpt: SearchExcerpt | null;
  /**
   * What narrows the result set, drawn first: the filter popover's own
   * button. A node rather than props, so the toolbar owes nothing to the
   * facet model it never reads.
   */
  filters: ReactNode;
  /** Find-in-table: the shared bar, in the place a matter's toolbar keeps it. */
  find: ReactNode;
  layout: DecisionTableLayout;
  onLayoutChange: (layout: DecisionTableLayout) => void;
  /** Drawn in the column chooser too, so a question can be hidden like any column. */
  questions: QuestionColumnSurface;
  onSortChange: (sort: SearchSort) => void;
  /** Null while browsing, where the list is newest-first by definition. */
  sort: SearchSort | null;
  /** What the list is: a count, or what the query matched. */
  summary: ReactNode;
};

/**
 * What the reader does to the result set: read how large it is, narrow it,
 * order it, and choose what each row shows. The reading controls scroll as one
 * row, so a narrow viewport drops none of them; the actions wrap beside it
 * instead, because a write affordance that scrolls out of a scrollbar-less row
 * is one the reader cannot find.
 */
export const DecisionResultsToolbar = ({
  actions,
  excerpt,
  filters,
  find,
  layout,
  onLayoutChange,
  onSortChange,
  questions,
  sort,
  summary,
}: DecisionResultsToolbarProps) => {
  const t = useTranslations();

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {filters}
      <div className="text-muted-foreground min-w-0 flex-1 text-xs">
        {summary}
      </div>
      <div className="flex max-w-full min-w-0 shrink-0 [scrollbar-width:none] items-center gap-1 overflow-x-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {find}
        {sort !== null && (
          <>
            <span className="bg-border mx-1 h-4 w-px" />
            <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
              {t("common.sort")}
            </span>
            <Select
              onValueChange={(value: string | null) => {
                const next = SEARCH_SORTS.find((order) => order === value);
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
                {SEARCH_SORTS.map((order) => (
                  <SelectItem key={order} value={order}>
                    {t(SORT_LABEL_KEYS[order])}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </>
        )}
        <span className="bg-border mx-1 h-4 w-px" />
        <SegmentedIconToggle
          onChange={(contentMode) => onLayoutChange({ ...layout, contentMode })}
          options={TABLE_CONTENT_MODE_OPTIONS.map((option) => ({
            value: option.mode,
            icon: option.icon,
            label: t(option.labelKey),
          }))}
          value={layout.contentMode}
        />
        {excerpt !== null && (
          <>
            <span className="bg-border mx-1 h-4 w-px" />
            <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
              {t("caseLaw.results.excerpt.label")}
            </span>
            <Select
              onValueChange={(value: string | null) => {
                const chosen = SEARCH_EXCERPTS.find(
                  (length) => length === value,
                );
                if (chosen !== undefined) {
                  onLayoutChange({ ...layout, excerpt: chosen });
                }
              }}
              value={excerpt}
            >
              <SelectTrigger
                aria-label={t("caseLaw.results.excerpt.label")}
                className="h-7 min-h-0 w-auto min-w-28 text-xs"
                size="sm"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {EXCERPT_OPTIONS.map((option) => (
                  <SelectItem key={option.excerpt} value={option.excerpt}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </>
        )}
        <DecisionColumnToggle
          layout={layout}
          onLayoutChange={onLayoutChange}
          questions={questions}
        />
      </div>
      {actions !== undefined && (
        <div className="flex shrink-0 items-center gap-1">
          <span className="bg-border mx-1 h-4 w-px" />
          {actions}
        </div>
      )}
    </div>
  );
};

/**
 * How much of a prose cell a row shows. The same two modes, icons and words as
 * the workspace table's own density control; the state is this page's, because
 * a public results table has no view to hang it on.
 */
const TABLE_CONTENT_MODE_OPTIONS = [
  {
    mode: "tight",
    icon: AlignJustifyIcon,
    labelKey: "workspaces.table.tightContent",
  },
  {
    mode: "fit-content",
    icon: WrapTextIcon,
    labelKey: "workspaces.table.wrapContent",
  },
] as const satisfies readonly {
  mode: DecisionContentMode;
  icon: ComponentType<{ className?: string }>;
  labelKey: TranslationKey;
}[];

// Every mode is offered, always: a control that silently dropped one would be
// a mode the reader cannot get back to.
type OfferedContentMode = (typeof TABLE_CONTENT_MODE_OPTIONS)[number]["mode"];
true satisfies DecisionContentMode extends OfferedContentMode ? true : never;

/**
 * How much of the matched passage a row carries, shortest first: the reader
 * trades reading the hit in context against fitting more hits on the screen.
 */
const EXCERPT_OPTIONS = [
  { excerpt: "short", labelKey: "caseLaw.results.excerpt.short" },
  { excerpt: "medium", labelKey: "caseLaw.results.excerpt.medium" },
  { excerpt: "long", labelKey: "caseLaw.results.excerpt.long" },
] as const satisfies readonly {
  excerpt: SearchExcerpt;
  labelKey: TranslationKey;
}[];

// Every length is offered, always: a length the control drops is one the
// reader cannot get back to, and a stored preference nothing can undo.
type OfferedExcerpt = (typeof EXCERPT_OPTIONS)[number]["excerpt"];
true satisfies SearchExcerpt extends OfferedExcerpt ? true : never;

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
