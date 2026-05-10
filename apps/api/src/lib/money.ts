/**
 * Branded monetary amounts.
 *
 * Money values in this codebase are stored and computed in
 * minor units ("cents" — for USD/EUR; halere for CZK; etc.).
 * The `CentsAmount` brand prevents the canonical 100x bug
 * where a major-unit value (e.g., 12.50 dollars) is silently
 * mixed with minor-unit math (1250 cents).
 *
 * The brand is structural: a plain `number` is not assignable
 * to `CentsAmount`. The only way to mint one is via `cents()`
 * (after deliberate construction), Drizzle reads from a column
 * declared with `.$type<CentsAmount>()`, or `unsafeCents()` at
 * a documented boundary.
 *
 * This module is currency-agnostic. The currency code lives
 * alongside the amount in the schema (e.g., invoices.currency)
 * and is not part of the brand — pairing them is the call
 * site's responsibility.
 */

declare const __cents: unique symbol;

export type CentsAmount = number & {
  readonly [__cents]: "CentsAmount";
};

/**
 * Construct a CentsAmount from a value already known to be in
 * minor units. Use at boundaries where the input is validated
 * as an integer minor-unit value (e.g., after Elysia
 * `t.Integer({ minimum: 0 })` or after parsing user input that
 * has been multiplied by 100).
 *
 * Throws on non-finite or non-integer input — money math at the
 * minor-unit level must be exact.
 */
export const cents = (value: number): CentsAmount => {
  if (!Number.isInteger(value)) {
    throw new TypeError(
      `cents(${value}): money values must be integer minor units`,
    );
  }
  // SAFETY: validated to be an integer; brand is nominal so the
  // assertion is sound at runtime.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return value as CentsAmount;
};

/**
 * Escape hatch for code paths that genuinely need to attach
 * the brand without a runtime check (test fixtures, generated
 * code). Prefer `cents()` everywhere else; reach for this only
 * with a `// SAFETY:` comment naming why the value is already
 * a valid minor-unit integer.
 */
export const unsafeCents = (value: number): CentsAmount =>
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  value as CentsAmount;
