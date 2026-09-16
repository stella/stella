import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  caseLawDecisions,
  caseLawProvisionCitations,
  caseLawSources,
  caseLawStatuteCitationCountState,
} from "@/api/db/schema";
import { createStatuteCitationCountRepair } from "@/api/handlers/case-law/provisions/citation-count-repair";
import { createSafeId } from "@/api/lib/branded-types";
import { publishedCaseLawDecisionSqlFor } from "@/api/lib/case-law/published-decisions";
import { storedObservationHasDetailSqlFor } from "@/api/lib/legal-search/ingestion-normalization";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
}, 120_000);
afterAll(async () => await client.close());

const listingOnly = {
  _stellaPartialObservation: {
    isListingOnly: true,
    caseNumberIsPlaceholder: false,
  },
};

/** Compare both directions, including phantom aggregate buckets and missing buckets. */
const expectExactProjection = async () => {
  const difference = await db.execute(sql`
    WITH eligible AS (
      SELECT DISTINCT c.decision_id, d.source_id, c.jurisdiction, c.work_eli,
        target.target_type, target.anchor
      FROM case_law_provision_citations c
      JOIN case_law_decisions d ON d.id = c.decision_id
      CROSS JOIN LATERAL (
        SELECT 'work' AS target_type, '' AS anchor
        UNION ALL SELECT 'provision', c.anchor WHERE c.anchor <> ''
      ) target
      WHERE c.work_eli IS NOT NULL AND d.country = c.jurisdiction
        AND ${sql.raw(publishedCaseLawDecisionSqlFor("d"))}
    ), expected AS (
      SELECT source_id, jurisdiction, work_eli, target_type, anchor,
        count(*)::integer AS decision_count FROM eligible GROUP BY 1, 2, 3, 4, 5
    ), actual AS (
      SELECT source_id, jurisdiction, work_eli, target_type, anchor, decision_count
      FROM case_law_statute_citation_counts
    )
    (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
  `);
  expect(difference.rows).toEqual([]);
};

test("statute memberships follow publication, country, citation and source transitions", async () => {
  const source = caseLawSourceRow();
  const movedSource = caseLawSourceRow({ adapterKey: "moved" });
  await db.insert(caseLawSources).values([source, movedSource]);
  const decisionId = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    id: decisionId,
    sourceId: source.id,
    country: "CZE",
    court: "Court",
    language: "cs",
    caseNumber: "1 C 1/2026",
    metadata: listingOnly,
  });
  const citationId = createSafeId<"caseLawProvisionCitation">();
  const duplicateId = createSafeId<"caseLawProvisionCitation">();
  await db.insert(caseLawProvisionCitations).values(
    [citationId, duplicateId].map((id, index) => ({
      id,
      decisionId,
      jurisdiction: "CZE",
      workIdentifier: "89/2012 Sb.",
      workNumber: 89,
      workYear: 2012,
      workCollection: "Sb.",
      unit: "section" as const,
      section: 1,
      workEli: "/eli/cz/sb/2012/89",
      anchor: "s1",
      spanStart: index * 10,
      spanEnd: index * 10 + 5,
      sentenceText: "Citation",
      confidence: 1,
    })),
  );
  await expectExactProjection();

  for (const metadata of [{}, listingOnly, {}, { unrelated: "change" }]) {
    await db
      .update(caseLawDecisions)
      .set({ metadata })
      .where(eq(caseLawDecisions.id, decisionId));
    await expectExactProjection();
  }
  for (const country of ["SVK", "CZE"]) {
    await db
      .update(caseLawDecisions)
      .set({ country })
      .where(eq(caseLawDecisions.id, decisionId));
    await expectExactProjection();
  }
  await db
    .update(caseLawDecisions)
    .set({ sourceId: movedSource.id })
    .where(eq(caseLawDecisions.id, decisionId));
  await expectExactProjection();
  await db
    .delete(caseLawProvisionCitations)
    .where(eq(caseLawProvisionCitations.id, duplicateId));
  await expectExactProjection();
  await db
    .update(caseLawProvisionCitations)
    .set({ anchor: "s2", workEli: "/eli/cz/sb/1963/99" })
    .where(eq(caseLawProvisionCitations.id, citationId));
  await expectExactProjection();
  await db
    .update(caseLawProvisionCitations)
    .set({ jurisdiction: "SVK" })
    .where(eq(caseLawProvisionCitations.id, citationId));
  await expectExactProjection();
  await db
    .update(caseLawDecisions)
    .set({ country: "SVK" })
    .where(eq(caseLawDecisions.id, decisionId));
  await expectExactProjection();
  await db.delete(caseLawDecisions).where(eq(caseLawDecisions.id, decisionId));
  await expectExactProjection();
}, 120_000);

test("checkpointed repair removes stale memberships and converges on replay", async () => {
  const repairBatch = createStatuteCitationCountRepair(db);
  const source = caseLawSourceRow({ adapterKey: "repair" });
  await db.insert(caseLawSources).values(source);
  const decisionId = createSafeId<"caseLawDecision">();
  const decisionIds = [
    decisionId,
    ...Array.from({ length: 500 }, () => createSafeId<"caseLawDecision">()),
  ];
  await db.insert(caseLawDecisions).values(
    decisionIds.map((id, index) => ({
      id,
      sourceId: source.id,
      country: "CZE",
      court: "Court",
      language: "cs",
      caseNumber: `${index} C 1/2026`,
      metadata: listingOnly,
    })),
  );
  // A pre-migration membership may outlive its eligibility or even its last citation.
  await db.execute(sql`
    INSERT INTO case_law_statute_citation_memberships
      (decision_id, source_id, jurisdiction, work_eli, target_type, anchor)
    VALUES (${decisionId}::uuid, ${source.id}::uuid, 'CZE', '/eli/cz/sb/2012/89', 'work', '')
  `);
  const stale = await db.execute(
    sql`SELECT decision_count FROM case_law_statute_citation_counts`,
  );
  expect(stale.rows).toEqual([{ decision_count: 1 }]);
  for (const _pass of [1, 2]) {
    await db
      .update(caseLawStatuteCitationCountState)
      .set({ status: "building", cursorDecisionId: null })
      .where(eq(caseLawStatuteCitationCountState.key, "global"));
    const advanced = await repairBatch();
    expect(advanced).toEqual({ status: "advanced", decisions: 500 });
    expect(await repairBatch()).toEqual({
      status: "advanced",
      decisions: 1,
    });
    await expectExactProjection();
    expect(await repairBatch()).toEqual({
      status: "ready",
      decisions: 0,
    });
    expect(await repairBatch()).toEqual({
      status: "ready",
      decisions: 0,
    });
  }
}, 120_000);

test("the stored publication predicate derives from the public-read owner", async () => {
  const definition = await db.execute(sql`
    SELECT prosrc FROM pg_proc WHERE oid = 'case_law_statute_citation_is_published(jsonb)'::regprocedure
  `);
  expect(definition.rows).toEqual([
    { prosrc: ` SELECT ${storedObservationHasDetailSqlFor("metadata")} ` },
  ]);
});

test("a failed checkpoint rolls back membership repair and can be replayed", async () => {
  const localClient = await createTestPglite();
  const localDb = drizzle({ client: localClient });
  const repairBatch = createStatuteCitationCountRepair(localDb);
  const source = caseLawSourceRow({ adapterKey: "rollback" });
  const decisionId = createSafeId<"caseLawDecision">();
  try {
    await localDb.insert(caseLawSources).values(source);
    await localDb.insert(caseLawDecisions).values({
      id: decisionId,
      sourceId: source.id,
      country: "CZE",
      court: "Court",
      language: "cs",
      caseNumber: "1 C 1/2026",
      metadata: listingOnly,
    });
    await localDb.execute(sql`
      INSERT INTO case_law_statute_citation_memberships
        (decision_id, source_id, jurisdiction, work_eli, target_type, anchor)
      VALUES (${decisionId}::uuid, ${source.id}::uuid, 'CZE', '/eli/cz/sb/2012/89', 'work', '')
    `);
    await localDb
      .update(caseLawStatuteCitationCountState)
      .set({ status: "building", cursorDecisionId: null })
      .where(eq(caseLawStatuteCitationCountState.key, "global"));
    await localDb.execute(sql`
      CREATE FUNCTION reject_test_citation_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'citation checkpoint fault';
      END;
      $$
    `);
    await localDb.execute(sql`
      CREATE TRIGGER reject_test_citation_checkpoint BEFORE UPDATE ON case_law_statute_citation_count_state
      FOR EACH ROW EXECUTE FUNCTION reject_test_citation_checkpoint()
    `);
    const outcome = await Result.tryPromise({
      try: repairBatch,
      catch: (cause) => cause,
    });
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error).toMatchObject({
        cause: { message: "citation checkpoint fault" },
      });
    }
    expect(
      (
        await localDb.execute(
          sql`SELECT decision_count FROM case_law_statute_citation_counts`,
        )
      ).rows,
    ).toEqual([{ decision_count: 1 }]);
    expect(
      await localDb
        .select({ cursor: caseLawStatuteCitationCountState.cursorDecisionId })
        .from(caseLawStatuteCitationCountState),
    ).toEqual([{ cursor: null }]);
    await localDb.execute(
      sql`DROP TRIGGER reject_test_citation_checkpoint ON case_law_statute_citation_count_state`,
    );
    expect(await repairBatch()).toEqual({
      status: "advanced",
      decisions: 1,
    });
    expect(
      (
        await localDb.execute(
          sql`SELECT decision_count FROM case_law_statute_citation_counts`,
        )
      ).rows,
    ).toEqual([]);
    expect(await repairBatch()).toEqual({
      status: "ready",
      decisions: 0,
    });
  } finally {
    await localClient.close();
  }
}, 120_000);
