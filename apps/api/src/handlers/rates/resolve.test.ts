import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import fc from "fast-check";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";
import type { OrganizationRoleName } from "@stll/auth-model";
import { propertyConfig, propertyTestTimeout } from "@stll/property-testing";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { rateEntries, rateTables } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import {
  rateLookupKey,
  resolveRate,
  resolveRatesInTransaction,
} from "@/api/lib/billing/rates";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { validateOrgUserId } from "@/api/lib/validated-org-user-id";
import type { ValidatedOrgUserId } from "@/api/lib/validated-org-user-id";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  NO_AUDIT,
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withTimeBillingEnrolment } from "@/api/tests/helpers/time-billing-enrolment";
import { createPropertyRunReclaimer } from "@/api/tests/property-run-reclaim";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import resolveRateHandler from "./resolve";

setDefaultTimeout(propertyTestTimeout(120_000));

// ── Effective-dated rate resolution contract (pinned after reading resolve.ts)
//
// Resolution is scoped to the workspace's single `isDefault` rate table:
//   1. If the workspace has no default rate table -> null.
//   2. Among entries in that table whose effective range covers the query date
//      (effectiveFrom <= date AND (effectiveTo IS NULL OR effectiveTo >= date)):
//        a. USER-SPECIFIC entries (userId = query user) take precedence; the
//           one with the greatest effectiveFrom wins — even over a newer
//           table-default entry.
//        b. Otherwise ROLE entries matching current organization membership;
//           the one with the greatest effectiveFrom wins.
//        c. Otherwise TABLE-DEFAULT entries (userId and role both NULL); the
//           one with the greatest effectiveFrom wins.
//        d. Otherwise -> null.
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
let reclaimRun: () => Promise<void>;

beforeAll(async () => {
  testDb = await getTestDb();
  reclaimRun = createPropertyRunReclaimer(testDb, [rateEntries]);
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
// table at all, exercising the "no default table -> null" branch). PGlite's
// transaction type is structurally distinct from the production `Transaction`
// (different QueryResultHKT); asTestRaw is the established cast for bridging
// a PGlite-backed safeDb into a prod-typed handler context.
const scopedSafeDb = (): SafeDb =>
  asTestRaw<SafeDb>(
    createSafeDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1),
  );

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
  kind: "user" | "other" | "role" | "other-role" | "default";
  rate: number;
  toDelta: number | null;
};

const entryArb = fc.record<GeneratedEntry>({
  fromOffset: fc.integer({ min: 0, max: 3650 }),
  kind: fc.constantFrom("user", "other", "role", "other-role", "default"),
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
  role: OrganizationRoleName | null;
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

const rowRole = (kind: GeneratedEntry["kind"]): ResolvedRow["role"] => {
  if (kind === "role") {
    return "member";
  }
  if (kind === "other-role") {
    return "intern";
  }
  return null;
};

const toRow = (entry: GeneratedEntry): ResolvedRow => ({
  userId: rowUserId(entry.kind),
  role: rowRole(entry.kind),
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
    userWinner ??
    pickLatest(inRange.filter((row) => row.role === "member")) ??
    pickLatest(
      inRange.filter((row) => row.userId === null && row.role === null),
    );
  return winner === null
    ? null
    : { hourlyRate: winner.rate, currency: DEFAULT_CURRENCY };
};

describe("effective-dated rate resolution", () => {
  let validatedUserA1: ValidatedOrgUserId;

  beforeAll(async () => {
    const scoped = createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
    const validated = await scoped(async (tx) =>
      validateOrgUserId(asTestRaw<Transaction>(tx), ids.userA1, ids.orgA),
    );
    if (!validated) {
      throw new Error("Expected userA1 to be a member of orgA");
    }
    validatedUserA1 = validated;
  });

  test(
    "resolves person over role over single within inclusive effective dates",
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
            // Otherwise the process grows with numRuns, not with the input.
            await reclaimRun();
            if (rows.length > 0) {
              await testDb.insert(rateEntries).values(
                rows.map((row) => ({
                  id: toSafeId<"rateEntry">(Bun.randomUUIDv7()),
                  workspaceId: ids.wsA1,
                  rateTableId: defaultTableId,
                  userId: row.userId,
                  role: row.role,
                  hourlyRate: cents(row.rate),
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
  const ROLE_RATE = 20_000;

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
        hourlyRate: cents(USER_RATE),
        effectiveFrom: "2025-01-01",
      },
      {
        id: toSafeId<"rateEntry">(Bun.randomUUIDv7()),
        workspaceId: ids.wsA1,
        rateTableId: defaultTableId,
        userId: null,
        role: "member",
        hourlyRate: cents(ROLE_RATE),
        effectiveFrom: "2025-01-01",
        effectiveTo: "2025-12-31",
      },
      {
        id: toSafeId<"rateEntry">(Bun.randomUUIDv7()),
        workspaceId: ids.wsA1,
        rateTableId: defaultTableId,
        userId: null,
        hourlyRate: cents(DEFAULT_RATE),
        effectiveFrom: "2024-01-01",
      },
    ]);
  });

  type ResolveCtx = Parameters<typeof resolveRateHandler.handler>[0];

  const contextFor = (query: { userId: string; date: string }): ResolveCtx =>
    withTimeBillingEnrolment(
      createTestHandlerContext<ResolveCtx>({
        audit: NO_AUDIT,
        scopedDb: NO_DB,
        workspaceId: ids.wsA1,
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        safeDb: scopedSafeDb(),
        query,
      }),
    );

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

  test("role applies at both inclusive boundaries and falls back to single outside its window", async () => {
    for (const [date, hourlyRate] of [
      ["2024-12-31", DEFAULT_RATE],
      ["2025-01-01", ROLE_RATE],
      ["2025-12-31", ROLE_RATE],
      ["2026-01-01", DEFAULT_RATE],
    ] as const) {
      const result = await resolveRateHandler.handler(
        contextFor({ userId: ids.userA2, date }),
      );
      expect(result).toEqual({ hourlyRate, currency: DEFAULT_CURRENCY });
    }
  });

  test("organization-scoped role lookup does not resolve a foreign organization's member", async () => {
    const result = await Result.gen(async function* () {
      return Result.ok(
        yield* resolveRate({
          safeDb: scopedSafeDb(),
          workspaceId: ids.wsA1,
          userId: ids.userB1,
          dateWorked: "2025-06-01",
        }),
      );
    });
    expect(result).toEqual(Result.ok(null));
  });

  test("404s when the queried user is not a member of the organization", async () => {
    const result = await resolveRateHandler.handler(
      contextFor({
        userId: mintAuthProviderId<"user">(),
        date: "2025-06-01",
      }),
    );
    expect(result).toMatchObject({ code: 404 });
  });
});

describe("rate resolution across stored membership role values", () => {
  const ADMIN_RATE = 30_000;
  const MEMBER_RATE = 20_000;
  const INTERN_RATE = 12_000;
  const DEFAULT_RATE = 15_000;
  const USER_RATE = 25_000;
  const IN_ADMIN_WINDOW = "2025-06-01";
  const AFTER_ADMIN_WINDOW = "2026-06-01";

  const roleRate = (
    role: OrganizationRoleName,
    hourlyRate: number,
    effectiveTo: string | null = null,
  ) => ({
    id: toSafeId<"rateEntry">(Bun.randomUUIDv7()),
    workspaceId: ids.wsA1,
    rateTableId: defaultTableId,
    userId: null,
    role,
    hourlyRate: cents(hourlyRate),
    effectiveFrom: "2025-01-01",
    effectiveTo,
  });

  beforeAll(async () => {
    await testDb
      .delete(rateEntries)
      .where(eq(rateEntries.rateTableId, defaultTableId));
    await testDb.insert(rateEntries).values([
      roleRate("admin", ADMIN_RATE, "2025-12-31"),
      roleRate("member", MEMBER_RATE),
      roleRate("intern", INTERN_RATE),
      {
        id: toSafeId<"rateEntry">(Bun.randomUUIDv7()),
        workspaceId: ids.wsA1,
        rateTableId: defaultTableId,
        userId: null,
        hourlyRate: cents(DEFAULT_RATE),
        effectiveFrom: "2025-01-01",
      },
    ]);
  });

  const storeRole = async (role: string) => {
    await testDb
      .update(member)
      .set({ role })
      .where(
        and(eq(member.organizationId, ids.orgA), eq(member.userId, ids.userA2)),
      );
  };

  afterEach(async () => {
    await storeRole("member");
    await testDb
      .delete(rateEntries)
      .where(
        and(
          eq(rateEntries.rateTableId, defaultTableId),
          eq(rateEntries.userId, ids.userA2),
        ),
      );
  });

  const resolveFor = async (
    userId: SafeId<"user">,
    dateWorked: string,
  ): Promise<{ hourlyRate: number; currency: string } | null> => {
    const result = await Result.gen(async function* () {
      return Result.ok(
        yield* resolveRate({
          safeDb: scopedSafeDb(),
          workspaceId: ids.wsA1,
          userId,
          dateWorked,
        }),
      );
    });
    if (Result.isError(result)) {
      throw result.error;
    }
    return result.value;
  };
  const priced = (hourlyRate: number) => ({
    hourlyRate,
    currency: DEFAULT_CURRENCY,
  });

  const rateByRole = {
    owner: DEFAULT_RATE,
    admin: ADMIN_RATE,
    member: MEMBER_RATE,
    intern: INTERN_RATE,
    external: DEFAULT_RATE,
  } as const satisfies Record<OrganizationRoleName, number>;

  test("each single valid membership role resolves its applicable rate", async () => {
    for (const role of ORGANIZATION_ROLE_NAMES) {
      await storeRole(role);
      expect(await resolveFor(ids.userA2, IN_ADMIN_WINDOW)).toEqual(
        priced(rateByRole[role]),
      );
    }
  });

  test("a role without an effective rate falls back to the table default", async () => {
    await storeRole("admin");
    expect(await resolveFor(ids.userA2, AFTER_ADMIN_WINDOW)).toEqual(
      priced(DEFAULT_RATE),
    );
  });

  test("storing a combined membership role is refused", async () => {
    const write = await Result.tryPromise({
      try: async () => await storeRole("admin,member"),
      catch: (error) => error,
    });
    expect(
      write.match({ ok: () => undefined, err: (error) => error }),
    ).toMatchObject({
      cause: {
        code: "23514",
        constraint: "member_single_product_role",
      },
    });
  });

  test("a person-specific rate wins for every single valid membership role", async () => {
    await testDb.insert(rateEntries).values({
      id: toSafeId<"rateEntry">(Bun.randomUUIDv7()),
      workspaceId: ids.wsA1,
      rateTableId: defaultTableId,
      userId: ids.userA2,
      hourlyRate: cents(USER_RATE),
      effectiveFrom: "2025-01-01",
    });
    for (const role of ORGANIZATION_ROLE_NAMES) {
      await storeRole(role);
      expect(await resolveFor(ids.userA2, IN_ADMIN_WINDOW)).toEqual(
        priced(USER_RATE),
      );
    }
  });

  test("a batch resolves every entry across role and default rates", async () => {
    await storeRole("admin");
    const adminInWindow = {
      userId: ids.userA2,
      dateWorked: IN_ADMIN_WINDOW,
    };
    const adminAfterWindow = {
      userId: ids.userA2,
      dateWorked: AFTER_ADMIN_WINDOW,
    };
    const single = { userId: ids.userA1, dateWorked: IN_ADMIN_WINDOW };
    // The fixture's owner has no role rate.
    const owner = { userId: ids.userAdmin, dateWorked: IN_ADMIN_WINDOW };
    const lookups = [adminInWindow, adminAfterWindow, single, owner];
    const result = await Result.gen(async function* () {
      return Result.ok(
        yield* Result.await(
          scopedSafeDb()(
            async (tx) =>
              await resolveRatesInTransaction({
                tx,
                workspaceId: ids.wsA1,
                lookups,
              }),
          ),
        ),
      );
    });
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(Object.fromEntries(result.value)).toEqual({
      [rateLookupKey(adminInWindow)]: priced(ADMIN_RATE),
      [rateLookupKey(adminAfterWindow)]: priced(DEFAULT_RATE),
      [rateLookupKey(single)]: priced(MEMBER_RATE),
      [rateLookupKey(owner)]: priced(DEFAULT_RATE),
    });
  });
});
