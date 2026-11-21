import { cn } from "@stll/ui/utils";

import { TOOLBAR_ROW_HEIGHT, TOOLBAR_ROW_MIN_HEIGHT } from "@/lib/consts";

export const SELECT_COLUMN_SIZE = 48;

const WORKSPACE_TABLE_COLUMNS_VAR = "var(--workspace-table-columns)";

/**
 * The element a workspace table scrolls its rows in. Named so a screen that
 * moves the reader to the top of new rows reaches the same element the table
 * draws.
 */
export const WORKSPACE_TABLE_SCROLL_SLOT = "workspace-table-scroll";

/** A standalone table's box in its page: the body's height. */
export const WORKSPACE_TABLE_FRAME_CLASS = "relative h-full flex-1";

/** A standalone table's scroller: rows and columns scroll together. */
export const WORKSPACE_TABLE_SCROLL_CLASS =
  "scrollbar-subtle h-full overflow-auto";

/** The grid itself: header rows over body rows, at the table's type size. */
export const WORKSPACE_TABLE_GRID_CLASS = "relative flex flex-col text-sm";

export const WorkspaceGridRow = ({
  className,
  style,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn("group/row relative isolate grid border-none", className)}
    data-slot="workspace-grid-row"
    role="row"
    style={{
      gridTemplateColumns: WORKSPACE_TABLE_COLUMNS_VAR,
      ...style,
    }}
    {...props}
  />
);

export const WorkspaceGridHead = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "group/table-head bg-background text-foreground hover:bg-background after:bg-border relative z-0 grid items-center overflow-visible border-e px-0 text-start font-semibold whitespace-nowrap after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-px after:z-20 after:h-px",
      TOOLBAR_ROW_HEIGHT,
      className,
    )}
    data-slot="workspace-grid-head"
    role="columnheader"
    {...props}
  />
);

export const WorkspaceGridCell = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "group/cell-content bg-background relative z-0 h-auto overflow-hidden border-e border-b p-2 whitespace-nowrap group-hover/row:bg-[color-mix(in_srgb,var(--color-foreground)_4%,var(--color-background))] group-data-[active]/row:bg-[color-mix(in_srgb,var(--color-foreground)_4%,var(--color-background))] group-data-[drop-target]/row:bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--color-background))] group-data-[state=selected]/row:bg-[color-mix(in_srgb,var(--color-info)_10%,var(--color-background))] group-data-[state=selected]/row:group-hover/row:bg-[color-mix(in_srgb,var(--color-info)_15%,var(--color-background))]",
      TOOLBAR_ROW_MIN_HEIGHT,
      className,
    )}
    data-slot="workspace-grid-cell"
    role="gridcell"
    {...props}
  />
);

export const WorkspaceGridFillerCell = ({
  className,
  ...props
}: React.ComponentProps<"div">) => (
  <WorkspaceGridCell
    aria-hidden="true"
    className={cn("border-e-0 p-0", className)}
    role="presentation"
    {...props}
  />
);
