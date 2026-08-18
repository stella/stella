import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  authorityBlendSql,
  blendedRankSql,
  saturatedAuthoritySql,
} from "@/api/lib/legal-search/authority-sql";
import {
  AUTHORITY_PIVOT,
  DEFAULT_AUTHORITY_WEIGHT,
  saturateAuthority,
} from "@/api/lib/legal-search/rerank";
import { createTestPglite } from "@/api/tests/pglite-test-db";

// The authority blend runs in two runtimes: TypeScript on the corpus-index
// path, SQL on the Postgres paths, which have to score inside the statement
// so the cursor predicate can be the same expression as the ORDER BY. Parity
// is therefore asserted by *executing* the SQL and comparing it to
// `saturateAuthority()`, not by reading the fragment and believing it.

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

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

/** Evaluate a scalar fragment in Postgres. */
const evaluate = async (
  expression: ReturnType<typeof sql>,
): Promise<number> => {
  const [row] = await db
    .select({ v: sql<number>`(${expression})::float8` })
    .from(sql`(SELECT 1) AS one`);
  return Number(row?.v);
};

const authorityLiteral = (value: number): ReturnType<typeof sql> =>
  sql`${sql.raw(value.toString())}::float8`;

test("the SQL saturation equals saturateAuthority(), value for value", async () => {
  for (const authority of [0, 0.25, AUTHORITY_PIVOT, 5, 40, 1000]) {
    // oxlint-disable-next-line no-await-in-loop -- one round-trip per sampled value against an in-process database
    const inPostgres = await evaluate(
      saturatedAuthoritySql(authorityLiteral(authority)),
    );
    expect(inPostgres).toBeCloseTo(saturateAuthority(authority), 12);
  }
});

test("the SQL saturation half-saturates at the pivot and stays below 1", async () => {
  expect(await evaluate(saturatedAuthoritySql(authorityLiteral(0)))).toBe(0);
  expect(
    await evaluate(saturatedAuthoritySql(authorityLiteral(AUTHORITY_PIVOT))),
  ).toBe(0.5);
  expect(
    await evaluate(saturatedAuthoritySql(authorityLiteral(1e6))),
  ).toBeLessThan(1);
  // A corrupt negative column cannot invert the signal in SQL either.
  expect(await evaluate(saturatedAuthoritySql(authorityLiteral(-5)))).toBe(0);
});

test("an authority of 5 adds less than the whole weight", async () => {
  const gained = await evaluate(authorityBlendSql(authorityLiteral(5)));
  // Raw authority would add 1.5 here and swamp the lexical score.
  expect(gained).toBeLessThan(DEFAULT_AUTHORITY_WEIGHT);
  expect(gained).toBeCloseTo(DEFAULT_AUTHORITY_WEIGHT * (5 / 6), 12);
});

test("the blended rank is the lexical score plus the bounded term", async () => {
  const blended = await evaluate(
    blendedRankSql(sql`0.5::float8`, authorityLiteral(5)),
  );
  expect(blended).toBeCloseTo(0.5 + DEFAULT_AUTHORITY_WEIGHT * (5 / 6), 12);
  // Same arithmetic the TypeScript blend does for the same inputs.
  expect(blended).toBeCloseTo(
    0.5 + DEFAULT_AUTHORITY_WEIGHT * saturateAuthority(5),
    12,
  );
});

// Every Postgres ranking path, and what it feeds the blend. A path that scores
// authority any other way is the drift this whole module exists to prevent, so
// the set is asserted rather than trusted: `blendedRankSql` present, and no
// weight multiplied straight into an authority expression.
const RANKING_SQL_PATHS = {
  "../../handlers/case-law/decisions/search.ts": "cb.authority",
  "../../handlers/legislation/search.ts": "d.citation_authority",
  "./pg-fts-legal-provider.ts": "d.citation_authority",
} as const satisfies Record<string, string>;

const RAW_AUTHORITY_BLEND =
  /[\d.]+\s*\*\s*(?:ln\(|d\.citation_authority|cb\.authority)/u;

test("every Postgres ranking path scores authority through the shared fragment", async () => {
  const audited = await Promise.all(
    Object.entries(RANKING_SQL_PATHS).map(async ([path, authority]) => {
      const source = await Bun.file(`${import.meta.dir}/${path}`).text();
      return {
        path,
        blendedThrough: source.includes(
          `blendedRankSql(ftsSearch.rank, sql\`${authority}\`)`,
        ),
        // The whole match, not a boolean, so a failure names the offender.
        rawAuthorityBlend: RAW_AUTHORITY_BLEND.exec(source)?.[0] ?? null,
      };
    }),
  );

  expect(audited).toEqual(
    Object.keys(RANKING_SQL_PATHS).map((path) => ({
      path,
      blendedThrough: true,
      rawAuthorityBlend: null,
    })),
  );
});
