/**
 * The entity half of find-in-table: which of a view's property columns a find
 * can reach, and what the server is asked for once the reader has narrowed it.
 *
 * Pure, so the route loader can resolve the same request the layouts send.
 * Entity rows are the one row kind whose find runs on the server, because the
 * rows a view holds are more than the page in front of the reader.
 */

import { PROPERTY_FIND_SUPPORT } from "@stll/api-contract";
import type { EntityFindScope } from "@stll/api-contract";

import { resolveTableFind } from "@/components/workspaces/table/table-find.logic";
import type {
  TableFindResolution,
  TableFindSelection,
} from "@/components/workspaces/table/table-find.logic";
import type { WorkspaceColumnDescriptor } from "@/components/workspaces/table/table-schema";
import type { PropertyContentType } from "@/lib/api-contract";
import type { WorkspaceProperty } from "@/lib/types";
import { pairPlaybookVerdicts } from "@/lib/workspaces/playbook-verdicts";
import type { EntitiesFindKey } from "@/lib/workspaces/queries/entities.logic";

/** A property column a find may be offered, with what the picker draws it as. */
export type EntityFindColumn = {
  contentType: PropertyContentType;
  id: string;
  label: string;
  searchable: boolean;
};

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
export const toEntityFindColumns = ({
  hiddenProperties,
  properties,
}: {
  hiddenProperties: readonly string[];
  properties: readonly WorkspaceProperty[];
}): EntityFindColumn[] => {
  const hidden = new Set(hiddenProperties);
  const findColumns: EntityFindColumn[] = [];
  for (const { property } of pairPlaybookVerdicts(properties)) {
    if (hidden.has(property.id)) {
      continue;
    }
    const contentType = property.content.type;
    findColumns.push({
      contentType,
      id: property.id,
      label: property.name,
      searchable: PROPERTY_FIND_SUPPORT[contentType] === "searchable",
    });
  }
  return findColumns;
};

/**
 * A row of a matter's find picker: a property column, or a metadata column a
 * find can never reach.
 */
export type EntityFindPickerColumn =
  | (EntityFindColumn & { kind: "property" })
  | { id: string; kind: "metadata"; label: string; searchable: false };

/**
 * The picker's rows: the property columns a find can reach, then the metadata
 * columns it cannot.
 *
 * The metadata half is read off the rendered schema rather than listed here,
 * so a metadata column added to the grid appears in the picker without anyone
 * remembering to add it. Metadata columns (Author, Last updated, Version) can
 * never be searched: a find runs over the row's name and its property cells,
 * and a metadata column is neither. They are listed anyway, disabled and
 * explained, for the same reason an unsearchable property type is — searching
 * an author name visible in every row is an obvious thing to try. Only the
 * picker needs them; the route loader resolves its request from the property
 * columns alone, since a column that can never be searched can never narrow a
 * scope.
 */
export const entityPickerColumns = ({
  findColumns,
  schemaColumns,
}: {
  findColumns: readonly EntityFindColumn[];
  schemaColumns: readonly WorkspaceColumnDescriptor[];
}): EntityFindPickerColumn[] => [
  ...findColumns.map((column) => ({ ...column, kind: "property" as const })),
  ...schemaColumns
    .filter((column) => column.emphasis === "metadata")
    .map((column) => ({
      id: column.id,
      kind: "metadata" as const,
      label: column.label,
      searchable: false as const,
    })),
];

export type EntityFindResolution = TableFindResolution & {
  columns: EntityFindColumn[];
  request: EntitiesFindKey;
};

type ResolveEntityFindOptions = {
  /**
   * Whether the grid renders a name column, which the unrestricted scope also
   * matches. A view of documents alone has none: there the unrestricted
   * selection means every cell and nothing else, and asking for `all` would
   * return rows matched on a name no cell shows.
   */
  hasNameColumn: boolean;
  hiddenProperties: readonly string[];
  properties: readonly WorkspaceProperty[];
  selection: TableFindSelection;
  /** The submitted term, never what the bar currently holds typed. */
  term: string;
};

/**
 * One resolution of a view's find: the request its row readers send, the marks
 * drawn over the answer, and the selection the picker shows.
 */
export const resolveEntityFind = ({
  hasNameColumn,
  hiddenProperties,
  properties,
  selection,
  term,
}: ResolveEntityFindOptions): EntityFindResolution => {
  const columns = toEntityFindColumns({ hiddenProperties, properties });
  const resolved = resolveTableFind({
    columns,
    hasNameColumn,
    selection,
    term,
  });
  return { ...resolved, columns, request: entityFindRequest(resolved) };
};

/**
 * The find a row reader sends. Both scope branches carry an explicit list,
 * because the group-counts endpoint receives no field selection and so cannot
 * recompute a default that would agree with the rows.
 */
const entityFindRequest = ({
  columnIds,
  matchesName,
  term,
}: TableFindResolution): EntitiesFindKey => {
  if (term === null) {
    return {};
  }
  const scope: EntityFindScope = {
    propertyIds: columnIds,
    type: matchesName ? "all" : "columns",
  };
  return { find: { scope, term } };
};
