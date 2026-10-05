import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  WORKSPACE_VIEWS_CORRESPONDENCE_INDEX,
  workspaceViews,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";
import { getDefaultViews } from "@/api/lib/views";
import type { ViewLayout } from "@/api/lib/views-schema";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import createView from "./create";

setDefaultTimeout(120_000);

// A matter holds one correspondence view. views.create checks for one under
// FOR UPDATE, but row locks cannot see a view another transaction is
// inserting, so the unique index is what holds the invariant under
// concurrency, and its refusal must read as the same conflict.

type CreateCtx = Parameters<typeof createView.handler>[0];

let testDb: TestDatabase;
let ids: TestIds;

const correspondenceLayout = (): ViewLayout => {
  const seeded = getDefaultViews("en").find(
    (view) => view.layout.type === "correspondence",
  );
  if (!seeded) {
    throw new Error("default views carry no correspondence view");
  }
  return seeded.layout;
};

const correspondenceRow = () => ({
  id: createSafeId<"workspaceView">(),
  workspaceId: ids.wsA1,
  name: "Correspondence",
  layout: correspondenceLayout(),
  position: 0,
});

const correspondenceViewIds = async (): Promise<SafeId<"workspaceView">[]> =>
  (
    await testDb
      .select({ id: workspaceViews.id })
      .from(workspaceViews)
      .where(
        and(
          eq(workspaceViews.workspaceId, ids.wsA1),
          sql`${workspaceViews.layout} ->> 'type' = 'correspondence'`,
        ),
      )
  ).map(({ id }) => id);

// The handler's SafeDb is typed over the production driver's transaction;
// the shared test database runs the same schema on PGlite.
const scopedSafeDb = (): SafeDb =>
  asTestRaw<SafeDb>(createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1));

const runCreate = async (
  safeDb: CreateCtx["safeDb"],
  viewId: SafeId<"workspaceView">,
): Promise<unknown> => {
  const context = asTestRaw<CreateCtx>({
    body: { id: viewId, name: "Mail", layout: correspondenceLayout() },
    createAuditRecorder: () => async () => undefined,
    memberRole: sessionMemberRole("owner"),
    recordAuditEvent: async () => undefined,
    request: new Request(`https://example.test/workspaces/${ids.wsA1}/views`),
    route: "/test/views/create",
    safeDb,
    scopedDb: createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    session: { activeOrganizationId: ids.orgA },
    user: { id: ids.userA1 },
    workspaceId: ids.wsA1,
  });

  try {
    return await createView.handler(context);
  } catch (error) {
    return error;
  }
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterEach(async () => {
  await testDb
    .delete(workspaceViews)
    .where(
      and(
        eq(workspaceViews.workspaceId, ids.wsA1),
        sql`${workspaceViews.layout} ->> 'type' = 'correspondence'`,
      ),
    );
});

afterAll(async () => {
  await releaseRlsFixture();
});

describe("one correspondence view per matter", () => {
  test("the database refuses a second one on the named index", async () => {
    expect(await correspondenceViewIds()).toEqual([]);
    const first = correspondenceRow();
    await testDb.insert(workspaceViews).values(first);

    const refusal = await testDb
      .insert(workspaceViews)
      .values(correspondenceRow())
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(
      isPgConstraintError(
        refusal,
        PG_ERROR.UNIQUE_VIOLATION,
        WORKSPACE_VIEWS_CORRESPONDENCE_INDEX,
      ),
    ).toBe(true);
    expect(await correspondenceViewIds()).toEqual([first.id]);
  });

  test("a create that loses the race gets the singleton conflict", async () => {
    expect(await correspondenceViewIds()).toEqual([]);
    const safeDb = scopedSafeDb();
    const competitor = correspondenceRow();

    // The competing create commits between this create's FOR UPDATE check
    // and its insert: the check saw no correspondence view, the insert meets
    // one.
    const racingSafeDb: CreateCtx["safeDb"] = async (fn, retry) =>
      await safeDb(
        async (tx) =>
          await fn(
            new Proxy(tx, {
              get(target, property, receiver) {
                if (property !== "insert") {
                  return Reflect.get(target, property, receiver);
                }
                return (table: typeof workspaceViews) => {
                  const insert = target.insert(table);
                  if (table !== workspaceViews) {
                    return insert;
                  }
                  return {
                    values: (row: typeof workspaceViews.$inferInsert) => ({
                      returning: async () => {
                        await target.insert(workspaceViews).values(competitor);
                        return await insert.values(row).returning();
                      },
                    }),
                  };
                };
              },
            }),
          ),
        retry,
      );

    const outcome = await runCreate(
      racingSafeDb,
      createSafeId<"workspaceView">(),
    );

    expect(outcome).toMatchObject({
      code: 400,
      response: { message: "A matter holds only one correspondence view" },
    });
    // Both inserts rolled back with the refused transaction.
    expect(await correspondenceViewIds()).toEqual([]);
  });

  test("an uncontested create still succeeds", async () => {
    const safeDb = scopedSafeDb();
    const viewId = createSafeId<"workspaceView">();

    const outcome = await runCreate(safeDb, viewId);

    expect(outcome).toMatchObject({ id: viewId, name: "Mail" });
    expect(await correspondenceViewIds()).toEqual([viewId]);
  });
});
