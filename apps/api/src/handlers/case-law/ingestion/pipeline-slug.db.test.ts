import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { createCaseLawDecisionSlug } from "@stll/api-contract/case-law-decision-route";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources, relations } from "@/api/db/schema";
import {
  CASE_LAW_DECISION_SLUG_ALLOCATION_ATTEMPTS,
  createCaseLawDecisionSlugCandidate,
} from "@/api/handlers/case-law/decisions/slug";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { plainTextIngestionResult } from "@/api/handlers/case-law/ingestion/adapters/plain-text-assembly";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { toSafeId } from "@/api/lib/branded-types";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import { logger } from "@/api/lib/observability/logger";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;

// Fixed, because a collision candidate is derived from the source identity:
// the golden slugs below hold only for this source id.
const sourceId = toSafeId<"caseLawSource">(
  "01920000-0000-7000-8000-00000000510a",
);

const decisionAt = (
  caseNumber: string,
  sourceDocumentId: string | undefined,
  language = "sk",
): IngestionResult =>
  plainTextIngestionResult({
    caseNumber,
    sourceDocumentId,
    court: "Okresný súd Prievidza",
    country: "SVK",
    language,
    decisionDate: "2019-05-14",
    decisionType: "rozsudok",
    fulltext: `Rozsudok ${caseNumber} ${sourceDocumentId ?? language}`,
    metadata: {},
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    rawHash: `hash-${caseNumber}-${sourceDocumentId ?? language}`,
    documentAst: EMPTY_AST,
  });

type TransactionLog = { started: number; failures: unknown[] };

/** A scoped db that counts its transactions and keeps every one that failed. */
const recordingDb = (
  log: TransactionLog,
  beforeTransaction?: (started: number) => Promise<void>,
): ScopedDb => {
  const recording: ScopedDb = async (work) => {
    log.started += 1;
    await beforeTransaction?.(log.started);
    try {
      return await scopedDb(work);
    } catch (error) {
      log.failures.push(error);
      throw error;
    }
  };
  return recording;
};

const newLog = (): TransactionLog => ({ started: 0, failures: [] });

const ingest = async (input: IngestionResult, scoped: ScopedDb = scopedDb) =>
  await processDecision({
    input,
    observationOrder: 1n,
    sourceId,
    scopedDb: scoped,
    observedAt: new Date("2026-07-31T12:00:00.000Z"),
  });

const storedSlug = async (
  where: SQL | undefined,
): Promise<string | null | undefined> =>
  (
    await db
      .select({ slug: caseLawDecisions.slug })
      .from(caseLawDecisions)
      .where(and(eq(caseLawDecisions.sourceId, sourceId), where))
  ).at(0)?.slug;

const slugOfDocument = async (sourceDocumentId: string) =>
  await storedSlug(eq(caseLawDecisions.sourceDocumentId, sourceDocumentId));

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client, relations: { ...relations, ...authRelationsPart } });
  scopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));

  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: "slug-allocation-test",
    name: "Slug allocation test",
    enabled: false,
  });
});

afterAll(async () => {
  await client.close();
});

describe("case-law decision slug allocation", () => {
  test("a colliding base slug takes the same candidate in the one row write", async () => {
    const free = newLog();
    await ingest(decisionAt("1C/7/2020", "free-a"), recordingDb(free));
    expect(await slugOfDocument("free-a")).toBe("1c-7-2020");

    const colliding = newLog();
    await ingest(decisionAt("1C/7/2020", "free-b"), recordingDb(colliding));

    expect(await slugOfDocument("free-b")).toBe(
      createCaseLawDecisionSlugCandidate({
        baseSlug: "1c-7-2020",
        identity: `${sourceId}\u0000document\u0000free-b`,
        attempt: 1,
      }),
    );
    // No write was abandoned for a taken slug: the collision costs no more
    // transactions than an insert that met none.
    expect(colliding.failures).toEqual([]);
    expect(colliding.started).toBe(free.started);
  });

  test("keeps the slugs the retrying allocation stored", async () => {
    // Computed with the allocation that retried the whole row write per
    // candidate; the ladder and its inputs are unchanged.
    await ingest(decisionAt("0T/42/2019", "golden-1"));
    await ingest(decisionAt("0T/42/2019", "golden-2"));
    await ingest(decisionAt("0T/42/2019", "golden-3"));
    // No publisher id: the identity is the docket and language.
    await ingest(decisionAt("0T/42/2019", undefined, "cs"));
    await ingest(decisionAt("Nds 12/2021 – č. 4", "golden-4"));
    await ingest(decisionAt("NDS-12-2021-C-4", "golden-5"));

    expect({
      "golden-1": await slugOfDocument("golden-1"),
      "golden-2": await slugOfDocument("golden-2"),
      "golden-3": await slugOfDocument("golden-3"),
      "cs-docket": await storedSlug(
        and(
          eq(caseLawDecisions.caseNumber, "0T/42/2019"),
          eq(caseLawDecisions.language, "cs"),
        ),
      ),
      "golden-4": await slugOfDocument("golden-4"),
      "golden-5": await slugOfDocument("golden-5"),
    }).toEqual({
      "golden-1": "0t-42-2019",
      "golden-2": "0t-42-2019-482dd3cda1eb1de8",
      "golden-3": "0t-42-2019-31499a06d7f572d0",
      "cs-docket": "0t-42-2019-5246e47db421409f",
      "golden-4": "nds-12-2021-c-4",
      "golden-5": "nds-12-2021-c-4-311d08e9361bdc6e",
    });
  });

  // PGlite serializes the two transactions; the Postgres-gated identity suite
  // runs the same race on concurrent connections.
  test("decisions racing for one base slug both land on distinct deterministic slugs", async () => {
    const log = newLog();
    const racing = recordingDb(log);
    await Promise.all([
      ingest(decisionAt("2Co/9/2022", "race-a"), racing),
      ingest(decisionAt("2Co/9/2022", "race-b"), racing),
    ]);

    const candidate = (publisherId: string) =>
      createCaseLawDecisionSlugCandidate({
        baseSlug: "2co-9-2022",
        identity: `${sourceId}\u0000document\u0000${publisherId}`,
        attempt: 1,
      });
    const slugA = await slugOfDocument("race-a");
    const slugB = await slugOfDocument("race-b");
    expect([slugA, slugB]).toEqual(
      slugA === "2co-9-2022"
        ? ["2co-9-2022", candidate("race-b")]
        : [candidate("race-a"), "2co-9-2022"],
    );
    expect(log.failures).toEqual([]);
  });

  test("a publisher identity taken by a concurrent insert still fails the row write", async () => {
    const publisherId = "identity-race";
    const probe = newLog();
    await ingest(decisionAt("3T/5/2023", "identity-probe"), recordingDb(probe));
    // The row write is the last transaction of an insert that met nothing.
    const rowWriteTransaction = probe.started;

    const log = newLog();
    const racing = recordingDb(log, async (started) => {
      if (started !== rowWriteTransaction) {
        return;
      }
      // The same publisher id, stored by another worker between this
      // attempt's read and its row write, under a slug of its own.
      await db
        .update(caseLawDecisions)
        .set({ sourceDocumentId: publisherId, slug: "identity-race-winner" })
        .where(
          and(
            eq(caseLawDecisions.sourceId, sourceId),
            eq(caseLawDecisions.sourceDocumentId, "identity-probe"),
          ),
        );
    });

    const outcome = await ingest(decisionAt("3T/5/2023", publisherId), racing);

    expect(log.failures).toHaveLength(1);
    expect(
      isPgConstraintError(
        log.failures.at(0),
        PG_ERROR.UNIQUE_VIOLATION,
        "case_law_decisions_source_document_idx",
      ),
    ).toBe(true);
    // Reconciled as contention: the second attempt finds and refreshes the
    // stored row rather than inserting a second one.
    expect(outcome).toEqual({
      status: "complete",
      inserted: false,
      searchVectorFailed: false,
    });
    const rows = await db
      .select({ slug: caseLawDecisions.slug })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.sourceId, sourceId),
          eq(caseLawDecisions.sourceDocumentId, publisherId),
        ),
      );
    expect(rows).toEqual([{ slug: "identity-race-winner" }]);
  });

  test("a docket whose every candidate is taken logs once and halts as before", async () => {
    const caseNumber = "4Cdo/1/2024";
    const baseSlug = createCaseLawDecisionSlug(caseNumber);
    const identity = `${sourceId}\u0000document\u0000exhausted`;
    const taken = CASE_LAW_DECISION_SLUG_ALLOCATION_ATTEMPTS;
    // Every candidate the ladder would try, held by another decision.
    await Promise.all(
      taken.map(async (attempt) => {
        const occupant = `occupant-${String(attempt)}`;
        await ingest(decisionAt(`occupant/${occupant}`, occupant));
        await db
          .update(caseLawDecisions)
          .set({
            slug: createCaseLawDecisionSlugCandidate({
              baseSlug,
              identity,
              attempt,
            }),
          })
          .where(
            and(
              eq(caseLawDecisions.sourceId, sourceId),
              eq(caseLawDecisions.sourceDocumentId, occupant),
            ),
          );
      }),
    );

    const warn = spyOn(logger, "warn");
    try {
      const log = newLog();
      const outcome = await ingest(
        decisionAt(caseNumber, "exhausted"),
        recordingDb(log),
      ).then(
        (value) => ({ settled: "resolved" as const, value }),
        (error: unknown) => ({ settled: "rejected" as const, error }),
      );

      expect(outcome.settled).toBe("rejected");
      expect(
        outcome.settled === "rejected" &&
          isPgConstraintError(
            outcome.error,
            PG_ERROR.UNIQUE_VIOLATION,
            "case_law_decisions_slug_uidx",
          ),
      ).toBe(true);
      expect(await slugOfDocument("exhausted")).toBeUndefined();

      const exhausted = warn.mock.calls.filter(
        ([event]) => event === "case_law.ingestion.slug_candidates_exhausted",
      );
      expect(exhausted).toEqual([
        [
          "case_law.ingestion.slug_candidates_exhausted",
          { sourceId, baseSlug, attempts: taken.length },
        ],
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});
