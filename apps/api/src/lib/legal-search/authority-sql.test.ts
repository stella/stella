import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  courtWeight,
  courtWeightSql,
} from "@/api/handlers/case-law/citation-score";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import {
  courtTierSqlFromMap,
  courtWeightFromMap,
} from "@/api/lib/case-law/court-weights";
import type { CourtWeightMap } from "@/api/lib/case-law/court-weights";
import {
  authorityBlendSql,
  blendedRankSql,
  courtTierValueSql,
  noCourtTierSql,
  saturatedAuthoritySql,
} from "@/api/lib/legal-search/authority-sql";
import {
  AUTHORITY_PIVOT,
  blendStableCitationAuthority,
  courtTierSignal,
  courtTierValue,
  DEFAULT_AUTHORITY_WEIGHT,
  HIGHEST_COURT_TIER,
  LOWEST_COURT_TIER,
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

test("the blended rank is the lexical score plus the bounded terms", async () => {
  const blended = await evaluate(
    blendedRankSql({
      authority: authorityLiteral(5),
      courtTier: noCourtTierSql(),
      lexicalRank: sql`0.5::float8`,
    }),
  );
  expect(blended).toBeCloseTo(0.5 + DEFAULT_AUTHORITY_WEIGHT * (5 / 6), 12);
  // Same arithmetic the TypeScript blend does for the same inputs, and a
  // corpus with no courts in it adds nothing for the court it does not have.
  expect(blended).toBeCloseTo(
    0.5 + DEFAULT_AUTHORITY_WEIGHT * saturateAuthority(5),
    12,
  );
});

test("the SQL court-tier scale equals courtTierValue(), rank for rank", async () => {
  for (const tier of [LOWEST_COURT_TIER, 2, 3, HIGHEST_COURT_TIER]) {
    // oxlint-disable-next-line no-await-in-loop -- one round-trip per rank against an in-process database
    const inPostgres = await evaluate(
      courtTierValueSql(sql`${sql.raw(String(tier))}::int`),
    );
    expect(inPostgres).toBeCloseTo(courtTierValue(tier), 12);
  }
  // Integer division would collapse every rank between the ends to zero.
  expect(await evaluate(courtTierValueSql(sql`2::int`))).toBeCloseTo(1 / 3, 12);
  // Clamped on both sides, as in TypeScript, so a registry row outside the
  // range cannot push the term past the weight the bound assumes.
  expect(await evaluate(courtTierValueSql(sql`0::int`))).toBe(0);
  expect(await evaluate(courtTierValueSql(sql`99::int`))).toBe(1);
});

/**
 * Decisions the two runtimes must agree on: a ranked court in its own
 * jurisdiction, one no pattern matches, one whose country the registry does
 * not know, and one named in another jurisdiction's language — the case that
 * exercises the cross-country fallback both sides walk in map order.
 */
const BLEND_FIXTURES = [
  { authority: 0, country: "CZE", court: "Ústavní soud", lexical: 0.5 },
  { authority: 2, country: "CZE", court: "Nejvyšší soud", lexical: 0.42 },
  {
    authority: 1,
    country: "CZE",
    court: "Okresní soud v Kolíně",
    lexical: 0.9,
  },
  {
    authority: 0.3,
    country: "SVK",
    court: "Najvyšší súd Slovenskej republiky",
    lexical: 0.7,
  },
  { authority: 0, country: "CZE", court: "Sąd Najwyższy", lexical: 0.6 },
  { authority: 4, country: "XYZ", court: "A court nobody ranks", lexical: 0.1 },
] as const;

test("the Postgres blend equals the TypeScript blend for the same decision", async () => {
  const map = courtWeightMapFromSeed();
  const courtTier = sql.raw(
    courtTierSqlFromMap({
      countryColumn: "d.country",
      courtColumn: "d.court",
      map,
    }),
  );

  for (const { authority, country, court, lexical } of BLEND_FIXTURES) {
    const [inTypeScript] = blendStableCitationAuthority({
      candidates: [{ id: court, score: lexical }],
      authorityById: new Map([[court, authority]]),
      signals: [
        courtTierSignal(
          new Map([[court, courtWeightFromMap(map, court, country).tier]]),
        ),
      ],
    });

    const scored = sql<number>`(${blendedRankSql({
      authority: authorityLiteral(authority),
      courtTier,
      lexicalRank: sql`${sql.raw(lexical.toString())}::float8`,
    })})::float8`;
    const [row] =
      // oxlint-disable-next-line no-await-in-loop -- one round-trip per fixture against an in-process database
      await db
        .select({ v: scored })
        .from(sql`(VALUES (${court}, ${country})) AS d(court, country)`);

    expect(Number(row?.v), court).toBeCloseTo(
      inTypeScript?.score ?? Number.NaN,
      12,
    );
  }
});

test("Postgres resolves an overlapping court to the tier the lookup does", async () => {
  // Two jurisdictions whose patterns both match one court name, at different
  // ranks. The CASE takes its first true branch and the lookup takes its
  // first match, so they agree only while both walk the precedence order.
  const overlapping: CourtWeightMap = new Map([
    [
      "XBB",
      [
        {
          country: "XBB",
          pattern: /shared court/iu,
          tier: 2,
          tierLabel: "regional",
          weight: 4,
        },
      ],
    ],
    [
      "XAA",
      [
        {
          country: "XAA",
          pattern: /shared court/iu,
          tier: 4,
          tierLabel: "constitutional",
          weight: 10,
        },
      ],
    ],
  ]);
  const courtTier = sql.raw(
    courtTierSqlFromMap({
      countryColumn: "d.country",
      courtColumn: "d.court",
      map: overlapping,
    }),
  );

  // A country the registry does not rank, so both runtimes take the
  // cross-jurisdiction fallback rather than the scoped branch.
  const [row] = await db
    .select({ v: sql<number>`(${courtTier})::float8` })
    .from(sql`(VALUES ('Shared Court', 'XZZ')) AS d(court, country)`);

  expect(Number(row?.v)).toBe(
    courtWeightFromMap(overlapping, "Shared Court", "XZZ").tier,
  );
  // The higher rank wins in both, though the map holds the lower one first.
  expect(Number(row?.v)).toBe(4);
});

test("an unseeded registry renders ranking SQL Postgres accepts", async () => {
  // Every registry-driven expression is a CASE over rows, and a CASE needs a
  // WHEN: an install whose registry table holds nothing has to rank at the
  // default rather than fail the statement it is interpolated into. Rendered
  // *and executed*, because the fault is a syntax error the renderer alone
  // cannot show.
  const empty: CourtWeightMap = new Map();
  const courtTier = sql.raw(
    courtTierSqlFromMap({
      countryColumn: "d.country",
      courtColumn: "d.court",
      map: empty,
    }),
  );
  const citingWeight = sql.raw(courtWeightSql("d.court", []));

  const [row] = await db
    .select({
      tier: sql<number>`(${courtTier})::float8`,
      weight: sql<number>`(${citingWeight})::float8`,
      // The search path's whole score, which is where the tier lands.
      blended: sql<number>`(${blendedRankSql({
        authority: authorityLiteral(2),
        courtTier,
        lexicalRank: sql`0.5::float8`,
      })})::float8`,
    })
    .from(sql`(VALUES ('Ústavní soud', 'CZE')) AS d(court, country)`);

  // The same default the TypeScript lookup falls back to for a court no row
  // ranks, which is every court while the registry is empty.
  expect(Number(row?.tier)).toBe(
    courtWeightFromMap(empty, "Ústavní soud", "CZE").tier,
  );
  expect(Number(row?.weight)).toBe(courtWeight("Ústavní soud", empty));
  expect(Number(row?.blended)).toBeCloseTo(
    0.5 + DEFAULT_AUTHORITY_WEIGHT * saturateAuthority(2),
    12,
  );
  // Not vacuous: the seeded registry ranks this court above that default, so
  // the assertions above cannot pass on a registry that ranked it after all.
  expect(
    courtWeightFromMap(courtWeightMapFromSeed(), "Ústavní soud", "CZE").tier,
  ).toBeGreaterThan(Number(row?.tier));
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
        blendedThrough:
          source.includes("blendedRankSql({") &&
          source.includes(`authority: sql\`${authority}\``),
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

/**
 * Which court-tier expression each ranking path feeds the blend: the registry
 * lookup for the two case-law paths, the no-court constant for legislation. A
 * path that stops resolving the tier ranks a jurisdiction's apex court like
 * any other, which is the drift the whole module exists to prevent.
 */
const RANKING_COURT_TIER = {
  "../../handlers/case-law/decisions/search.ts": "courtTierSqlFromMap({",
  "../../handlers/legislation/search.ts": "courtTier: noCourtTierSql()",
  "./pg-fts-legal-provider.ts": "courtTierSqlFromMap({",
} as const satisfies Record<keyof typeof RANKING_SQL_PATHS, string>;

test("every Postgres ranking path resolves the court tier the same way", async () => {
  const audited = await Promise.all(
    Object.entries(RANKING_COURT_TIER).map(async ([path, expression]) => {
      const source = await Bun.file(`${import.meta.dir}/${path}`).text();
      return { path, resolvesTier: source.includes(expression) };
    }),
  );

  expect(audited).toEqual(
    Object.keys(RANKING_COURT_TIER).map((path) => ({
      path,
      resolvesTier: true,
    })),
  );
});
