import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import fc from "fast-check";

import { propertyConfig, propertyTestTimeout } from "@stll/property-testing";

import { rateEntries, rateTables } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { validateOrgUserId } from "@/api/lib/validated-org-user-id";
import type { ValidatedOrgUserId } from "@/api/lib/validated-org-user-id";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import resolveRateHandler, { resolveRate } from "./resolve";

setDefaultTimeout(120_000);

// ── Effective-dated rate resolution contract (pinned after reading resolve.ts)
//
// Resolution is scoped to the workspace's single `isDefault` rate table:
//   1. If the workspace has no default rate table -> null.
//   2. Among entries in that table whose effective range covers the query date
//      (effectiveFrom <= date AND (effectiveTo IS NULL OR effectiveTo >= date)):
//        a. USER-SPECIFIC entries (userId = query user) take precedence; the
//           one with the greatest effectiveFrom wins — even over a newer
//           table-default entry.
//        b. Otherwise TABLE-DEFAULT entries (userId IS NULL); the one with the
//           greatest effectiveFrom wins.
//        c. Otherwise -> null.
//   Entries belonging to a different user never participate.
//   The resolved currency is always the default table's currency.

const BASE_EPOCH_MS = Date.UTC(2020, 0, 1);
const DAY_MS = 86_400_000;
const DEFAULT_CURRENCY = "USD";

const isoDate = (dayOffset: number): string =>
  new Date(BASE_EPOCH_MS + dayOffset * DAY_MS).toISOString().slice(0, 10);

let testDb: TestDatabase;
let ids: TestIds;
let defaultTableId: SafeId<"rateTable">;

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);

  // A dedicated default rate table for wsA1. The fixture's rateTableA1 is not
  // a default table, so this is the only isDefault table for the workspace and
  // resolution is deterministic.
  defaultTableId = toSafeId<"rateTable">(Bun.randomUUIDv7());
  await testDb.insert(rateTables).values({
    id: defaultTableId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    name: "Default table",
    currency: DEFAULT_CURRENCY,
    isDefault: true,
  });
});

afterAll(async () => {
  await releaseTestDb();
});

// safeDb authorized for wsA1 (owns the default table) and wsA2 (has no rate
// table at all, exercising the "no default table -> null" branch).
const scopedSafeDb = () =>
  createSafeDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1);

const runResolve = async (input: {
  workspaceId: SafeId<"workspace">;
  userId: ValidatedOrgUserId;
  dateWorked: string;
}) => {
  // resolveRate delegates its DB failures via `yield*` and returns a plain
  // value, so drive it through a generator that wraps the value back into a
  // Result for `Result.gen`.
  const result = await Result.gen(async function* () {
    const value = yield* resolveRate({ safeDb: scopedSafeDb(), ...input });
    return Result.ok(value);
  });
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value;
};

type GeneratedEntry = {
  fromOffset: number;
  kind: "user" | "other" | "default";
  rate: number;
  toDelta: number | null;
};

const entryArb = fc.record<GeneratedEntry>({
  fromOffset: fc.integer({ min: 0, max: 3650 }),
  kind: fc.constantFrom("user", "other", "default"),
  rate: fc.integer({ min: 1, max: 1_000_000 }),
  toDelta: fc.option(fc.integer({ min: 0, max: 365 }), { nil: null }),
});

// Unique effectiveFrom offsets keep "greatest effectiveFrom" unambiguous, so
// the property has a single well-defined expected winner (no ORDER BY tie).
const entriesArb = fc.uniqueArray(entryArb, {
  maxLength: 10,
  selector: (entry) => entry.fromOffset,
});

type ResolvedRow = {
  userId: SafeId<"user"> | null;
  rate: number;
  fromOffset: number;
  fromIso: string;
  toIso: string | null;
};

const rowUserId = (kind: GeneratedEntry["kind"]): SafeId<"user"> | null => {
  if (kind === "user") {
    return ids.userA1;
  }
  if (kind === "other") {
    return ids.userA2;
  }
  return null;
};

const toRow = (entry: GeneratedEntry): ResolvedRow => ({
  userId: rowUserId(entry.kind),
  rate: entry.rate,
  fromOffset: entry.fromOffset,
  fromIso: isoDate(entry.fromOffset),
  toIso:
    entry.toDelta === null ? null : isoDate(entry.fromOffset + entry.toDelta),
});

const covers = (row: ResolvedRow, date: string): boolean =>
  row.fromIso <= date && (row.toIso === null || row.toIso >= date);

const pickLatest = (rows: ResolvedRow[]): ResolvedRow | null => {
  let best: ResolvedRow | null = null;
  for (const row of rows) {
    if (best === null || row.fromOffset > best.fromOffset) {
      best = row;
    }
  }
  return best;
};

const expectedResolution = (
  rows: ResolvedRow[],
  date: string,
): { hourlyRate: number; currency: string } | null => {
  const inRange = rows.filter((row) => covers(row, date));
  const userWinner = pickLatest(
    inRange.filter((row) => row.userId === ids.userA1),
  );
  const winner =
    userWinner ?? pickLatest(inRange.filter((row) => row.userId === null));
  return winner === null
    ? null
    : { hourlyRate: winner.rate, currency: DEFAULT_CURRENCY };
};

describe("effective-dated rate resolution", () => {
  let validatedUserA1: ValidatedOrgUserId;

  beforeAll(async () => {
    const scoped = createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
    const validated = await scoped((tx) =>
      validateOrgUserId(tx, ids.userA1, ids.orgA),
    );
    if (!validated) {
      throw new Error("Expected userA1 to be a member of orgA");
    }
    validatedUserA1 = validated;
  });

  test(
    "resolves the greatest-effectiveFrom in-range entry, user rate over default",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          entriesArb,
          fc.integer({ min: 0, max: 3650 }),
          async (entries, queryOffset) => {
            const rows = entries.map(toRow);
            const queryDate = isoDate(queryOffset);

            await testDb
              .delete(rateEntries)
              .where(eq(rateEntries.rateTableId, defaultTableId));
            if (rows.length > 0) {
              await testDb.insert(rateEntries).values(
                rows.map((row) => ({
                  id: toSafeId<"rateEntry">(Bun.randomUUIDv7()),
                  workspaceId: ids.wsA1,
                  rateTableId: defaultTableId,
                  userId: row.userId,
                  hourlyRate: row.rate,
                  effectiveFrom: row.fromIso,
                  effectiveTo: row.toIso,
                })),
              );
            }

            const actual = await runResolve({
              workspaceId: ids.wsA1,
              userId: validatedUserA1,
              dateWorked: queryDate,
            });

            expect(actual).toEqual(expectedResolution(rows, queryDate));
          },
        ),
        propertyConfig({ numRuns: 60 }),
      );
    },
    propertyTestTimeout(120_000),
  );

  test("returns null when the workspace has no default rate table", async () => {
    const actual = await runResolve({
      workspaceId: ids.wsA2,
      userId: validatedUserA1,
      dateWorked: isoDate(1000),
    });
    expect(actual).toBeNull();
  });
});

describe("resolveRate HTTP handler", () => {
  const USER_RATE = 25_000;
  const DEFAULT_RATE = 15_000;

  beforeAll(async () => {
    await testDb
      .delete(rateEntries)
      .where(eq(rateEntries.rateTableId, defaultTableId));
    await testDb.insert(rateEntries).values([
      {
        id: toSafeId<"rateEntry">(Bun.randomUUIDv7()),
        workspaceId: ids.wsA1,
        rateTableId: defaultTableId,
        userId: ids.userA1,
        hourlyRate: USER_RATE,
        effectiveFrom: "2025-01-01",
      },
      {
        id: toSafeId<"rateEntry">(Bun.randomUUIDv7()),
        workspaceId: ids.wsA1,
        rateTableId: defaultTableId,
        userId: null,
        hourlyRate: DEFAULT_RATE,
        effectiveFrom: "2024-01-01",
      },
    ]);
  });

  type ResolveCtx = Parameters<typeof resolveRateHandler.handler>[0];

  const contextFor = (query: { userId: string; date: string }): ResolveCtx =>
    createTestHandlerContext<ResolveCtx>({
      workspaceId: ids.wsA1,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      safeDb: scopedSafeDb(),
      query,
    });

  test("returns the user-specific rate when one is effective", async () => {
    const result = await resolveRateHandler.handler(
      contextFor({ userId: ids.userA1, date: "2025-06-01" }),
    );
    expect(result).toEqual({
      hourlyRate: USER_RATE,
      currency: DEFAULT_CURRENCY,
    });
  });

  test("falls back to the table default for a member without a user rate", async () => {
    const result = await resolveRateHandler.handler(
      contextFor({ userId: ids.userAdmin, date: "2025-06-01" }),
    );
    expect(result).toEqual({
      hourlyRate: DEFAULT_RATE,
      currency: DEFAULT_CURRENCY,
    });
  });

  test("404s when the queried user is not a member of the organization", async () => {
    const result = await resolveRateHandler.handler(
      contextFor({
        userId: toSafeId<"user">(Bun.randomUUIDv7()),
        date: "2025-06-01",
      }),
    );
    expect(result).toMatchObject({ code: 404 });
  });
});
