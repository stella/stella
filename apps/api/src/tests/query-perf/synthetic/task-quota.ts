import { panic } from "better-result";

type AllocateTaskQuotasOptions = {
  entityCounts: readonly number[];
  itemCounts: readonly number[];
  assigneeCounts: readonly number[];
  taskCount: number;
};

/** Child task rows constrain each workspace's task population before kind slots are assigned. */
export const allocateTaskQuotas = ({
  entityCounts,
  itemCounts,
  assigneeCounts,
  taskCount,
}: AllocateTaskQuotasOptions) => {
  if (
    itemCounts.length !== entityCounts.length ||
    assigneeCounts.length !== entityCounts.length
  ) {
    panic("Task quota allocations must share a workspace universe");
  }
  if (
    ![taskCount, ...entityCounts, ...itemCounts, ...assigneeCounts].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    )
  ) {
    panic("Task quota counts must be nonnegative safe integers");
  }
  const quotas = entityCounts.map((entities, index) => {
    const minimum = Math.max(
      itemCounts.at(index) ?? 0,
      assigneeCounts.at(index) ?? 0,
    );
    if (minimum > entities) {
      panic("Task child rows exceed workspace entity capacity");
    }
    return minimum;
  });
  const minimumTotal = quotas.reduce((sum, count) => sum + count, 0);
  const remaining = taskCount - minimumTotal;
  const capacities = entityCounts.map(
    (entities, index) => entities - (quotas.at(index) ?? 0),
  );
  const totalCapacity = capacities.reduce((sum, count) => sum + count, 0);
  if (remaining < 0 || remaining > totalCapacity) {
    panic("Task kind frequency cannot accommodate task child rows");
  }
  if (remaining === 0) {
    return quotas;
  }
  const exact = capacities.map(
    (capacity) => (capacity / totalCapacity) * remaining,
  );
  const additions = exact.map(Math.floor);
  const remainder =
    remaining - additions.reduce((sum, count) => sum + count, 0);
  const order = exact.map((value, index) => ({
    index,
    fraction: value - Math.floor(value),
  }));
  order.sort(
    (left, right) => right.fraction - left.fraction || left.index - right.index,
  );
  for (const { index } of order.slice(0, remainder)) {
    additions[index] = (additions.at(index) ?? 0) + 1;
  }
  return quotas.map((quota, index) => quota + (additions.at(index) ?? 0));
};
