import { panic, Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, count, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  desktopEditSessions,
  entities,
  entityVersions,
  fields,
  properties,
  taskAssignees,
} from "@/api/db/schema";
import type { FieldContent, PropertyContent } from "@/api/db/schema-validators";
import { createScopedDb } from "@/api/db/scoped";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { TASK_ASSIGNEE_ROLE } from "@/api/lib/entity-constants";
import { buildFindConditions } from "@/api/lib/entity-filters";
import { isRecord } from "@/api/lib/type-guards";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { queryEntities } from "./query-entities";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
const sessionIds: SafeId<"desktopEditSession">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  safeDb = toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    ),
  );
});

afterAll(async () => {
  try {
    await clearSessions();
  } finally {
    await releaseRlsFixture();
  }
});

const clearSessions = async (): Promise<void> => {
  if (sessionIds.length === 0) {
    return;
  }
  await testDb
    .delete(desktopEditSessions)
    .where(inArray(desktopEditSessions.id, sessionIds));
  sessionIds.length = 0;
};

afterEach(async () => {
  await clearSessions();
});

beforeEach(async () => {
  await clearSessions();
});

const insertLiveSession = async ({
  createdAt,
  createdBy,
  status = "open",
  id,
  propertyId,
  tokenExpiresAt = new Date("2100-01-01T00:00:00.000Z"),
}: {
  createdAt: Date;
  createdBy: SafeId<"user">;
  id: SafeId<"desktopEditSession">;
  propertyId: SafeId<"property">;
  status?: "cancelled" | "open";
  tokenExpiresAt?: Date;
}): Promise<void> => {
  sessionIds.push(id);
  await testDb.insert(desktopEditSessions).values({
    id,
    workspaceId: ids.wsA1,
    entityId: ids.entityA1,
    propertyId,
    baseVersionId: ids.entityVersionA1,
    createdBy,
    fileName: "active.docx",
    fileType: "docx",
    checkpointFileId: toSafeId<"userFile">(Bun.randomUUIDv7()),
    sessionTokenHash: Bun.randomUUIDv7().replaceAll("-", ""),
    tokenExpiresAt,
    createdAt,
    status,
  });
};

const readActiveEditor = async () => {
  const result = await queryEntities({
    safeDb,
    workspaceId: ids.wsA1,
    currentUserId: ids.userA1,
    currentOrganizationId: ids.orgA,
    filters: [],
    sorts: [],
    limit: 10,
    fieldMode: "visible",
    fieldIds: [],
  });
  if (Result.isError(result)) {
    throw result.error;
  }
  return result.value.entities.find(
    (entity) => entity.entityId === ids.entityA1,
  )?.activeEditBy;
};

describe("entity active edit indicators", () => {
  test("shows the oldest live session when an entity has concurrent editors", async () => {
    await insertLiveSession({
      id: toSafeId<"desktopEditSession">(Bun.randomUUIDv7()),
      propertyId: ids.propertyA1,
      createdBy: ids.userA1,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    });
    await insertLiveSession({
      id: toSafeId<"desktopEditSession">(Bun.randomUUIDv7()),
      propertyId: ids.propertyA1dep,
      createdBy: ids.userA2,
      createdAt: new Date("2026-08-01T11:00:00.000Z"),
    });

    const activeEditor = await readActiveEditor();

    expect(activeEditor).toEqual({
      name: "User A1",
      image: null,
      isMe: true,
    });
  });

  test("breaks equal creation timestamps by session id", async () => {
    const firstId = toSafeId<"desktopEditSession">(Bun.randomUUIDv7());
    const secondId = toSafeId<"desktopEditSession">(Bun.randomUUIDv7());
    const expectedEditor = firstId < secondId ? ids.userA1 : ids.userA2;
    const createdAt = new Date("2026-08-01T12:00:00.000Z");

    await insertLiveSession({
      id: firstId,
      propertyId: ids.propertyA1,
      createdBy: ids.userA1,
      createdAt,
    });
    await insertLiveSession({
      id: secondId,
      propertyId: ids.propertyA1dep,
      createdBy: ids.userA2,
      createdAt,
    });

    const activeEditor = await readActiveEditor();

    expect(activeEditor).toMatchObject({
      name: expectedEditor === ids.userA1 ? "User A1" : "User A2",
      isMe: expectedEditor === ids.userA1,
    });
  });

  test("excludes expired and closed sessions", async () => {
    await insertLiveSession({
      id: toSafeId<"desktopEditSession">(Bun.randomUUIDv7()),
      propertyId: ids.propertyA1,
      createdBy: ids.userA1,
      createdAt: new Date("2026-08-01T09:00:00.000Z"),
      tokenExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    await insertLiveSession({
      id: toSafeId<"desktopEditSession">(Bun.randomUUIDv7()),
      propertyId: ids.propertyA1dep,
      createdBy: ids.userA2,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
      status: "cancelled",
    });

    const activeEditor = await readActiveEditor();

    expect(activeEditor).toBeNull();
  });

  test("does not expose an editor outside the active organization", async () => {
    await insertLiveSession({
      id: toSafeId<"desktopEditSession">(Bun.randomUUIDv7()),
      propertyId: ids.propertyA1,
      createdBy: ids.userB1,
      createdAt: new Date("2026-08-01T10:00:00.000Z"),
    });

    const activeEditor = await readActiveEditor();

    expect(activeEditor).toBeNull();
  });
});

describe("entity creator projection", () => {
  test("keeps the creator ID when the entity has a different last editor", async () => {
    await testDb
      .update(entities)
      .set({ createdBy: ids.userA1, lastEditedBy: ids.userA2 })
      .where(eq(entities.id, ids.entityA1));

    try {
      const result = await queryEntities({
        safeDb,
        workspaceId: ids.wsA1,
        currentUserId: ids.userA1,
        currentOrganizationId: ids.orgA,
        filters: [],
        sorts: [],
        limit: 10,
        fieldMode: "visible",
        fieldIds: [],
      });
      if (Result.isError(result)) {
        throw result.error;
      }

      const entity = result.value.entities.find(
        (candidate) => candidate.entityId === ids.entityA1,
      );
      expect(entity?.createdBy).toBe("User A1");
      expect(entity?.createdByUserId).toBe(ids.userA1);
    } finally {
      await testDb
        .update(entities)
        .set({ createdBy: null, lastEditedBy: null })
        .where(eq(entities.id, ids.entityA1));
    }
  });
});

describe("task assignee projection", () => {
  const taskEntityIds: SafeId<"entity">[] = [];

  afterEach(async () => {
    if (taskEntityIds.length === 0) {
      return;
    }
    await testDb.delete(entities).where(inArray(entities.id, taskEntityIds));
    taskEntityIds.length = 0;
  });

  const seedTask = async (): Promise<SafeId<"entity">> => {
    const entityId = createSafeId<"entity">();
    const versionId = createSafeId<"entityVersion">();
    taskEntityIds.push(entityId);

    await testDb.insert(entities).values({
      id: entityId,
      workspaceId: ids.wsA1,
      kind: "task",
      name: "assignee projection task",
      status: "open",
      createdBy: ids.userA1,
    });
    await testDb.insert(entityVersions).values({
      id: versionId,
      workspaceId: ids.wsA1,
      entityId,
    });
    await testDb
      .update(entities)
      .set({ currentVersionId: versionId })
      .where(eq(entities.id, entityId));

    return entityId;
  };

  const readAssignees = async (
    entityId: SafeId<"entity">,
    includeAssignees = true,
  ) => {
    const result = await queryEntities({
      safeDb,
      workspaceId: ids.wsA1,
      currentUserId: ids.userA1,
      currentOrganizationId: ids.orgA,
      filters: [],
      sorts: [],
      limit: 10,
      fieldMode: "visible",
      fieldIds: [],
      includeAssignees,
    });
    if (Result.isError(result)) {
      throw result.error;
    }
    return result.value.entities.find(
      (candidate) => candidate.entityId === entityId,
    )?.assignees;
  };

  test("returns an empty list for a task with no assignees", async () => {
    const entityId = await seedTask();

    expect(await readAssignees(entityId)).toEqual([]);
  });

  test("omits assignees when includeAssignees is false, even for a task with assignees", async () => {
    const entityId = await seedTask();
    await testDb.insert(taskAssignees).values({
      id: createSafeId<"taskAssignee">(),
      workspaceId: ids.wsA1,
      entityId,
      userId: ids.userA1,
      role: TASK_ASSIGNEE_ROLE.ASSIGNEE,
    });

    expect(await readAssignees(entityId, false)).toEqual([]);
  });

  test("returns one entry for a task with a single assignee", async () => {
    const entityId = await seedTask();
    await testDb.insert(taskAssignees).values({
      id: createSafeId<"taskAssignee">(),
      workspaceId: ids.wsA1,
      entityId,
      userId: ids.userA1,
      role: TASK_ASSIGNEE_ROLE.ASSIGNEE,
    });

    const assignees = await readAssignees(entityId);

    expect(assignees).toEqual([
      expect.objectContaining({ userId: ids.userA1, name: "User A1" }),
    ]);
  });

  test("returns every assignee row for a task with several assignees, regardless of role", async () => {
    const entityId = await seedTask();
    await testDb.insert(taskAssignees).values([
      {
        id: createSafeId<"taskAssignee">(),
        workspaceId: ids.wsA1,
        entityId,
        userId: ids.userA1,
        role: TASK_ASSIGNEE_ROLE.ASSIGNEE,
      },
      {
        id: createSafeId<"taskAssignee">(),
        workspaceId: ids.wsA1,
        entityId,
        userId: ids.userA2,
        role: TASK_ASSIGNEE_ROLE.REVIEWER,
      },
    ]);

    const assignees = await readAssignees(entityId);

    expect(assignees).toHaveLength(2);
    expect(assignees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: ids.userA1 }),
        expect.objectContaining({ userId: ids.userA2 }),
      ]),
    );
  });
});

describe("field_find_text", () => {
  // The immutable projection the trigram index is built over. Its contract is
  // what makes the index only ever narrow: the text it returns is the text
  // the cell displays, or NULL.
  const findText = async (content: FieldContent): Promise<string | null> => {
    const result: unknown = await testDb.execute(
      sql`SELECT field_find_text(${JSON.stringify(content)}::text::jsonb) AS text`,
    );
    // The pglite driver answers `{ rows }`, the postgres driver an array.
    const rows = isRecord(result) ? result["rows"] : result;
    if (!Array.isArray(rows)) {
      return panic("field_find_text returned no rows");
    }
    const row: unknown = rows.at(0);
    return isRecord(row) && typeof row["text"] === "string"
      ? row["text"]
      : null;
  };

  test("a multi-select element keeps its quotes and backslashes", async () => {
    // The array is read off its JSON text, which escapes these two characters;
    // left escaped, a term containing either would miss the cell.
    const text = await findText({
      version: 1,
      type: "multi-select",
      value: ['say "zeta"', "back\\slash"],
    });

    expect(text).toContain('say "zeta"');
    expect(text).toContain("back\\slash");
    expect(text).not.toContain('\\"');
  });

  test("each findable type yields the text its cell displays", async () => {
    expect(
      await findText({ version: 1, type: "text", value: "Zeta lease" }),
    ).toBe("Zeta lease");
    expect(
      await findText({ version: 1, type: "single-select", value: "open" }),
    ).toBe("open");
    expect(
      await findText({
        version: 1,
        type: "person",
        userId: null,
        name: "Zeta Person",
        image: null,
      }),
    ).toBe("Zeta Person");
  });

  test("a type a find cannot reach yields nothing", async () => {
    expect(await findText({ version: 1, type: "pending" })).toBeNull();
    expect(
      await findText({ version: 1, type: "int", value: 4321, currency: null }),
    ).toBeNull();
  });
});

describe("find in table", () => {
  const TERM = "zeta";
  const seededEntityIds: SafeId<"entity">[] = [];
  const seededPropertyIds: SafeId<"property">[] = [];
  const propertyIds = {
    date: createSafeId<"property">(),
    int: createSafeId<"property">(),
    money: createSafeId<"property">(),
    memo: createSafeId<"property">(),
    tags: createSafeId<"property">(),
    text: createSafeId<"property">(),
  };
  const searchableIds = [propertyIds.text, propertyIds.tags, propertyIds.memo];
  const everyId = Object.values(propertyIds);
  // The names read back from a query, so they double as the assertion subject.
  const NAMED_ZETA = "Zeta lease";
  const CELL_ZETA = "Alpha";
  const TAG_ZETA = "Beta";
  const NUMERIC = "Delta";
  const MEMO_ZETA = "Epsilon";

  const seedEntity = async (
    name: string,
    cells: { content: FieldContent; propertyId: SafeId<"property"> }[],
  ): Promise<void> => {
    const entityId = createSafeId<"entity">();
    const versionId = createSafeId<"entityVersion">();
    seededEntityIds.push(entityId);

    // The test schema is pushed from the Drizzle definitions, so the trigger
    // that maintains `display_name` is not installed here; seed the value it
    // would have written.
    await testDb.insert(entities).values({
      id: entityId,
      workspaceId: ids.wsA1,
      kind: "document",
      name,
      displayName: name,
    });
    await testDb
      .insert(entityVersions)
      .values({ id: versionId, workspaceId: ids.wsA1, entityId });
    await testDb
      .update(entities)
      .set({ currentVersionId: versionId })
      .where(eq(entities.id, entityId));

    if (cells.length > 0) {
      await testDb.insert(fields).values(
        cells.map((cell) => ({
          id: createSafeId<"field">(),
          workspaceId: ids.wsA1,
          propertyId: cell.propertyId,
          entityVersionId: versionId,
          content: cell.content,
        })),
      );
    }
  };

  beforeAll(async () => {
    const tool = { version: 1 as const, type: "manual-input" as const };
    const definitions: {
      content: PropertyContent;
      id: SafeId<"property">;
      name: string;
    }[] = [
      {
        id: propertyIds.text,
        name: "Text",
        content: { version: 1, type: "text" },
      },
      {
        id: propertyIds.memo,
        name: "Memo",
        content: { version: 1, type: "text" },
      },
      {
        id: propertyIds.tags,
        name: "Tags",
        content: {
          version: 1,
          type: "multi-select",
          options: [
            { value: "gamma", color: "red" },
            { value: "zeta rider", color: "blue" },
          ],
          fallback: null,
        },
      },
      {
        id: propertyIds.date,
        name: "Date",
        content: { version: 1, type: "date" },
      },
      {
        id: propertyIds.int,
        name: "Int",
        content: { version: 1, type: "int" },
      },
      {
        id: propertyIds.money,
        name: "Money",
        content: { version: 1, type: "money", currency: "USD" },
      },
    ];
    seededPropertyIds.push(...definitions.map((definition) => definition.id));
    await testDb.insert(properties).values(
      definitions.map((definition) => ({
        id: definition.id,
        workspaceId: ids.wsA1,
        name: definition.name,
        content: definition.content,
        tool,
        status: "fresh" as const,
      })),
    );

    await seedEntity(NAMED_ZETA, []);
    await seedEntity(CELL_ZETA, [
      {
        propertyId: propertyIds.text,
        content: { version: 1, type: "text", value: "zeta clause" },
      },
    ]);
    await seedEntity(TAG_ZETA, [
      {
        propertyId: propertyIds.tags,
        content: {
          version: 1,
          type: "multi-select",
          value: ["gamma", "zeta rider"],
        },
      },
    ]);
    await seedEntity(NUMERIC, [
      {
        propertyId: propertyIds.date,
        content: { version: 1, type: "date", value: "2026-01-01" },
      },
      {
        propertyId: propertyIds.int,
        content: { version: 1, type: "int", value: 4321, currency: null },
      },
      {
        propertyId: propertyIds.money,
        content: {
          version: 1,
          type: "money",
          amountCents: 4321,
          currency: "USD",
        },
      },
    ]);
    await seedEntity(MEMO_ZETA, [
      {
        propertyId: propertyIds.memo,
        content: { version: 1, type: "text", value: "zeta memo" },
      },
    ]);
  });

  afterAll(async () => {
    if (seededEntityIds.length > 0) {
      await testDb
        .delete(entities)
        .where(inArray(entities.id, seededEntityIds));
    }
    if (seededPropertyIds.length > 0) {
      await testDb
        .delete(properties)
        .where(inArray(properties.id, seededPropertyIds));
    }
  });

  const readNames = async (args: {
    find?: {
      scope: { propertyIds: SafeId<"property">[]; type: "all" | "columns" };
      term: string;
    };
    limit?: number;
    search?: string;
  }): Promise<string[]> => {
    const result = await queryEntities({
      safeDb,
      workspaceId: ids.wsA1,
      currentUserId: ids.userA1,
      currentOrganizationId: ids.orgA,
      filters: [],
      sorts: [],
      limit: args.limit ?? 50,
      fieldMode: "visible",
      fieldIds: [],
      ...args,
    });
    if (Result.isError(result)) {
      throw result.error;
    }
    return result.value.entities.map((entity) => entity.name ?? "");
  };

  test("matches the name a row displays", async () => {
    const names = await readNames({
      find: { scope: { type: "all", propertyIds: searchableIds }, term: TERM },
    });

    expect(names).toContain(NAMED_ZETA);
  });

  test("matches a cell value, and one element of a multi-select", async () => {
    const names = await readNames({
      find: { scope: { type: "all", propertyIds: searchableIds }, term: TERM },
    });

    expect(names).toContain(CELL_ZETA);
    expect(names).toContain(TAG_ZETA);
  });

  test("a narrowed scope drops the name half", async () => {
    const names = await readNames({
      find: {
        scope: { type: "columns", propertyIds: searchableIds },
        term: TERM,
      },
    });

    expect(names).not.toContain(NAMED_ZETA);
    expect(names).toContain(CELL_ZETA);
  });

  test("narrowing to a subset of columns leaves the others out", async () => {
    const names = await readNames({
      find: {
        scope: { type: "columns", propertyIds: [propertyIds.memo] },
        term: TERM,
      },
    });

    expect(names).toEqual([MEMO_ZETA]);
  });

  test("date, int and money cells never match, whatever ids arrive", async () => {
    expect(
      await readNames({
        find: { scope: { type: "all", propertyIds: everyId }, term: "4321" },
      }),
    ).not.toContain(NUMERIC);
    expect(
      await readNames({
        find: { scope: { type: "all", propertyIds: everyId }, term: "2026-01" },
      }),
    ).not.toContain(NUMERIC);
  });

  test("finds a row the search index has never reached", async () => {
    // The seeded rows have no `search_documents` entry, which is exactly the
    // state a just-renamed row is in until the indexing queue catches up.
    expect(
      await readNames({
        find: {
          scope: { type: "all", propertyIds: searchableIds },
          term: TERM,
        },
      }),
    ).toContain(NAMED_ZETA);
    expect(await readNames({ search: TERM })).not.toContain(NAMED_ZETA);
  });

  test("counts built from the same condition agree with the rows", async () => {
    const find = {
      scope: { propertyIds: searchableIds, type: "all" as const },
      term: TERM,
    };
    const names = await readNames({ find });

    // The shape the group-counts handler builds: the same base set, the same
    // builder, no field selection of its own.
    const countResult = await safeDb((tx) =>
      tx
        .select({ total: count() })
        .from(entities)
        .where(
          and(
            eq(entities.workspaceId, ids.wsA1),
            isNotNull(entities.currentVersionId),
            ...buildFindConditions(find),
          ),
        ),
    );
    if (Result.isError(countResult)) {
      throw countResult.error;
    }

    expect(countResult.value.at(0)?.total).toBe(names.length);
  });

  test("pages past the first cursor with a find applied", async () => {
    const find = {
      scope: { propertyIds: searchableIds, type: "all" as const },
      term: TERM,
    };
    const first = await queryEntities({
      safeDb,
      workspaceId: ids.wsA1,
      currentUserId: ids.userA1,
      currentOrganizationId: ids.orgA,
      filters: [],
      sorts: [],
      find,
      limit: 2,
      fieldMode: "visible",
      fieldIds: [],
    });
    if (Result.isError(first)) {
      throw first.error;
    }
    const lastId = first.value.entities.at(-1)?.entityId ?? "";
    const cursor = first.value.cursorValuesByEntityId.get(lastId);
    expect(cursor).toBeDefined();

    const second = await queryEntities({
      safeDb,
      workspaceId: ids.wsA1,
      currentUserId: ids.userA1,
      currentOrganizationId: ids.orgA,
      filters: [],
      sorts: [],
      find,
      cursor,
      limit: 50,
      fieldMode: "visible",
      fieldIds: [],
    });
    if (Result.isError(second)) {
      throw second.error;
    }

    const firstNames = first.value.entities.map((entity) => entity.name);
    const secondNames = second.value.entities.map((entity) => entity.name);
    expect(firstNames).toHaveLength(2);
    expect(secondNames.length).toBeGreaterThan(0);
    expect(secondNames).not.toContain(firstNames.at(0));
  });
});
