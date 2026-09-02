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
 * traces back to no real column (a typo, a column since dropped, or a column
 * that is named in `Excused` and so must not be projected). Both helpers take
 * the same `Excused` type argument, so a column can never be simultaneously
 * "reasoned as excused" and "actually sent to the client" without a compile
 * error pointing at the drift.
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
 *   WidgetListItem,
 *   (typeof UNPROJECTED_WIDGET_COLUMNS)[number]
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

/**
 * Keys of Projection that no non-excused Row column backs: a typo, a column
 * since dropped, or — since `Excused` is subtracted from the allowed set
 * before the check — a column reasoned as excused above that the projection
 * sends to the client anyway. That last case is what keeps the two guards
 * honest against each other: an excused column that starts being projected
 * fails here, instead of staying green because it is still a real row key.
 */
export type UnbackedProjectionKeys<
  Row,
  Projection,
  Excused extends keyof Row = never,
> = Exclude<keyof Projection, Exclude<keyof Row, Excused>>;
