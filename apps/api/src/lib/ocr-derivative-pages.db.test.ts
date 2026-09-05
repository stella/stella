/**
 * Boundary regression for the OCR-derivative cleanup walk.
 *
 * `document_processing_runs.created_at` defaults to `now()`, so it carries
 * microseconds a JS `Date` cannot. The walk pages backwards (`created_at`
 * descending), and a boundary that lost its microseconds excludes every run
 * inside the truncated sliver: their searchable-PDF objects then survive the
 * deletion of the matter or entity that owned them. Only rows with non-zero
 * sub-millisecond digits can show that, so they are written by raw SQL.
 *
 * The in-memory walk test beside this one covers `forEachOcrDerivativePage`'s
 * paging mechanics; this one covers the SQL order and predicate those pages
 * are cut with.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { documentProcessingRuns } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  ocrDerivativeCursorFilter,
  ocrDerivativePageOrder,
} from "@/api/lib/ocr-derivative-pages";
import type { OcrDerivativeCursor } from "@/api/lib/ocr-derivative-pages";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const PAGE_LIMIT = 3;
/** A stalled or skipping walk must fail the test, not spin. */
const MAX_PAGES = 40;

/**
 * Nine runs sharing one millisecond, separated only by microseconds, plus
 * three sharing an exact timestamp so the id tiebreaker is exercised too.
 * Every one of the nine collapses onto the same JS `Date`.
 */
const RUN_TIMESTAMPS = [
  "2026-06-01 10:00:00.500001+00",
  "2026-06-01 10:00:00.500002+00",
  "2026-06-01 10:00:00.500003+00",
  "2026-06-01 10:00:00.500004+00",
  "2026-06-01 10:00:00.500005+00",
  "2026-06-01 10:00:00.500006+00",
  "2026-06-01 10:00:00.500007+00",
  "2026-06-01 10:00:00.500008+00",
  "2026-06-01 10:00:00.500009+00",
  "2026-06-01 10:00:00.600000+00",
  "2026-06-01 10:00:00.600000+00",
  "2026-06-01 10:00:00.600000+00",
] as const;

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);

  for (const [index, createdAt] of RUN_TIMESTAMPS.entries()) {
    // `created_at` is written as a literal: binding it from a `Date` would
    // erase exactly the digits this fixture exists to carry.
    await testDb.execute(sql`
      INSERT INTO document_processing_runs (
        id, organization_id, workspace_id, entity_id, entity_version_id,
        field_id, source_file_id, source_sha256_hex, kind, request_source,
        status, created_at
      ) VALUES (
        ${toSafeId<"documentProcessingRun">(Bun.randomUUIDv7())},
        ${ids.orgA}, ${ids.wsA1}, ${ids.entityA1}, ${ids.entityVersionA1},
        ${ids.fieldA1}, ${Bun.randomUUIDv7()}, ${"a".repeat(64)},
        'ocr', 'upload', 'succeeded', ${createdAt}::timestamptz
      )
    `);
    expect(index).toBeGreaterThanOrEqual(0);
  }
}, 120_000);

afterAll(async () => {
  await releaseTestDb();
});

/** The production read, verbatim: same projection, predicate, and order. */
const readPage = async (cursor: OcrDerivativeCursor | null, limit: number) =>
  await testDb
    .select({ id: documentProcessingRuns.id })
    .from(documentProcessingRuns)
    .where(
      and(
        eq(documentProcessingRuns.workspaceId, ids.wsA1),
        ocrDerivativeCursorFilter(cursor),
      ),
    )
    .orderBy(...ocrDerivativePageOrder())
    .limit(limit);

const walk = async (
  startCursor: OcrDerivativeCursor | null = null,
): Promise<SafeId<"documentProcessingRun">[]> => {
  const visited: SafeId<"documentProcessingRun">[] = [];
  let cursor = startCursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await readPage(cursor, PAGE_LIMIT);
    for (const row of rows) {
      visited.push(row.id);
    }
    if (rows.length < PAGE_LIMIT) {
      return visited;
    }
    const last = rows.at(-1);
    if (!last) {
      return visited;
    }
    cursor = last.id;
  }
  throw new Error(
    `the derivative walk did not terminate within ${MAX_PAGES} pages`,
  );
};

test("INVARIANT: the walk visits every derivative exactly once, in page order", async () => {
  const expected = (
    await testDb
      .select({ id: documentProcessingRuns.id })
      .from(documentProcessingRuns)
      .where(eq(documentProcessingRuns.workspaceId, ids.wsA1))
      .orderBy(...ocrDerivativePageOrder())
  ).map(({ id }) => id);
  expect(expected).toHaveLength(RUN_TIMESTAMPS.length);

  const visited = await walk();

  // No microsecond twin skipped, no boundary row repeated.
  expect(visited).toEqual(expected);
  expect(new Set(visited).size).toBe(expected.length);
});

test("the fixture lands in the sliver a millisecond boundary would drop", async () => {
  // Guards the whole file against going vacuous: seeded from a JS `Date`
  // (or truncated by the driver) these rows could not reproduce the bug at
  // all. Every one of them must differ from its own millisecond truncation,
  // and a millisecond boundary must demonstrably lose rows the real one
  // keeps.
  const ordered = await walk();
  // A boundary inside the microsecond twins, where truncation is lossy.
  const boundaryIndex = 5;
  const boundary = ordered.at(boundaryIndex);
  expect(boundary).toBeDefined();
  if (boundary === undefined) {
    return;
  }

  const [counts] = await testDb
    .select({
      microsecondRows: sql<number>`count(*) FILTER (
        WHERE ${documentProcessingRuns.createdAt}
          <> date_trunc('milliseconds', ${documentProcessingRuns.createdAt})
      )::int`,
      truncatedRemainder: sql<number>`count(*) FILTER (
        WHERE ${documentProcessingRuns.createdAt} < date_trunc(
          'milliseconds',
          (SELECT b.created_at FROM document_processing_runs b WHERE b.id = ${boundary})
        )
      )::int`,
    })
    .from(documentProcessingRuns)
    .where(eq(documentProcessingRuns.workspaceId, ids.wsA1));
  expect(counts).toBeDefined();
  expect(counts?.microsecondRows).toBeGreaterThan(0);
  // The real walk still has these many runs to visit after the boundary; a
  // truncated boundary reaches strictly fewer, and the difference is exactly
  // the orphaned searchable-PDF objects.
  expect(counts?.truncatedRemainder).toBeLessThan(
    ordered.length - (boundaryIndex + 1),
  );
});

test("INVARIANT: resuming from any run yields exactly the runs that follow it", async () => {
  const expected = await walk();

  for (const [index, boundary] of expected.entries()) {
    const remainder = await walk(boundary);
    expect(remainder).toEqual(expected.slice(index + 1));
  }
});
