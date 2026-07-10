import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";

import { workspaceViews } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import type { ViewLayout } from "@/api/lib/views-schema";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import reorderViews from "./reorder";

setDefaultTimeout(120_000);

// Pins the reorder handler's single-UPDATE CASE expression against a real
// Postgres (pglite): each CASE branch binds an untyped integer parameter,
// and without an explicit `::integer` cast Postgres rejects the assignment
// to the integer `position` column ("column is of type integer but
// expression is of type text"). No test exercised this write path before,
// which is how that broken UPDATE shipped.

type ReorderCtx = Parameters<typeof reorderViews.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;

const seededViewIds: SafeId<"workspaceView">[] = [];

const emptyLayout: ViewLayout = {
  type: "filesystem",
  version: 1,
  filters: [],
  sorts: [],
  hiddenProperties: [],
};

const seedView = async (
  name: string,
  position: number,
): Promise<SafeId<"workspaceView">> => {
  const id = createSafeId<"workspaceView">();
  seededViewIds.push(id);
  await testDb.insert(workspaceViews).values({
    id,
    workspaceId: ids.wsA1,
    name,
    layout: emptyLayout,
    position,
  });
  return id;
};

const runReorder = async (
  viewIds: SafeId<"workspaceView">[],
): Promise<unknown> => {
  const safeDb = createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);

  const context = asTestRaw<ReorderCtx>({
    body: { viewIds },
    createAuditRecorder: () => async () => undefined,
    memberRole: { role: "owner" },
    recordAuditEvent: async () => undefined,
    request: new Request(`https://example.test/workspaces/${ids.wsA1}/views`),
    route: "/test/views/reorder",
    safeDb,
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
    workspaceId: ids.wsA1,
  });

  try {
    return await reorderViews.handler(context);
  } catch (error) {
    return error;
  }
};

const readPositions = async (): Promise<
  { id: SafeId<"workspaceView">; position: number }[]
> =>
  await testDb
    .select({ id: workspaceViews.id, position: workspaceViews.position })
    .from(workspaceViews)
    .where(eq(workspaceViews.workspaceId, ids.wsA1))
    .orderBy(asc(workspaceViews.position));

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  try {
    if (seededViewIds.length > 0) {
      await testDb
        .delete(workspaceViews)
        .where(inArray(workspaceViews.id, seededViewIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

describe("views reorder integration", () => {
  test("persists positions matching a permuted order", async () => {
    const a = await seedView("Alpha", 0);
    const b = await seedView("Bravo", 1);
    const c = await seedView("Charlie", 2);

    const result = await runReorder([c, a, b]);

    expect(result).toEqual({});
    expect(await readPositions()).toEqual([
      { id: c, position: 0 },
      { id: a, position: 1 },
      { id: b, position: 2 },
    ]);
  });
});
