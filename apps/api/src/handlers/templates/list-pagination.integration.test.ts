import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray, sql } from "drizzle-orm";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import { templates } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  encodeTemplateListCursor,
  listTemplatesHandler,
} from "@/api/handlers/templates/list";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Exercises the real keyset SQL in listTemplatesHandler against PGlite, not
// just the cursor codec. The boundary is resolved in-DB by id (the cursor
// carries no timestamp), so rows sharing the exact same `created_at` must
// still page without gaps or duplicates, ordered by id alone as the
// tiebreaker.

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
let safeDb: SafeDb;
let safeDbOrgB: SafeDb;
const seededTemplateIds: SafeId<"template">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  safeDb = toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
    ),
  );
  safeDbOrgB = toSafeDbMock(
    asTestRaw<ScopedDb>(
      createScopedDb(testDb, [ids.wsB1], ids.orgB, ids.userB1),
    ),
  );
});

afterAll(async () => {
  if (seededTemplateIds.length > 0) {
    await testDb
      .delete(templates)
      .where(inArray(templates.id, seededTemplateIds));
  }
  await releaseRlsFixture();
});

type SeededTemplate = { id: SafeId<"template">; organizationId: string };

const seedTemplate = async ({
  organizationId,
  userId,
  createdAt,
  name,
}: {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  createdAt: string;
  name: string;
}): Promise<SeededTemplate> => {
  const id = toSafeId<"template">(Bun.randomUUIDv7());
  seededTemplateIds.push(id);

  await testDb.execute(sql`
    insert into templates (
      id,
      organization_id,
      name,
      file_name,
      s3_key,
      size_bytes,
      created_by,
      created_at,
      updated_at
    ) values (
      ${id},
      ${organizationId},
      ${name},
      'template.docx',
      ${`templates/${id}.docx`},
      1024,
      ${userId},
      ${createdAt}::timestamp,
      ${createdAt}::timestamp
    )
  `);

  return { id, organizationId };
};

const seedTemplatesSharingOneTimestamp = async (
  count: number,
  createdAt: string,
): Promise<SeededTemplate[]> =>
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      seedTemplate({
        organizationId: ids.orgA,
        userId: ids.userA1,
        createdAt,
        name: `Tie-break template ${index}`,
      }),
    ),
  );

// Rows share createdAt, so DESC id order is the only tiebreaker.
const expectedDescendingIds = (rows: SeededTemplate[]): string[] =>
  [...rows]
    .map(({ id }) => id)
    .sort()
    .toReversed();

const readPage = async (db: SafeDb, cursor: string | undefined) =>
  await Result.gen(() =>
    listTemplatesHandler({
      safeDb: db,
      organizationId: ids.orgA,
      query: { limit: 3, ...(cursor === undefined ? {} : { cursor }) },
    }),
  );

describe("templates list cursor ordering", () => {
  test("returns every row exactly once across page boundaries, including rows sharing one created_at", async () => {
    const rows = await seedTemplatesSharingOneTimestamp(
      7,
      "2026-07-10T08:15:30.000000",
    );
    const expectedIds = expectedDescendingIds(rows);
    const collectedIds: string[] = [];
    let cursor: string | undefined;

    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      // oxlint-disable-next-line no-await-in-loop -- each cursor comes from the preceding page
      const result = await readPage(safeDb, cursor);
      if (Result.isError(result)) {
        throw result.error;
      }

      collectedIds.push(
        ...result.value.items
          .filter((item) => expectedIds.includes(item.id))
          .map((item) => item.id),
      );
      cursor = result.value.nextCursor ?? undefined;
      if (cursor === undefined) {
        break;
      }
    }

    expect(collectedIds).toEqual(expectedIds);
    expect(new Set(collectedIds).size).toBe(rows.length);
  });

  test("rejects a malformed cursor", async () => {
    const result = await Result.gen(() =>
      listTemplatesHandler({
        safeDb,
        organizationId: ids.orgA,
        query: { cursor: "not-a-cursor" },
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ status: 400 });
    }
  });

  test("a cursor referencing another org's template resolves to an empty page instead of leaking its boundary", async () => {
    const foreignTemplate = await seedTemplate({
      organizationId: ids.orgB,
      userId: ids.userB1,
      createdAt: "2026-07-10T09:00:00.000000",
      name: "Org B template",
    });

    // Sanity check: the foreign template is visible from its own org.
    const ownPage = await Result.gen(() =>
      listTemplatesHandler({
        safeDb: safeDbOrgB,
        organizationId: ids.orgB,
        query: {},
      }),
    );
    if (Result.isError(ownPage)) {
      throw ownPage.error;
    }
    expect(
      ownPage.value.items.some((item) => item.id === foreignTemplate.id),
    ).toBe(true);

    // The boundary lookup is scoped to organizationId, so a foreign id
    // resolves to no row and the tuple comparison yields no matches — an
    // empty page, not an error and not org A's real templates.
    const result = await readPage(
      safeDb,
      encodeTemplateListCursor(foreignTemplate.id),
    );
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(result.value.items).toEqual([]);
    expect(result.value.nextCursor).toBeNull();
  });
});
