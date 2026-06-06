/**
 * Branded monetary amounts and minor-unit billing arithmetic.
 *
 * Money in this codebase is stored and computed in minor units
 * ("cents" for USD/EUR, halere for CZK, etc.). The `CentsAmount`
 * brand prevents the canonical 100x bug where a major-unit value
 * (12.50 dollars) is silently mixed with minor-unit math (1250 cents).
 *
 * The brand lives here, in a shared package, so it threads end to end:
 * the same `CentsAmount` flows from a Drizzle column declared with
 * `.$type<CentsAmount>()`, across the API boundary (Eden infers the
 * brand from the handler's return type), into browser previews and back.
 * A plain `number` is not assignable to `CentsAmount`; mint one with
 * `cents()` after validating minor-unit input, or `unsafeCents()` at a
 * documented boundary.
 *
 * Currency-agnostic: the currency code lives alongside the amount in the
 * schema (e.g. invoices.currency); pairing them is the call site's
 * responsibility.
 */

declare const __cents: unique symbol;

export type CentsAmount = number & {
  readonly [__cents]: "CentsAmount";
};

/**
 * Construct a CentsAmount from a value already known to be in minor
 * units. Use at boundaries where the input is validated as an integer
 * minor-unit value (e.g. after Elysia `t.Integer({ minimum: 0 })` or
 * after parsing user input that has been multiplied by 100).
 *
 * Throws on non-integer input — money math at the minor-unit level must
 * be exact.
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
 * Escape hatch for code paths that genuinely need to attach the brand
 * without a runtime check (test fixtures, generated code). Prefer
 * `cents()` everywhere else; reach for this only with a `// SAFETY:`
 * comment naming why the value is already a valid minor-unit integer.
 */
export const unsafeCents = (value: number): CentsAmount =>
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  value as CentsAmount;

export type ProrateHourlyCentsInput = {
  billedMinutes: number;
  hourlyRateCents: CentsAmount;
};

export const prorateHourlyCents = ({
  billedMinutes,
  hourlyRateCents,
}: ProrateHourlyCentsInput): CentsAmount => {
  assertNonNegativeInteger("billedMinutes", billedMinutes);
  assertNonNegativeInteger("hourlyRateCents", hourlyRateCents);

  return cents(Math.floor((billedMinutes * hourlyRateCents + 30) / 60));
};

export type ApplyMarkupCentsInput = {
  amountCents: CentsAmount;
  markupPercent: number;
};

export const applyMarkupCents = ({
  amountCents,
  markupPercent,
}: ApplyMarkupCentsInput): CentsAmount => {
  assertNonNegativeInteger("amountCents", amountCents);
  assertNonNegativeInteger("markupPercent", markupPercent);

  return cents(Math.floor((amountCents * (100 + markupPercent) + 50) / 100));
};

function assertNonNegativeInteger(name: string, value: number) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative integer`);
  }
}
