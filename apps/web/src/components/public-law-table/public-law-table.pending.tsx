import type { CSSProperties, ReactNode } from "react";

import { cn } from "@stll/ui/utils";

import { MobileTableOrientationGate } from "@/components/workspaces/table/mobile-table-orientation-gate";
import {
  WorkspaceGridHead,
  WorkspaceGridRow,
} from "@/components/workspaces/table/workspace-grid";
import type { GridColumnGeometry } from "@/components/workspaces/table/workspace-table/internals-helpers";
import { WorkspaceTableSkeletonRows } from "@/components/workspaces/table/workspace-table/skeleton-rows";
import { tableSkeletonRowCount } from "@/components/workspaces/table/workspace-table/skeleton-rows.logic";

// The results table's frame and its loading face. A route's pending view draws
// the face, the grid with its headers and waiting rows; the page's table sits
// in the same frame, so the box the rows arrive in is the box that waited.

/**
 * The bounded box the results table owns its scroll in, and fades in while a
 * new search is in flight.
 */
export const PublicLawTableFrame = ({
  children,
  isRefreshing = false,
}: {
  children: ReactNode;
  isRefreshing?: boolean | undefined;
}) => (
  <MobileTableOrientationGate>
    <div
      aria-busy={isRefreshing}
      className={cn(
        // The table owns its scroll: it claims the height the page gives it
        // rather than growing to its rows. Without a bounded box the
        // virtualizer's scroll element never scrolls, so every row is drawn
        // and the frozen header has nothing to freeze against.
        "border-border/45 bg-background/60 flex min-h-64 flex-1 flex-col overflow-hidden rounded-md border transition-opacity duration-200",
        isRefreshing && "opacity-56",
      )}
      data-slot="public-law-table-frame"
    >
      {children}
    </div>
  </MobileTableOrientationGate>
);

/** One column of the waiting grid: its width and what its header says. */
export type PublicLawSkeletonColumn = {
  id: string;
  /** The header's content; null for the row-number column, which has none. */
  header: ReactNode;
  /** The width the table gives the column, in pixels. */
  size: number;
};

type PublicLawTableSkeletonStyle = CSSProperties & {
  "--workspace-table-columns": string;
};

/**
 * The results table before its page is there: the grid with its column
 * headers and one shimmering row per row the page will hold. The columns are
 * the table's defaults; a reader's own arrangement is the page's to read.
 */
export const PublicLawTableSkeleton = ({
  columns,
  expectedRowCount,
}: {
  columns: readonly PublicLawSkeletonColumn[];
  /** How many rows the page will hold; see `tableSkeletonRowCount`. */
  expectedRowCount?: number | undefined;
}) => {
  const width = columns.reduce((sum, column) => sum + column.size, 0);
  const style: PublicLawTableSkeletonStyle = {
    "--workspace-table-columns": `${columns.map((column) => `${String(column.size)}px`).join(" ")} minmax(0, 1fr)`,
    minWidth: width,
  };
  const renderColumns = columns.map(
    ({ id, size }) =>
      ({
        id,
        getSize: () => size,
        getIsPinned: () => false,
        getStart: () => 0,
        getIsLastColumn: () => false,
      }) satisfies GridColumnGeometry,
  );
  const filler = { gridColumn: `${String(columns.length + 1)} / -1` };

  return (
    <PublicLawTableFrame>
      <div className="relative h-full flex-1 overflow-hidden">
        {/*
          A picture of the grid, not the grid: nothing in it can be read or
          reached yet, so it stays out of the accessibility tree until the
          page's table replaces it.
        */}
        <div
          aria-hidden="true"
          className="relative flex min-h-full flex-col text-sm"
          style={style}
        >
          <div className="bg-background z-30">
            <WorkspaceGridRow role="presentation">
              {columns.map((column, index) => (
                <WorkspaceGridHead
                  key={column.id}
                  role="presentation"
                  style={{ gridColumn: index + 1 }}
                >
                  {column.header}
                </WorkspaceGridHead>
              ))}
              <WorkspaceGridHead
                className="pointer-events-none"
                role="presentation"
                style={filler}
              />
            </WorkspaceGridRow>
          </div>
          <div className="flex flex-1 flex-col">
            <WorkspaceTableSkeletonRows
              renderColumns={renderColumns}
              rowCount={tableSkeletonRowCount(expectedRowCount)}
            />
          </div>
        </div>
      </div>
    </PublicLawTableFrame>
  );
};

/**
 * A column header's face: the icon and the name its header menu opens from,
 * laid out as the menu's trigger lays them out.
 */
export const PublicLawTableHeaderFace = ({
  icon,
  label,
}: {
  icon: ReactNode;
  label: ReactNode;
}) => (
  <span className="flex h-full w-full min-w-0 items-center gap-1.5 px-[calc(--spacing(2.5)-1px)] text-sm font-medium sm:text-xs [&_svg]:shrink-0 [&_svg]:opacity-80">
    {icon}
    <span className="min-w-0 overflow-hidden">{label}</span>
  </span>
);
