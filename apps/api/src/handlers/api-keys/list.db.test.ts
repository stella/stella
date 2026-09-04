/**
 * Page-boundary regression for the machine-key list.
 *
 * `apikey.created_at` defaults to `now()`, so it carries microseconds a JS
 * `Date` cannot. The list pages newest-first, and a descending `<` boundary
 * that lost its microseconds excludes every key inside the truncated sliver:
 * a machine credential that never appears on page two is one an admin cannot
 * see, and therefore one nobody can revoke — the exact failure this table's
 * organization-scoped reads exist to prevent. Only rows with non-zero
 * sub-millisecond digits can show that, so they are written by raw SQL.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { apikey } from "@/api/db/auth-schema";
import { createListMachineApiKeysHandler } from "@/api/handlers/api-keys/list";
import { compareCodepoint } from "@stll/collation";
import { MACHINE_API_KEY_CONFIG_ID } from "@/api/lib/machine-api-key-config";
import { listOrganizationMachineApiKeys } from "@/api/lib/machine-api-key-queries";
import { encodePaginationCursor } from "@/api/lib/pagination";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const PAGE_LIMIT = 3;
/** A skipping or stalling walk must fail the test, not spin. */
const MAX_PAGES = 40;

/**
 * Nine keys inside one millisecond, separated only by microseconds; every one
 * collapses onto the same JS `Date`. Timestamps mostly descend as ids ascend,
 * so a legacy id fallback returns the already-consumed prefix. The first three
 * share an exact timestamp so the canonical id tie-break is exercised too.
 */
const KEY_TIMESTAMPS = [
  "2026-06-02 08:00:00.250007+00",
  "2026-06-02 08:00:00.250007+00",
  "2026-06-02 08:00:00.250007+00",
  "2026-06-02 08:00:00.250006+00",
  "2026-06-02 08:00:00.250005+00",
  "2026-06-02 08:00:00.250004+00",
  "2026-06-02 08:00:00.250003+00",
  "2026-06-02 08:00:00.250002+00",
  "2026-06-02 08:00:00.250001+00",
] as const;

/** Distinct milliseconds, so a millisecond truncation stays order-preserving. */
const DISTINCT_MS_TIMESTAMPS = [
  "2026-06-02 08:00:01.001456+00",
  "2026-06-02 08:00:01.002456+00",
  "2026-06-02 08:00:01.003456+00",
  "2026-06-02 08:00:01.004456+00",
] as const;

let testDb: TestDatabase;
let ids: TestIds;
let listMachineApiKeys: ReturnType<typeof createListMachineApiKeysHandler>;

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);

  // The queries module reads this table through the owner connection; point
  // that connection at the test database.
  listMachineApiKeys = createListMachineApiKeysHandler(
    async (input) =>
      await listOrganizationMachineApiKeys({ ...input, db: testDb }),
  );

  const timestamps = [...KEY_TIMESTAMPS, ...DISTINCT_MS_TIMESTAMPS];
  for (const [index, createdAt] of timestamps.entries()) {
    // `created_at` is written as a literal: binding a `Date` would erase
    // exactly the digits this fixture exists to carry.
    // oxlint-disable-next-line no-await-in-loop -- ordered inserts on one test DB connection
    await testDb.execute(sql`
      INSERT INTO apikey (
        id, config_id, name, start, prefix, key, reference_id,
        enabled, rate_limit_enabled, request_count,
        metadata, permissions, created_at, updated_at
      ) VALUES (
        ${`machine-key-${String(index).padStart(3, "0")}`},
        ${MACHINE_API_KEY_CONFIG_ID},
        ${`Key ${index}`}, 'stll_', 'stll_', ${`digest-${index}`}, ${ids.userA1},
        true, true, 0,
        ${JSON.stringify({ organizationId: ids.orgA, scopes: [] })},
        ${JSON.stringify({})},
        ${createdAt}::timestamptz, ${createdAt}::timestamptz
      )
    `);
  }
}, 120_000);

afterAll(async () => {
  await releaseTestDb();
});

const listPage = async (cursor: string | undefined) => {
  type ListCtx = Parameters<typeof listMachineApiKeys.handler>[0];
  return await listMachineApiKeys.handler(
    createTestHandlerContext<ListCtx>({
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      query: { limit: PAGE_LIMIT, cursor },
    }),
  );
};

/** The handler answers a rejected request with a status response, not a page. */
const expectPage = (result: Awaited<ReturnType<typeof listPage>>) => {
  if (!("items" in result)) {
    throw new Error(`expected a page, got ${JSON.stringify(result)}`);
  }
  return result;
};

const walk = async (startCursor?: string): Promise<string[]> => {
  const visited: string[] = [];
  let cursor = startCursor;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- sequential keyset pagination
    const result = expectPage(await listPage(cursor));
    for (const item of result.items) {
      visited.push(item.id);
    }
    if (result.nextCursor === null) {
      return visited;
    }
    cursor = result.nextCursor;
  }
  throw new Error(
    `the key list did not terminate within ${MAX_PAGES} pages; the cursor is stalling`,
  );
};

const expectedOrder = (): string[] =>
  [...KEY_TIMESTAMPS, ...DISTINCT_MS_TIMESTAMPS]
    .map((createdAt, index) => ({
      createdAt,
      id: `machine-key-${String(index).padStart(3, "0")}`,
    }))
    // Newest first, ties broken by descending id: the query's own ORDER BY.
    // Codepoint order, matching PostgreSQL's ordering of these opaque keys.
    .toSorted((left, right) =>
      left.createdAt === right.createdAt
        ? compareCodepoint(right.id, left.id)
        : compareCodepoint(right.createdAt, left.createdAt),
    )
    .map(({ id }) => id);

test("the fixture carries the microseconds a Date cursor would lose", async () => {
  // Without this the whole file could go vacuous: keys seeded from a JS
  // `Date` cannot reproduce the skipped-sliver bug at all.
  const [counts] = await testDb
    .select({
      microsecondRows: sql<number>`count(*) FILTER (
        WHERE ${apikey.createdAt}
          <> date_trunc('milliseconds', ${apikey.createdAt})
      )::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(apikey)
    .where(eq(apikey.configId, MACHINE_API_KEY_CONFIG_ID));

  const seeded = KEY_TIMESTAMPS.length + DISTINCT_MS_TIMESTAMPS.length;
  expect(counts?.total).toBe(seeded);
  expect(counts?.microsecondRows).toBe(seeded);
});

test("INVARIANT: paging to exhaustion lists every key exactly once", async () => {
  const expected = expectedOrder();

  const visited = await walk();

  // No key inside the boundary's truncated millisecond may be skipped: an
  // unlistable machine credential is an unrevokable one.
  expect(visited).toEqual(expected);
  expect(new Set(visited).size).toBe(expected.length);
});

test("INVARIANT: resuming from any page boundary yields exactly the tail", async () => {
  const expected = expectedOrder();

  let cursor: string | undefined;
  let consumed = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- sequential keyset pagination
    const result = expectPage(await listPage(cursor));
    if (result.nextCursor === null) {
      expect(consumed + result.items.length).toBe(expected.length);
      return;
    }
    consumed += result.items.length;
    // oxlint-disable-next-line no-await-in-loop -- sequential keyset pagination
    const remainder = await walk(result.nextCursor);
    expect(remainder).toEqual(expected.slice(consumed));
    cursor = result.nextCursor;
  }
  throw new Error("pagination did not terminate");
});

test("a cursor issued before the fix still decodes and resumes", async () => {
  // The old encoder was `encodePaginationCursor([createdAt.toISOString(), id])`.
  // Such a cursor is in flight in clients; it must never 400 or 500, and on
  // distinct milliseconds (where the truncation is order-preserving) it still
  // resumes exactly.
  const expected = expectedOrder();
  const boundaryId = "machine-key-010";
  const boundaryIndex = expected.indexOf(boundaryId);
  expect(boundaryIndex).toBeGreaterThan(-1);

  const visited = await walk(
    encodePaginationCursor(["2026-06-02T08:00:01.002Z", boundaryId]),
  );

  expect(visited).toEqual(expected.slice(boundaryIndex + 1));
});

test("a legacy cursor inside a shared millisecond resumes the exact tail", async () => {
  const expected = expectedOrder();
  const boundaryId = "machine-key-004";
  const boundaryIndex = expected.indexOf(boundaryId);
  expect(boundaryIndex).toBeGreaterThan(-1);

  const visited = await walk(
    encodePaginationCursor(["2026-06-02T08:00:00.250Z", boundaryId]),
  );

  expect(visited).toEqual(expected.slice(boundaryIndex + 1));
});

test("a malformed cursor is rejected rather than silently restarting page one", async () => {
  const result = await listPage("not-a-cursor");

  expect("items" in result).toBe(false);
});
