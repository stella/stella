/**
 * Find-in-table, without React.
 *
 * Which of a view's columns a find can reach, and what the server is asked for
 * once the reader has narrowed it. Pure, so the route loader can resolve the
 * same request the layouts send, and the column set and the scope resolution
 * are testable without rendering a table.
 */

import {
  ENTITY_FIND_TERM_MIN_LENGTH,
  PROPERTY_FIND_SUPPORT,
} from "@stll/api-contract";
import type { EntityFindScope } from "@stll/api-contract";

import type { TableFindHighlight } from "@/components/workspaces/table/find-highlight";
import type { PropertyContentType } from "@/lib/api-contract";
import type { ViewLayout, WorkspaceProperty } from "@/lib/types";
import { pairPlaybookVerdicts } from "@/lib/workspaces/playbook-verdicts";
import type { EntitiesFindKey } from "@/lib/workspaces/queries/entities.logic";
import type { WorkspaceColumnDescriptor } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-schema";
import { includesListItems } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-kind-filters";
import type { TableFindSelection } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";

/**
 * A row in the find bar's column picker.
 *
 * Metadata columns (Author, Last updated, Version) can never be searched: a
 * find runs over the row's name and its property cells, and a metadata column
 * is neither. They are listed anyway, disabled and explained, for the same
 * reason an unsearchable property type is: a column the reader can see in the
 * grid that is silently missing from the picker reads as a bug, and searching
 * an author name that is visible in every row is an obvious thing to try.
 */
export type TableFindColumn = { id: string; label: string } & (
  | {
      contentType: PropertyContentType;
      kind: "property";
      support: (typeof PROPERTY_FIND_SUPPORT)[PropertyContentType];
    }
  | { kind: "metadata" }
);

/** The half of the picker a find can actually be narrowed to. */
export type TableFindPropertyColumn = Extract<
  TableFindColumn,
  { kind: "property" }
>;

/**
 * The property columns a find can offer, in column order.
 *
 * Built from the property list by the pairing the table schema uses, so the
 * picker lists columns in grid order and the route loader, which has no
 * schema, resolves the request the layout will send. Hidden columns are left
 * out entirely: a row that matched only in a column the reader cannot see
 * would show no highlight and read as a bug. Columns whose type cannot be
 * searched stay in the list, marked, so the picker can say why rather than
 * quietly omitting them.
 */
export const toFindColumns = ({
  hiddenProperties,
  properties,
}: {
  hiddenProperties: readonly string[];
  properties: readonly WorkspaceProperty[];
}): TableFindPropertyColumn[] => {
  const hidden = new Set(hiddenProperties);
  const findColumns: TableFindPropertyColumn[] = [];
  for (const { property } of pairPlaybookVerdicts(properties)) {
    if (hidden.has(property.id)) {
      continue;
    }
    const contentType = property.content.type;
    findColumns.push({
      contentType,
      id: property.id,
      kind: "property",
      label: property.name,
      support: PROPERTY_FIND_SUPPORT[contentType],
    });
  }
  return findColumns;
};

export const searchableColumnIds = (
  columns: readonly TableFindColumn[],
): string[] =>
  columns
    .filter(
      (column) => column.kind === "property" && column.support === "searchable",
    )
    .map((column) => column.id);

/**
 * The picker's rows: the property columns a find can reach, then the metadata
 * columns it cannot.
 *
 * The metadata half is read off the rendered schema rather than listed here,
 * so a metadata column added to the grid appears in the picker without anyone
 * remembering to add it. Only the picker needs this; the route loader resolves
 * its request from {@link toFindColumns} alone, since a column that can never
 * be searched can never narrow a scope.
 */
export const toPickerFindColumns = ({
  findColumns,
  schemaColumns,
}: {
  findColumns: readonly TableFindPropertyColumn[];
  schemaColumns: readonly WorkspaceColumnDescriptor[];
}): TableFindColumn[] => [
  ...findColumns,
  ...schemaColumns
    .filter((column) => column.emphasis === "metadata")
    .map((column) => ({
      id: column.id,
      kind: "metadata" as const,
      label: column.label,
    })),
];

/**
 * The picker's selection after the columns it named are re-intersected with
 * what is currently searchable. A column hidden or deleted while the find is
 * live drops out; when that drops the last one the find widens back to
 * unrestricted, the same way clearing the last tick does, so the rows never
 * narrow to a search nothing can satisfy and the picker always shows a state
 * a click can leave.
 */
export const effectiveFindSelection = ({
  columns,
  selection,
}: {
  columns: readonly TableFindColumn[];
  selection: TableFindSelection;
}): TableFindSelection => {
  if (selection.type === "all") {
    return selection;
  }
  const chosen = new Set(selection.propertyIds);
  const propertyIds = searchableColumnIds(columns).filter((columnId) =>
    chosen.has(columnId),
  );
  if (propertyIds.length === 0) {
    return { type: "all" };
  }
  return { propertyIds, type: "columns" };
};

/**
 * The scope the server is asked for. Both branches carry an explicit list.
 *
 * `all` is the server's name half plus the listed columns, so it is sent only
 * while the grid renders a name column. A view of documents alone has none:
 * there the unrestricted selection means every cell and nothing else, and
 * sending `all` would return rows matched on a name no cell shows.
 */
export const resolveFindScope = ({
  columns,
  hasNameColumn,
  selection,
}: {
  columns: readonly TableFindColumn[];
  hasNameColumn: boolean;
  selection: TableFindSelection;
}): EntityFindScope => {
  const effective = effectiveFindSelection({ columns, selection });
  if (effective.type === "columns") {
    return { propertyIds: effective.propertyIds, type: "columns" };
  }
  return {
    propertyIds: searchableColumnIds(columns),
    type: hasNameColumn ? "all" : "columns",
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

export const UNRESTRICTED_FIND: TableFindSelection = { type: "all" };

export type TableFindResolution = {
  columns: TableFindPropertyColumn[];
  highlight: TableFindHighlight | null;
  request: EntitiesFindKey;
  /** The picker's selection, with columns that left the view dropped. */
  selection: TableFindSelection;
};

type ResolveTableFindOptions = {
  layout: Pick<
    Extract<ViewLayout, { type: "table" }>,
    "filters" | "hiddenProperties"
  >;
  properties: readonly WorkspaceProperty[];
  selection: TableFindSelection;
  /** The submitted term, never what the bar currently holds typed. */
  term: string;
};

/**
 * One resolution of a view's find: the request its row readers send, the
 * marks drawn over the answer, and the selection the picker shows. The three
 * derive from one pass so none can describe a find the others were not sent.
 */
export const resolveTableFind = ({
  layout,
  properties,
  selection,
  term,
}: ResolveTableFindOptions): TableFindResolution => {
  const columns = toFindColumns({
    hiddenProperties: layout.hiddenProperties,
    properties,
  });
  const effective = effectiveFindSelection({ columns, selection });
  // A term under the floor is no find, the same as a blank one: the server
  // would reject it, and marking it would explain rows nothing narrowed.
  const trimmed = term.trim();
  if (trimmed.length < ENTITY_FIND_TERM_MIN_LENGTH) {
    return { columns, highlight: null, request: {}, selection: effective };
  }

  const scope = resolveFindScope({
    columns,
    hasNameColumn: includesListItems(layout.filters),
    selection: effective,
  });
  return {
    columns,
    highlight: {
      matchesName: scope.type === "all",
      propertyIds: new Set(scope.propertyIds),
      term: trimmed,
    },
    request: { find: { scope, term: trimmed } },
    selection: effective,
  };
};
