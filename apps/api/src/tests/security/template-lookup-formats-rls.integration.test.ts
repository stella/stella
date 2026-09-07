import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { templateLookupFormats } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import createLookupFormat from "@/api/handlers/templates/lookup-formats/create";
import setDefaultLookupFormat from "@/api/handlers/templates/lookup-formats/default/update";
import deleteLookupFormat from "@/api/handlers/templates/lookup-formats/delete";
import listLookupFormats from "@/api/handlers/templates/lookup-formats/list";
import { createSafeId } from "@/api/lib/branded-types";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
const formatA = createSafeId<"templateLookupFormat">();
const formatB = createSafeId<"templateLookupFormat">();

beforeAll(
  async () => {
    const fixture = await getRlsFixture();
    testDb = fixture.testDb;
    ids = fixture.ids;
    await testDb.insert(templateLookupFormats).values([
      {
        id: formatA,
        organizationId: ids.orgA,
        registry: "ares",
        name: "Shared format A",
        format: "[company name], [registry number]",
      },
      {
        id: formatB,
        organizationId: ids.orgB,
        registry: "ares",
        name: "Shared format B",
        format: "[company name]",
      },
    ]);
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await releaseRlsFixture();
});

describe("organization company format isolation", () => {
  test("a default is shared with colleagues, scoped to its registry, and can be cleared", async () => {
    const scopedDb = asTestRaw<ScopedDb>(
      createScopedDb(testDb, [], ids.orgA, ids.userA1),
    );
    const context = {
      scopedDb,
      safeDb: toSafeDbMock(scopedDb),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
    };
    const setDefault = async (
      formatId: typeof formatA | null,
      registry: "ares" | "krs" = "ares",
    ) =>
      await setDefaultLookupFormat.handler(
        createTestHandlerContext<
          Parameters<typeof setDefaultLookupFormat.handler>[0]
        >({ ...context, body: { registry, formatId } }),
      );
    expect(await setDefault(formatA)).toEqual({ success: true });
    const colleagueDb = asTestRaw<ScopedDb>(
      createScopedDb(testDb, [], ids.orgA, ids.userA2),
    );
    const listed = await listLookupFormats.handler(
      createTestHandlerContext<Parameters<typeof listLookupFormats.handler>[0]>(
        {
          ...context,
          scopedDb: colleagueDb,
          safeDb: toSafeDbMock(colleagueDb),
          user: { id: ids.userA2 },
          query: { registry: "ares", limit: 1 },
        },
      ),
    );
    expect(listed).toMatchObject({ defaultFormat: { id: formatA } });
    expect(await setDefault(formatB)).toMatchObject({ code: 404 });
    expect(await setDefault(formatA, "krs")).toMatchObject({ code: 404 });
    expect(await setDefault(null)).toEqual({ success: true });
    const cleared = await listLookupFormats.handler(
      createTestHandlerContext<Parameters<typeof listLookupFormats.handler>[0]>(
        { ...context, query: { registry: "ares", limit: 1 } },
      ),
    );
    expect(cleared).toMatchObject({ defaultFormat: null });
  });
  test("saved templates are reusable by colleagues with stable bounded pages", async () => {
    const scopedDb = asTestRaw<ScopedDb>(
      createScopedDb(testDb, [], ids.orgA, ids.userA1),
    );
    const safeDb = toSafeDbMock(scopedDb);
    const auditActions: string[] = [];
    const recordAuditEvent: Parameters<
      typeof createLookupFormat.handler
    >[0]["recordAuditEvent"] = async (_tx, event) => {
      for (const item of Array.isArray(event) ? event : [event]) {
        auditActions.push(item.action);
      }
    };
    const created = await createLookupFormat.handler(
      createTestHandlerContext<
        Parameters<typeof createLookupFormat.handler>[0]
      >({
        scopedDb,
        safeDb,
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        body: {
          registry: "ares",
          name: "  Colleague format  ",
          format: "[company name], IČO [registry number]",
        },
        recordAuditEvent,
      }),
    );
    expect(created).toMatchObject({
      name: "Colleague format",
      format: "[company name], IČO [registry number]",
    });
    if (!("id" in created)) {
      throw new Error("Expected saved format");
    }
    const colleagueDb = asTestRaw<ScopedDb>(
      createScopedDb(testDb, [], ids.orgA, ids.userA2),
    );
    const listContext = {
      scopedDb: colleagueDb,
      safeDb: toSafeDbMock(colleagueDb),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA2 },
    };
    const first = await listLookupFormats.handler(
      createTestHandlerContext<Parameters<typeof listLookupFormats.handler>[0]>(
        { ...listContext, query: { registry: "ares", limit: 1 } },
      ),
    );
    expect(first).toMatchObject({ items: [created], limit: 1 });
    if (!("items" in first) || !first.nextCursor) {
      throw new Error("Expected next page cursor");
    }
    const second = await listLookupFormats.handler(
      createTestHandlerContext<Parameters<typeof listLookupFormats.handler>[0]>(
        {
          ...listContext,
          query: { registry: "ares", limit: 1, cursor: first.nextCursor },
        },
      ),
    );
    expect(second).toMatchObject({
      items: [{ id: formatA }],
      nextCursor: null,
    });
    const wrongRegistry = await listLookupFormats.handler(
      createTestHandlerContext<Parameters<typeof listLookupFormats.handler>[0]>(
        {
          ...listContext,
          query: { registry: "vies", limit: 1, cursor: first.nextCursor },
        },
      ),
    );
    expect(wrongRegistry).toMatchObject({ code: 400 });
    const empty = await createLookupFormat.handler(
      createTestHandlerContext<
        Parameters<typeof createLookupFormat.handler>[0]
      >({
        ...listContext,
        body: { registry: "ares", name: "  ", format: "[company name]" },
        recordAuditEvent,
      }),
    );
    expect(empty).toMatchObject({ code: 400 });
    await deleteLookupFormat.handler(
      createTestHandlerContext<
        Parameters<typeof deleteLookupFormat.handler>[0]
      >({ ...listContext, params: { formatId: created.id }, recordAuditEvent }),
    );
    expect(auditActions).toEqual(["create", "delete"]);
  });
  test("colleagues see the same formats but other organizations do not", async () => {
    for (const [organizationId, userId, expectedId] of [
      [ids.orgA, ids.userA1, formatA],
      [ids.orgA, ids.userA2, formatA],
      [ids.orgB, ids.userB1, formatB],
    ] as const) {
      const scoped = createScopedDb(testDb, [], organizationId, userId);
      const rows = await scoped((tx) =>
        tx.select({ id: templateLookupFormats.id }).from(templateLookupFormats),
      );
      expect(rows).toEqual([{ id: expectedId }]);
    }
  });

  test("cross-organization mutations cannot change or delete a format", async () => {
    const scoped = createScopedDb(testDb, [], ids.orgA, ids.userA1);
    const updated = await scoped((tx) =>
      tx
        .update(templateLookupFormats)
        .set({ name: "Unauthorized change" })
        .where(eq(templateLookupFormats.id, formatB))
        .returning(),
    );
    const deleted = await scoped((tx) =>
      tx
        .delete(templateLookupFormats)
        .where(eq(templateLookupFormats.id, formatB))
        .returning(),
    );
    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
    const unchanged = await testDb
      .select({ name: templateLookupFormats.name })
      .from(templateLookupFormats)
      .where(eq(templateLookupFormats.id, formatB));
    expect(unchanged).toEqual([{ name: "Shared format B" }]);
  });
});
