/**
 * Apportion a time entry's total minutes across N splits by percentage.
 *
 * Uses the largest-remainder method over the whole duration so the result stays
 * proportional and always sums to `totalMinutes` exactly (never over-allocates,
 * unlike independently rounding each split). Any split whose proportional share
 * floors to zero is lifted to one minute by borrowing from the largest split;
 * callers guarantee `totalMinutes >= percentages.length`, so every deficit can
 * be covered. Percentages are expected to sum to 100 (validated at the boundary).
 */
export const apportionSplitDurations = (
  totalMinutes: number,
  percentages: readonly number[],
): number[] => {
  const ideal = percentages.map(
    (percentage) => (totalMinutes * percentage) / 100,
  );
  const remainder =
    totalMinutes - ideal.reduce((sum, value) => sum + Math.floor(value), 0);
  const bumped = new Set(
    ideal
      .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
      .sort((left, right) => right.fraction - left.fraction)
      .slice(0, remainder)
      .map((entry) => entry.index),
  );
  const durations = ideal.map(
    (value, index) => Math.floor(value) + (bumped.has(index) ? 1 : 0),
  );

  for (let index = 0; index < durations.length; index += 1) {
    while ((durations[index] ?? 0) < 1) {
      let largest = 0;
      for (let candidate = 1; candidate < durations.length; candidate += 1) {
        if ((durations[candidate] ?? 0) > (durations[largest] ?? 0)) {
          largest = candidate;
        }
      }
      durations[largest] = (durations[largest] ?? 0) - 1;
      durations[index] = (durations[index] ?? 0) + 1;
    }
  }

  return durations;
};
