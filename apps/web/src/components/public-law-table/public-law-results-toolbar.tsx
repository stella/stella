import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { XIcon } from "@stll/ui/icons";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { TruncatedText } from "@stll/ui/truncated-text";

import {
  PublicLawContentModeToggle,
  PublicLawResultsToolbarFace,
  PublicLawToolbarSelectLabel,
} from "@/components/public-law-table/public-law-results-toolbar.pending";
import type {
  PublicLawTableLayout,
  PublicLawTableLayoutUpdate,
} from "@/components/public-law-table/public-law-table-layout.logic";
import { ColumnToggle } from "@/components/workspaces/table/column-toggle";
import type { ColumnToggleGroup } from "@/components/workspaces/table/column-toggle";

type PublicLawResultsToolbarProps<TLayout extends PublicLawTableLayout> = {
  /**
   * What the reader can do with the whole result set, drawn last.
   *
   * Outside the scrolling control row: these are the row's only write
   * affordances, and the row hides its scrollbar, so a narrow viewport used
   * to carry them off the end with nothing to say they were there.
   */
  actions?: ReactNode | undefined;
  /** The columns the reader may show or hide, grouped as they think of them. */
  columnGroups: readonly ColumnToggleGroup[];
  /**
   * Controls only one table has, drawn between the density toggle and the
   * column chooser: the decision table's excerpt length.
   */
  controls?: ReactNode | undefined;
  /**
   * What narrows the result set, drawn first: the filter popover's own
   * button. A node rather than props, so the toolbar owes nothing to the
   * facet model it never reads.
   */
  filters: ReactNode;
  /** Find-in-table: the shared bar, in the place a matter's toolbar keeps it. */
  find: ReactNode;
  layout: TLayout;
  onLayoutChange: (update: PublicLawTableLayoutUpdate<TLayout>) => void;
  /** The order control, or nothing where no order is the reader's to choose. */
  sort?: ReactNode | undefined;
  /** What the list is: a count, or what the query matched. */
  summary: ReactNode;
};

/**
 * The results toolbar with its controls: the frame the pending view shares,
 * holding the density toggle and the column chooser that act on the layout.
 */
export const PublicLawResultsToolbar = <TLayout extends PublicLawTableLayout>({
  actions,
  columnGroups,
  controls,
  filters,
  find,
  layout,
  onLayoutChange,
  sort,
  summary,
}: PublicLawResultsToolbarProps<TLayout>) => (
  <PublicLawResultsToolbarFace
    actions={actions}
    columns={
      <ColumnToggle
        groups={columnGroups}
        hidden={layout.hidden}
        onChange={(hidden) =>
          onLayoutChange((latest) => ({ ...latest, hidden }))
        }
      />
    }
    contentMode={
      <PublicLawContentModeToggle
        onChange={(contentMode) =>
          onLayoutChange((latest) => ({ ...latest, contentMode }))
        }
        value={layout.contentMode}
      />
    }
    controls={controls}
    filters={filters}
    find={find}
    sort={sort}
    summary={summary}
  />
);

type ToolbarSelectProps<TValue extends string> = {
  /** Already translated; drawn beside the control from `sm` up. */
  label: string;
  onValueChange: (value: TValue) => void;
  /** Every value the control offers, in order, with its translated label. */
  options: readonly { value: TValue; label: string }[];
  value: TValue;
};

/**
 * One labelled choice in the toolbar (an order, an excerpt length). Only a
 * value the options hold is ever handed back.
 */
export const ToolbarSelect = <TValue extends string>({
  label,
  onValueChange,
  options,
  value,
}: ToolbarSelectProps<TValue>) => (
  <>
    <PublicLawToolbarSelectLabel>{label}</PublicLawToolbarSelectLabel>
    <Select
      onValueChange={(next: string | null) => {
        const chosen = options.find((option) => option.value === next);
        if (chosen !== undefined) {
          onValueChange(chosen.value);
        }
      }}
      value={value}
    >
      <SelectTrigger
        aria-label={label}
        className="h-7 min-h-0 w-auto min-w-28"
        size="sm"
      >
        <SelectValue>
          {options.find((option) => option.value === value)?.label}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  </>
);

export type PublicLawFilterChip = {
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
export const PublicLawFilterChips = ({
  chips,
  onClearAll,
}: {
  chips: readonly PublicLawFilterChip[];
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
          <TruncatedText render={<BidiText as="span" />}>
            {chip.value}
          </TruncatedText>
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
        className="text-muted-foreground h-6 min-h-0"
        onClick={onClearAll}
        size="sm"
        type="button"
        variant="ghost"
      >
        {t("common.clearFilters")}
      </Button>
    </div>
  );
};
