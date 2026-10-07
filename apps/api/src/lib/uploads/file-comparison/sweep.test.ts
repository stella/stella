import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { OrganizationFileUsageError } from "@/api/lib/files/organization-file-usage";
import {
  FileComparisonSweepError,
  sweepExpiredFileComparisonUploads,
} from "@/api/lib/uploads/file-comparison/sweep";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const ORGANIZATION_ID = "org_1";
const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";

type ExpiredRow = { id: string; organizationId: string };

const createHarness = ({
  deleteFailsFor = new Set<string>(),
  ledgerFailsFor = new Set<string>(),
  deleteObject,
  readCause,
  removeCause,
  rows = [
    { id: FIRST_ID, organizationId: ORGANIZATION_ID },
    { id: SECOND_ID, organizationId: ORGANIZATION_ID },
  ],
}: {
  deleteFailsFor?: Set<string>;
  ledgerFailsFor?: Set<string>;
  rows?: ExpiredRow[];
  deleteObject?: NonNullable<
    Parameters<typeof sweepExpiredFileComparisonUploads>[0]["deleteObject"]
  >;
  readCause?: Error;
  removeCause?: Error;
} = {}) => {
  const deletedKeys: string[] = [];
  const selectLimits: number[] = [];
  const rowDeletes: number[] = [];

  const transaction = asTestRaw<Transaction>({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async (limit: number) => {
              selectLimits.push(limit);
              if (readCause) {
                throw readCause;
              }
              return await Promise.resolve(rows);
            },
          }),
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          rowDeletes.push(1);
          if (removeCause) {
            throw removeCause;
          }
          return rows.filter(({ id }) =>
            deletedKeys.includes(`${ORGANIZATION_ID}/tmp/comparisons/${id}`),
          );
        },
      }),
    }),
  });

  const safeDb: SafeDb = async (run) =>
    await Result.tryPromise(async () => await run(transaction));

  return {
    deletedKeys,
    rowDeletes,
    selectLimits,
    sweep: async (limit?: number) =>
      await sweepExpiredFileComparisonUploads({
        deleteObject:
          deleteObject ??
          (async (key) => {
            if (deleteFailsFor.has(key)) {
              throw new Error("s3 delete failed");
            }
            if (ledgerFailsFor.has(key)) {
              return Result.err(
                new OrganizationFileUsageError({
                  message: "Ledger unavailable",
                  reason: "storage_unavailable",
                }),
              );
            }
            deletedKeys.push(key);
            return Result.ok(undefined);
          }),
        ...(limit === undefined ? {} : { limit }),
        safeDb,
      }),
  };
};

describe("file comparison expiry sweep", () => {
  test("deletes each expired object and then its row", async () => {
    const harness = createHarness();

    const swept = await harness.sweep();

    expect(swept).toEqual(
      Result.ok({ scanned: 2, sweptUploads: 2, failed: 0 }),
    );
    expect(harness.deletedKeys).toEqual([
      `${ORGANIZATION_ID}/tmp/comparisons/${FIRST_ID}`,
      `${ORGANIZATION_ID}/tmp/comparisons/${SECOND_ID}`,
    ]);
    expect(harness.rowDeletes).toHaveLength(1);
  });

  test("keeps the row of an object it could not delete", async () => {
    const harness = createHarness({
      deleteFailsFor: new Set([
        `${ORGANIZATION_ID}/tmp/comparisons/${FIRST_ID}`,
      ]),
    });

    const swept = await harness.sweep();

    // The surviving row is what makes the next tick retry that key; deleting
    // it here would leave bytes nothing can name.
    expect(Result.isError(swept)).toBe(true);
    if (Result.isOk(swept)) {
      throw new Error("Expected partial failure");
    }
    expect(swept.error.summary).toEqual({
      scanned: 2,
      sweptUploads: 1,
      failed: 1,
    });
    expect(harness.deletedKeys).toEqual([
      `${ORGANIZATION_ID}/tmp/comparisons/${SECOND_ID}`,
    ]);
  });

  test("keeps the row when ledger decrement fails after storage deletion", async () => {
    const harness = createHarness({
      ledgerFailsFor: new Set([
        `${ORGANIZATION_ID}/tmp/comparisons/${FIRST_ID}`,
      ]),
    });

    const swept = await harness.sweep();
    expect(Result.isError(swept)).toBe(true);
    if (Result.isOk(swept)) {
      throw new Error("Expected ledger failure");
    }
    expect(swept.error.cause).toBeInstanceOf(OrganizationFileUsageError);
    expect(swept.error.summary).toEqual({
      scanned: 2,
      sweptUploads: 1,
      failed: 1,
    });
    expect(harness.deletedKeys).toEqual([
      `${ORGANIZATION_ID}/tmp/comparisons/${SECOND_ID}`,
    ]);
  });

  test("bounds one tick to the batch it was given", async () => {
    const harness = createHarness();

    await harness.sweep(7);

    expect(harness.selectLimits).toEqual([7]);
  });

  test("does nothing, and deletes nothing, when nothing has expired", async () => {
    const harness = createHarness({ rows: [] });

    const swept = await harness.sweep();

    expect(swept).toEqual(
      Result.ok({ scanned: 0, sweptUploads: 0, failed: 0 }),
    );
    expect(harness.deletedKeys).toHaveLength(0);
    expect(harness.rowDeletes).toHaveLength(0);
  });
});

test.each(["read", "remove"] as const)(
  "propagates %s failures instead of a healthy zero",
  async (stage) => {
    const cause = new TypeError("Database operation failed");
    const harness = createHarness(
      stage === "read" ? { readCause: cause } : { removeCause: cause },
    );
    const outcome = await harness.sweep();
    expect(Result.isError(outcome)).toBe(true);
    if (Result.isOk(outcome)) {
      throw new Error("Expected sweep failure");
    }
    expect(outcome.error).toBeInstanceOf(FileComparisonSweepError);
    expect(outcome.error.summary).toEqual({
      scanned: stage === "read" ? 0 : 2,
      sweptUploads: 0,
      failed: stage === "read" ? 0 : 2,
    });
    expect(harness.deletedKeys).toHaveLength(stage === "read" ? 0 : 2);
  },
);

test("keeps the first row cause when multiple deletes and row removal fail", async () => {
  const harness = createHarness({
    ledgerFailsFor: new Set([`${ORGANIZATION_ID}/tmp/comparisons/${FIRST_ID}`]),
    removeCause: new TypeError("Row removal failed"),
  });
  const outcome = await harness.sweep();
  expect(Result.isError(outcome)).toBe(true);
  if (Result.isOk(outcome)) {
    throw new Error("Expected partial failure");
  }
  expect(outcome.error.cause).toBeInstanceOf(OrganizationFileUsageError);
  expect(outcome.error.summary).toEqual({
    scanned: 2,
    sweptUploads: 0,
    failed: 2,
  });
});

test("keeps the first scan cause when later rows fail sooner", async () => {
  const first = new TypeError("First row failed");
  const second = new TypeError("Second row failed");
  const completion: string[] = [];
  const harness = createHarness({
    deleteObject: async (key) => {
      if (key.endsWith(FIRST_ID)) {
        await Promise.resolve();
        completion.push(FIRST_ID);
        throw first;
      }
      completion.push(SECOND_ID);
      throw second;
    },
  });
  const outcome = await harness.sweep();
  expect(completion).toEqual([SECOND_ID, FIRST_ID]);
  expect(Result.isError(outcome)).toBe(true);
  if (Result.isOk(outcome)) {
    throw new Error("Expected multi-row failure");
  }
  expect(outcome.error.cause).toBe(first);
  expect(outcome.error.summary).toEqual({
    scanned: 2,
    sweptUploads: 0,
    failed: 2,
  });
  expect(harness.rowDeletes).toHaveLength(0);
});
