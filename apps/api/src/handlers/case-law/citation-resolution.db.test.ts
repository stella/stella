import { afterAll, beforeAll, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api-postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as authSchema from "@/api/db/auth-schema";
import * as rlsExports from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import * as schema from "@/api/db/schema";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { resolveCitationBatch } from "@/api/handlers/case-law/citation-resolution";
import { createSafeId } from "@/api/lib/branded-types";
import {
  createSchemaPglite,
  installPgliteSchemaPrerequisites,
} from "@/api/tests/pglite-schema";

/**
 * Resolution runs entirely in SQL, so the rules that keep a link honest are
 * join predicates rather than branches a unit test could reach. Each case
 * below is a wrong edge the citation graph must not contain: a link across
 * jurisdictions, a link to a decision published later than the one citing
 * it, a link chosen arbitrarily from an ambiguous pair, and a self-link.
 */

const allSchema = { ...schema, ...authSchema, ...rlsExports };

let client: Awaited<ReturnType<typeof createSchemaPglite>>;
let db: ReturnType<typeof drizzle>;

const sourceId = createSafeId<"caseLawSource">();
// A case number is unique within a source, so a genuine collision can only
// come from a second court publishing the same number.
const otherSourceId = createSafeId<"caseLawSource">();
const czTarget = createSafeId<"caseLawDecision">();
const skTarget = createSafeId<"caseLawDecision">();
const laterTarget = createSafeId<"caseLawDecision">();
const ambiguousA = createSafeId<"caseLawDecision">();
const ambiguousB = createSafeId<"caseLawDecision">();
const citing = createSafeId<"caseLawDecision">();

const plainCitation = createSafeId<"caseLawCitation">();
const crossBorderCitation = createSafeId<"caseLawCitation">();
const futureCitation = createSafeId<"caseLawCitation">();
const ambiguousCitation = createSafeId<"caseLawCitation">();
const selfCitation = createSafeId<"caseLawCitation">();
const unkeyedCitation = createSafeId<"caseLawCitation">();

// The pglite handle stands in for a transaction, matching the pattern the
// other case-law database tests use for their fakes.
// eslint-disable-next-line typescript/no-unsafe-type-assertion
const asTx = () => db as unknown as Transaction;

const scopedDb = async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
  await fn(asTx());

beforeAll(
  async () => {
    client = await createSchemaPglite();
    db = drizzle({ client });
    await db.execute(sql.raw("CREATE ROLE stella NOLOGIN"));
    await db.execute(sql.raw("CREATE ROLE stella_ingestion NOLOGIN"));
    await installPgliteSchemaPrerequisites(db);
    const { sqlStatements } = await pushSchema(allSchema, db);
    for (const statement of sqlStatements) {
      // oxlint-disable-next-line no-await-in-loop -- DDL statements must apply in emitted order
      await db.execute(sql.raw(statement));
    }

    await db.insert(caseLawSources).values([
      { id: sourceId, adapterKey: "cz-ns", name: "test source" },
      { id: otherSourceId, adapterKey: "cz-regional", name: "other court" },
    ]);

    const base = {
      sourceId,
      court: "Nejvyšší soud",
      language: "cs",
      fulltext: "text",
    };
    await db.insert(caseLawDecisions).values([
      {
        ...base,
        id: citing,
        caseNumber: "99 Cdo 1/2022",
        citationKey: "99cdo/1/2022",
        country: "CZE",
        decisionDate: "2022-01-01",
        slug: "citing",
        languageGroupKey: "citing",
      },
      {
        ...base,
        id: czTarget,
        caseNumber: "21 Cdo 5/2019",
        citationKey: "21cdo/5/2019",
        country: "CZE",
        decisionDate: "2019-05-01",
        slug: "cz-target",
        languageGroupKey: "cz-target",
      },
      {
        // Same key, different country: a Slovak case number can collide
        // with a Czech one and mean an unrelated case.
        ...base,
        id: skTarget,
        caseNumber: "7 Cdo 9/2019",
        citationKey: "7cdo/9/2019",
        country: "SVK",
        decisionDate: "2019-06-01",
        slug: "sk-target",
        languageGroupKey: "sk-target",
      },
      {
        ...base,
        id: laterTarget,
        caseNumber: "30 Cdo 8/2024",
        citationKey: "30cdo/8/2024",
        country: "CZE",
        decisionDate: "2024-03-01",
        slug: "later",
        languageGroupKey: "later",
      },
      {
        ...base,
        id: ambiguousA,
        caseNumber: "5 Co 2/2018",
        citationKey: "5co/2/2018",
        country: "CZE",
        decisionDate: "2018-02-01",
        slug: "ambiguous-a",
        languageGroupKey: "ambiguous-a",
      },
      {
        ...base,
        id: ambiguousB,
        sourceId: otherSourceId,
        caseNumber: "5 Co 2/2018",
        citationKey: "5co/2/2018",
        country: "CZE",
        decisionDate: "2018-03-01",
        slug: "ambiguous-b",
        languageGroupKey: "ambiguous-b",
      },
    ]);

    await db.insert(caseLawCitations).values([
      {
        id: plainCitation,
        citingDecisionId: citing,
        citationText: "sp. zn. 21 Cdo 5/2019",
        citationKey: "21cdo/5/2019",
      },
      {
        id: crossBorderCitation,
        citingDecisionId: citing,
        citationText: "sp. zn. 7 Cdo 9/2019",
        citationKey: "7cdo/9/2019",
      },
      {
        id: futureCitation,
        citingDecisionId: citing,
        citationText: "sp. zn. 30 Cdo 8/2024",
        citationKey: "30cdo/8/2024",
      },
      {
        id: ambiguousCitation,
        citingDecisionId: citing,
        citationText: "sp. zn. 5 Co 2/2018",
        citationKey: "5co/2/2018",
      },
      {
        id: selfCitation,
        citingDecisionId: citing,
        citationText: "sp. zn. 99 Cdo 1/2022",
        citationKey: "99cdo/1/2022",
      },
      {
        id: unkeyedCitation,
        citingDecisionId: citing,
        citationText: "č. 12/2020 Sb. rozh. tr.",
        citationKey: null,
      },
    ]);

    await resolveCitationBatch(scopedDb, { limit: 100, afterId: null });
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

const citedIdOf = async (id: string): Promise<string | null> => {
  const rows = await db
    .select({ cited: caseLawCitations.citedDecisionId })
    .from(caseLawCitations)
    .where(eq(caseLawCitations.id, id))
    .limit(1);
  return rows.at(0)?.cited ?? null;
};

test("an unambiguous same-jurisdiction citation resolves", async () => {
  expect(await citedIdOf(plainCitation)).toBe(czTarget);
});

test("a matching key in another jurisdiction does not link", async () => {
  // The citing decision is Czech; the only holder of this key is Slovak.
  expect(await citedIdOf(crossBorderCitation)).toBeNull();
});

test("a decision published later than the citing one does not link", async () => {
  // Key collision with a future case: the citation cannot mean this.
  expect(await citedIdOf(futureCitation)).toBeNull();
});

test("an ambiguous key links to neither candidate", async () => {
  expect(await citedIdOf(ambiguousCitation)).toBeNull();
});

test("a decision does not cite itself", async () => {
  expect(await citedIdOf(selfCitation)).toBeNull();
});

test("a citation without a key is never examined", async () => {
  expect(await citedIdOf(unkeyedCitation)).toBeNull();
});

test("the keyset cursor advances past unresolvable rows", async () => {
  // Resolved rows leave the predicate, so a second pass from the start
  // would re-examine only the unresolvable ones forever. Walking by id
  // must reach the end instead.
  let after: string | null = null;
  let scans = 0;
  let examined = 0;
  while (scans < 10) {
    // oxlint-disable-next-line no-await-in-loop -- keyset walk: each batch's cursor comes from the previous one
    const batch = await resolveCitationBatch(scopedDb, {
      limit: 2,
      afterId: after,
    });
    scans += 1;
    examined += batch.scanned;
    if (batch.scanned === 0) {
      break;
    }
    after = batch.lastId;
  }
  // Five keyed rows remain unresolved-or-resolved but still keyed; the walk
  // terminates rather than looping on them.
  expect(scans).toBeLessThan(10);
  expect(examined).toBeGreaterThan(0);
});
