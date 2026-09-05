import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, TransactionRollbackError } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { usageLaneCounters } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  getLaneCounterMicroUnits,
  incrementLaneCounter,
} from "@/api/lib/usage/lane-budget";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await getTestDb();
});

afterAll(async () => {
  await releaseTestDb();
});

// 2026-08-14 is a Friday: the daily and weekly buckets of these instants
// are distinct, so a kind mix-up cannot pass unnoticed.
const ASOF = new Date("2026-08-14T09:15:00.000Z");
const SAME_DAY_LATER = new Date("2026-08-14T23:59:59.999Z");
const NEXT_DAY = new Date("2026-08-15T00:30:00.000Z");

type Fixture = {
  organizationId: SafeId<"organization">;
  userId: string;
};

const setupFixture = async (tx: Transaction): Promise<Fixture> => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  const userId = `user_${Bun.randomUUIDv7()}`;

  await tx.insert(organization).values({
    id: organizationId,
    name: "Test Org",
    slug: organizationId,
    createdAt: ASOF,
  });
  await tx.insert(user).values({
    id: userId,
    name: "Test User",
    email: `${userId}@test.local`,
  });

  return { organizationId, userId };
};

const withRolledBackTx = async (
  fn: (tx: Transaction) => Promise<void>,
): Promise<void> => {
  try {
    await testDb.transaction(async (rawTx) => {
      // SAFETY: PGlite drizzle transaction is structurally compatible
      // with prod BunSQL transaction for the queries we run here.
      const tx = asTestRaw<Transaction>(rawTx);
      await fn(tx);
      rawTx.rollback();
    });
  } catch (error) {
    if (error instanceof TransactionRollbackError) {
      return;
    }
    throw error;
  }
};

const countCounterRows = async (
  tx: Transaction,
  fx: Fixture,
): Promise<number> => {
  const rows = await tx
    .select({ id: usageLaneCounters.id })
    .from(usageLaneCounters)
    .where(eq(usageLaneCounters.organizationId, fx.organizationId));
  return rows.length;
};

describe("lane counters — increment and read", () => {
  test("creates the bucket row on the first write and accumulates on the next", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);

      await incrementLaneCounter({
        tx,
        ...fx,
        kind: "daily",
        microUnits: 120,
        asOf: ASOF,
      });
      expect(
        await getLaneCounterMicroUnits({
          tx,
          ...fx,
          kind: "daily",
          asOf: ASOF,
        }),
      ).toBe(120);

      await incrementLaneCounter({
        tx,
        ...fx,
        kind: "daily",
        microUnits: 30,
        asOf: SAME_DAY_LATER,
      });
      expect(
        await getLaneCounterMicroUnits({
          tx,
          ...fx,
          kind: "daily",
          asOf: ASOF,
        }),
      ).toBe(150);
      // One bucket, one row: the second write upserts rather than inserting.
      expect(await countCounterRows(tx, fx)).toBe(1);
    });
  });

  test("a different kind or a different day counts independently", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);

      await incrementLaneCounter({
        tx,
        ...fx,
        kind: "daily",
        microUnits: 500,
        asOf: ASOF,
      });
      await incrementLaneCounter({
        tx,
        ...fx,
        kind: "fallback_weekly",
        microUnits: 70,
        asOf: ASOF,
      });
      await incrementLaneCounter({
        tx,
        ...fx,
        kind: "daily",
        microUnits: 9,
        asOf: NEXT_DAY,
      });

      expect(
        await getLaneCounterMicroUnits({
          tx,
          ...fx,
          kind: "daily",
          asOf: ASOF,
        }),
      ).toBe(500);
      expect(
        await getLaneCounterMicroUnits({
          tx,
          ...fx,
          kind: "fallback_weekly",
          asOf: ASOF,
        }),
      ).toBe(70);
      // The next day is a fresh bucket: the reset is the missing row.
      expect(
        await getLaneCounterMicroUnits({
          tx,
          ...fx,
          kind: "daily",
          asOf: NEXT_DAY,
        }),
      ).toBe(9);
      expect(await countCounterRows(tx, fx)).toBe(3);
    });
  });

  test("zero and negative increments mint no row and change no count", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);

      for (const microUnits of [0, -40]) {
        await incrementLaneCounter({
          tx,
          ...fx,
          kind: "daily",
          microUnits,
          asOf: ASOF,
        });
      }
      expect(await countCounterRows(tx, fx)).toBe(0);

      await incrementLaneCounter({
        tx,
        ...fx,
        kind: "daily",
        microUnits: 200,
        asOf: ASOF,
      });
      await incrementLaneCounter({
        tx,
        ...fx,
        kind: "daily",
        microUnits: -200,
        asOf: ASOF,
      });
      expect(
        await getLaneCounterMicroUnits({
          tx,
          ...fx,
          kind: "daily",
          asOf: ASOF,
        }),
      ).toBe(200);
    });
  });

  test("an untouched bucket reads as zero", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);

      expect(
        await getLaneCounterMicroUnits({
          tx,
          ...fx,
          kind: "fallback_weekly",
          asOf: ASOF,
        }),
      ).toBe(0);
      expect(await countCounterRows(tx, fx)).toBe(0);
    });
  });
});
