import { cn } from "@stll/ui/lib/utils";

import { TOOLBAR_ROW_HEIGHT, TOOLBAR_ROW_MIN_HEIGHT } from "@/lib/consts";

export const WORKSPACE_TABLE_COLUMNS_VAR = "var(--workspace-table-columns)";

export const WorkspaceGridRow = ({
  className,
  style,
  ...props
}: React.ComponentProps<"div">) => (
  <div
    className={cn(
      "group/row isolate grid border-none transition-colors",
      className,
    )}
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
      "group/table-head bg-background text-foreground hover:bg-background after:bg-border relative z-0 grid items-center overflow-visible border-e px-0 text-start font-semibold whitespace-nowrap transition-colors after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-px after:z-20 after:h-px",
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
      "group/cell-content bg-background relative z-0 h-auto overflow-hidden border-e border-b p-2 whitespace-nowrap group-hover/row:bg-[color-mix(in_srgb,var(--color-foreground)_4%,var(--color-background))] group-data-[active]/row:bg-[color-mix(in_srgb,var(--color-foreground)_4%,var(--color-background))] group-data-[state=selected]/row:bg-[color-mix(in_srgb,var(--color-info)_10%,var(--color-background))] group-data-[state=selected]/row:group-hover/row:bg-[color-mix(in_srgb,var(--color-info)_15%,var(--color-background))]",
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
