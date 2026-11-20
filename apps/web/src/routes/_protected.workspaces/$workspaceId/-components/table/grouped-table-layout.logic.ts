import { ENTITY_KINDS } from "@stll/api-contract";

import type { PendingTextKey } from "@/components/pending-text";
import { getInternalPropertyId } from "@/components/workspaces/internal-ids.logic";
import {
  ENTITY_KIND_GROUP_LABEL_IDS,
  UNCATEGORIZED_GROUP_LABEL_ID,
} from "@/components/workspaces/kanban/kanban-group-labels.logic";
import { resolveOptionColor } from "@/components/workspaces/property-utils";
import {
  buildDocTypeGateLabels,
  resolveDocumentTypeClassifier,
} from "@/components/workspaces/table/group-columns";
import { getWorkspaceGridTemplateColumns } from "@/components/workspaces/table/workspace-table/internals-helpers";
import type { GridColumnGeometry } from "@/components/workspaces/table/workspace-table/internals-helpers";
import { SKELETON_ROW_KEYS } from "@/components/workspaces/table/workspace-table/skeleton-rows.logic";
import type { WorkspaceProperty, WorkspaceView } from "@/lib/types";
import type { StoredColumnSizing } from "@/lib/workspaces/stored-column-sizing.logic";
import { pendingTableGrid } from "@/routes/_protected.workspaces/$workspaceId/-components/table/pending-table-columns.logic";
import type { PendingTableGrid } from "@/routes/_protected.workspaces/$workspaceId/-components/table/pending-table-columns.logic";

export const GROUP_TABLE_PAGE_SIZE = 200;
const DEFAULT_GROUP_SKELETON_ROW_COUNT = 3;

export const getGroupSkeletonLayout = (totalRowCount: number | undefined) => {
  const rowCount = totalRowCount ?? DEFAULT_GROUP_SKELETON_ROW_COUNT;
  const reservedRowCount = Math.min(rowCount, GROUP_TABLE_PAGE_SIZE);
  const skeletonRowCount = Math.min(reservedRowCount, SKELETON_ROW_KEYS.length);

  return {
    skeletonRowCount,
    fillerRowCount: reservedRowCount - skeletonRowCount,
  };
};

/** A section's name: an option's own text, or a message. */
type PendingGroupLabel =
  { type: "text"; text: string } | { type: "message"; id: PendingTextKey };

/** One section of a grouped table as it stands before its count loads. */
type PendingGroupSection = {
  key: string;
  label: PendingGroupLabel;
  /** The option's resolved colour, for the header's swatch. */
  color: string | undefined;
  /** The section's own columns, laid out as its table lays them out. */
  grid: PendingTableGrid;
};

type PendingGroup = {
  value: string | null;
  label: PendingGroupLabel;
  color: string | undefined;
};

/**
 * The section's columns, without those it does not show, the pinned ones
 * docked again from the start.
 */
const keepColumns = (
  grid: PendingTableGrid,
  keep: (id: string) => boolean,
): PendingTableGrid => {
  const kept = grid.renderColumns.filter((column) => keep(column.id));
  if (kept.length === grid.renderColumns.length) {
    return grid;
  }
  const pinned = kept.filter((column) => column.getIsPinned() === "start");
  const lastPinned = pinned.at(-1);
  let offset = 0;
  const renderColumns = kept.map((column): GridColumnGeometry => {
    if (column.getIsPinned() !== "start") {
      return column;
    }
    const start = offset;
    offset += column.getSize();
    return {
      id: column.id,
      getSize: () => column.getSize(),
      getIsPinned: () => "start",
      getStart: () => start,
      getIsLastColumn: () => column === lastPinned,
    };
  });
  const dropped = grid.renderColumns
    .filter((column) => !keep(column.id))
    .reduce((sum, column) => sum + column.getSize(), 0);
  return {
    renderColumns,
    addPropertyColumn: grid.addPropertyColumn,
    templateColumns: getWorkspaceGridTemplateColumns({
      renderColumns,
      addPropertyColumn: grid.addPropertyColumn,
    }),
    tableWidth: grid.tableWidth - dropped,
  };
};

const UNCATEGORIZED_GROUP: PendingGroup = {
  value: null,
  label: { type: "message", id: UNCATEGORIZED_GROUP_LABEL_ID },
  color: undefined,
};

/**
 * The sections a grouping draws, from the view and the matter's properties
 * alone: an entity kind's or a select property's options, then the
 * uncategorized bucket, as the board's kit orders them. `null` where the
 * sections are not known here: a view without a stored grouping (the layout
 * resolves the matter's default), and the groupings the grouped table does
 * not draw (it shows its "select a property" state).
 */
const pendingGroups = (
  properties: readonly WorkspaceProperty[],
  groupBy: string,
): PendingGroup[] | null => {
  if (groupBy === getInternalPropertyId("kind")) {
    return [
      ...ENTITY_KINDS.map((kind): PendingGroup => ({
        value: kind,
        label: { type: "message", id: ENTITY_KIND_GROUP_LABEL_IDS[kind] },
        color: undefined,
      })),
      UNCATEGORIZED_GROUP,
    ];
  }
  const property = properties.find((candidate) => candidate.id === groupBy);
  if (property === undefined) {
    return null;
  }
  const { content } = property;
  if (content.type !== "single-select" && content.type !== "multi-select") {
    return null;
  }
  return [
    ...content.options.map((option): PendingGroup => ({
      value: option.value,
      label: { type: "text", text: option.value },
      color: resolveOptionColor(option.color).color,
    })),
    UNCATEGORIZED_GROUP,
  ];
};

// Stable key for a group. The null (uncategorized) bucket and real string values
// live in disjoint namespaces so an option literally named "uncategorized"
// can't collide with the null bucket.
export const groupKeyFor = (value: string | null): string =>
  value === null ? "uncategorized" : `value:${value}`;

/**
 * A grouped table view's sections before their counts arrive, each with the
 * columns its table will have: the view's columns, and, grouped by the
 * document-type classifier, only the playbook columns scoped to that
 * section's type (the uncategorized section keeps the common ones).
 */
export const pendingGroupedSections = ({
  properties,
  sizing,
  view,
}: {
  properties: readonly WorkspaceProperty[];
  /** The widths the table store holds for this view (`storedColumnSizing`). */
  sizing?: StoredColumnSizing | undefined;
  view: WorkspaceView<"table">;
}): PendingGroupSection[] | null => {
  const groupBy = view.layout.groupByPropertyId ?? "";
  const groups = groupBy === "" ? null : pendingGroups(properties, groupBy);
  if (groups === null) {
    return null;
  }
  const grid = pendingTableGrid({ properties, sizing, view });
  const classifier = resolveDocumentTypeClassifier(properties);
  const gateLabels =
    classifier?.id === groupBy
      ? buildDocTypeGateLabels({ properties, classifierPropertyId: groupBy })
      : new Map<string, Set<string>>();
  return groups.map((group) => ({
    key: groupKeyFor(group.value),
    label: group.label,
    color: group.color,
    grid:
      gateLabels.size === 0
        ? grid
        : keepColumns(grid, (id) => {
            const labels = gateLabels.get(id);
            return (
              labels === undefined ||
              (group.value !== null && labels.has(group.value))
            );
          }),
  }));
};
