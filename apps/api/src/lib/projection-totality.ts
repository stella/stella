import type * as v from "valibot";

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

// --- Compile-time payload ties -------------------------------------------------

/**
 * The field paths in `Payload` that `SchemaInput` does not declare, at any
 * depth (arrays compared element-wise; a `Payload` union branch is compared
 * only against the `SchemaInput` branches it is assignable to; an `unknown`
 * schema field — stripped/unenumerated positions — admits any payload type
 * without descending). Optional never fields synthesized by TypeScript when
 * inferring heterogeneous arrays describe absent keys, so they are ignored.
 * Required keys remain classified even when their value is undefined.
 */
type ProjectionScalar =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined;

type ExtraProjectionFields<Payload, SchemaInput> = unknown extends SchemaInput
  ? never
  : SchemaInput extends ProjectionScalar
    ? never
    : Payload extends readonly (infer Item)[]
      ? SchemaInput extends readonly (infer ShapeItem)[]
        ? ExtraProjectionFields<Item, ShapeItem>
        : never
      : Payload extends object
        ? SchemaInput extends object
          ? Payload extends SchemaInput
            ? {
                [K in keyof Payload]-?: K extends keyof SchemaInput
                  ? ExtraProjectionFields<Payload[K], SchemaInput[K]>
                  : Partial<Payload> extends Pick<Payload, K>
                    ? [Required<Payload>[K]] extends [never]
                      ? never
                      : K
                    : K;
              }[keyof Payload]
            : never
          : never
        : never;

/**
 * Compile-time exactness tie for a payload that is NOT built as an
 * object literal (a shared helper's return value forwarded verbatim), where
 * `satisfies v.InferInput<typeof X_PROJECTION>` gets no excess-property
 * check. `AssertNoExtraFields<Payload, SchemaInput>` fails typecheck when
 * `Payload` carries a field the projection schema does not classify, naming
 * the offending keys. Use `projectionPayload` at construction sites to retain
 * the producer type
 * before a handler return annotation widens it.
 */
export type AssertNoExtraFields<
  Payload extends ([ExtraProjectionFields<Payload, SchemaInput>] extends [never]
    ? SchemaInput
    : { unclassifiedFields: ExtraProjectionFields<Payload, SchemaInput> }),
  SchemaInput,
> = Payload;

/**
 * Bind inferred payloads before a handler return annotation can erase extra
 * fields in forwarded domain objects. Unlike `satisfies`, this checks nested
 * variables and spreads as well as fresh literals; runtime strict parsing
 * remains the responsibility of the existing dispatch boundary.
 */
export const projectionPayload = <
  TSchema extends v.GenericSchema,
  TPayload extends v.InferInput<TSchema>,
>(
  _schema: TSchema,
  payload: TPayload &
    NoInfer<
      [ExtraProjectionFields<TPayload, v.InferInput<TSchema>>] extends [never]
        ? unknown
        : {
            unclassifiedFields: ExtraProjectionFields<
              TPayload,
              v.InferInput<TSchema>
            >;
          }
    >,
): TPayload => payload;
