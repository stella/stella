import { Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  templateLookupFormatUserDefaults,
  templateLookupFormats,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import createLookupFormat from "@/api/handlers/templates/lookup-formats/create";
import setDefaultLookupFormat from "@/api/handlers/templates/lookup-formats/default/update";
import deleteLookupFormat from "@/api/handlers/templates/lookup-formats/delete";
import listLookupFormats from "@/api/handlers/templates/lookup-formats/list";
import setMyDefaultLookupFormat from "@/api/handlers/templates/lookup-formats/my-default/update";
import {
  LOOKUP_FORMAT_DEFAULT_SOURCE,
  resolveLookupFormatDefault,
} from "@/api/handlers/templates/lookup-formats/resolve-default";
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

describe("personal company format defaults", () => {
  const scopedFor = (organizationId: string, userId: string) =>
    asTestRaw<ScopedDb>(createScopedDb(testDb, [], organizationId, userId));
  const contextFor = (organizationId: string, userId: string) => {
    const scopedDb = scopedFor(organizationId, userId);
    return {
      scopedDb,
      safeDb: toSafeDbMock(scopedDb),
      session: { activeOrganizationId: organizationId },
      user: { id: userId },
    };
  };
  const resolveFor = async (
    organizationId: string,
    userId: string,
    registry: "ares" | "krs" = "ares",
  ) => {
    const resolved = await resolveLookupFormatDefault({
      safeDb: contextFor(organizationId, userId).safeDb,
      organizationId: asTestRaw(organizationId),
      userId: asTestRaw(userId),
      registry,
    });
    if (Result.isError(resolved)) {
      throw resolved.error;
    }
    return resolved.value;
  };
  const setMyDefault = async (
    organizationId: string,
    userId: string,
    formatId: string | null,
    registry: "ares" | "krs" = "ares",
  ) =>
    await setMyDefaultLookupFormat.handler(
      createTestHandlerContext<
        Parameters<typeof setMyDefaultLookupFormat.handler>[0]
      >({
        ...contextFor(organizationId, userId),
        body: { registry, formatId: asTestRaw(formatId) },
      }),
    );
  const listFor = async (organizationId: string, userId: string) =>
    await listLookupFormats.handler(
      createTestHandlerContext<Parameters<typeof listLookupFormats.handler>[0]>(
        {
          ...contextFor(organizationId, userId),
          query: { registry: "ares", limit: 10 },
        },
      ),
    );

  test("a member's own default overrides the organization's, for that member alone", async () => {
    const setOrgDefault = async (formatId: typeof formatA | null) =>
      await setDefaultLookupFormat.handler(
        createTestHandlerContext<
          Parameters<typeof setDefaultLookupFormat.handler>[0]
        >({
          ...contextFor(ids.orgA, ids.userA1),
          body: { registry: "ares", formatId },
        }),
      );
    const created = await createLookupFormat.handler(
      createTestHandlerContext<
        Parameters<typeof createLookupFormat.handler>[0]
      >({
        ...contextFor(ids.orgA, ids.userA1),
        body: {
          registry: "ares",
          name: "Personal pick",
          format: "[company name] ([registry number])",
        },
        recordAuditEvent: async () => {
          await Promise.resolve();
        },
      }),
    );
    if (!("id" in created)) {
      throw new Error("Expected saved format");
    }

    expect(await setOrgDefault(formatA)).toEqual({ success: true });
    expect(await resolveFor(ids.orgA, ids.userA1)).toMatchObject({
      id: formatA,
      source: LOOKUP_FORMAT_DEFAULT_SOURCE.ORGANIZATION,
    });

    expect(await setMyDefault(ids.orgA, ids.userA1, created.id)).toEqual({
      success: true,
    });
    expect(await resolveFor(ids.orgA, ids.userA1)).toMatchObject({
      id: created.id,
      format: "[company name] ([registry number])",
      source: LOOKUP_FORMAT_DEFAULT_SOURCE.USER,
    });
    // The colleague's answer is untouched: a personal choice is not shared.
    expect(await resolveFor(ids.orgA, ids.userA2)).toMatchObject({
      id: formatA,
      source: LOOKUP_FORMAT_DEFAULT_SOURCE.ORGANIZATION,
    });
    expect(await listFor(ids.orgA, ids.userA1)).toMatchObject({
      defaultFormat: { id: formatA },
      userDefaultFormat: {
        id: created.id,
        format: "[company name] ([registry number])",
      },
    });
    expect(await listFor(ids.orgA, ids.userA2)).toMatchObject({
      defaultFormat: { id: formatA },
      userDefaultFormat: null,
    });

    // Re-saving is a converging upsert, not a duplicate row.
    expect(await setMyDefault(ids.orgA, ids.userA1, formatA)).toEqual({
      success: true,
    });
    expect(await listFor(ids.orgA, ids.userA1)).toMatchObject({
      userDefaultFormat: { id: formatA },
    });
    expect(await setMyDefault(ids.orgA, ids.userA1, created.id)).toEqual({
      success: true,
    });

    // Deleting the chosen format clears the preference by cascade rather than
    // leaving it pointing at a format that is gone.
    await deleteLookupFormat.handler(
      createTestHandlerContext<
        Parameters<typeof deleteLookupFormat.handler>[0]
      >({
        ...contextFor(ids.orgA, ids.userA1),
        params: { formatId: created.id },
        recordAuditEvent: async () => {
          await Promise.resolve();
        },
      }),
    );
    expect(await listFor(ids.orgA, ids.userA1)).toMatchObject({
      userDefaultFormat: null,
    });
    expect(await resolveFor(ids.orgA, ids.userA1)).toMatchObject({
      id: formatA,
      source: LOOKUP_FORMAT_DEFAULT_SOURCE.ORGANIZATION,
    });

    // Clearing both leaves the built-in format as the only answer.
    expect(await setMyDefault(ids.orgA, ids.userA1, null)).toEqual({
      success: true,
    });
    expect(await setOrgDefault(null)).toEqual({ success: true });
    expect(await resolveFor(ids.orgA, ids.userA1)).toBeNull();
    expect(await resolveFor(ids.orgA, ids.userA1, "krs")).toBeNull();
  });

  test("a format from another organization or registry cannot become a personal default", async () => {
    expect(await setMyDefault(ids.orgA, ids.userA1, formatB)).toMatchObject({
      code: 404,
    });
    expect(
      await setMyDefault(ids.orgA, ids.userA1, formatA, "krs"),
    ).toMatchObject({ code: 404 });
    expect(await listFor(ids.orgA, ids.userA1)).toMatchObject({
      userDefaultFormat: null,
    });
  });

  test("one member's preference is invisible and immutable to everyone else", async () => {
    expect(await setMyDefault(ids.orgA, ids.userA1, formatA)).toEqual({
      success: true,
    });
    for (const [organizationId, userId] of [
      [ids.orgA, ids.userA2],
      [ids.orgB, ids.userB1],
    ] as const) {
      const rows = await createScopedDb(
        testDb,
        [],
        organizationId,
        userId,
      )((tx) =>
        tx
          .select({ formatId: templateLookupFormatUserDefaults.formatId })
          .from(templateLookupFormatUserDefaults),
      );
      expect(rows).toEqual([]);
    }
    const colleague = createScopedDb(testDb, [], ids.orgA, ids.userA2);
    const updated = await colleague((tx) =>
      tx
        .update(templateLookupFormatUserDefaults)
        .set({ formatId: formatA })
        .where(eq(templateLookupFormatUserDefaults.userId, ids.userA1))
        .returning({ userId: templateLookupFormatUserDefaults.userId }),
    );
    const deleted = await colleague((tx) =>
      tx
        .delete(templateLookupFormatUserDefaults)
        .where(eq(templateLookupFormatUserDefaults.userId, ids.userA1))
        .returning({ userId: templateLookupFormatUserDefaults.userId }),
    );
    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
    expect(await listFor(ids.orgA, ids.userA1)).toMatchObject({
      userDefaultFormat: { id: formatA },
    });
    expect(await setMyDefault(ids.orgA, ids.userA1, null)).toEqual({
      success: true,
    });
  });
});
