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
declare const typedAmount: number;
declare const markupPercent: number;
declare const billedMinutes: number;
declare const percentage: number;
declare const scaleFactor: number;

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
// oxlint-disable-next-line no-literal-minor-unit-scale/no-literal-minor-unit-scale
export const _minorRounded = Math.round(typedAmount * 100);

// --- Allowed ---

// Percentage arithmetic: 100 is the percent base, not a minor-unit exponent.
export const _splitMinutes = (billedMinutes * percentage) / 100;
export const _markup = (amountCents * (100 + markupPercent) + 50) / 100;
// A name that is not money, whatever the literal is.
export const _scaled = scaleFactor * 100;
// A hundred divided BY money is not a scale conversion.
export const _ratio = 100 / amountCents;
// A name that merely contains a money word without ending in one.
export const _entryRate = row.rateAtEntry / 100;
// Any other factor: only the hundredths assumption is the bug class here.
export const _thousandths = amountCents / 1000;
