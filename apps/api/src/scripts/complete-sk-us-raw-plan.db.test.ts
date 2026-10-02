import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { caseLawSources } from "@/api/db/schema";
import { SOURCE_RAW_ENVELOPE_CONTENT_TYPE } from "@/api/handlers/case-law/ingestion/adapter";
import { shouldSkipRefresh } from "@/api/handlers/case-law/ingestion/refresh-policy";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { isRecord } from "@/api/lib/type-guards";
import {
  completeSkUsRawStatement,
  selectSkUsRawPageStatement,
} from "@/api/scripts/complete-sk-us-raw-plan";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const MULTIPART_CONTENT_TYPE = SOURCE_RAW_ENVELOPE_CONTENT_TYPE;
const PUBLISHER_HASH = "publisher-observation-hash";

let client: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
});

afterAll(async () => {
  await client.close();
});

const createSource = async () => {
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `${ADAPTER_KEYS.SK_US}-${sourceId}`,
    name: "sk-us raw plan fixture",
  });
  return sourceId;
};

const insertDecision = async ({
  sourceId,
  id,
  createdAt,
  rawKey = null,
  contentType = null,
  sourceHash = PUBLISHER_HASH,
}: {
  sourceId: SafeId<"caseLawSource">;
  id: SafeId<"caseLawDecision">;
  createdAt: string;
  rawKey?: string | null;
  contentType?: string | null;
  sourceHash?: string;
}) => {
  await db.execute(sql`
    INSERT INTO case_law_decisions
      (id, source_id, case_number, court, country, language,
       source_raw_s3_key, source_raw_content_type, source_hash, created_at)
    VALUES (
      ${id}::uuid, ${sourceId}::uuid, ${`case-${id}`}, 'Ústavný súd',
      'SVK', 'sk', ${rawKey}, ${contentType}, ${sourceHash},
      ${createdAt}::timestamptz
    )
  `);
};

const rowsFrom = (result: unknown) =>
  executedRows(result).map((row) => {
    if (!isRecord(row)) {
      throw new TypeError("page row is not an object");
    }
    const id = row["id"];
    const createdAt = row["created_at"];
    if (typeof id !== "string" || typeof createdAt !== "string") {
      throw new TypeError("page row does not expose text id and created_at");
    }
    return { id, createdAt };
  });

test("source pages preserve microseconds across the created_at/id cursor", async () => {
  const sourceId = await createSource();
  const ids = [
    createSafeId<"caseLawDecision">(),
    createSafeId<"caseLawDecision">(),
    createSafeId<"caseLawDecision">(),
  ];
  const createdAt = [
    "2026-03-01T12:00:00.000001Z",
    "2026-03-01T12:00:00.000002Z",
    "2026-03-01T12:00:00.000003Z",
  ];
  for (const [index, id] of ids.entries()) {
    const timestamp = createdAt.at(index);
    if (timestamp === undefined) {
      throw new TypeError("fixture timestamp is missing");
    }
    await insertDecision({ sourceId, id, createdAt: timestamp });
  }

  const walked: { id: string; createdAt: string }[] = [];
  let after: { createdAt: string; id: SafeId<"caseLawDecision"> } | null = null;
  for (const expectedId of ids) {
    const rows = rowsFrom(
      await db.execute(
        selectSkUsRawPageStatement({ sourceId, after, limit: 1 }),
      ),
    );
    expect(rows).toHaveLength(1);
    const row = rows.at(0);
    if (row === undefined) {
      throw new TypeError("page unexpectedly empty");
    }
    expect(row.id).toBe(expectedId);
    walked.push(row);
    const id = ids.find((candidate) => candidate === row.id);
    if (id === undefined) {
      throw new TypeError("page returned a decision outside the fixture");
    }
    after = { createdAt: row.createdAt, id };
  }
  expect(walked.map(({ id }) => id)).toEqual(ids);
  expect(walked.map(({ createdAt: timestamp }) => timestamp)).toEqual(
    createdAt,
  );
  expect(walked[0]?.createdAt).toMatch(/\.000001Z/u);
});

test("source page walks partition tied microsecond rows without skips or duplicates", async () => {
  const sourceId = await createSource();
  const otherSourceId = await createSource();
  const timestamps = [
    "2026-03-01T12:00:00.000001Z",
    "2026-03-01T12:00:00.000001Z",
    "2026-03-01T12:00:00.000001Z",
    "2026-03-01T12:00:00.000002Z",
    "2026-03-01T12:00:00.000002Z",
    "2026-03-01T12:00:00.000003Z",
    "2026-03-01T12:00:00.000003Z",
  ];
  const fixture = timestamps.map((createdAt) => ({
    id: createSafeId<"caseLawDecision">(),
    createdAt,
  }));
  for (const { id, createdAt } of fixture) {
    await insertDecision({ sourceId, id, createdAt });
  }
  const unrelatedTimestamps = [timestamps.at(0), timestamps.at(3)];
  for (const createdAt of unrelatedTimestamps) {
    if (createdAt === undefined) {
      throw new TypeError("fixture timestamp is missing");
    }
    await insertDecision({
      sourceId: otherSourceId,
      id: createSafeId<"caseLawDecision">(),
      createdAt,
    });
  }

  const expected = fixture
    .toSorted((left, right) => {
      const leftKey = `${left.createdAt}/${left.id}`;
      const rightKey = `${right.createdAt}/${right.id}`;
      if (leftKey === rightKey) {
        return 0;
      }
      return leftKey < rightKey ? -1 : 1;
    })
    .map(({ id }) => id);
  const ids = new Set<string>(fixture.map(({ id }) => id));

  const walk = async (pageSizes: readonly number[]) => {
    const walked: string[] = [];
    let after: { createdAt: string; id: SafeId<"caseLawDecision"> } | null =
      null;
    for (let pageIndex = 0; pageIndex <= expected.length; pageIndex++) {
      const limit = pageSizes.at(pageIndex % pageSizes.length);
      if (limit === undefined) {
        throw new TypeError("page size fixture is empty");
      }
      expect(limit).toBeGreaterThanOrEqual(1);
      expect(limit).toBeLessThanOrEqual(200);
      const rows = rowsFrom(
        await db.execute(
          selectSkUsRawPageStatement({ sourceId, after, limit }),
        ),
      );
      expect(rows.length).toBeLessThanOrEqual(limit);
      if (rows.length === 0) {
        return walked;
      }
      for (const row of rows) {
        expect(ids.has(row.id)).toBe(true);
        walked.push(row.id);
      }
      const last = rows.at(-1);
      if (last === undefined) {
        throw new TypeError("non-empty page has no last row");
      }
      const id = fixture.find((candidate) => candidate.id === last.id)?.id;
      if (id === undefined) {
        throw new TypeError("page returned a decision outside the fixture");
      }
      after = { createdAt: last.createdAt, id };
    }
    throw new TypeError("page walk did not terminate within the fixture size");
  };

  await assertProperty(
    "source page walks partition tied microsecond rows without skips or duplicates",
    fc.asyncProperty(
      fc.array(fc.integer({ min: 1, max: 200 }), {
        minLength: 1,
        maxLength: 8,
      }),
      async (pageSizes) => {
        const walkedAtLimitOne = await walk([1]);
        expect(walkedAtLimitOne).toEqual(expected);
        expect(new Set(walkedAtLimitOne).size).toBe(expected.length);

        const walkedWithPartitions = await walk(pageSizes);
        expect(walkedWithPartitions).toEqual(expected);
        expect(new Set(walkedWithPartitions).size).toBe(expected.length);
      },
    ),
    { numRuns: 20, seed: 20_261_002 },
  );
});

test("source page selection uses the covering index without a table scan", async () => {
  const sourceId = await createSource();
  const otherSourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: otherSourceId,
    adapterKey: `sk-us-raw-plan-other-${otherSourceId}`,
    name: "unrelated source fixture",
  });
  await db.execute(sql`
    INSERT INTO case_law_decisions
      (id, source_id, case_number, court, country, language, created_at)
    SELECT gen_random_uuid(), ${sourceId}::uuid, 'target-' || i,
      'Ústavný súd Slovenskej republiky', 'SVK', 'sk',
      TIMESTAMPTZ '2026-03-01 12:00:00+00' + i * INTERVAL '1 second'
    FROM generate_series(1, 1000) AS i
  `);
  await db.execute(sql`
    INSERT INTO case_law_decisions
      (id, source_id, case_number, court, country, language, created_at)
    SELECT gen_random_uuid(), ${otherSourceId}::uuid, 'other-' || i,
      'Other court', 'SVK', 'sk',
      TIMESTAMPTZ '2025-01-01 00:00:00+00' + i * INTERVAL '1 second'
    FROM generate_series(1, 20000) AS i
  `);
  await db.execute(sql`VACUUM (ANALYZE) case_law_decisions`);

  const planRows = executedRows(
    await db.execute(
      sql`EXPLAIN ${selectSkUsRawPageStatement({ sourceId, after: null, limit: 100 })}`,
    ),
  );
  const plan = planRows
    .map((row) => (isRecord(row) ? String(row["QUERY PLAN"]) : ""))
    .join("\n");
  expect(plan).toContain(
    "Index Only Scan using case_law_decisions_source_generation_cursor_idx",
  );
  expect(plan).not.toContain("Seq Scan on case_law_decisions");
  expect(plan).not.toContain("Sort");
});

test("a raw pointer completion changes only the pointer and content type", async () => {
  const sourceId = await createSource();
  const id = createSafeId<"caseLawDecision">();
  const oldKey = `case-law/raw/legacy/${id}`;
  const newKey = `case-law/raw/completed/${id}`;
  await insertDecision({
    sourceId,
    id,
    createdAt: "2026-03-01 12:00:00+00",
    rawKey: oldKey,
    contentType: "application/pdf",
  });

  const beforeRows = executedRows(
    await db.execute(sql`
      SELECT to_jsonb(d) - 'source_raw_s3_key' - 'source_raw_content_type' AS stable
      FROM case_law_decisions d WHERE id = ${id}::uuid
    `),
  );
  const updatedRows = executedRows(
    await db.execute(
      completeSkUsRawStatement({
        sourceId,
        id,
        oldKey,
        newKey,
        oldContentType: "application/pdf",
      }),
    ),
  );
  expect(updatedRows).toHaveLength(1);
  const afterRows = executedRows(
    await db.execute(sql`
      SELECT to_jsonb(d) - 'source_raw_s3_key' - 'source_raw_content_type' AS stable,
        source_raw_s3_key, source_raw_content_type, source_hash
      FROM case_law_decisions d WHERE id = ${id}::uuid
    `),
  );
  const before = beforeRows[0];
  const after = afterRows[0];
  if (!isRecord(before) || !isRecord(after)) {
    throw new TypeError("decision snapshot is missing");
  }
  expect(after["stable"]).toEqual(before["stable"]);
  expect(after["source_raw_s3_key"]).toBe(newKey);
  expect(after["source_raw_content_type"]).toBe(MULTIPART_CONTENT_TYPE);
  expect(after["source_hash"]).toBe(PUBLISHER_HASH);
});

test("a compare-and-set skips a pointer changed by a concurrent writer", async () => {
  const sourceId = await createSource();
  const id = createSafeId<"caseLawDecision">();
  const oldKey = `case-law/raw/legacy/${id}`;
  const writerKey = `case-law/raw/concurrent/${id}`;
  await insertDecision({
    sourceId,
    id,
    createdAt: "2026-03-01 12:00:00+00",
    rawKey: oldKey,
    contentType: "application/pdf",
  });

  // PGlite has one backend, so this update models the winner before the
  // command's stale statement reaches its atomic compare-and-set.
  await db.execute(sql`
    UPDATE case_law_decisions SET source_raw_s3_key = ${writerKey}
    WHERE id = ${id}::uuid
  `);
  const staleWrite = executedRows(
    await db.execute(
      completeSkUsRawStatement({
        sourceId,
        id,
        oldKey,
        newKey: `case-law/raw/completed/${id}`,
        oldContentType: "application/pdf",
      }),
    ),
  );
  expect(staleWrite).toHaveLength(0);

  const winner = executedRows(
    await db.execute(sql`
      SELECT source_raw_s3_key, source_raw_content_type, source_hash
      FROM case_law_decisions WHERE id = ${id}::uuid
    `),
  )[0];
  expect(winner).toEqual({
    source_raw_s3_key: writerKey,
    source_raw_content_type: "application/pdf",
    source_hash: PUBLISHER_HASH,
  });
});

test("a compare-and-set skips a redacted decision", async () => {
  const sourceId = await createSource();
  const id = createSafeId<"caseLawDecision">();
  const oldKey = `case-law/raw/legacy/${id}`;
  await insertDecision({
    sourceId,
    id,
    createdAt: "2026-03-01 12:00:00+00",
    rawKey: oldKey,
    contentType: "application/pdf",
  });
  await db.execute(sql`
    UPDATE case_law_decisions SET redacted_at = now() WHERE id = ${id}::uuid
  `);

  const rows = executedRows(
    await db.execute(
      completeSkUsRawStatement({
        sourceId,
        id,
        oldKey,
        newKey: `case-law/raw/completed/${id}`,
        oldContentType: "application/pdf",
      }),
    ),
  );
  expect(rows).toHaveLength(0);
});

test("a compare-and-set cannot cross to another source", async () => {
  const sourceId = await createSource();
  const otherSourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: otherSourceId,
    adapterKey: `sk-us-raw-plan-other-${otherSourceId}`,
    name: "unrelated source fixture",
  });
  const id = createSafeId<"caseLawDecision">();
  const oldKey = `case-law/raw/legacy/${id}`;
  await insertDecision({
    sourceId,
    id,
    createdAt: "2026-03-01 12:00:00+00",
    rawKey: oldKey,
    contentType: "application/pdf",
  });

  const rows = executedRows(
    await db.execute(
      completeSkUsRawStatement({
        sourceId: otherSourceId,
        id,
        oldKey,
        newKey: `case-law/raw/completed/${id}`,
        oldContentType: "application/pdf",
      }),
    ),
  );
  expect(rows).toHaveLength(0);
});

test("an unchanged publisher observation skips after multipart completion", async () => {
  const sourceId = await createSource();
  const id = createSafeId<"caseLawDecision">();
  const oldKey = `case-law/raw/legacy/${id}`;
  await insertDecision({
    sourceId,
    id,
    createdAt: "2026-03-01 12:00:00+00",
    rawKey: oldKey,
    contentType: "application/pdf",
  });
  await db.execute(
    completeSkUsRawStatement({
      sourceId,
      id,
      oldKey,
      newKey: `case-law/raw/completed/${id}`,
      oldContentType: "application/pdf",
    }),
  );

  expect(
    shouldSkipRefresh({
      existingMetadata: {},
      existingSourceRawContentType: MULTIPART_CONTENT_TYPE,
      existingSourceHash: PUBLISHER_HASH,
      incomingMetadata: {},
      incomingRawHash: PUBLISHER_HASH,
      incomingSourceRawContentType: MULTIPART_CONTENT_TYPE,
      incomingUsesSourceRawBytes: true,
    }),
  ).toBe(true);
});
