import { Temporal } from "@stll/time";

import {
  lawRecentKey,
  readLawRecent,
} from "@/lib/law-search-history/law-search-history.rows";

/** Merge the unscoped browser history into its owner's scoped history. */
export const mergeLegacyLawHistory = (
  legacyRaw: string,
  existingRaw: string | null,
): string | null => {
  const legacy = readLawRecent(legacyRaw);
  if (legacy.length === 0) {
    return null;
  }
  const seen = new Set<string>();
  return JSON.stringify(
    [...readLawRecent(existingRaw), ...legacy]
      .toSorted((left, right) => Temporal.Instant.compare(right.at, left.at))
      .filter((row) => {
        const key = lawRecentKey(row);
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      }),
  );
};
