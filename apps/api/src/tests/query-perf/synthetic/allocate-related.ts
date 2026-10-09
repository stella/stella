import { panic } from "better-result";

type AllocateRelatedRowsOptions = {
  desired: readonly number[];
  minimum: readonly number[];
  maximum: readonly number[];
};

const checkedTotal = (values: readonly number[]) => {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(total)) {
    panic("Related row allocation total must be a safe integer");
  }
  return total;
};

const distribute = (amount: number, capacities: readonly number[]) => {
  const capacityBigInt = capacities.map(BigInt);
  const totalCapacityBigInt = capacityBigInt.reduce(
    (sum, capacity) => sum + capacity,
    0n,
  );
  if (amount < 0 || BigInt(amount) > totalCapacityBigInt) {
    panic("Related row allocation is infeasible");
  }
  if (amount === 0) {
    return capacities.map(() => 0);
  }

  const amountBigInt = BigInt(amount);
  const exact = capacityBigInt.map((capacity) => {
    const numerator = amountBigInt * capacity;
    return {
      count: Number(numerator / totalCapacityBigInt),
      remainder: numerator % totalCapacityBigInt,
    };
  });
  const allocated = exact.map(({ count }) => count);
  const remaining = amount - checkedTotal(allocated);
  const order = exact
    .map(({ remainder }, index) => ({ index, remainder }))
    .toSorted((left, right) => {
      if (left.remainder === right.remainder) {
        return left.index - right.index;
      }
      return left.remainder > right.remainder ? -1 : 1;
    });
  for (const { index } of order.slice(0, remaining)) {
    allocated[index] = (allocated.at(index) ?? 0) + 1;
  }
  return allocated;
};

/** Keeps desired counts where possible, then proportionally reallocates to fit bounds. */
export const allocateRelatedRows = ({
  desired,
  minimum,
  maximum,
}: AllocateRelatedRowsOptions) => {
  if (minimum.length !== desired.length || maximum.length !== desired.length) {
    panic("Related row allocation arrays must have matching lengths");
  }
  if (
    ![...desired, ...minimum, ...maximum].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    )
  ) {
    panic("Related row counts and bounds must be nonnegative safe integers");
  }
  if (minimum.some((count, index) => count > (maximum.at(index) ?? -1))) {
    panic("Related row minimum exceeds maximum");
  }

  const target = checkedTotal(desired);
  const minimumTotal = checkedTotal(minimum);
  const maximumTotal = maximum
    .map(BigInt)
    .reduce((sum, count) => sum + count, 0n);
  if (target < minimumTotal || BigInt(target) > maximumTotal) {
    panic("Related row allocation total is infeasible");
  }

  const baseline = desired.map((count, index) =>
    Math.min(maximum.at(index) ?? 0, Math.max(minimum.at(index) ?? 0, count)),
  );
  const baselineTotal = checkedTotal(baseline);
  if (baselineTotal === target) {
    return baseline;
  }
  if (baselineTotal < target) {
    const additions = distribute(
      target - baselineTotal,
      maximum.map((count, index) => count - (baseline.at(index) ?? 0)),
    );
    return baseline.map((count, index) => count + (additions.at(index) ?? 0));
  }

  const reductions = distribute(
    baselineTotal - target,
    baseline.map((count, index) => count - (minimum.at(index) ?? 0)),
  );
  return baseline.map((count, index) => count - (reductions.at(index) ?? 0));
};
