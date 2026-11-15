import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  CITATION_AUTHORITY_BUCKET_MAX,
  CITATION_AUTHORITY_BUCKET_MAX_ERROR,
  CITATION_AUTHORITY_BUCKETS,
  citationAuthorityBucket,
  citationAuthorityBucketSql,
  citationAuthorityOfBucket,
  saturatedAuthorityOfBucket,
  UNCITED_AUTHORITY_BUCKET,
} from "@/api/lib/legal-search/case-law-ranking-signals";
import { saturateAuthority } from "@/api/lib/legal-search/rerank";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * Every authority a bucket edge falls on, and the doubles either side of it:
 * where `floor` is decided, so where two runtimes rounding differently would
 * disagree. Plus the values the column actually holds at its extremes.
 */
const edgeAuthorities = (): number[] => {
  const values = [0, -0, -1, 1e-12, 1e-6, 0.5, 1, 3, 10, 1e6, Number.MAX_VALUE];
  for (let cell = 1; cell < CITATION_AUTHORITY_BUCKETS; cell += 1) {
    const saturated = cell / CITATION_AUTHORITY_BUCKETS;
    const edge = saturated / (1 - saturated);
    values.push(edge, edge * (1 - Number.EPSILON), edge * (1 + Number.EPSILON));
  }
  return values;
};

test("an uncited decision is bucket 0 and stands for exactly no authority", () => {
  for (const authority of [0, -0, -1, Number.NaN, Number.NEGATIVE_INFINITY]) {
    expect(citationAuthorityBucket(authority)).toBe(UNCITED_AUTHORITY_BUCKET);
  }
  expect(saturatedAuthorityOfBucket(UNCITED_AUTHORITY_BUCKET)).toBe(0);
  expect(citationAuthorityOfBucket(UNCITED_AUTHORITY_BUCKET)).toBe(0);
  // The smallest positive authority already leaves bucket 0, so a decision's
  // first citation always reaches the index.
  expect(citationAuthorityBucket(Number.MIN_VALUE)).toBe(1);
});

test("buckets are monotone in authority and cover 1..max for every positive value", () => {
  // A geometric grid rather than the edges: within a few ulps of an edge the
  // rounded quotient `a / (a + 1)` need not be monotone, and a one-bucket
  // wobble there moves a blend by one bucket width, which is the stated error.
  const authorities = Array.from(
    { length: 4000 },
    (_, step) => 1e-6 * 1.005 ** step,
  );
  let previous = UNCITED_AUTHORITY_BUCKET;
  for (const authority of authorities) {
    const bucket = citationAuthorityBucket(authority);
    expect(bucket).toBeGreaterThanOrEqual(previous);
    expect(bucket).toBeGreaterThanOrEqual(1);
    expect(bucket).toBeLessThanOrEqual(CITATION_AUTHORITY_BUCKET_MAX);
    previous = bucket;
  }
  expect(previous).toBe(CITATION_AUTHORITY_BUCKET_MAX);
  expect(citationAuthorityBucket(Number.MAX_VALUE)).toBe(
    CITATION_AUTHORITY_BUCKET_MAX,
  );
  expect(citationAuthorityBucket(Number.POSITIVE_INFINITY)).toBe(
    UNCITED_AUTHORITY_BUCKET,
  );
});

test("a bucket's representative sits within the stated error of every authority in it", () => {
  for (const authority of edgeAuthorities()) {
    const bucket = citationAuthorityBucket(authority);
    const error = Math.abs(
      saturateAuthority(authority) - saturatedAuthorityOfBucket(bucket),
    );
    expect(error).toBeLessThanOrEqual(
      CITATION_AUTHORITY_BUCKET_MAX_ERROR + Number.EPSILON,
    );
    // The raw representative saturates back onto the midpoint, so a blend
    // fed it adds what the bucket stands for.
    expect(saturateAuthority(citationAuthorityOfBucket(bucket))).toBeCloseTo(
      saturatedAuthorityOfBucket(bucket),
      12,
    );
  }
});

test("an invalid bucket is refused rather than read as a number", () => {
  for (const bucket of [-1, 1.5, CITATION_AUTHORITY_BUCKET_MAX + 1]) {
    expect(() => saturatedAuthorityOfBucket(bucket)).toThrow(
      "Invalid citation authority bucket",
    );
  }
});

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

// timeout: builds the PGlite schema from every migration before the parity reads.
beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await client.close();
});

test("the SQL bucket agrees with the TypeScript bucket on every edge", async () => {
  const authorities = [
    ...edgeAuthorities(),
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ];
  // Through a VALUES list of double precision literals, as a column holds
  // them: a bound text parameter would be parsed by Postgres, not by us.
  const rows = await db.execute<{ authority: number; bucket: number }>(sql`
    SELECT authority, ${citationAuthorityBucketSql(sql`authority`)} AS bucket
    FROM (VALUES ${sql.join(
      authorities.map(
        (authority) =>
          sql`(${sql.raw(
            Number.isFinite(authority)
              ? `${authority.toPrecision(17)}::double precision`
              : `'${String(authority)}'::double precision`,
          )})`,
      ),
      sql`, `,
    )}) AS edge (authority)
  `);
  expect(rows.rows).toHaveLength(authorities.length);
  for (const [index, row] of rows.rows.entries()) {
    const authority = authorities[index] ?? panic("Edge row without input");
    expect({ index, bucket: row.bucket }).toEqual({
      index,
      bucket: citationAuthorityBucket(authority),
    });
  }
  // The edges straddle every boundary, so a fixture that never crossed one
  // could not pass for agreement.
  expect(new Set(rows.rows.map(({ bucket }) => bucket)).size).toBe(
    CITATION_AUTHORITY_BUCKET_MAX + 1,
  );
});

test("the SQL bucket of a NULL authority is the uncited bucket", async () => {
  const rows = await db.execute<{ bucket: number }>(
    sql`SELECT ${citationAuthorityBucketSql(sql`NULL::double precision`)} AS bucket`,
  );
  expect(Number(rows.rows[0]?.bucket)).toBe(UNCITED_AUTHORITY_BUCKET);
});
