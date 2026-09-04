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
