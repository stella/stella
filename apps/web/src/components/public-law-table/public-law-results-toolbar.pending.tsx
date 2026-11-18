import type { ComponentProps, ComponentType, ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  AlignJustifyIcon,
  EyeIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  WrapTextIcon,
} from "@stll/ui/icons";
import { SegmentedIconToggle } from "@stll/ui/segmented-icon-toggle";
import { Skeleton } from "@stll/ui/skeleton";

import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import type { TableContentMode } from "@stll/api-contract/public-law-table";

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

/**
 * How much of a prose cell a row shows. The same two modes, icons and words as
 * the workspace table's own density control; the state is the page's, because
 * a public results table has no view to hang it on.
 */
export const PublicLawContentModeToggle = ({
  onChange,
  value,
}: {
  onChange: (contentMode: TableContentMode) => void;
  value: TableContentMode;
}) => {
  const t = useTranslations();

  return (
    <SegmentedIconToggle
      onChange={onChange}
      options={TABLE_CONTENT_MODE_OPTIONS.map((option) => ({
        value: option.mode,
        icon: option.icon,
        label: t(option.labelKey),
      }))}
      value={value}
    />
  );
};

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

/**
 * The filter popover's button. The popover renders it as its trigger; the
 * pending view draws it alone, so the button stands where it will open.
 */
export const PublicLawFiltersButton = (
  props: Omit<ComponentProps<typeof Button>, "className" | "size" | "variant">,
) => <Button {...props} className="shrink-0" size="sm" variant="outline" />;

/** What the filter button says, with how many filters are on. */
export const PublicLawFiltersLabel = ({
  activeFilterCount,
}: {
  activeFilterCount: number;
}) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <>
      <SlidersHorizontalIcon aria-hidden="true" className="size-3.5" />
      {t("common.filters")}
      {activeFilterCount > 0 && (
        <span className="bg-primary text-primary-foreground text-3xs inline-flex min-w-4 items-center justify-center rounded-full px-1 leading-4 font-medium tabular-nums">
          {format.number(activeFilterCount)}
        </span>
      )}
    </>
  );
};

/**
 * The filter button before the page is there. Which filters are on lives in
 * the address, which only the page reads, so the face counts none.
 */
export const PublicLawFiltersFace = () => (
  <PublicLawFiltersButton>
    <PublicLawFiltersLabel activeFilterCount={0} />
  </PublicLawFiltersButton>
);

/** The find bar's closed face: the bare icon its trigger shows. */
export const PublicLawFindFace = () => {
  const t = useTranslations();

  return (
    <Button
      aria-label={t("workspaces.views.findInTable")}
      size="icon-xs"
      variant="ghost"
    >
      <SearchIcon className="size-3.5" />
    </Button>
  );
};

/** The column chooser's face: the icon its menu opens from. */
export const PublicLawColumnsFace = () => {
  const t = useTranslations();

  return (
    <Button aria-label={t("common.columns")} size="icon-xs" variant="ghost">
      <EyeIcon className="size-3.5" />
    </Button>
  );
};

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
export const PublicLawToolbarSelectFace = ({ label }: { label: string }) => (
  <>
    <PublicLawToolbarSelectLabel>{label}</PublicLawToolbarSelectLabel>
    <Skeleton className="h-7 w-28 rounded-md" />
  </>
);

/** The density toggle before the page is there, at the default density. */
export const PublicLawContentModeFace = () => (
  <PublicLawContentModeToggle onChange={ignoreContentMode} value="tight" />
);

/** The face's density stays put: the page that owns the choice is not there yet. */
const ignoreContentMode = (_contentMode: TableContentMode) => undefined;
