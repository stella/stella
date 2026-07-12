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
  // SAFETY: documented escape hatch; caller asserts value is already a valid minor-unit integer.
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

declare const __currency: unique symbol;

/**
 * A `CentsAmount` additionally branded with its ISO 4217-ish currency code
 * `C`. This makes cross-currency addition a compile error instead of a
 * runtime bug: `addCents` only accepts two `CurrencyCents` sharing the same
 * `C`, so `addCents(usdAmount, eurAmount)` fails to typecheck rather than
 * silently producing a meaningless sum.
 *
 * Mint one with `currencyCents()`; there is no unsafe escape hatch because
 * the underlying `CentsAmount` validation (`cents()`) is cheap and the
 * currency code is a plain string carried alongside it, so there is no
 * boundary that needs to skip it.
 */
export type CurrencyCents<C extends string = string> = CentsAmount & {
  readonly [__currency]: C;
};

/**
 * Construct a `CurrencyCents<C>` from a currency code and a minor-unit
 * amount. The only producer of `CurrencyCents`; downstream code narrows `C`
 * from the literal `currency` argument (e.g. `currencyCents("USD", 100)`
 * infers `CurrencyCents<"USD">`).
 */
export const currencyCents = <C extends string>(
  currency: C,
  amount: number,
): CurrencyCents<C> => {
  if (!currency) {
    throw new TypeError("currencyCents(): currency must be a non-empty code");
  }
  // SAFETY: cents() validates the minor-unit integer; the currency brand
  // is nominal and carried only at the type level.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  return cents(amount) as CurrencyCents<C>;
};

/**
 * Add two `CurrencyCents` amounts of the SAME currency. The second
 * parameter's currency `B` is constrained to `extends A`, so passing a
 * different currency literal (e.g. `addCents(usdAmount, eurAmount)`) is a
 * compile error, not a runtime bug — see `packages/money/src/index.test.ts`
 * for the `@ts-expect-error` proof.
 *
 * Both operands are further constrained to reject the WIDE
 * `CurrencyCents<string>` (as opposed to a literal currency such as
 * `CurrencyCents<"USD">`). A currency read back from a DB row types as
 * plain `string`, so without this, `addCents(currencyCents(row.currency, x),
 * currencyCents(row.currency, y))` would still typecheck even when the two
 * rows carry genuinely different runtime currencies — the compile-time
 * guarantee above only bites for literal currency types. Code that
 * aggregates rows with a dynamic (non-literal) currency must use
 * `MoneyTotals` instead, which buckets by currency at runtime and is the
 * runtime-correct tool for that case.
 */
export const addCents = <A extends string, B extends A = A>(
  a: string extends A ? never : CurrencyCents<A>,
  b: string extends B ? never : CurrencyCents<B>,
): CurrencyCents<A> =>
  // SAFETY: the currency brand is phantom-only (never materialized at
  // runtime, same as CentsAmount itself); the result is just a + b with
  // A's brand reattached, which is sound because the parameter types
  // already proved both operands share currency A.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion
  cents((a as CurrencyCents<A>) + (b as CurrencyCents<B>)) as CurrencyCents<A>;

/**
 * Per-currency accumulator for aggregating money across rows that may carry
 * different currencies (e.g. time entries across matters, expenses across
 * clients). There is deliberately no method that returns a single combined
 * number: the only way to read totals out is `entries()`, which groups by
 * currency and sorts deterministically by currency code. This keeps
 * cross-currency summation structurally unreachable through this package's
 * API — callers must handle each currency's total explicitly.
 *
 * Division of responsibility with `addCents`: `addCents` gives a
 * compile-time guarantee, but only when both operands carry a literal
 * currency type (`CurrencyCents<"USD">`); it rejects the wide
 * `CurrencyCents<string>` outright. Any flow whose currency is dynamic
 * (read from a DB row, request body, etc.) cannot satisfy that literal
 * constraint and must bucket through `MoneyTotals` instead, which enforces
 * the same "never sum across currencies" invariant at runtime via the
 * per-currency `Map`.
 */
export type MoneyTotalsEntry = {
  currency: string;
  amountCents: CentsAmount;
};

export class MoneyTotals {
  readonly #totals = new Map<string, CentsAmount>();

  /** Add `amountCents` to the running total for `currency`. */
  add(currency: string, amountCents: CentsAmount): void {
    if (!currency) {
      throw new TypeError(
        "MoneyTotals.add(): currency must be a non-empty code",
      );
    }
    const running = this.#totals.get(currency) ?? cents(0);
    this.#totals.set(currency, cents(running + amountCents));
  }

  /**
   * Per-currency totals, sorted deterministically by currency code so
   * output (PDF lines, API responses) does not depend on insertion order.
   * Sorts by UTF-16 code unit (default `Array.sort`) rather than
   * `localeCompare`, so ordering does not vary with the runtime's locale.
   */
  entries(): MoneyTotalsEntry[] {
    return [...this.#totals.keys()].sort().map((currency) => ({
      currency,
      amountCents: this.#totals.get(currency) ?? cents(0),
    }));
  }
}
