/**
 * Page-boundary regression for the entity suggestion list.
 *
 * `docx_suggestions.created_at` is a timestamptz: PostgreSQL keeps
 * microseconds, a JS `Date` keeps milliseconds. An ascending `>` boundary
 * that went through a `Date` still admits the row the page was cut at, so
 * that row is re-emitted at the head of every following page and the cursor
 * never advances — the reviewer panel then spends its whole hydration cap on
 * one page. Only rows carrying non-zero sub-millisecond digits can show
 * that, so they are written by raw SQL and the walk runs against Postgres.
 *
 * Runs on PGlite through the shared RLS fixture, like the other
 * database-backed handler suites.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { docxSuggestions, entities } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { encodePaginationCursor } from "@/api/lib/pagination";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import listDocxSuggestions from "./read";

const PAGE_LIMIT = 4;
/**
 * A stalled cursor loops forever, so the walk is bounded. Generous against
 * the largest fixture (25 rows at 4 per page = 7 pages) and still far below
 * anything a working keyset can reach.
 */
const MAX_PAGES = 40;

/**
 * Twelve rows inside one millisecond, separated only by microseconds. Every
 * one of them collapses onto the same JS `Date`, which is exactly what a
 * millisecond boundary cannot tell apart.
 */
const TWIN_COUNT = 12;
const twinTimestamp = (index: number): string =>
  `2026-05-01 09:00:00.100${String(index + 1).padStart(3, "0")}+00`;
const twinId = (index: number): SafeId<"docxSuggestion"> =>
  toSafeId<"docxSuggestion">(
    `00000000-0000-7000-8000-${String(TWIN_COUNT - index).padStart(12, "0")}`,
  );

/**
 * Ten rows on distinct milliseconds, each still carrying microseconds. A
 * millisecond truncation is order-preserving here, so a cursor issued by the
 * old encoder resumes this set exactly.
 */
const DISTINCT_COUNT = 10;
const distinctTimestamp = (index: number): string =>
  `2026-05-01 09:00:01.${String(index + 1).padStart(3, "0")}456+00`;
const distinctIsoMillisecond = (index: number): string =>
  `2026-05-01T09:00:01.${String(index + 1).padStart(3, "0")}Z`;

let testDb: TestDatabase;
let ids: TestIds;
// Dedicated entities: the shared RLS fixture already attaches suggestions to
// its own entities, and this suite asserts exact row sets.
const twinEntityId = toSafeId<"entity">(Bun.randomUUIDv7());
const distinctEntityId = toSafeId<"entity">(Bun.randomUUIDv7());

const seedSuggestions = async ({
  entityId,
  count,
  timestampAt,
  idAt,
}: {
  entityId: SafeId<"entity">;
  count: number;
  timestampAt: (index: number) => string;
  idAt?: ((index: number) => SafeId<"docxSuggestion">) | undefined;
}): Promise<SafeId<"docxSuggestion">[]> => {
  const seeded: SafeId<"docxSuggestion">[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = idAt?.(index) ?? toSafeId<"docxSuggestion">(Bun.randomUUIDv7());
    // The microsecond digits are the whole point of the fixture, so
    // `created_at` is written as a literal instead of being bound from a
    // `Date` (which cannot carry them).
    await testDb.execute(sql`
      INSERT INTO docx_suggestions
        (id, workspace_id, entity_id, op_payload, severity, area, status, created_at)
      VALUES (
        ${id}, ${ids.wsA1}, ${entityId}, ${sql.raw("'{}'::jsonb")},
        'medium', 'clause', 'pending', ${timestampAt(index)}::timestamptz
      )
    `);
    seeded.push(id);
  }
  return seeded;
};

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);

  await testDb.insert(entities).values([
    {
      id: twinEntityId,
      workspaceId: ids.wsA1,
      name: "Microsecond-twin suggestions",
    },
    {
      id: distinctEntityId,
      workspaceId: ids.wsA1,
      name: "Distinct-millisecond suggestions",
    },
  ]);

  await seedSuggestions({
    entityId: twinEntityId,
    count: TWIN_COUNT,
    timestampAt: twinTimestamp,
    idAt: twinId,
  });
  await seedSuggestions({
    entityId: distinctEntityId,
    count: DISTINCT_COUNT,
    timestampAt: distinctTimestamp,
  });
}, 120_000);

afterAll(async () => {
  await releaseTestDb();
});

// PGlite's transaction type is structurally distinct from the production
// `Transaction`; asTestRaw is the established bridge for a PGlite-backed
// safeDb in a prod-typed handler context.
const scopedSafeDb = (): SafeDb =>
  asTestRaw<SafeDb>(createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1));

type ListCtx = Parameters<typeof listDocxSuggestions.handler>[0];

const listPage = async (
  entityId: SafeId<"entity">,
  cursor: string | undefined,
) =>
  await listDocxSuggestions.handler(
    createTestHandlerContext<ListCtx>({
      workspaceId: ids.wsA1,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      safeDb: scopedSafeDb(),
      params: { workspaceId: ids.wsA1, entityId },
      query: { limit: PAGE_LIMIT, status: "pending", cursor },
    }),
  );

/** The handler answers a rejected request with a status response, not a page. */
const expectPage = (result: Awaited<ReturnType<typeof listPage>>) => {
  if (!("items" in result)) {
    throw new Error(`expected a page, got ${JSON.stringify(result)}`);
  }
  return result;
};

/** Walk to exhaustion, failing rather than looping when the cursor stalls. */
const walk = async (
  entityId: SafeId<"entity">,
  startCursor?: string,
): Promise<SafeId<"docxSuggestion">[]> => {
  const visited: SafeId<"docxSuggestion">[] = [];
  let cursor = startCursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = expectPage(await listPage(entityId, cursor));
    for (const item of result.items) {
      visited.push(item.id);
    }
    if (result.nextCursor === null) {
      return visited;
    }
    cursor = result.nextCursor;
  }
  throw new Error(
    `pagination did not terminate within ${MAX_PAGES} pages; the cursor is stalling`,
  );
};

const orderedIds = async (
  entityId: SafeId<"entity">,
): Promise<SafeId<"docxSuggestion">[]> =>
  (
    await testDb
      .select({ id: docxSuggestions.id })
      .from(docxSuggestions)
      .where(eq(docxSuggestions.entityId, entityId))
      .orderBy(docxSuggestions.createdAt, docxSuggestions.id)
  ).map(({ id }) => id);

describe("docx suggestion list keyset", () => {
  test("the fixture carries the microseconds a Date cursor would lose", async () => {
    // Without this the whole file could go vacuous: rows seeded from a JS
    // `Date` cannot reproduce any of these boundary bugs.
    const [counts] = await testDb
      .select({
        microsecondRows: sql<number>`count(*) FILTER (
          WHERE ${docxSuggestions.createdAt}
            <> date_trunc('milliseconds', ${docxSuggestions.createdAt})
        )::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(docxSuggestions)
      .where(
        inArray(docxSuggestions.entityId, [twinEntityId, distinctEntityId]),
      );

    expect(counts?.total).toBe(TWIN_COUNT + DISTINCT_COUNT);
    expect(counts?.microsecondRows).toBe(TWIN_COUNT + DISTINCT_COUNT);
  });

  test("INVARIANT: paging to exhaustion visits every row exactly once, in order", async () => {
    const expected = await orderedIds(twinEntityId);
    expect(expected).toHaveLength(TWIN_COUNT);

    const visited = await walk(twinEntityId);

    // Exactly once: no duplicate boundary row, no skipped microsecond twin.
    expect(visited).toEqual(expected);
    expect(new Set(visited).size).toBe(TWIN_COUNT);
  });

  test("INVARIANT: resuming from every page boundary yields the exact remainder", async () => {
    const expected = await orderedIds(distinctEntityId);
    expect(expected).toHaveLength(DISTINCT_COUNT);

    // Every reachable cursor is a page boundary; each must resume the tail
    // that follows it, with no row repeated across the cut and none lost.
    let cursor: string | undefined;
    let consumed = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = expectPage(await listPage(distinctEntityId, cursor));
      if (result.nextCursor === null) {
        expect(consumed + result.items.length).toBe(DISTINCT_COUNT);
        return;
      }
      consumed += result.items.length;
      const remainder = await walk(distinctEntityId, result.nextCursor);
      expect(remainder).toEqual(expected.slice(consumed));
      cursor = result.nextCursor;
    }
    throw new Error("pagination did not terminate");
  });
});

describe("docx suggestion cursors issued before the microsecond fix", () => {
  // The old encoder was `encodePaginationCursor([createdAt.toISOString(), id])`.
  const legacyCursor = (createdAtIso: string, id: string): string =>
    encodePaginationCursor([createdAtIso, id]);

  test("an in-flight millisecond cursor resumes the distinct-millisecond tail exactly", async () => {
    const expected = await orderedIds(distinctEntityId);
    const boundaryIndex = 3;
    const boundaryId = expected.at(boundaryIndex);
    expect(boundaryId).toBeDefined();
    if (boundaryId === undefined) {
      return;
    }

    const visited = await walk(
      distinctEntityId,
      legacyCursor(distinctIsoMillisecond(boundaryIndex), boundaryId),
    );

    expect(visited).toEqual(expected.slice(boundaryIndex + 1));
  });

  test("an in-flight millisecond cursor over microsecond twins resumes the exact tail", async () => {
    const expected = await orderedIds(twinEntityId);
    const boundaryIndex = 5;
    const boundaryId = expected.at(boundaryIndex);
    expect(boundaryId).toBeDefined();
    if (boundaryId === undefined) {
      return;
    }

    // Timestamps increase while ids decrease, so an id fallback would return
    // the already-consumed prefix. Resolving this id in-DB must recover the
    // actual timestamp and return only the true ordered tail.
    const visited = await walk(
      twinEntityId,
      legacyCursor("2026-05-01T09:00:00.100Z", boundaryId),
    );

    expect(visited).toEqual(expected.slice(boundaryIndex + 1));
  });

  test("a malformed cursor is rejected rather than silently restarting page one", async () => {
    const result = await listPage(twinEntityId, "not-a-cursor");

    expect("items" in result).toBe(false);
  });
});
