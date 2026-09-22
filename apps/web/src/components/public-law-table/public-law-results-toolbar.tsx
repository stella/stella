import type { ComponentType, ReactNode } from "react";

import { AlignJustifyIcon, WrapTextIcon, XIcon } from "lucide-react";
import { useTranslations } from "use-intl";

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

import type { PublicLawTableLayout } from "@/components/public-law-table/public-law-table-layout.logic";
import { ColumnToggle } from "@/components/workspaces/table/column-toggle";
import type { ColumnToggleGroup } from "@/components/workspaces/table/column-toggle";
import type { TranslationKey } from "@/i18n/types";
import type { TableContentMode } from "@/lib/workspaces/table-store.logic";

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
  onLayoutChange: (layout: TLayout) => void;
  /** The order control, or nothing where no order is the reader's to choose. */
  sort?: ReactNode | undefined;
  /** What the list is: a count, or what the query matched. */
  summary: ReactNode;
};

/**
 * What the reader does to a public-law result set: read how large it is,
 * narrow it, order it, and choose what each row shows. The reading controls
 * scroll as one row, so a narrow viewport drops none of them; the actions wrap
 * beside it instead, because a write affordance that scrolls out of a
 * scrollbar-less row is one the reader cannot find.
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
}: PublicLawResultsToolbarProps<TLayout>) => {
  const t = useTranslations();

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {filters}
      <div className="text-muted-foreground min-w-0 flex-1 text-xs">
        {summary}
      </div>
      <div className="flex max-w-full min-w-0 shrink-0 [scrollbar-width:none] items-center gap-1 overflow-x-auto [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
        {find}
        {sort !== undefined && (
          <>
            <ToolbarDivider />
            {sort}
          </>
        )}
        <ToolbarDivider />
        <SegmentedIconToggle
          onChange={(contentMode) => onLayoutChange({ ...layout, contentMode })}
          options={TABLE_CONTENT_MODE_OPTIONS.map((option) => ({
            value: option.mode,
            icon: option.icon,
            label: t(option.labelKey),
          }))}
          value={layout.contentMode}
        />
        {controls !== undefined && (
          <>
            <ToolbarDivider />
            {controls}
          </>
        )}
        <ColumnToggle
          groups={columnGroups}
          hidden={layout.hidden}
          onChange={(hidden) => onLayoutChange({ ...layout, hidden })}
        />
      </div>
      {actions !== undefined && (
        <div className="flex shrink-0 items-center gap-1">
          <ToolbarDivider />
          {actions}
        </div>
      )}
    </div>
  );
};

/** The hairline between two groups of controls. */
const ToolbarDivider = () => <span className="bg-border mx-1 h-4 w-px" />;

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
    <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
      {label}
    </span>
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

/**
 * How much of a prose cell a row shows. The same two modes, icons and words as
 * the workspace table's own density control; the state is the page's, because
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
  mode: TableContentMode;
  icon: ComponentType<{ className?: string }>;
  labelKey: TranslationKey;
}[];

// Every mode is offered, always: a control that silently dropped one would be
// a mode the reader cannot get back to.
type OfferedContentMode = (typeof TABLE_CONTENT_MODE_OPTIONS)[number]["mode"];
true satisfies TableContentMode extends OfferedContentMode ? true : never;

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
        className="text-muted-foreground h-6 min-h-0"
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
