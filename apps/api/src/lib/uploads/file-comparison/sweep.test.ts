import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { sweepExpiredFileComparisonUploads } from "@/api/lib/uploads/file-comparison/sweep";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const ORGANIZATION_ID = "org_1";
const FIRST_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_ID = "22222222-2222-4222-8222-222222222222";

type ExpiredRow = { id: string; organizationId: string };

const createHarness = ({
  deleteFailsFor = new Set<string>(),
  rows = [
    { id: FIRST_ID, organizationId: ORGANIZATION_ID },
    { id: SECOND_ID, organizationId: ORGANIZATION_ID },
  ],
}: {
  deleteFailsFor?: Set<string>;
  rows?: ExpiredRow[];
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
              return await Promise.resolve(rows);
            },
          }),
        }),
      }),
    }),
    delete: () => ({
      where: async () => {
        rowDeletes.push(1);
        await Promise.resolve();
      },
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
        deleteObject: async (key) => {
          if (deleteFailsFor.has(key)) {
            throw new Error("s3 delete failed");
          }
          deletedKeys.push(key);
          await Promise.resolve();
        },
        ...(limit === undefined ? {} : { limit }),
        safeDb,
      }),
  };
};

describe("file comparison expiry sweep", () => {
  test("deletes each expired object and then its row", async () => {
    const harness = createHarness();

    const swept = await harness.sweep();

    expect(swept).toBe(2);
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
    expect(swept).toBe(1);
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

    expect(swept).toBe(0);
    expect(harness.deletedKeys).toHaveLength(0);
    expect(harness.rowDeletes).toHaveLength(0);
  });
});
