/**
 * A table's schema: which columns exist, what each can do, and how wide it
 * starts. Not how a cell draws — that is the caller's, and it is the reason
 * this module holds no React.
 *
 * The split matters because "which columns does this view have, and which of
 * them can be sorted, hidden, resized or pinned" is a question about data, and
 * a question about data can be answered by a test. It used to be answerable
 * only by rendering the table and asking TanStack.
 */

/** What a reader may do to a column. */
export type TableColumnCapabilities = {
  sort: boolean;
  hide: boolean;
  resize: boolean;
  pin: boolean;
};

/**
 * One column.
 *
 * `render` is whatever the caller needs to draw the column: this module never
 * looks inside it, which is what keeps the schema free of any idea about what
 * a row holds.
 */
export type TableColumnDescriptor<TRender> = {
  /** Unique within the schema, and stable across renders. */
  id: string;
  /** Header text. Empty for a column whose header draws no text. */
  label: string;
  render: TRender;
  /** Starting width, in pixels. */
  size: number;
  /** Narrowest this column may be resized to; the schema's default if absent. */
  minSize?: number | undefined;
  capabilities: TableColumnCapabilities;
  /**
   * Metadata columns read quieter than content ones; a utility column
   * (a selection checkbox, an add-column affordance) draws no value at all.
   */
  emphasis: "content" | "metadata" | "utility";
};

export type TableSchema<TRender> = {
  columns: readonly TableColumnDescriptor<TRender>[];
  /** Narrowest any column may be resized to. */
  defaultMinSize: number;
};

/** Every column a schema declares, in order. */
export const tableColumnIds = <TRender>(
  schema: TableSchema<TRender>,
): string[] => schema.columns.map((column) => column.id);

const withCapability = <TRender>(
  schema: TableSchema<TRender>,
  capability: keyof TableColumnCapabilities,
): string[] =>
  schema.columns
    .filter((column) => column.capabilities[capability])
    .map((column) => column.id);

export const sortableColumnIds = <TRender>(
  schema: TableSchema<TRender>,
): string[] => withCapability(schema, "sort");

export const hideableColumnIds = <TRender>(
  schema: TableSchema<TRender>,
): string[] => withCapability(schema, "hide");

export const findTableColumn = <TRender>(
  schema: TableSchema<TRender>,
  id: string,
): TableColumnDescriptor<TRender> | undefined =>
  schema.columns.find((column) => column.id === id);

/**
 * Which columns a view shows.
 *
 * A column that cannot be hidden stays visible whatever the stored hidden list
 * says, so a stale list — a column that lost its hide capability while it was
 * hidden — cannot strand the table without its select or name column.
 */
export const visibleColumnIds = <TRender>(
  schema: TableSchema<TRender>,
  hiddenColumnIds: readonly string[],
): string[] => {
  const hidden = new Set(hiddenColumnIds);
  return schema.columns
    .filter((column) => !column.capabilities.hide || !hidden.has(column.id))
    .map((column) => column.id);
};

/** The starting width of every column, keyed by id. */
export const tableColumnSizing = <TRender>(
  schema: TableSchema<TRender>,
): Record<string, number> => {
  const sizing: Record<string, number> = {};
  for (const column of schema.columns) {
    sizing[column.id] = column.size;
  }
  return sizing;
};

/**
 * A duplicate column id silently drops a column: the table keys by id, so the
 * second declaration wins and the first disappears with no error anywhere.
 * Callers that build a schema from user data (a property list) check here.
 */
export const duplicateColumnIds = <TRender>(
  schema: TableSchema<TRender>,
): string[] => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const column of schema.columns) {
    if (seen.has(column.id)) {
      duplicates.add(column.id);
    }
    seen.add(column.id);
  }
  return [...duplicates];
};
