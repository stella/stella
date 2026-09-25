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
import { legalLists } from "@/api/db/schema";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import type { ViewLayout } from "@/api/lib/views-schema";
import { rejectAvtLayout } from "@/api/lib/views/avt-layout";
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

const check = async (layout: ViewLayout, legalListsEnabled = true) =>
  await testDb.transaction(
    async (tx) =>
      await rejectAvtLayout({
        // The PGlite handle is the production transaction's test double.
        tx: asTestRaw<Transaction>(tx),
        workspaceId: ids.wsA1,
        layout,
        legalListsEnabled,
      }),
  );

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  try {
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
    expect(await check(avtLayout(null), false)).toBe("legal-lists-disabled");
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
