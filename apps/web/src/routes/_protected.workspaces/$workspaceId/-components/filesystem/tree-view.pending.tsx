import type { ReactNode } from "react";

import { useSearch } from "@tanstack/react-router";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { PlusIcon } from "@stll/ui/icons";
import { Skeleton } from "@stll/ui/skeleton";
import { TRUNCATED_TEXT_LINES_CLASS } from "@stll/ui/truncated-text-face";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import { SKELETON_ROW_KEYS } from "@/components/workspaces/table/workspace-table/skeleton-rows.logic";
import type { WorkspaceProperty, WorkspaceView } from "@/lib/types";
import {
  buildGridTemplate,
  FILESYSTEM_METADATA_LABEL_IDS,
  FILESYSTEM_ROW_HEIGHT_PX,
  filesystemRowContentStyle,
  resolveExtraColumns,
} from "@/routes/_protected.workspaces/$workspaceId/-components/filesystem/tree-view-columns.logic";
import type { ExtraColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/filesystem/tree-view-columns.logic";

/*
 * The boxes the filesystem view lays its tree out in. The loaded tree
 * (`tree-view.tsx`) draws them from here, so its face stands in the same
 * boxes.
 */

/** The view's box: the breadcrumb row, the scrolling tree, the add row. */
export const FILESYSTEM_VIEW_CLASS =
  "flex h-full flex-1 flex-col overflow-hidden p-2";
export const FILESYSTEM_BREADCRUMB_ROW_CLASS = "mb-2 px-2";
export const FILESYSTEM_SCROLL_CLASS = "mt-1 min-h-0 flex-1 overflow-auto";
export const FILESYSTEM_CONTENT_CLASS = "w-max min-w-full";
export const FILESYSTEM_COLUMN_HEADER_CLASS =
  "text-muted-foreground bg-background sticky top-0 z-10 grid w-full items-center gap-x-4 border-b px-2 pb-1 text-xs font-medium";
/** One column's head inside the header row. */
export const FILESYSTEM_COLUMN_HEAD_CLASS =
  "group/column relative flex min-w-0 items-center";
/** The line a head's label sits on. */
export const FILESYSTEM_COLUMN_LABEL_CLASS =
  "hover:text-foreground flex min-w-0 items-center gap-1 rounded-sm py-0.5";
export const FILESYSTEM_ROWS_CLASS = "relative mt-1";
/** A row's grid, in the header's template. */
export const FILESYSTEM_ROW_GRID_CLASS =
  "hover:bg-muted grid h-full w-full items-center gap-x-4 rounded-sm px-2 text-start text-sm";
export const FILESYSTEM_EXTRA_CELL_CLASS =
  "text-muted-foreground flex h-full min-w-0 items-center justify-end overflow-hidden text-end text-xs whitespace-nowrap";
export const FILESYSTEM_FOOTER_CLASS = "mt-2 shrink-0 px-2";

/** Rows the tree stands in while its entities load: about a screen. */
const PENDING_TREE_ROWS = 12;

/** Headers name their columns through the pending labels, not these. */
const NO_LABELS = {};
const NO_WIDTHS = {};

const ColumnHeadPending = ({
  align,
  children,
}: {
  align: "start" | "end";
  children: ReactNode;
}) => (
  <div
    className={cn(
      FILESYSTEM_COLUMN_HEAD_CLASS,
      align === "end" ? "justify-end" : "justify-start",
    )}
  >
    <span
      className={cn(
        FILESYSTEM_COLUMN_LABEL_CLASS,
        align === "end" ? "justify-end text-end" : "justify-start text-start",
      )}
    >
      <span className={cn(TRUNCATED_TEXT_LINES_CLASS[1], "font-medium")}>
        {children}
      </span>
    </span>
  </div>
);

const FilesystemRowPending = ({
  extraColumns,
  gridTemplate,
}: {
  extraColumns: readonly ExtraColumn[];
  gridTemplate: string;
}) => (
  <div style={{ height: FILESYSTEM_ROW_HEIGHT_PX }}>
    <div className="relative h-full">
      <div
        className={FILESYSTEM_ROW_GRID_CLASS}
        style={{ gridTemplateColumns: gridTemplate }}
      >
        <div style={filesystemRowContentStyle(gridTemplate)}>
          {/* The name cell's chevron slot, icon and name, at depth 0. */}
          <div className="flex h-full min-w-0 items-center gap-1.5 self-stretch">
            <span className="w-3.5 shrink-0" />
            <Skeleton className="size-4 shrink-0 rounded-sm" />
            <Skeleton className="h-3.5 w-2/5" />
          </div>
          {extraColumns.map((column) => (
            <div className={FILESYSTEM_EXTRA_CELL_CLASS} key={column.id}>
              <Skeleton className="h-3 w-3/5" />
            </div>
          ))}
        </div>
        <span />
      </div>
    </div>
  </div>
);

/**
 * A filesystem view before its entities arrive: the tree's own box, its
 * breadcrumb row, the column header in the grid the view's columns give
 * (the same columns and template the tree computes), placeholder rows at
 * the tree's row height, and the add button below. A matter with no
 * entities shows its empty state instead once they load; that cannot be
 * known here, so the face claims the tree. Widths a reader dragged in this
 * browser are passed in as `columnWidths` when known; without them the
 * columns stand at their defaults and settle when the tree mounts.
 */
export const FilesystemViewPending = ({
  columnWidths = NO_WIDTHS,
  properties,
  view,
}: {
  columnWidths?: Readonly<Record<string, number>> | undefined;
  properties: readonly WorkspaceProperty[];
  view: WorkspaceView<"filesystem">;
  workspaceId: string;
}) => {
  const inFolder = useSearch({
    strict: false,
    select: (search) => search.folder !== undefined,
  });
  const extraColumns = resolveExtraColumns(
    view.layout.hiddenProperties,
    properties,
    NO_LABELS,
  );
  const gridTemplate = buildGridTemplate(extraColumns, columnWidths);
  return (
    <div
      aria-hidden="true"
      className={cn(FILESYSTEM_VIEW_CLASS, "pointer-events-none")}
    >
      <div className={FILESYSTEM_BREADCRUMB_ROW_CLASS}>
        <div className="min-w-0">
          {inFolder && (
            // The folder trail's names arrive with the entities.
            <div className="text-muted-foreground flex items-center text-sm">
              <FaceLabelPending className="w-40" />
            </div>
          )}
        </div>
      </div>
      <div className={FILESYSTEM_SCROLL_CLASS}>
        <div className={FILESYSTEM_CONTENT_CLASS}>
          <div
            className={FILESYSTEM_COLUMN_HEADER_CLASS}
            style={{ gridTemplateColumns: gridTemplate }}
          >
            <ColumnHeadPending align="start">
              <PendingText barClassName="w-10" id="common.name" />
            </ColumnHeadPending>
            {extraColumns.map((column) => (
              <ColumnHeadPending align="end" key={column.id}>
                {column.type === "metadata" ? (
                  <PendingText
                    barClassName="w-12"
                    id={FILESYSTEM_METADATA_LABEL_IDS[column.id]}
                  />
                ) : (
                  column.label
                )}
              </ColumnHeadPending>
            ))}
            <span />
          </div>
          <div className={FILESYSTEM_ROWS_CLASS}>
            {SKELETON_ROW_KEYS.slice(0, PENDING_TREE_ROWS).map((rowKey) => (
              <FilesystemRowPending
                extraColumns={extraColumns}
                gridTemplate={gridTemplate}
                key={rowKey}
              />
            ))}
          </div>
        </div>
      </div>
      <div className={FILESYSTEM_FOOTER_CLASS}>
        <ButtonFace size="xs" variant="ghost">
          <PlusIcon />
          <PendingText barClassName="w-8" id="common.add" />
        </ButtonFace>
      </div>
    </div>
  );
};
