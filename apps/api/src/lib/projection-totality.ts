/**
 * A schema column can go silently unprojected: a handler hand-lists the
 * fields it sends to the client, a migration adds a column to the table, and
 * nothing forces the handler back open. `properties/list.ts` shipped exactly
 * this bug — `kinds` landed on the table with no branch projecting it, so
 * the web client had no way to scope properties by entity kind, and nothing
 * failed until someone noticed by hand.
 *
 * These two type helpers turn that silence into a compile error. Pair them at
 * the bottom of a projection module with the idiom below: one line fails if a
 * row column is neither projected nor named in an explicit, reasoned
 * `Excused` list, and the other fails if the projection carries a key that
 * traces back to no real column (a typo, or a column since dropped).
 *
 * ```ts
 * const UNPROJECTED_WIDGET_COLUMNS = [
 *   // One reason per excused column, not just its name.
 *   "internalCorrelationId",
 * ] as const satisfies readonly (keyof WidgetRow)[];
 *
 * type MissingProjectedWidgetColumn = UnprojectedColumns<
 *   WidgetRow,
 *   WidgetListItem,
 *   (typeof UNPROJECTED_WIDGET_COLUMNS)[number]
 * >;
 * type UnexpectedProjectedWidgetColumn = UnbackedProjectionKeys<
 *   WidgetRow,
 *   WidgetListItem
 * >;
 *
 * true satisfies MissingProjectedWidgetColumn extends never ? true : never;
 * true satisfies UnexpectedProjectedWidgetColumn extends never ? true : never;
 * ```
 */

/** Columns of Row that Projection neither carries nor Excused names. */
export type UnprojectedColumns<
  Row,
  Projection,
  Excused extends keyof Row = never,
> = Exclude<Exclude<keyof Row, Excused>, keyof Projection>;

/** Keys of Projection that no Row column backs. */
export type UnbackedProjectionKeys<Row, Projection> = Exclude<
  keyof Projection,
  keyof Row
>;
