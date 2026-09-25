/**
 * The projection's behaviour at Postgres's 1 MiB `tsvector` ceiling.
 *
 * A decision the server refuses to project whole still has to leave a row
 * behind: no row keeps it in the backfill's missing scan, which reselects it
 * on every pass and never converges. The bounded retry is what lands that
 * row, and it writes a prefix, so what the row can still answer — the head of
 * the text, and preview passages cut before the bound — is the property here,
 * not the refusal itself.
 */

import type { PGlite } from "@electric-sql/pglite";
import { Result } from "better-result";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSearchDocumentPreviewPassages,
  caseLawSearchDocuments,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  backfillSearchIndex,
  indexDecision,
} from "@/api/lib/legal-search/case-law-search-index";
import { logger } from "@/api/lib/observability/logger";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/** Same budget as the schema push in `beforeAll`: an embedded Postgres is slow. */
const DB_TEST_TIMEOUT_MS = 120_000;

const BOUNDED_SIGNATURE = "case_law.search_index.tsvector_bounded";

let client: PGlite;
let db: ReturnType<typeof drizzle>;

const resolveConfig: Parameters<typeof indexDecision>[2] = async () => ({
  regconfig: "simple",
  useUnaccent: false,
});

const scopedDb: Parameters<typeof indexDecision>[1] = async (callback) =>
  // SAFETY: pglite stands in for the transaction used by this projection;
  // the test exercises only the statements issued by the callback.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test transaction shim
  await callback(db as unknown as Transaction);

const sourceId = createSafeId<"caseLawSource">();
const shortId = createSafeId<"caseLawDecision">();
const oversizedId = createSafeId<"caseLawDecision">();

const SHORT_DECISION = {
  caseNumber: "25 Cdo 1234/2021",
  court: "Nejvyšší soud",
  ecli: "ECLI:CZ:NS:2021:25.CDO.1234.2021",
  fulltext: "Ušlý zisk se nahrazuje jen v prokázaném rozsahu.",
  identifier: "NS 1234/2021",
} as const;

// Postgres stores a lexeme once and at most 256 positions, so ordinary prose
// projects into a fraction of its own size however long the decision runs.
// Tokens that are all distinct are what reaches the ceiling: a schedule of
// dockets, a table of references, a numbered list of provisions.
const OVERSIZED_TOKEN_COUNT = 90_000;
const oversizedToken = (index: number) => `rozhodnuti${index.toString(36)}`;
const OVERSIZED_FULLTEXT = Array.from(
  { length: OVERSIZED_TOKEN_COUNT },
  (_unused, index) => oversizedToken(index),
).join(" ");
const OVERSIZED_HEAD_TOKEN = oversizedToken(0);
const OVERSIZED_TAIL_TOKEN = oversizedToken(OVERSIZED_TOKEN_COUNT - 1);

const boundedWarnings = (calls: readonly unknown[][]) =>
  calls.filter(([signature]) => signature === BOUNDED_SIGNATURE);

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });

  await db
    .insert(caseLawSources)
    .values(caseLawSourceRow({ id: sourceId, name: "tsvector ceiling" }));
  await db.insert(caseLawDecisions).values([
    {
      caseNumber: SHORT_DECISION.caseNumber,
      country: "CZE",
      court: SHORT_DECISION.court,
      ecli: SHORT_DECISION.ecli,
      fulltext: SHORT_DECISION.fulltext,
      id: shortId,
      language: "cs",
      sourceId,
    },
    {
      caseNumber: "30 Cdo 99/2020",
      country: "CZE",
      court: "Nejvyšší soud",
      fulltext: OVERSIZED_FULLTEXT,
      id: oversizedId,
      language: "cs",
      sourceId,
    },
  ]);
  await db.insert(caseLawDecisionIdentifiers).values({
    decisionId: shortId,
    normalizedValue: SHORT_DECISION.identifier,
    type: DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
    value: SHORT_DECISION.identifier,
  });
}, DB_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
});

test("a decision within the tsvector ceiling indexes its whole searchable text", async () => {
  const warn = spyOn(logger, "warn");
  try {
    expect(
      Result.isOk(await indexDecision(shortId, scopedDb, resolveConfig)),
    ).toBe(true);

    const projection = (
      await db
        .select({ searchableText: caseLawSearchDocuments.searchableText })
        .from(caseLawSearchDocuments)
        .where(eq(caseLawSearchDocuments.decisionId, shortId))
    ).at(0);

    expect(projection?.searchableText).toBe(
      `${SHORT_DECISION.caseNumber} ${SHORT_DECISION.ecli} ${SHORT_DECISION.identifier} ${SHORT_DECISION.court} ${SHORT_DECISION.fulltext}`,
    );
    expect(boundedWarnings(warn.mock.calls)).toEqual([]);
  } finally {
    warn.mockRestore();
  }
});

test(
  "a decision whose text outgrows the tsvector ceiling is still indexed",
  async () => {
    const warn = spyOn(logger, "warn");
    try {
      expect(
        Result.isOk(await indexDecision(oversizedId, scopedDb, resolveConfig)),
      ).toBe(true);

      const projection = (
        await db
          .select({
            headMatches: sql<boolean>`${caseLawSearchDocuments.tsv} @@ plainto_tsquery('simple', ${OVERSIZED_HEAD_TOKEN})`,
            searchableText: caseLawSearchDocuments.searchableText,
            tailMatches: sql<boolean>`${caseLawSearchDocuments.tsv} @@ plainto_tsquery('simple', ${OVERSIZED_TAIL_TOKEN})`,
          })
          .from(caseLawSearchDocuments)
          .where(eq(caseLawSearchDocuments.decisionId, oversizedId))
      ).at(0);

      // The row is what takes the decision out of the backfill's missing scan,
      // so landing a bounded projection is what stops the scan reselecting it.
      expect(projection?.headMatches).toBe(true);
      expect(projection?.tailMatches).toBe(false);
      expect(projection?.searchableText.length).toBeLessThan(
        OVERSIZED_FULLTEXT.length,
      );

      const passages = await db
        .select({ content: caseLawSearchDocumentPreviewPassages.content })
        .from(caseLawSearchDocumentPreviewPassages)
        .where(
          eq(caseLawSearchDocumentPreviewPassages.decisionId, oversizedId),
        );

      // Passages are cut from the whole text before the bound applies, so they
      // carry text the indexed prefix stops short of.
      expect(
        passages.some(({ content }) => content.includes(OVERSIZED_TAIL_TOKEN)),
      ).toBe(true);

      // Postgres refusing the whole text is what the bounded retry answers: a
      // row written without that refusal would prove nothing about the ceiling.
      const bounded = boundedWarnings(warn.mock.calls);
      expect(bounded).toHaveLength(1);
      expect(bounded.at(0)?.[1]).toMatchObject({
        decisionId: oversizedId,
        "error.cause.pg_code": "54000",
      });
    } finally {
      warn.mockRestore();
    }
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "the backfill indexes every missing decision and counts only the ones that landed",
  async () => {
    // More decisions than the backfill runs at once, so the count has to
    // survive results arriving from several in-flight operations.
    const indexable = Array.from({ length: 6 }, () =>
      createSafeId<"caseLawDecision">(),
    );
    const failing = createSafeId<"caseLawDecision">();
    await db.insert(caseLawDecisions).values([
      ...indexable.map((id, index) => ({
        caseNumber: `21 Cdo ${index + 1}/2022`,
        country: "CZE",
        court: "Nejvyšší soud",
        fulltext: `Rozhodnutí číslo ${index + 1}.`,
        id,
        language: "cs",
        sourceId,
      })),
      {
        caseNumber: "21 Cdo 99/2022",
        country: "CZE",
        court: "Nejvyšší soud",
        fulltext: "Rozhodnutí, které se nepodaří zaindexovat.",
        id: failing,
        language: "xx",
        sourceId,
      },
    ]);

    const failingConfig: typeof resolveConfig = async (language) => {
      if (language === "xx") {
        throw new Error("fts configuration unavailable");
      }
      return await resolveConfig(language);
    };
    const error = spyOn(logger, "error");
    try {
      const result = await backfillSearchIndex(scopedDb, 32, failingConfig);

      const projected = await db
        .select({ decisionId: caseLawSearchDocuments.decisionId })
        .from(caseLawSearchDocuments)
        .where(
          inArray(caseLawSearchDocuments.decisionId, [...indexable, failing]),
        );
      expect(new Set(projected.map(({ decisionId }) => decisionId))).toEqual(
        new Set(indexable),
      );
      expect(result.indexed).toBe(result.found - 1);
      expect(result.found).toBeGreaterThanOrEqual(indexable.length + 1);
      expect(
        error.mock.calls.filter(
          ([signature, fields]) =>
            signature === "case_law.search_index.backfill_failed" &&
            typeof fields === "object" &&
            fields !== null &&
            "decisionId" in fields &&
            fields.decisionId === failing,
        ),
      ).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  },
  DB_TEST_TIMEOUT_MS,
);
