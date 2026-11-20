import type { ComponentType, ReactNode } from "react";

import type { TableContentMode } from "@stll/api-contract/public-law-table";
import {
  ButtonFace,
  FaceLabelPending,
  SegmentedIconToggleFace,
  SelectTriggerFace,
} from "@stll/ui/control-face";
import {
  AlignJustifyIcon,
  EyeIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  WrapTextIcon,
} from "@stll/ui/icons";

import { PendingText } from "@/components/pending-text";
import type { TranslationKey } from "@/i18n/types";

// The results toolbar's frame and the faces of its controls. A route's pending
// view fills the frame with the faces; the page fills the same frame with the
// controls (the filter popover, the find bar, the column chooser), so the row
// holds still when the page arrives.

type PublicLawResultsToolbarFaceProps = {
  /**
   * What the reader can do with the whole result set, drawn last.
   *
   * Outside the scrolling control row: these are the row's only write
   * affordances, and the row hides its scrollbar, so a narrow viewport used
   * to carry them off the end with nothing to say they were there.
   */
  actions?: ReactNode | undefined;
  /** The column chooser, drawn at the end of the control row. */
  columns: ReactNode;
  /** The density toggle: how much of a prose cell a row shows. */
  contentMode: ReactNode;
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
  /** The order control, or nothing where no order is the reader's to choose. */
  sort?: ReactNode | undefined;
  /** What the list is: a count, or what the query matched. */
  summary: ReactNode;
};

/**
 * What the reader does to a public-law result set: read how large it is,
 * narrow it, order it, and choose what each row shows. The reading controls
 * scroll as one row, so a narrow viewport drops none of them; the summary takes
 * a row of its own there; the actions wrap beside the controls instead, because a write affordance that scrolls out of a
 * scrollbar-less row is one the reader cannot find.
 */
export const PublicLawResultsToolbarFace = ({
  actions,
  columns,
  contentMode,
  controls,
  filters,
  find,
  sort,
  summary,
}: PublicLawResultsToolbarFaceProps) => (
  <div
    className="@container/results-toolbar flex min-w-0 flex-wrap items-center gap-1"
    data-slot="public-law-results-toolbar"
  >
    {filters}
    {/*
      The summary never shares a narrow row with the controls: there it took
      whatever width they left, and a query broke word by word under them.
      Below the container breakpoint it is a full row of its own above the
      controls; above it, it keeps a floor width, and the controls wrap to
      the next row before the summary is squeezed under that floor.
    */}
    <div
      className="text-muted-foreground order-first min-w-0 basis-full text-xs @2xl/results-toolbar:order-0 @2xl/results-toolbar:min-w-56 @2xl/results-toolbar:flex-1 @2xl/results-toolbar:basis-0"
      data-slot="public-law-results-summary"
    >
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
      {contentMode}
      {controls !== undefined && (
        <>
          <ToolbarDivider />
          {controls}
        </>
      )}
      {columns}
    </div>
    {actions !== undefined && (
      <div className="flex shrink-0 items-center gap-1">
        <ToolbarDivider />
        {actions}
      </div>
    )}
  </div>
);

/** The hairline between two groups of controls. */
const ToolbarDivider = () => <span className="bg-border mx-1 h-4 w-px" />;

export const TABLE_CONTENT_MODE_OPTIONS = [
  {
    value: "tight",
    icon: AlignJustifyIcon,
    labelKey: "workspaces.table.tightContent",
  },
  {
    value: "fit-content",
    icon: WrapTextIcon,
    labelKey: "workspaces.table.wrapContent",
  },
] as const satisfies readonly {
  value: TableContentMode;
  icon: ComponentType<{ className?: string }>;
  labelKey: TranslationKey;
}[];

// Every mode is offered, always: a control that silently dropped one would be
// a mode the reader cannot get back to.
type OfferedContentMode = (typeof TABLE_CONTENT_MODE_OPTIONS)[number]["value"];
true satisfies TableContentMode extends OfferedContentMode ? true : never;

/** What the filter button says, with how many filters are on. */
export const PublicLawFiltersLabel = ({
  children,
  badge,
}: {
  children: ReactNode;
  /** The caller formats the active filter count in its locale. */
  badge: string | null;
}) => (
  <>
    <SlidersHorizontalIcon aria-hidden="true" className="size-3.5" />
    {children}
    {badge !== null && (
      <span className="bg-primary text-primary-foreground text-3xs inline-flex min-w-4 items-center justify-center rounded-full px-1 leading-4 font-medium tabular-nums">
        {badge}
      </span>
    )}
  </>
);

/** The filter button holds its place while its popover loads. */
export const PublicLawFiltersFace = () => (
  <ButtonFace className="shrink-0" size="sm" variant="outline">
    <PublicLawFiltersLabel badge={null}>
      <PendingText barClassName="w-9" id="common.filters" />
    </PublicLawFiltersLabel>
  </ButtonFace>
);

/** The find bar's closed face: the bare icon its trigger shows. */
export const PublicLawFindFace = () => (
  <ButtonFace size="icon-xs" variant="ghost">
    <SearchIcon className="size-3.5" />
  </ButtonFace>
);

/** The column chooser's face: the icon its menu opens from. */
export const PublicLawColumnsFace = () => (
  <ButtonFace size="icon-xs" variant="ghost">
    <EyeIcon className="size-3.5" />
  </ButtonFace>
);

/** A toolbar choice's caption, drawn beside the control from `sm` up. */
export const PublicLawToolbarSelectLabel = ({
  children,
}: {
  children: ReactNode;
}) => (
  <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
    {children}
  </span>
);

/**
 * A toolbar choice (an order, an excerpt length) before its page is there:
 * the caption reads, and the value the address holds waits in place.
 */
export const PublicLawToolbarSelectFace = ({ label }: { label: ReactNode }) => (
  <>
    <PublicLawToolbarSelectLabel>{label}</PublicLawToolbarSelectLabel>
    <SelectTriggerFace className="h-7 min-h-0 w-auto min-w-28" size="sm">
      <FaceLabelPending className="w-14" />
    </SelectTriggerFace>
  </>
);

/** The density toggle before the page is there, at the default density. */
export const PublicLawContentModeFace = () => (
  <SegmentedIconToggleFace options={TABLE_CONTENT_MODE_OPTIONS} value="tight" />
);
