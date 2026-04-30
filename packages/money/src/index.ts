/**
 * Money values in this codebase are stored and computed in minor units
 * ("cents" for USD/EUR, halere for CZK, etc.). These helpers deliberately
 * return plain numbers so browser previews and backend persistence can share
 * the same integer arithmetic without sharing backend-only brands.
 */
export type ProrateHourlyCentsInput = {
  billedMinutes: number;
  hourlyRateCents: number;
};

export const prorateHourlyCents = ({
  billedMinutes,
  hourlyRateCents,
}: ProrateHourlyCentsInput): number => {
  assertNonNegativeInteger("billedMinutes", billedMinutes);
  assertNonNegativeInteger("hourlyRateCents", hourlyRateCents);

  return Math.floor((billedMinutes * hourlyRateCents + 30) / 60);
};

export type ApplyMarkupCentsInput = {
  amountCents: number;
  markupPercent: number;
};

export const applyMarkupCents = ({
  amountCents,
  markupPercent,
}: ApplyMarkupCentsInput): number => {
  assertNonNegativeInteger("amountCents", amountCents);
  assertNonNegativeInteger("markupPercent", markupPercent);

  return Math.floor((amountCents * (100 + markupPercent) + 50) / 100);
};

function assertNonNegativeInteger(name: string, value: number) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative integer`);
  }
}
