import type { ENTITY_VIEW_COLUMNS } from "@stll/api-contract/entity-views";

import { layoutPendingGrid } from "@/components/workspaces/table/pending-grid.logic";
import type { PendingTableGrid } from "@/components/workspaces/table/pending-grid.logic";
import { DEFAULT_TABLE_COLUMN_MIN_SIZE } from "@/components/workspaces/table/table-column-sizing";
import type { StoredColumnSizing } from "@/lib/workspaces/stored-column-sizing.logic";

/**
 * Each inbox table column's width before a reader drags it, in the table's
 * column order. The table's column model and its loading grid both take
 * their columns from here.
 */
export const ENTITY_VIEW_COLUMN_SIZES = {
  _name: 300,
  _matter: 200,
  "_agenda-kind": 130,
  _status: 140,
  _priority: 130,
  "_due-date": 150,
  _assignee: 180,
  _actions: 240,
} as const satisfies Record<keyof typeof ENTITY_VIEW_COLUMNS, number>;

/** Where the table store keeps the widths of an organization's inbox views. */
export const entityViewSizingScope = (organizationId: string) =>
  `entity-view:${organizationId}`;

/**
 * The inbox table's grid before its column model exists, from the saved
 * view's columns (hidden, order, pinning) and the widths this browser keeps
 * for the view, as the table lays them out.
 */
export const entityViewPendingGrid = ({
  layout,
  sizing,
}: {
  /** The saved view's columns: which are hidden, their order and pinning. */
  layout: {
    columnOrder: readonly string[];
    columnPinning: readonly string[];
    hiddenProperties: readonly string[];
  };
  sizing?: StoredColumnSizing | undefined;
}): PendingTableGrid =>
  layoutPendingGrid({
    columns: Object.entries(ENTITY_VIEW_COLUMN_SIZES).map(([id, size]) => ({
      id,
      size,
      minSize: DEFAULT_TABLE_COLUMN_MIN_SIZE,
    })),
    hiddenIds: new Set(layout.hiddenProperties),
    orderIds: layout.columnOrder,
    pinnedIds: layout.columnPinning,
    sizing,
  });
