import * as v from "valibot";

export const isSafeIdValue = (value: string): boolean => value.length > 0;

const safeIdSchema = v.pipe(
  v.string(),
  v.check(isSafeIdValue, "Expected a non-empty identifier"),
  v.brand("SafeId"),
);

/**
 * Portable compile-time identifier brand. Runtime validation belongs to the
 * boundary that owns each identifier; the type parameter prevents IDs from
 * different domains being exchanged accidentally inside typed code.
 */
export type SafeId<TType extends string> = v.InferOutput<
  typeof safeIdSchema
> & {
  readonly __safeIdType?: TType;
};

/** Brand an identifier at a boundary that has already established its source. */
export const toSafeId = <TType extends string>(value: string): SafeId<TType> =>
  v.parse(safeIdSchema, value);
