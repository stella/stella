import { Result } from "better-result";
import * as v from "valibot";

/**
 * Path and query values arrive as strings. A route schema states how it reads
 * one that means something else; the HTTP layer never guesses, and a route's
 * types refuse a query or path schema whose input is not a string.
 */

const DECIMAL = /^-?(?:\d+|\d*\.\d+)$/u;

const WIRE_VALUE_KEY = "x-stella-wire-value";

/**
 * The metadata a wire marker carries. A schema whose pipe holds it reads a
 * string that stands for its output, so a typed client offers the output.
 */
export type WireValueMetadata = { readonly [WIRE_VALUE_KEY]: true };

/** The value schema each wire marker stands for, keyed by the marker action. */
const wireValues = new WeakMap<object, v.GenericSchema>();

/**
 * A no-op pipe action that records which value a wire string carries, placed
 * just before the step that reads the string. A client that holds the value
 * itself (an agent, a generated CLI, the browser) is shown the value's
 * schema, and sends the value in the form `toWireInput` writes.
 */
const wireMarker = <TInput>(
  value: v.GenericSchema,
): v.MetadataAction<TInput, WireValueMetadata> => {
  const marker = v.metadata<TInput, WireValueMetadata>({
    [WIRE_VALUE_KEY]: true,
  });
  wireValues.set(marker, value);
  return marker;
};

/** The value schema a wire marker stands for, or `undefined` for any other action. */
export const wireValueOf = (action: object): v.GenericSchema | undefined =>
  wireValues.get(action);

/** A decimal string read as a number, then checked by `schema`. */
export const numberFromString = <
  TSchema extends v.GenericSchema<number, number>,
>(
  schema: TSchema,
) =>
  v.pipe(
    v.string(),
    v.regex(DECIMAL, "Expected a number"),
    wireMarker<string>(schema),
    v.transform(Number),
    schema,
  );

/** `"true"` or `"false"` read as a boolean. */
export const booleanFromString = () =>
  v.pipe(
    v.picklist(["true", "false"], "Expected true or false"),
    wireMarker<"true" | "false">(v.boolean()),
    v.transform((value) => value === "true"),
  );

/**
 * One or more values of a repeated query key (`?tag=a&tag=b`); a single value
 * is a one-item list.
 */
export const arrayFromQuery = <
  TSchema extends v.GenericSchema<string, unknown>,
>(
  item: TSchema,
) =>
  v.pipe(
    v.union([v.string(), v.array(v.string())]),
    wireMarker<string | string[]>(v.array(item)),
    v.transform((value) => (Array.isArray(value) ? value : [value])),
    v.array(item),
  );

/** A JSON document carried in one string field, then checked by `schema`. */
export const jsonFromString = <TSchema extends v.GenericSchema>(
  schema: TSchema,
) =>
  v.pipe(
    v.string(),
    wireMarker<string>(schema),
    v.rawTransform(({ dataset, addIssue, NEVER }) => {
      const parsed = Result.try((): unknown => JSON.parse(dataset.value));
      if (parsed.isErr()) {
        addIssue({ message: "Expected JSON" });
        return NEVER;
      }
      return parsed.value;
    }),
    schema,
  );

/** What a query or path schema reads: strings, and lists of them for repeated keys. */
export type HttpStringInput = Readonly<
  Record<string, string | readonly string[] | undefined>
>;

/** One value as the string a wire schema reads back; a document is JSON. */
const wireString = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/**
 * Path or query values written the way a browser sends them: text as is,
 * numbers and booleans as their literal, lists as repeated keys and documents
 * as JSON. An absent or `null` value is left out. Anything but a record is
 * returned unchanged, for the schema to refuse.
 */
export const toWireInput = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const entries: [string, string | string[]][] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || entry === null) {
      continue;
    }
    entries.push([
      key,
      Array.isArray(entry) ? entry.map(wireString) : wireString(entry),
    ]);
  }
  return Object.fromEntries(entries);
};
