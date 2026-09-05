// Passive regression fixture for
// `no-literal-minor-unit-scale/no-literal-minor-unit-scale`.
//
// `oxlint-disable-next-line` directives suppress cases the rule MUST flag;
// a regression makes them unused and CI fails. Lines without a directive
// cover the allow-list and must keep passing.

declare const amountCents: number;
declare const hourlyRate: number;
declare const row: { totalCents: number; rateAtEntry: number };
declare const policy: { price: { amountCents: number } };
declare const defaultValues: { amount?: number } | undefined;
declare const typedAmount: number;
declare const rateInputValue: string;
declare const markupPercent: number;
declare const billedMinutes: number;
declare const percentage: number;
declare const scaleFactor: number;
declare const elapsedMinutes: number;
declare const bigAmountCents: bigint;
declare const bigTotal: bigint;

// --- Flagged: a literal hundred standing in for the currency's exponent ---

// oxlint-disable-next-line no-literal-minor-unit-scale/no-literal-minor-unit-scale
export const _majorFromIdentifier = amountCents / 100;
// oxlint-disable-next-line no-literal-minor-unit-scale/no-literal-minor-unit-scale
export const _majorFromMember = row.totalCents / 100;
// oxlint-disable-next-line no-literal-minor-unit-scale/no-literal-minor-unit-scale
export const _majorFromNestedMember = policy.price.amountCents / 100;
// oxlint-disable-next-line no-literal-minor-unit-scale/no-literal-minor-unit-scale
export const _minorFromIdentifier = typedAmount * 100;
// oxlint-disable-next-line no-literal-minor-unit-scale/no-literal-minor-unit-scale
export const _minorReversed = 100 * hourlyRate;

// Production shapes: the number being scaled comes out of a parse or a round,
// so the operand is a call rather than a name.
// oxlint-disable-next-line no-literal-minor-unit-scale/no-literal-minor-unit-scale
export const _parsedInput = Math.round(Number.parseFloat(rateInputValue) * 100);
// oxlint-disable-next-line no-literal-minor-unit-scale/no-literal-minor-unit-scale
export const _floored = Math.floor(typedAmount * 100);
// A rounding call only passes along what it was given, so the money name
// inside it is what reports this one.
// oxlint-disable-next-line no-literal-minor-unit-scale/no-literal-minor-unit-scale
export const _roundedName = Math.round(hourlyRate) / 100;
// oxlint-disable-next-line no-literal-minor-unit-scale/no-literal-minor-unit-scale
export const _ceiled = Math.ceil(Number.parseFloat(rateInputValue) * 100);
// oxlint-disable-next-line no-literal-minor-unit-scale/no-literal-minor-unit-scale
export const _parsedInt = Number.parseInt(rateInputValue, 10) / 100;
// oxlint-disable-next-line no-literal-minor-unit-scale/no-literal-minor-unit-scale
export const _coerced = Number(rateInputValue) * 100;
// `Number` as a bare callee is the identifier branch; the repo's
// `unicorn/prefer-number-properties` already bans a bare `parseFloat`.

// A money name nested inside the operand is the same defect as a bare one.
// oxlint-disable-next-line no-literal-minor-unit-scale/no-literal-minor-unit-scale
export const _defaulted = (defaultValues?.amount ?? 0) / 100;
// oxlint-disable-next-line no-literal-minor-unit-scale/no-literal-minor-unit-scale
export const _summed = (row.totalCents + amountCents) / 100;
// The markup contract's own shape: flagged everywhere except the module that
// owns it (`packages/money/src/index.ts`), which the rule exempts by name.
// oxlint-disable-next-line no-literal-minor-unit-scale/no-literal-minor-unit-scale
export const _markup = (amountCents * (100 + markupPercent) + 50) / 100;
// A bigint literal carries the same assumption.
// oxlint-disable-next-line no-literal-minor-unit-scale/no-literal-minor-unit-scale
export const _majorBigint = bigAmountCents / 100n;
// oxlint-disable-next-line no-literal-minor-unit-scale/no-literal-minor-unit-scale
export const _minorBigint = 100n * bigTotal;

// --- Allowed ---

// Percentage arithmetic with no money operand: 100 is the percent base.
export const _splitMinutes = (billedMinutes * percentage) / 100;
export const _elapsedShare = (elapsedMinutes * percentage) / 100;
// A name that is not money, whatever the literal is.
export const _scaled = scaleFactor * 100;
// A hundred divided BY money is not a scale conversion.
export const _ratio = 100 / amountCents;
// A name that merely contains a money word without ending in one.
export const _entryRate = row.rateAtEntry / 100;
// Any other factor: only the hundredths assumption is the bug class here.
export const _thousandths = amountCents / 1000;
// Round-to-two-decimals: `Math.round` is not evidence of money on its own, or
// every fixed-precision helper in the repo would be reported.
export const _twoDecimals = Math.round((elapsedMinutes / 60) * 100) / 100;
