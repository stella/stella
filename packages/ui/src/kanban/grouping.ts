/**
 * Kanban grouping: which columns a board has, and which rows may appear on it.
 *
 * The module never inspects a row. A caller describes its board with a
 * `KanbanSchema`: the properties a board may group by, plus the built-in group
 * resolvers for columns that do not come from a property (a status enum, a kind
 * enum). The column list, the uncategorized bucket, and the row scope all
 * derive from that description, so grouping has no opinion about what is being
 * grouped.
 */

import type { OptionColor } from "../lib/option-color";

/** One column, before the uncategorized bucket is appended. */
export type KanbanGroupOption = {
  value: string;
  label: string;
  image?: string | null | undefined;
  color?: string | undefined;
  colorBg?: string | undefined;
  optionColor?: OptionColor | undefined;
};

/** A column, including the uncategorized bucket (`value: null`). */
export type KanbanGroup = {
  value: string | null;
  label: string;
  image?: string | null | undefined;
  color?: string | undefined;
  colorBg?: string | undefined;
  optionColor?: OptionColor | undefined;
};

/**
 * A column source that is not a schema property, addressed by a reserved id.
 *
 * The board's columns are the caller's `options`, in the caller's order, so a
 * built-in grouping is a data declaration rather than a branch this module has
 * to know about.
 */
export type KanbanBuiltInGroup<TRow> = {
  /** Reserved group id, distinct from any property id. */
  id: string;
  /** Ordered columns, without the uncategorized bucket. */
  options: readonly KanbanGroupOption[];
  /**
   * Narrows the board to the rows this grouping can place. Omit when every row
   * belongs on the board.
   */
  selectRows?: ((rows: readonly TRow[]) => TRow[]) | undefined;
};

/**
 * Everything the grouping needs to know about a board.
 *
 * `getPropertyOptions` returns `null` for a property that cannot carry columns,
 * which keeps the decision — and the property model it depends on — with the
 * caller.
 */
export type KanbanSchema<TRow, TProperty> = {
  builtInGroups: readonly KanbanBuiltInGroup<TRow>[];
  properties: readonly TProperty[];
  getPropertyId: (property: TProperty) => string;
  getPropertyOptions: (
    property: TProperty,
  ) => readonly KanbanGroupOption[] | null;
};

export type KanbanGrouping<TRow, TProperty> =
  | { type: "none" }
  | {
      type: "built-in";
      propertyId: string;
      group: KanbanBuiltInGroup<TRow>;
    }
  | {
      type: "property";
      propertyId: string;
      property: TProperty;
      options: readonly KanbanGroupOption[];
    };

export type ResolveKanbanGroupingParams<TRow, TProperty> = {
  /** The group-by id the view carries; empty means no grouping. */
  groupBy: string;
  schema: KanbanSchema<TRow, TProperty>;
};

/** Resolve a stored group-by id against a schema. */
export const resolveKanbanGrouping = <TRow, TProperty>({
  groupBy,
  schema,
}: ResolveKanbanGroupingParams<TRow, TProperty>): KanbanGrouping<
  TRow,
  TProperty
> => {
  if (groupBy === "") {
    return { type: "none" };
  }

  const builtIn = schema.builtInGroups.find((group) => group.id === groupBy);
  if (builtIn !== undefined) {
    return { type: "built-in", propertyId: groupBy, group: builtIn };
  }

  const property = schema.properties.find(
    (candidate) => schema.getPropertyId(candidate) === groupBy,
  );
  if (property === undefined) {
    return { type: "none" };
  }

  return {
    type: "property",
    propertyId: groupBy,
    property,
    options: schema.getPropertyOptions(property) ?? [],
  };
};

export const getKanbanGroupingPropertyId = <TRow, TProperty>(
  grouping: KanbanGrouping<TRow, TProperty>,
): string | null => {
  switch (grouping.type) {
    case "none":
      return null;
    case "built-in":
    case "property":
      return grouping.propertyId;
    default: {
      const exhaustive: never = grouping;
      return exhaustive;
    }
  }
};

/**
 * A grouping with no columns is not a board. A built-in grouping declares its
 * columns up front, so an empty declaration is the signal that the board cannot
 * be drawn; a property grouping always draws, even when the property has no
 * options yet, because rows still land in the uncategorized bucket.
 */
export const isKanbanGroupingRenderable = <TRow, TProperty>(
  grouping: KanbanGrouping<TRow, TProperty>,
): boolean => {
  switch (grouping.type) {
    case "none":
      return false;
    case "built-in":
      return grouping.group.options.length > 0;
    case "property":
      return true;
    default: {
      const exhaustive: never = grouping;
      return exhaustive;
    }
  }
};

/** The rows a grouping can place on the board, in their incoming order. */
export const selectKanbanRows = <TRow, TProperty>(
  rows: readonly TRow[],
  grouping: KanbanGrouping<TRow, TProperty>,
): TRow[] => {
  switch (grouping.type) {
    case "none":
      return [];
    case "built-in":
      return grouping.group.selectRows
        ? grouping.group.selectRows(rows)
        : [...rows];
    case "property":
      return [...rows];
    default: {
      const exhaustive: never = grouping;
      return exhaustive;
    }
  }
};

/** The static column options for a grouping, excluding uncategorized. */
export const resolveKanbanGroupOptions = <TRow, TProperty>(
  grouping: KanbanGrouping<TRow, TProperty>,
): readonly KanbanGroupOption[] => {
  switch (grouping.type) {
    case "none":
      return [];
    case "built-in":
      return grouping.group.options;
    case "property":
      return grouping.options;
    default: {
      const exhaustive: never = grouping;
      return exhaustive;
    }
  }
};

/** Append the uncategorized bucket (null value) after the options. */
export const getKanbanGroups = (
  options: readonly KanbanGroupOption[],
  uncategorizedLabel: string,
): KanbanGroup[] => {
  const result: KanbanGroup[] = options.map((option) => ({
    value: option.value,
    label: option.label,
    image: option.image,
    color: option.color,
    colorBg: option.colorBg,
    optionColor: option.optionColor,
  }));
  result.push({ value: null, label: uncategorizedLabel });
  return result;
};
