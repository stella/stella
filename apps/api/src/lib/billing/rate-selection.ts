type RateEntry = {
  rateTableId: string;
  userId: string | null;
  role: string | null;
  activityCode: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  hourlyRate: number;
};

const selectorKey = ({
  rateTableId,
  userId,
  role,
  activityCode,
}: Pick<RateEntry, "rateTableId" | "userId" | "role" | "activityCode">) =>
  JSON.stringify([rateTableId, userId, role, activityCode]);

/** Entries arrive newest first, including the stable id tie-breaker. */
export const indexRateEntries = <T extends RateEntry>(
  entries: readonly T[],
) => {
  const indexed = new Map<string, T[]>();
  for (const entry of entries) {
    const key = selectorKey(entry);
    const bucket = indexed.get(key);
    if (bucket) {
      bucket.push(entry);
    } else {
      indexed.set(key, [entry]);
    }
  }
  return indexed;
};

type SelectEffectiveRateEntryOptions<T extends RateEntry> = {
  entries: ReadonlyMap<string, readonly T[]>;
  rateTableId: string;
  userId: string;
  roles: readonly string[];
  activityCode: string | null;
  dateWorked: string;
};

/** Specificity precedes effective-date recency; role order is canonical. */
export const selectEffectiveRateEntry = <T extends RateEntry>({
  entries,
  rateTableId,
  userId,
  roles,
  activityCode,
  dateWorked,
}: SelectEffectiveRateEntryOptions<T>): T | undefined => {
  const forSelector = (
    selector: Pick<RateEntry, "userId" | "role" | "activityCode">,
  ) =>
    entries
      .get(selectorKey({ rateTableId, ...selector }))
      ?.find(
        (entry) =>
          entry.effectiveFrom <= dateWorked &&
          (entry.effectiveTo === null || entry.effectiveTo >= dateWorked),
      );
  const forRole = (activity: string | null) =>
    roles
      .map((role) =>
        forSelector({ userId: null, role, activityCode: activity }),
      )
      .find((entry) => entry !== undefined);
  if (activityCode !== null) {
    const activityEntry =
      forSelector({ userId, role: null, activityCode }) ??
      forRole(activityCode) ??
      forSelector({ userId: null, role: null, activityCode });
    if (activityEntry !== undefined) {
      return activityEntry;
    }
  }
  return (
    forSelector({ userId, role: null, activityCode: null }) ??
    forRole(null) ??
    forSelector({ userId: null, role: null, activityCode: null })
  );
};
