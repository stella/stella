import type { CSSProperties } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import {
  KanbanColumnHeaderShell,
  KanbanColumnNameFace,
} from "@stll/ui/kanban-column-header-shell";
import {
  getKanbanGroupingPropertyId,
  getKanbanGroups,
  isKanbanGroupingRenderable,
  resolveKanbanGroupOptions,
} from "@stll/ui/kanban-grouping";
import type { KanbanGroup } from "@stll/ui/kanban-grouping";
import { cn } from "@stll/ui/utils";

import { KanbanCardsPending } from "@/components/workspaces/kanban/kanban-card.pending";
import {
  resolveWorkspaceKanbanGrouping,
  workspaceKanbanSchema,
} from "@/components/workspaces/kanban/kanban-grouping.logic";
import type { WorkspaceKanbanGrouping } from "@/components/workspaces/kanban/kanban-grouping.logic";
import type { WorkspaceProperty, WorkspaceView } from "@/lib/types";

/** The board: its columns side by side, scrolled sideways. */
export const KANBAN_BOARD_CLASS = "flex h-full gap-4 overflow-x-auto p-4";

/** The surface a board's marquee selection draws on. */
export const KANBAN_SELECTION_SURFACE_CLASS = "relative min-h-0";

/** A column's frame, before its colour or drag state. */
export const KANBAN_COLUMN_CLASS =
  "group/column relative flex w-[300px] max-w-[320px] min-w-[280px] shrink-0 flex-col rounded-lg transition-opacity";

/** A column's card list under its header. */
export const KANBAN_COLUMN_BODY_CLASS = "flex-1 overflow-y-auto p-2";

/** A column that carries no colour of its own. */
export const KANBAN_COLUMN_PLAIN_CLASS = "bg-muted/50";

/** A coloured column's surface at rest: its option colour, washed out. */
export const kanbanColumnRestingBackground = (
  colorBg: string | undefined,
): string | undefined =>
  colorBg ? `color-mix(in srgb, ${colorBg} 50%, transparent)` : undefined;

/** The swatch of a column's colour, as the header draws it. */
export const KANBAN_COLUMN_SWATCH_CLASS = "size-2.5 rounded-full";

/**
 * Drops write one column value per card, so a board needs fixed
 * single-select columns; any other grouping shows the board's empty state.
 */
export const canRenderKanbanBoard = (
  propertyId: string | null,
  grouping: WorkspaceKanbanGrouping,
): propertyId is string =>
  propertyId !== null &&
  isKanbanGroupingRenderable(grouping) &&
  (grouping.type !== "property" ||
    grouping.property.content.type === "single-select");

// The column names a loading board draws are bars, so the built-in groups'
// labels are never read; the schema only needs every key present.
const NO_STATUS_LABELS = {
  open: "",
  in_progress: "",
  in_review: "",
  done: "",
  cancelled: "",
};
const NO_KIND_LABELS = {
  document: "",
  folder: "",
  task: "",
  message: "",
  link: "",
};

/**
 * The columns a flat board draws on its first paint, from the same grouping
 * the board resolves: every group in its order, the uncategorized one last.
 * `null` when the cached view cannot say: a board with a subgroup lays out
 * lanes from loaded rows, and a grouping the board cannot draw shows its
 * empty state.
 */
export const pendingKanbanColumns = ({
  properties,
  view,
}: {
  properties: readonly WorkspaceProperty[];
  view: WorkspaceView;
}): readonly KanbanGroup[] | null => {
  if (view.layout.type !== "kanban") {
    return null;
  }
  if ((view.layout.subgroupByPropertyId ?? "") !== "") {
    return null;
  }
  const schema = workspaceKanbanSchema({
    properties,
    statusLabels: NO_STATUS_LABELS,
    entityKindLabels: NO_KIND_LABELS,
  });
  const grouping = resolveWorkspaceKanbanGrouping(
    view.layout.groupByPropertyId ?? "",
    schema,
  );
  if (!canRenderKanbanBoard(getKanbanGroupingPropertyId(grouping), grouping)) {
    return null;
  }
  return getKanbanGroups(resolveKanbanGroupOptions(grouping), "");
};

const KanbanColumnPending = ({ group }: { group: KanbanGroup }) => {
  const background = kanbanColumnRestingBackground(group.colorBg);
  const style: CSSProperties | undefined =
    background === undefined ? undefined : { backgroundColor: background };
  // Only a named column can be dragged or hidden; the uncategorized one has
  // neither its handle nor its menu.
  const named = group.value !== null;
  return (
    <div
      className={cn(
        KANBAN_COLUMN_CLASS,
        !group.colorBg && KANBAN_COLUMN_PLAIN_CLASS,
      )}
      style={style}
    >
      <KanbanColumnHeaderShell
        actions={
          named ? <ButtonFace size="icon-xs" variant="ghost" /> : undefined
        }
        name={
          <KanbanColumnNameFace>
            <FaceLabelPending className="w-20" />
            <span className="text-muted-foreground text-xs">
              <FaceLabelPending className="w-3" />
            </span>
          </KanbanColumnNameFace>
        }
        swatch={
          group.color === undefined ? undefined : (
            <span className="flex shrink-0">
              <span
                className={cn("block", KANBAN_COLUMN_SWATCH_CLASS)}
                style={{ backgroundColor: group.color }}
              />
            </span>
          )
        }
      />
      <div className={KANBAN_COLUMN_BODY_CLASS}>
        <KanbanCardsPending />
      </div>
    </div>
  );
};

/**
 * A kanban view before the board mounts: its columns, with their colours,
 * header rows and placeholder cards, in the board's own frame, so the board
 * that replaces them lands column for column. Draws nothing (the body's
 * neutral frame) where the cached view cannot say what the board will be.
 */
export const KanbanViewPending = ({
  properties,
  view,
}: {
  properties: readonly WorkspaceProperty[];
  view: WorkspaceView;
}) => {
  const columns = pendingKanbanColumns({ properties, view });
  if (columns === null) {
    return null;
  }
  return (
    <div
      aria-hidden="true"
      className={cn(KANBAN_SELECTION_SURFACE_CLASS, "h-full")}
      data-slot="kanban-view-pending"
    >
      <div className={KANBAN_BOARD_CLASS}>
        {columns.map((group) => (
          <KanbanColumnPending
            group={group}
            key={group.value ?? "__uncategorized__"}
          />
        ))}
      </div>
    </div>
  );
};
