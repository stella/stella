/**
 * The data table's schema: the columns a view has and what each of them can do.
 *
 * One module rather than one subpath per file, because the parts answer one
 * question together: the capability queries and the visibility rule only mean
 * anything against the descriptor list they read.
 */

export type {
  TableColumnCapabilities,
  TableColumnDescriptor,
  TableSchema,
} from "./schema";
export {
  duplicateColumnIds,
  findTableColumn,
  hideableColumnIds,
  sortableColumnIds,
  tableColumnIds,
  tableColumnSizing,
  visibleColumnIds,
} from "./schema";
