/**
 * Find-in-table, without React.
 *
 * Which of a view's columns a find can reach, and what the server is asked for
 * once the reader has narrowed it. Pure, so the column set and the scope
 * resolution are testable without rendering a table.
 */

import { PROPERTY_FIND_SUPPORT } from "@stll/api-contract";
import type { EntityFindScope } from "@stll/api-contract";

import type { PropertyContentType } from "@/lib/api-contract";
import type { WorkspaceColumnDescriptor } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-schema";
import type { TableFindSelection } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";

export type TableFindColumn = {
  contentType: PropertyContentType;
  id: string;
  label: string;
  support: (typeof PROPERTY_FIND_SUPPORT)[PropertyContentType];
};

/**
 * The property columns a find can offer, in column order.
 *
 * Hidden columns are left out entirely: a row that matched only in a column
 * the reader cannot see would show no highlight and read as a bug. Columns
 * whose type cannot be searched stay in the list, marked, so the picker can
 * say why rather than quietly omitting them.
 */
export const toFindColumns = ({
  columns,
  hiddenProperties,
}: {
  columns: readonly WorkspaceColumnDescriptor[];
  hiddenProperties: readonly string[];
}): TableFindColumn[] => {
  const hidden = new Set(hiddenProperties);
  const findColumns: TableFindColumn[] = [];
  for (const column of columns) {
    if (column.render.type !== "property" || hidden.has(column.id)) {
      continue;
    }
    const contentType = column.render.property.content.type;
    findColumns.push({
      contentType,
      id: column.id,
      label: column.label,
      support: PROPERTY_FIND_SUPPORT[contentType],
    });
  }
  return findColumns;
};

export const searchableColumnIds = (
  columns: readonly TableFindColumn[],
): string[] =>
  columns
    .filter((column) => column.support === "searchable")
    .map((column) => column.id);

/**
 * The scope the server is asked for. Both branches carry an explicit list, and
 * a narrowed one is re-intersected with what is currently searchable on every
 * read: a column hidden or deleted while the bar is open then narrows the
 * picker instead of silently narrowing the search.
 */
export const resolveFindScope = ({
  columns,
  selection,
}: {
  columns: readonly TableFindColumn[];
  selection: TableFindSelection;
}): EntityFindScope => {
  const searchable = searchableColumnIds(columns);
  if (selection.type === "all") {
    return { propertyIds: searchable, type: "all" };
  }
  const chosen = new Set(selection.propertyIds);
  return {
    propertyIds: searchable.filter((columnId) => chosen.has(columnId)),
    type: "columns",
  };
};

/**
 * The picker's selection after one column row is clicked.
 *
 * `all` is the unrestricted state, not the full list ticked, so under it the
 * columns show unticked and the first click narrows to exactly the column
 * clicked. Ticking every column stays `columns`: it is the only scope that
 * searches every cell without also matching the row's name, and on a view with
 * a single searchable column it is the only way to narrow at all. Clearing the
 * last tick is the way back, because a search of no columns is one nothing can
 * satisfy.
 */
export const toggleFindColumn = ({
  columnId,
  searchable,
  selection,
}: {
  columnId: string;
  searchable: readonly string[];
  selection: TableFindSelection;
}): TableFindSelection => {
  const chosen = new Set(selection.type === "all" ? [] : selection.propertyIds);
  if (chosen.has(columnId)) {
    chosen.delete(columnId);
  } else {
    chosen.add(columnId);
  }
  const propertyIds = searchable.filter((id) => chosen.has(id));
  if (propertyIds.length === 0) {
    return { type: "all" };
  }
  return { propertyIds, type: "columns" };
};
