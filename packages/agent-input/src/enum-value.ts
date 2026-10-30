/**
 * Closed vocabularies on the agent wire: a style name, a registry slug, an
 * input type, a select option.
 *
 * Case and surrounding whitespace never carry meaning in a closed set, so they
 * are read. A near miss is not: `"lookup"` for `"lookups"` is one edit away
 * from a real value and also one edit away from a value the model invented, so
 * it asks and names the closest allowed value instead of guessing which.
 */

import { distance } from "@stll/fuzzy-search";
import { foldToAscii } from "@stll/text-normalize";

import type { Normalized } from "./normalized";
import { askForFix, readValueAs } from "./normalized";

/** How far a spelling may sit from an allowed value and still be reported as
 *  "did you mean". Beyond one edit the closest value is noise. */
const NEAR_MISS_DISTANCE = 1;

const fold = (value: string): string => foldToAscii(value.trim()).toLowerCase();

const quote = (values: readonly string[]): string =>
  values.map((value) => `"${value}"`).join(", ");

export type EnumValueOptions = {
  /** What the set is called in the ask: "The styles", "The registries". */
  label?: string;
  /** What the set is, as a noun phrase for `expected`: "a date style". */
  expected?: string;
};

/**
 * Read one value of a closed set. An exact hit is taken verbatim; a hit that
 * differs only in case, spacing, or diacritics is read with a note; a value one
 * edit from an allowed one asks and names it; anything else asks with the whole
 * set, which is short enough to copy from.
 */
export const normalizeEnumValue = <TValue extends string>(
  input: unknown,
  allowed: readonly TValue[],
  options?: EnumValueOptions,
): Normalized<TValue> => {
  const label = options?.label ?? "The allowed values";
  const expected = options?.expected ?? "one of a closed set of values";
  const listed = `${label} are ${quote(allowed)}.`;
  if (typeof input !== "string") {
    return askForFix({ input, expected, hint: listed });
  }

  const exact = allowed.find((value) => value === input);
  if (exact !== undefined) {
    return readValueAs(input, exact);
  }

  const folded = fold(input);
  const loose = allowed.find((value) => fold(value) === folded);
  if (loose !== undefined) {
    return readValueAs(input, loose);
  }

  const closest = allowed.find(
    (value) => distance(folded, fold(value)) <= NEAR_MISS_DISTANCE,
  );
  return askForFix({
    input,
    expected,
    hint:
      closest === undefined ? listed : `Did you mean "${closest}"? ${listed}`,
  });
};
