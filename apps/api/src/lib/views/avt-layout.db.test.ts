// The STELLA_RUN_POSTGRES_TESTS runner includes this PGlite suite alongside
// the verification suites; it also remains available in the ordinary DB lane.
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { legalLists, workspaceViews } from "@/api/db/schema";
import {
  operationProposesAvtLayout,
  operationUsesAvtLayout,
} from "@/api/lib/auth/feature-access/view-eligibility";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { rejectAvtLayout } from "@/api/lib/lists/verification/view-layout";
import type { ViewLayout } from "@/api/lib/views-schema";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
const seededViewIds: SafeId<"workspaceView">[] = [];
const seededListIds: SafeId<"legalList">[] = [];

const seedList = async (
  workspaceId: SafeId<"workspace">,
): Promise<SafeId<"legalList">> => {
  const id = createSafeId<"legalList">();
  seededListIds.push(id);
  await testDb
    .insert(legalLists)
    .values({ id, workspaceId, name: "Chronology" });
  return id;
};

const avtLayout = (listId: SafeId<"legalList"> | null): ViewLayout => ({
  type: "avt",
  version: 1,
  filters: [],
  sorts: [],
  hiddenProperties: [],
  calculations: [],
  listId,
});

const check = async (
  layout: ViewLayout,
  legalListsEnabled = true,
  accessStatus: "available" | "unavailable" = "available",
) =>
  await testDb.transaction(
    async (tx) =>
      await rejectAvtLayout({
        // The PGlite handle is the production transaction's test double.
        tx: asTestRaw<Transaction>(tx),
        workspaceId: ids.wsA1,
        layout,
        legalListsEnabled,
        accessStatus,
      }),
  );

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
    if (seededListIds.length > 0) {
      await testDb
        .delete(legalLists)
        .where(inArray(legalLists.id, seededListIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

describe("storing an AVT view layout", () => {
  test("accepts a list of the same matter, or none yet", async () => {
    const listId = await seedList(ids.wsA1);

    expect(await check(avtLayout(listId))).toBeNull();
    expect(await check(avtLayout(null))).toBeNull();
  });

  test("refuses a list of another matter", async () => {
    const foreignListId = await seedList(ids.wsA2);

    expect(await check(avtLayout(foreignListId))).toBe("list-not-found");
  });

  test("refuses a list that does not exist", async () => {
    expect(await check(avtLayout(createSafeId<"legalList">()))).toBe(
      "list-not-found",
    );
  });

  test("refuses any AVT layout while legal lists are off", async () => {
    expect(await check(avtLayout(null), false)).toBe("access-unavailable");
  });

  test("refuses every AVT list selection without an access grant", async () => {
    const listId = await seedList(ids.wsA1);
    for (const selection of [null, listId, createSafeId<"legalList">()]) {
      expect(await check(avtLayout(selection), true, "unavailable")).toBe(
        "access-unavailable",
      );
    }
  });

  test("leaves other layouts alone", async () => {
    expect(
      await check(
        {
          type: "filesystem",
          version: 1,
          filters: [],
          sorts: [],
          hiddenProperties: [],
          calculations: [],
        },
        false,
      ),
    ).toBeNull();
  });
});

describe("conditional AVT transport admission", () => {
  test("proposed admission recognizes AVT layouts and conversion targets only", () => {
    for (const body of [{ layout: avtLayout(null) }, { targetType: "avt" }]) {
      expect(operationProposesAvtLayout(body)).toBe(true);
    }
    for (const body of [
      undefined,
      null,
      "avt",
      [],
      {},
      { name: "Renamed" },
      { layout: "avt" },
      { layout: null },
      { layout: { type: "filesystem" } },
      { targetType: "filesystem" },
    ]) {
      expect(operationProposesAvtLayout(body)).toBe(false);
    }
  });
  test("recognizes proposed layouts without reading a resource", async () => {
    for (const body of [{ layout: avtLayout(null) }, { targetType: "avt" }]) {
      const usesAvt = await operationUsesAvtLayout({
        tx: {
          select: () => {
            throw new Error("proposed layouts need no resource lookup");
          },
        },
        workspaceId: ids.wsA1,
        body,
        params: {},
      });
      expect(usesAvt).toBe(true);
    }
  });

  test("recognizes persisted layouts for rename and conversion within the matter", async () => {
    const viewId = createSafeId<"workspaceView">();
    seededViewIds.push(viewId);
    await testDb.insert(workspaceViews).values({
      id: viewId,
      workspaceId: ids.wsA1,
      name: "View",
      layout: avtLayout(null),
      position: 0,
    });
    for (const body of [
      { name: "Renamed" },
      { targetType: "filesystem" },
      undefined,
    ]) {
      for (const workspaceId of [ids.wsA1, ids.wsA2]) {
        const usesAvt = await testDb.transaction(
          async (tx) =>
            await operationUsesAvtLayout({
              tx: asTestRaw<Transaction>(tx),
              workspaceId,
              body,
              params: { viewId },
            }),
        );
        expect(usesAvt).toBe(workspaceId === ids.wsA1);
      }
    }
  });
});
