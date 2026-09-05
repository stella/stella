/**
 * The minor-unit brand and its constructors.
 *
 * Separate from `index.ts` because `format.ts` mints amounts too: the
 * conversion helpers there return a `CentsAmount`, and a module the package
 * entry re-exports cannot import back from that entry without a cycle.
 */

import { panic } from "better-result";

declare const __cents: unique symbol;

export type CentsAmount = number & {
  readonly [__cents]: "CentsAmount";
};

/**
 * Construct a CentsAmount from a value already known to be in minor
 * units. Use at boundaries where the input is validated as an integer
 * minor-unit value (e.g. after Elysia `t.Integer({ minimum: 0 })` or
 * after scaling a typed major-unit amount by the currency's exponent).
 *
 * A non-integer input is a caller defect, not a runtime condition: money
 * math at the minor-unit level must be exact, so it panics.
 */
export const cents = (value: number): CentsAmount => {
  if (!Number.isInteger(value)) {
    return panic(`cents(${value}): money values must be integer minor units`);
  }
  // SAFETY: validated to be an integer; brand is nominal so the
  // assertion is sound at runtime.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return value as CentsAmount;
};

/**
 * Escape hatch for code paths that genuinely need to attach the brand
 * without a runtime check (test fixtures, generated code). Prefer
 * `cents()` everywhere else; reach for this only with a `// SAFETY:`
 * comment naming why the value is already a valid minor-unit integer.
 */
export const unsafeCents = (value: number): CentsAmount =>
  // SAFETY: documented escape hatch; caller asserts value is already a valid minor-unit integer.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  value as CentsAmount;
