/**
 * A fixture decision the seed is asked to refresh reads, afterwards, exactly
 * as a fresh seed would store it, whatever an earlier seed left in the row.
 * The reader story is built on its decision's text, so a database seeded
 * before a fixture edit must not keep the old text under the new story.
 */

import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSearchDocuments,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import {
  fixtureDecisionRow,
  fixtureSourceRow,
  refreshFixtureDecision,
} from "./seed-case-law";
import type { FixtureDecision } from "./seed-case-law";
import { syntheticCaseLawFixtures } from "./seed-case-law-synthetic";

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

let client: PGlite;

beforeAll(async () => {
  client = await createTestPglite();
}, DB_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
});

test(
  "a refreshed decision reads as its fixture again",
  async () => {
    const db = drizzle({ client });
    const [fixture] = syntheticCaseLawFixtures();
    const decision = fixture?.decisions.at(0);
    if (!fixture || !decision) {
      throw new Error("expected a synthetic fixture decision");
    }
    const sourceRow = fixtureSourceRow(fixture.source);
    await db.insert(caseLawSources).values(sourceRow);
    const fresh = fixtureDecisionRow({
      adapterKey: fixture.source.adapter_key,
      sourceId: sourceRow.id,
      decision,
    });

    // What an earlier seed left: the same decision under another text.
    const stale: FixtureDecision = {
      ...decision,
      fulltext: "Starší text.",
      metadata: { stale: true },
      parser_version: 0,
    };
    await db.insert(caseLawDecisions).values(
      fixtureDecisionRow({
        adapterKey: fixture.source.adapter_key,
        sourceId: sourceRow.id,
        decision: stale,
      }),
    );

    await refreshFixtureDecision(
      asTestRaw<Parameters<typeof refreshFixtureDecision>[0]>(db),
      {
        adapterKey: fixture.source.adapter_key,
        decision,
        decisionId: fresh.id,
        sourceId: sourceRow.id,
      },
    );

    const [stored] = await db
      .select({
        fulltext: caseLawDecisions.fulltext,
        metadata: caseLawDecisions.metadata,
        parserVersion: caseLawDecisions.parserVersion,
        documentAst: caseLawDecisions.documentAst,
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, fresh.id));
    expect(stored).toEqual({
      fulltext: fresh.fulltext,
      metadata: fresh.metadata,
      parserVersion: fresh.parserVersion,
      documentAst: fresh.documentAst,
    });
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a rerun updates the decision in place and keeps what hangs off it",
  async () => {
    const db = drizzle({ client });
    const fixtures = syntheticCaseLawFixtures();
    const fixture = fixtures.at(1) ?? fixtures.at(0);
    const decision = fixture?.decisions.at(0);
    if (!fixture || !decision) {
      throw new Error("expected a synthetic fixture decision");
    }
    const sourceRow = fixtureSourceRow(fixture.source);
    await db.insert(caseLawSources).values(sourceRow).onConflictDoNothing();
    const options = {
      adapterKey: fixture.source.adapter_key,
      sourceId: sourceRow.id,
    };
    const seed = async (next: FixtureDecision) => {
      const row = fixtureDecisionRow({ ...options, decision: next });
      await refreshFixtureDecision(
        asTestRaw<Parameters<typeof refreshFixtureDecision>[0]>(db),
        { ...options, decision: next, decisionId: row.id },
      );
      return row;
    };

    const first = await seed(decision);

    // Rows other users' state is made of: both reference the decision with a
    // cascading foreign key, so a delete-and-insert would take them along.
    await db.insert(caseLawSearchDocuments).values({ decisionId: first.id });
    const citationId = createSafeId<"caseLawCitation">();
    await db.insert(caseLawCitations).values({
      id: citationId,
      citingDecisionId: first.id,
      citationText: "sp. zn. 1 Cdo 1/2020",
      citationKey: "1cdo/1/2020",
    });

    const survivors = async () => ({
      searchDocuments: await db
        .select({ decisionId: caseLawSearchDocuments.decisionId })
        .from(caseLawSearchDocuments)
        .where(eq(caseLawSearchDocuments.decisionId, first.id)),
      citations: await db
        .select({ id: caseLawCitations.id })
        .from(caseLawCitations)
        .where(eq(caseLawCitations.citingDecisionId, first.id)),
    });
    const expected = {
      searchDocuments: [{ decisionId: first.id }],
      citations: [{ id: citationId }],
    };

    // Unchanged fixture: nothing is written, nothing is lost.
    await seed(decision);
    expect(await survivors()).toEqual(expected);

    // Changed fixture: the column follows, the dependents stay attached.
    const changed = await seed({ ...decision, fulltext: "Změněný text." });
    expect(changed.id).toBe(first.id);
    expect(await survivors()).toEqual(expected);
    const [stored] = await db
      .select({ fulltext: caseLawDecisions.fulltext })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, first.id));
    expect(stored).toEqual({ fulltext: "Změněný text." });
  },
  DB_TEST_TIMEOUT_MS,
);
