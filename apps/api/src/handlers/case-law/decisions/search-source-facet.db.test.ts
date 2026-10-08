import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as v from "valibot";

import {
  SEARCH_TOTAL_NOT_COUNTED,
  FACET_COUNT_TYPE,
  DEFAULT_SEARCH_EXCERPT,
  DEFAULT_SEARCH_SORT,
} from "@stll/api-contract/search";
import { compareCodeUnit } from "@stll/collation";

import {
  caseLawDecisions,
  caseLawSources,
  caseLawSearchDocuments,
} from "@/api/db/schema";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import { caseLawSearchPlan } from "@/api/handlers/case-law/decisions/search";
import { createSafeId } from "@/api/lib/branded-types";
import { cappedSourceFacetBuckets } from "@/api/lib/case-law/decision-search-facets";
import { SEARCH_CASE_LAW_PROJECTION } from "@/api/lib/chat/projections";
import { LIMITS } from "@/api/lib/limits";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const smallSource = createSafeId<"caseLawSource">();
const belowSource = createSafeId<"caseLawSource">();
const atSource = createSafeId<"caseLawSource">();
const aboveSource = createSafeId<"caseLawSource">();
const sources = [smallSource, belowSource, atSource, aboveSource];
let client: PGlite;
let readFacet: (
  language?: string,
  query?: string,
) => Promise<{ value: string; count: number }[]>;
let readExact: (
  language?: string,
) => Promise<{ value: string; count: number }[]>;

beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({ client });
    await db
      .insert(caseLawSources)
      .values(
        sources.map((id) => caseLawSourceRow({ id, adapterKey: `open-${id}` })),
      );
    const cap = LIMITS.caseLawSourceFacetCountCap;
    const rows = sources.flatMap((sourceId, sourceIndex) => {
      let groupCount = cap + sourceIndex - 2;
      if (sourceIndex === 0) {
        groupCount = 2;
      }
      if (sourceIndex === 3) {
        groupCount = cap + 37;
      }
      return Array.from({ length: groupCount }, (_, groupIndex) => {
        const key = `shared-${groupIndex}`;
        return [
          {
            id: createSafeId<"caseLawDecision">(),
            sourceId,
            country: "CZE",
            court: "Synthetic court",
            caseNumber: `${sourceIndex}-${groupIndex}-en`,
            language: "en",
            languageGroupKey: key,
          },
          {
            id: createSafeId<"caseLawDecision">(),
            sourceId,
            country: "CZE",
            court: "Synthetic court",
            caseNumber: `${sourceIndex}-${groupIndex}-cs`,
            language: "cs",
            languageGroupKey: key,
          },
        ];
      }).flat();
    });
    // Null groups remain separate documents. A nonmatching earlier sibling
    // cannot suppress a matching later version of the same judgment.
    const unmatched = {
      id: createSafeId<"caseLawDecision">(),
      sourceId: smallSource,
      country: "CZE",
      court: "Synthetic court",
      caseNumber: "unmatched",
      language: "cs",
      languageGroupKey: "partial-match",
    };
    rows.push(unmatched, {
      ...unmatched,
      id: createSafeId<"caseLawDecision">(),
      caseNumber: "matched",
    });
    const singletons = ["singleton-1", "singleton-2"].map((caseNumber) => ({
      id: createSafeId<"caseLawDecision">(),
      sourceId: smallSource,
      country: "CZE",
      court: "Synthetic court",
      caseNumber,
      language: "cs",
      languageGroupKey: null,
    }));
    // Insert in bounded batches; the fixture has several thousand rows.
    const decisions = [...rows, ...singletons];
    const batchSize = 500;
    for (let offset = 0; offset < decisions.length; offset += batchSize) {
      const batch = decisions.slice(offset, offset + batchSize);
      await db.insert(caseLawDecisions).values(batch);
      await db.insert(caseLawSearchDocuments).values(
        batch.map(({ id, language }) => ({
          decisionId: id,
          language,
          regconfig: "simple",
          searchableText: id === unmatched.id ? "unrelated" : "facetword",
          tsv: sql`to_tsvector('simple', ${id === unmatched.id ? "unrelated" : "facetword"})`,
        })),
      );
    }
    readFacet = async (language, query = "facetword") =>
      await withPublicLawReaderRole(db, async (tx) => {
        const plan = caseLawSearchPlan({
          body: {
            country: "CZE",
            query,
            sourceId: smallSource,
            ...(language === undefined ? {} : { language }),
          },
          configs: [
            {
              languages: ["cs", "en"],
              regconfig: "simple",
              includeDefault: false,
              useUnaccent: false,
            },
          ],
          courtWeights: courtWeightMapFromSeed(),
          excerpt: DEFAULT_SEARCH_EXCERPT,
          limit: 10,
          parsedCursor: null,
          queryUsed: query,
          sort: DEFAULT_SEARCH_SORT,
        });
        const result = await tx.execute(plan.facets.source);
        return result.rows.map((row) => ({
          value: String(row["value"]),
          count: Number(row["count"]),
        }));
      });
    readExact = async (language) =>
      await withPublicLawReaderRole(db, async (tx) => {
        const result = await tx.execute(sql`
      SELECT d.source_id::text AS value, count(distinct coalesce(d.language_group_key, d.id::text))::int AS count
      FROM case_law_decisions d
      JOIN case_law_search_documents sd ON sd.decision_id = d.id
      WHERE sd.tsv @@ plainto_tsquery('simple', 'facetword')
        ${language === undefined ? sql`` : sql`AND d.language = ${language}`}
      GROUP BY d.source_id
    `);
        return result.rows.map((row) => ({
          value: String(row["value"]),
          count: Number(row["count"]),
        }));
      });
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

test.each([undefined, "cs", "en"])(
  "source counts preserve matching judgments under language %s",
  async (language) => {
    const exact = new Map(
      (await readExact(language)).map(({ value, count }) => [value, count]),
    );
    const capped = await readFacet(language);
    expect(capped).toHaveLength(sources.length);
    const rawBySource = new Map(
      capped.map(({ value, count }) => [value, count]),
    );
    expect(exact.get(aboveSource)).toBeGreaterThan(
      LIMITS.caseLawSourceFacetCountCap + 1,
    );
    for (const [source, count] of exact) {
      expect(rawBySource.get(source)).toBe(
        Math.min(count, LIMITS.caseLawSourceFacetCountCap + 1),
      );
    }
    const projected = cappedSourceFacetBuckets(
      capped.map(({ value, count }) => ({ value, count, label: null })),
    );
    const payload = {
      facets: {
        courtYear: null,
        court: [],
        year: [],
        decisionType: [],
        source: projected,
        language: [],
      },
      searches: [],
      nextCursor: null,
      results: [],
      total: SEARCH_TOTAL_NOT_COUNTED,
    };
    // Parse the real query's buckets after the production count builder, not
    // a hand-maintained source-facet fixture. Cover exact and capped counts.
    expect(v.parse(SEARCH_CASE_LAW_PROJECTION, payload)).toEqual(payload);
    expect(
      v.safeParse(SEARCH_CASE_LAW_PROJECTION, {
        ...payload,
        facets: {
          ...payload.facets,
          source: projected.map((bucket) => ({ ...bucket, undeclared: true })),
        },
      }).success,
    ).toBe(false);
    for (const bucket of projected) {
      const expected = exact.get(bucket.value);
      expect(expected).toBeDefined();
      expect(bucket.count).toBe(
        Math.min(expected ?? 0, LIMITS.caseLawSourceFacetCountCap),
      );
      expect(bucket.countType).toBe(
        (expected ?? 0) > LIMITS.caseLawSourceFacetCountCap
          ? FACET_COUNT_TYPE.AT_LEAST
          : FACET_COUNT_TYPE.EXACT,
      );
    }
    expect(projected.find(({ value }) => value === smallSource)?.count).toBe(
      language === "en" ? 2 : 5,
    );
    for (const source of [belowSource, atSource]) {
      expect(projected.find(({ value }) => value === source)?.countType).toBe(
        FACET_COUNT_TYPE.EXACT,
      );
    }
    expect(
      projected.find(({ value }) => value === aboveSource)?.countType,
    ).toBe(FACET_COUNT_TYPE.AT_LEAST);
  },
);

test(
  "more capped sources than visible buckets are selected by name then id",
  async () => {
    const db = drizzle({ client });
    const sourceCount = LIMITS.caseLawFacetLimit + 3;
    const orderedSources = Array.from({ length: sourceCount }, (_, index) =>
      caseLawSourceRow({
        id: createSafeId<"caseLawSource">(),
        adapterKey: `cap-order-${index}`,
        name: `Source ${String(sourceCount - Math.floor(index / 2)).padStart(2, "0")}`,
      }),
    );
    await db.insert(caseLawSources).values(orderedSources);
    const ids = sql.join(
      orderedSources.map(({ id }) => sql`${id}::uuid`),
      sql`, `,
    );
    // Generate the bounded fixture in the database, avoiding 20,000 JS objects
    // and their per-row insert parameters.
    await db.execute(sql`
    INSERT INTO case_law_decisions (id, source_id, country, court, case_number, language)
    SELECT md5(source.id::text || ':' || series.n::text)::uuid,
      source.id, 'CZE', 'Synthetic court', series.n::text, 'cs'
    FROM case_law_sources source
    CROSS JOIN generate_series(1, ${LIMITS.caseLawSourceFacetCountCap + 1}) series(n)
    WHERE source.id IN (${ids})
  `);
    await db.execute(sql`
    INSERT INTO case_law_search_documents
      (decision_id, language, regconfig, searchable_text, tsv)
    SELECT id, 'cs', 'simple', 'caporderword', to_tsvector('simple', 'caporderword')
    FROM case_law_decisions
    WHERE source_id IN (${ids})
  `);
    await db.execute(sql`ANALYZE case_law_sources`);
    await db.execute(sql`ANALYZE case_law_decisions`);
    await db.execute(sql`ANALYZE case_law_search_documents`);
    const expected = orderedSources.toSorted(
      (left, right) =>
        compareCodeUnit(left.name, right.name) ||
        compareCodeUnit(left.id, right.id),
    );
    expect(expected.map(({ id }) => id)).not.toEqual(
      orderedSources
        .toSorted((left, right) => compareCodeUnit(left.id, right.id))
        .map(({ id }) => id),
    );
    const buckets = await readFacet(undefined, "caporderword");
    expect(buckets.map(({ value }) => value)).toEqual(
      expected.slice(0, LIMITS.caseLawFacetLimit).map(({ id }) => id),
    );
    expect(
      buckets.every(
        ({ count }) => count === LIMITS.caseLawSourceFacetCountCap + 1,
      ),
    ).toBe(true);
  },
  { timeout: 120_000 },
);
