import { cn } from "@stll/ui/lib/utils";

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
      "group/table-head bg-background text-foreground hover:bg-background relative z-0 grid h-10 items-center overflow-hidden border-e border-t border-b px-0 text-start font-semibold whitespace-nowrap transition-colors",
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
      "group/cell-content bg-background relative z-0 h-auto min-h-10 overflow-hidden border-e border-b p-2 whitespace-nowrap group-hover/row:bg-[color-mix(in_srgb,var(--color-foreground)_4%,var(--color-background))] group-data-[active]/row:bg-[color-mix(in_srgb,var(--color-foreground)_4%,var(--color-background))] group-data-[state=selected]/row:bg-[color-mix(in_srgb,var(--color-info)_10%,var(--color-background))] group-data-[state=selected]/row:group-hover/row:bg-[color-mix(in_srgb,var(--color-info)_15%,var(--color-background))]",
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
