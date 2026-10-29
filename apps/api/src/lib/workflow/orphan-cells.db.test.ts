import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { extractionRuns, fields } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  errorPendingCell,
  errorPendingCells,
  selectPendingCellPage,
  selectWorkspacesWithPendingCells,
} from "@/api/lib/workflow/orphan-cells";
import type { OrphanCellsDatabase } from "@/api/lib/workflow/orphan-cells";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Orphan reconciliation reads and writes cells on the connection the
// workflow workers were started with. These tests hand it a recording
// wrapper over the test database: the scan and the update must go through
// it, and nothing reaches for a connection of its own.

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
}, 120_000);

afterAll(async () => {
  await releaseTestDb();
});

const setContentType = async (
  fieldIds: readonly (typeof ids.fieldA1)[],
  type: "pending" | "text",
) => {
  await testDb
    .update(fields)
    .set({
      content:
        type === "pending"
          ? { type: "pending", version: 1 }
          : { type: "text", value: "done", version: 1 },
      ...(type === "text"
        ? { ownerRunId: null, attempt: null, aiSettlement: null }
        : {}),
    })
    .where(inArray(fields.id, [...fieldIds]));
};

beforeEach(async () => {
  await setContentType([ids.fieldA1, ids.fieldA2, ids.fieldB1], "text");
});

type Recorded = { selectDistinct: number; update: number };

const recordingDatabase = (): {
  calls: Recorded;
  database: OrphanCellsDatabase;
} => {
  const calls: Recorded = { selectDistinct: 0, update: 0 };
  const database = asTestRaw<OrphanCellsDatabase>({
    selectDistinct: (...args: Parameters<typeof testDb.selectDistinct>) => {
      calls.selectDistinct += 1;
      return testDb.selectDistinct(...args);
    },
    update: (...args: Parameters<typeof testDb.update>) => {
      calls.update += 1;
      return testDb.update(...args);
    },
  });
  return { calls, database };
};

describe("orphan cell reconciliation", () => {
  test("errors a selected owned pending cell with its failed settlement", async () => {
    const ownerRunId = createSafeId<"extractionRun">();
    await testDb
      .update(fields)
      .set({
        content: { type: "pending", version: 1 },
        ownerRunId,
        attempt: 1,
      })
      .where(eq(fields.id, ids.fieldA1));

    expect(
      await errorPendingCell(testDb, {
        id: ids.fieldA1,
        ownerRunId,
        attempt: 1,
      }),
    ).toBe(true);
    const [cell] = await testDb
      .select({ content: fields.content, aiSettlement: fields.aiSettlement })
      .from(fields)
      .where(eq(fields.id, ids.fieldA1));
    expect(cell).toEqual({
      content: { type: "error", version: 1 },
      aiSettlement: {
        type: "failed",
        runId: ownerRunId,
        settledAt: expect.any(String),
      },
    });
  });

  test("does not borrow another member's identity for an unowned cell", async () => {
    await testDb.insert(extractionRuns).values({
      id: createSafeId<"extractionRun">(),
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      requestedBy: ids.userA2,
      scope: "workspace",
    });
    await testDb
      .update(fields)
      .set({
        content: { type: "pending", version: 1 },
        ownerRunId: null,
        attempt: null,
      })
      .where(eq(fields.id, ids.fieldA1));

    const cells = await selectPendingCellPage(testDb, null, 10);
    const unowned = cells.find(({ id }) => id === ids.fieldA1);
    expect(unowned).toMatchObject({
      ownerRunId: null,
      requestedBy: null,
    });
  });

  test("scans for pending cells on the handle it is given", async () => {
    await setContentType([ids.fieldA1, ids.fieldB1], "pending");
    const { calls, database } = recordingDatabase();

    const everywhere = await selectWorkspacesWithPendingCells(database);
    const amongLocked = await selectWorkspacesWithPendingCells(database, [
      ids.wsA1,
      ids.wsA2,
    ]);

    expect(everywhere).toEqual(expect.arrayContaining([ids.wsA1, ids.wsB1]));
    expect(everywhere).not.toContain(ids.wsA2);
    expect(amongLocked).toEqual([ids.wsA1]);
    expect(calls).toEqual({ selectDistinct: 2, update: 0 });
    // An empty candidate list asks nothing of the database.
    expect(await selectWorkspacesWithPendingCells(database, [])).toEqual([]);
    expect(calls.selectDistinct).toBe(2);
  });

  test("errors one workspace's pending cells on the handle it is given", async () => {
    const ownerRunId = createSafeId<"extractionRun">();
    await setContentType([ids.fieldA1, ids.fieldB1], "pending");
    await testDb
      .update(fields)
      .set({ ownerRunId })
      .where(eq(fields.id, ids.fieldA1));
    const { calls, database } = recordingDatabase();

    expect(await errorPendingCells(database, ids.wsA1)).toBe(1);
    expect(calls).toEqual({ selectDistinct: 0, update: 1 });

    const contentTypes = await testDb
      .select({
        id: fields.id,
        content: fields.content,
        aiSettlement: fields.aiSettlement,
      })
      .from(fields)
      .where(inArray(fields.id, [ids.fieldA1, ids.fieldB1]));
    expect(
      Object.fromEntries(
        contentTypes.map(({ id, content }) => [id, content.type]),
      ),
    ).toEqual({ [ids.fieldA1]: "error", [ids.fieldB1]: "pending" });
    expect(
      contentTypes.find(({ id }) => id === ids.fieldA1)?.aiSettlement,
    ).toEqual({
      type: "failed",
      runId: ownerRunId,
      settledAt: expect.any(String),
    });

    // A second pass finds nothing left to error in that workspace.
    expect(await errorPendingCells(database, ids.wsA1)).toBe(0);
    const [stillText] = await testDb
      .select({ content: fields.content })
      .from(fields)
      .where(eq(fields.id, ids.fieldA2));
    expect(stillText?.content.type).toBe("text");
  });
});
