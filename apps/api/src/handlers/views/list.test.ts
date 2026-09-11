import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray } from "drizzle-orm";

import { workspaceViews } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import type { ViewLayout } from "@/api/lib/views-schema";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import readViews from "./list";

setDefaultTimeout(120_000);

// The web client reconciles its per-view table state against this list and
// drops state for any view it does not name (`lib/workspaces/queries/views.ts`),
// which is only correct while the list is complete. `create` caps a matter at
// `LIMITS.viewsCount` views, so a matter filled to that cap must list every
// one of them; a page size or filter added here would fail this before it
// wiped a user's column widths.

type ListCtx = Parameters<typeof readViews.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;

const seededViewIds: SafeId<"workspaceView">[] = [];

const emptyLayout: ViewLayout = {
  type: "filesystem",
  version: 1,
  filters: [],
  sorts: [],
  hiddenProperties: [],
  calculations: [],
};

const seedViews = async (count: number): Promise<SafeId<"workspaceView">[]> => {
  const rows = Array.from({ length: count }, (_, position) => ({
    id: createSafeId<"workspaceView">(),
    workspaceId: ids.wsA1,
    name: `View ${String(position)}`,
    layout: emptyLayout,
    position,
  }));
  await testDb.insert(workspaceViews).values(rows);
  const viewIds = rows.map((row) => row.id);
  seededViewIds.push(...viewIds);
  return viewIds;
};

const listViews = async () => {
  const safeDb = createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1);
  const context = asTestRaw<ListCtx>({
    memberRole: { role: "owner" },
    request: new Request(`https://example.test/views/${ids.wsA1}`),
    route: "/test/views",
    safeDb,
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
    workspaceId: ids.wsA1,
  });
  return await readViews.handler(context);
};

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

describe("views list completeness", () => {
  test("lists every view of a matter filled to the creation cap", async () => {
    const seeded = await seedViews(LIMITS.viewsCount);

    const listed = await listViews();
    if (!Array.isArray(listed)) {
      throw new TypeError(`list failed: ${JSON.stringify(listed)}`);
    }

    expect(listed.map((view) => view.id)).toEqual(seeded);
  });
});
