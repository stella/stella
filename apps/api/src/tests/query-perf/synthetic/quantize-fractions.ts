import { panic } from "better-result";

const HUNDREDTHS_PER_UNIT = 100;
const MINIMUM_POSITIVE_HUNDREDTHS = 1;
const MAX_POSITIVE_SHARES = HUNDREDTHS_PER_UNIT;
const RESIDUAL_WEIGHT_SCALE = 100_000_000;
const DISTRIBUTION_SUM_TOLERANCE = 1e-6;

const validateFraction = (fraction: number) => {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    panic("Fractions must be finite numbers from zero through one");
  }
};

/** Rounds a fraction to hundredths, preserving zero and every positive value. */
export const quantizeFraction = (fraction: number) => {
  validateFraction(fraction);
  if (fraction === 0) {
    return 0;
  }
  return Math.max(
    MINIMUM_POSITIVE_HUNDREDTHS / HUNDREDTHS_PER_UNIT,
    Math.round(fraction * HUNDREDTHS_PER_UNIT) / HUNDREDTHS_PER_UNIT,
  );
};

/** Normalizes a near-unit distribution into whole hundredths without losing support. */
export const quantizeDistribution = (shares: readonly number[]) => {
  if (shares.length === 0) {
    panic("Distributions must contain at least one share");
  }
  for (const share of shares) {
    validateFraction(share);
  }
  const positiveCount = shares.filter((share) => share > 0).length;
  if (positiveCount === 0) {
    panic("Distributions must have positive mass");
  }
  if (positiveCount > MAX_POSITIVE_SHARES) {
    panic(
      "Distributions cannot preserve more than one hundred positive shares",
    );
  }
  const total = shares.reduce((sum, share) => sum + share, 0);
  if (Math.abs(total - 1) > DISTRIBUTION_SUM_TOLERANCE + Number.EPSILON) {
    panic("Distribution mass must be within 1e-6 of one");
  }

  const remainingBudget = HUNDREDTHS_PER_UNIT - positiveCount;
  if (remainingBudget === 0) {
    return shares.map((share) =>
      share === 0 ? 0 : MINIMUM_POSITIVE_HUNDREDTHS / HUNDREDTHS_PER_UNIT,
    );
  }

  const residualWeights = shares.map((share) => {
    if (share === 0) {
      return 0n;
    }
    const residual = Math.max(
      0,
      share * HUNDREDTHS_PER_UNIT - MINIMUM_POSITIVE_HUNDREDTHS,
    );
    const nearestInteger = Math.round(residual);
    const snappedResidual =
      Math.abs(residual - nearestInteger) <= 1e-8 ? nearestInteger : residual;
    return BigInt(Math.round(snappedResidual * RESIDUAL_WEIGHT_SCALE));
  });
  const totalResidualWeight = residualWeights.reduce(
    (sum, weight) => sum + weight,
    0n,
  );
  if (totalResidualWeight === 0n) {
    panic("Distribution residual weights must have positive mass");
  }

  const budget = BigInt(remainingBudget);
  const exactAllocations = residualWeights.map((weight) => {
    const numerator = weight * budget;
    return {
      hundredths: Number(numerator / totalResidualWeight),
      remainder: numerator % totalResidualWeight,
    };
  });
  const allocatedHundredths = exactAllocations.map(
    ({ hundredths }) => hundredths,
  );
  const unallocated =
    remainingBudget -
    allocatedHundredths.reduce((sum, hundredths) => sum + hundredths, 0);
  const remainderOrder = exactAllocations
    .map(({ remainder }, index) => ({ index, remainder }))
    .toSorted((left, right) => {
      if (left.remainder === right.remainder) {
        return left.index - right.index;
      }
      return left.remainder > right.remainder ? -1 : 1;
    });
  for (const { index } of remainderOrder.slice(0, unallocated)) {
    allocatedHundredths[index] = (allocatedHundredths.at(index) ?? 0) + 1;
  }

  return shares.map((share, index) => {
    const hundredths =
      (share === 0 ? 0 : MINIMUM_POSITIVE_HUNDREDTHS) +
      (allocatedHundredths.at(index) ?? 0);
    return hundredths / HUNDREDTHS_PER_UNIT;
  });
};
