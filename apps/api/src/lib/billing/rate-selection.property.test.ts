import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { indexRateEntries, selectEffectiveRateEntry } from "./rate-selection";

const TABLES = ["table-a", "table-b", "table-c"] as const;
const USERS = ["user-1", "user-2", "user-3"] as const;
const ROLES = ["partner", "associate", "paralegal"] as const;
const ACTIVITIES = ["research", "drafting", "hearing"] as const;
const DATES = [
  "2025-01-01",
  "2025-06-01",
  "2026-01-01",
  "2026-06-01",
  "2026-12-31",
] as const;

type TestRateEntry = {
  id: string;
  rateTableId: string;
  userId: string | null;
  role: string | null;
  activityCode: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  hourlyRate: number;
};

const dateArb = fc.constantFrom(...DATES);

const rateEntryArb: fc.Arbitrary<TestRateEntry> = fc
  .record({
    id: fc.uuid(),
    rateTableId: fc.constantFrom(...TABLES),
    selectorKind: fc.constantFrom("user", "role", "default"),
    userId: fc.constantFrom(...USERS),
    role: fc.constantFrom(...ROLES),
    activityCode: fc.option(fc.constantFrom(...ACTIVITIES), { nil: null }),
    fromIdx: fc.integer({ min: 0, max: DATES.length - 1 }),
    toOffset: fc.option(fc.integer({ min: 0, max: DATES.length - 1 }), {
      nil: null,
    }),
    hourlyRate: fc.integer({ min: 100, max: 50_000 }),
  })
  .map((raw) => {
    const effectiveFrom = DATES[raw.fromIdx] ?? "2025-01-01";
    const toIdx =
      raw.toOffset === null
        ? null
        : Math.min(DATES.length - 1, raw.fromIdx + raw.toOffset);
    const effectiveTo = toIdx === null ? null : (DATES[toIdx] ?? null);
    return {
      id: raw.id,
      rateTableId: raw.rateTableId,
      userId: raw.selectorKind === "user" ? raw.userId : null,
      role: raw.selectorKind === "role" ? raw.role : null,
      activityCode: raw.activityCode,
      effectiveFrom,
      effectiveTo,
      hourlyRate: raw.hourlyRate,
    };
  });

const specificityRank = (
  entry: TestRateEntry,
  roles: readonly string[],
): number => {
  const activityBase = entry.activityCode !== null ? 0 : 100;
  if (entry.userId !== null) {
    return activityBase;
  }
  if (entry.role !== null) {
    const roleIndex = roles.indexOf(entry.role);
    return activityBase + 10 + (roleIndex === -1 ? 50 : roleIndex);
  }
  return activityBase + 90;
};

const isApplicable = (
  entry: TestRateEntry,
  query: {
    rateTableId: string;
    userId: string;
    roles: readonly string[];
    activityCode: string | null;
    dateWorked: string;
  },
): boolean => {
  if (entry.rateTableId !== query.rateTableId) {
    return false;
  }
  if (
    entry.effectiveFrom > query.dateWorked ||
    (entry.effectiveTo !== null && entry.effectiveTo < query.dateWorked)
  ) {
    return false;
  }
  if (
    entry.activityCode !== null &&
    entry.activityCode !== query.activityCode
  ) {
    return false;
  }
  if (entry.userId !== null && entry.userId !== query.userId) {
    return false;
  }
  if (entry.role !== null && !query.roles.includes(entry.role)) {
    return false;
  }
  return true;
};

describe("billing rate selection properties", () => {
  test("selected entry is always applicable and has strictly best specificity rank", () => {
    assertProperty(
      "selected entry is always applicable and has strictly best specificity rank",
      fc.property(
        fc.array(rateEntryArb, { maxLength: 30 }),
        fc.constantFrom(...TABLES),
        fc.constantFrom(...USERS),
        fc.subarray([...ROLES]),
        fc.option(fc.constantFrom(...ACTIVITIES), { nil: null }),
        dateArb,
        (entries, rateTableId, userId, roles, activityCode, dateWorked) => {
          const indexed = indexRateEntries(entries);
          const query = {
            rateTableId,
            userId,
            roles,
            activityCode,
            dateWorked,
          };
          const selected = selectEffectiveRateEntry({
            entries: indexed,
            ...query,
          });
          const applicable = entries.filter((entry) =>
            isApplicable(entry, query),
          );

          if (applicable.length === 0) {
            expect(selected).toBeUndefined();
            return;
          }

          expect(selected).toBeDefined();
          if (selected === undefined) {
            return;
          }
          expect(isApplicable(selected, query)).toBe(true);

          const bestRank = Math.min(
            ...applicable.map((entry) => specificityRank(entry, roles)),
          );
          expect(specificityRank(selected, roles)).toBe(bestRank);

          // Within the winning specificity tier, the earliest (newest-first)
          // applicable entry must win.
          const firstInBestTier = applicable.find(
            (entry) => specificityRank(entry, roles) === bestRank,
          );
          expect(firstInBestTier).toBeDefined();
          if (firstInBestTier !== undefined) {
            expect(selected.id).toBe(firstInBestTier.id);
          }
        },
      ),
    );
  });

  test("entries in other rate tables never influence selection", () => {
    assertProperty(
      "entries in other rate tables never influence selection",
      fc.property(
        fc.array(rateEntryArb, { maxLength: 20 }),
        fc.array(rateEntryArb, { maxLength: 15 }),
        fc.constantFrom(...TABLES),
        fc.constantFrom(...USERS),
        fc.subarray([...ROLES]),
        fc.option(fc.constantFrom(...ACTIVITIES), { nil: null }),
        dateArb,
        (
          baseEntries,
          noiseEntries,
          rateTableId,
          userId,
          roles,
          activityCode,
          dateWorked,
        ) => {
          const otherTableNoise = noiseEntries.filter(
            (entry) => entry.rateTableId !== rateTableId,
          );
          const withoutNoise = selectEffectiveRateEntry({
            entries: indexRateEntries(baseEntries),
            rateTableId,
            userId,
            roles,
            activityCode,
            dateWorked,
          });
          const withNoise = selectEffectiveRateEntry({
            entries: indexRateEntries([...otherTableNoise, ...baseEntries]),
            rateTableId,
            userId,
            roles,
            activityCode,
            dateWorked,
          });
          expect(withNoise?.id).toBe(withoutNoise?.id);
        },
      ),
    );
  });
});
