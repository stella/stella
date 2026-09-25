import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { fields } from "@/api/db/schema";
import {
  errorPendingCells,
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
    await setContentType([ids.fieldA1, ids.fieldB1], "pending");
    const { calls, database } = recordingDatabase();

    expect(await errorPendingCells(database, ids.wsA1)).toBe(1);
    expect(calls).toEqual({ selectDistinct: 0, update: 1 });

    const contentTypes = await testDb
      .select({ id: fields.id, content: fields.content })
      .from(fields)
      .where(inArray(fields.id, [ids.fieldA1, ids.fieldB1]));
    expect(
      Object.fromEntries(
        contentTypes.map(({ id, content }) => [id, content.type]),
      ),
    ).toEqual({ [ids.fieldA1]: "error", [ids.fieldB1]: "pending" });

    // A second pass finds nothing left to error in that workspace.
    expect(await errorPendingCells(database, ids.wsA1)).toBe(0);
    const [stillText] = await testDb
      .select({ content: fields.content })
      .from(fields)
      .where(eq(fields.id, ids.fieldA2));
    expect(stillText?.content.type).toBe("text");
  });
});
