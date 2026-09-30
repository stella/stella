import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  caseLawTextRetentionVerdicts,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { ORACLE_VERSION } from "@/api/lib/legal-search/text-retention/types";
import { EXCLUSION_VERSION } from "@/api/lib/legal-search/text-retention/validation";
import type { PayloadAssessment } from "@/api/lib/legal-search/text-retention/validation";
import {
  readRetentionVerdictTx,
  writeRetentionVerdictTx,
} from "@/api/lib/legal-search/text-retention/verdict-storage";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { loadValidationSnapshot } from "./validation-snapshot";
import { certifyUnchangedDecision } from "./verdict-transition";

const DB_TEST_TIMEOUT_MS = 120_000;
const sourceId = createSafeId<"caseLawSource">();
let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
const scopedDb = async <T>(run: (tx: Transaction) => Promise<T>): Promise<T> =>
  await db.transaction(async (tx) => await run(asTestRaw<Transaction>(tx)));

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db
    .insert(caseLawSources)
    .values(
      caseLawSourceRow({ id: sourceId, adapterKey: "verdict-transition" }),
    );
}, DB_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
});

const assessmentWith = (verdict: PayloadAssessment["verdict"]) =>
  ({
    rawFingerprint: "a".repeat(64),
    payloadFingerprint: "b".repeat(64),
    compositionFingerprint: "c".repeat(64),
    components: [],
    parserVersion: 1,
    oracleVersion: ORACLE_VERSION,
    exclusionVersion: EXCLUSION_VERSION,
    verdict,
  }) satisfies PayloadAssessment;

const validAssessment = () =>
  assessmentWith({
    status: "assessed",
    oracleVersion: ORACLE_VERSION,
    retainedRatio: 1,
    defect: null,
    missingWords: 0,
    missingCharacters: 0,
    missingSampleHash: null,
  });

const createDecision = async () => {
  const decisionId = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    id: decisionId,
    sourceId,
    caseNumber: decisionId,
    court: "Court",
    country: "CZE",
    language: "cs",
    fulltext: "Retained judgment text.",
    parserVersion: 1,
    contentHash: "b".repeat(64),
    sourceHash: "d".repeat(64),
    sourceObservationOrder: 10n,
    sourceRawS3Key: `case_law/raw/${sourceId}/${decisionId}`,
    sourceRawContentType: "text/html",
  });
  const snapshot = await loadValidationSnapshot({ scopedDb, decisionId });
  if (snapshot === null) {
    return panic("Inserted decision snapshot exists");
  }
  return { decisionId, snapshot };
};

const decisionRow = async (decisionId: SafeId<"caseLawDecision">) =>
  (
    await db
      .select()
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, decisionId))
      .limit(1)
  ).at(0) ?? panic("Inserted decision exists");

const storeAssessment = async ({
  decisionId,
  assessment,
}: {
  decisionId: SafeId<"caseLawDecision">;
  assessment: PayloadAssessment;
}) => {
  const row = await decisionRow(decisionId);
  await scopedDb(
    async (tx) =>
      await writeRetentionVerdictTx(tx, {
        decisionId,
        sourceId,
        sourceHash: row.sourceHash,
        rawS3Key: row.sourceRawS3Key,
        assessment,
      }),
  );
};

const storedVerdict = async (decisionId: SafeId<"caseLawDecision">) =>
  await scopedDb(async (tx) => await readRetentionVerdictTx(tx, decisionId));

test(
  "certifying an identical persisted payload changes only its verdict",
  async () => {
    const { decisionId, snapshot } = await createDecision();
    const before = await decisionRow(decisionId);
    expect(await storedVerdict(decisionId)).toBeNull();
    expect(
      await certifyUnchangedDecision({
        scopedDb,
        decisionId,
        assessed: { snapshot, assessment: validAssessment() },
      }),
    ).toBe(true);
    expect(await decisionRow(decisionId)).toEqual(before);
    expect(await storedVerdict(decisionId)).toMatchObject({
      decisionId,
      sourceId,
      sourceHash: before.sourceHash,
      rawS3Key: before.sourceRawS3Key,
      status: "assessed",
      retainedRatio: 1,
      defect: null,
      reason: null,
      payloadFingerprint: snapshot.row.contentHash,
    });
  },
  DB_TEST_TIMEOUT_MS,
);

test.each(["source_order", "raw_replacement", "redaction"] as const)(
  "lost validation CAS after %s preserves the winner's verdict",
  async (mutation) => {
    const { decisionId, snapshot } = await createDecision();
    await storeAssessment({ decisionId, assessment: validAssessment() });
    const previousVerdict = await storedVerdict(decisionId);
    const before = await decisionRow(decisionId);
    // Preserve updated_at to exercise each identity predicate independently of the timestamp fence.
    switch (mutation) {
      case "source_order":
        await db.execute(
          sql`UPDATE ${caseLawDecisions} SET source_observation_order = 11 WHERE id = ${decisionId}`,
        );
        break;
      case "raw_replacement":
        await db.execute(
          sql`UPDATE ${caseLawDecisions} SET source_raw_s3_key = 'replacement/raw' WHERE id = ${decisionId}`,
        );
        break;
      case "redaction":
        await db.transaction(async (tx) => {
          await tx.execute(sql`UPDATE ${caseLawDecisions} SET
            redacted_at = now(), fulltext = NULL, sections = NULL,
            document_ast = NULL, source_raw = NULL, source_raw_s3_key = NULL,
            source_raw_content_type = NULL, text_s3_key = NULL, ast_s3_key = NULL,
            normalized_s3_key = NULL, content_hash = NULL,
            metadata = '{}'::jsonb
            WHERE id = ${decisionId}`);
          await tx
            .delete(caseLawTextRetentionVerdicts)
            .where(eq(caseLawTextRetentionVerdicts.decisionId, decisionId));
        });
        break;
      default:
        mutation satisfies never;
        panic("Unhandled CAS mutation");
    }
    const winner = await decisionRow(decisionId);
    expect(winner.updatedAt).toEqual(before.updatedAt);
    expect(winner).not.toEqual(before);
    const staleAssessment = assessmentWith({
      status: "unavailable",
      reason: "raw_mismatch",
    });
    expect(
      await certifyUnchangedDecision({
        scopedDb,
        decisionId,
        assessed: { snapshot, assessment: staleAssessment },
      }),
    ).toBe(false);
    expect(await storedVerdict(decisionId)).toEqual(
      mutation === "redaction" ? null : previousVerdict,
    );
    expect(await decisionRow(decisionId)).toEqual(winner);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "verdict upserts clear fields from the previous assessment status",
  async () => {
    const { decisionId } = await createDecision();
    const defective = assessmentWith({
      status: "assessed",
      oracleVersion: ORACLE_VERSION,
      retainedRatio: 0.5,
      defect: "text_loss_suspected",
      missingWords: 1,
      missingCharacters: 7,
      missingSampleHash: "e".repeat(64),
    });
    for (const terminal of [
      { status: "unavailable", reason: "no_raw" },
      { status: "empty_source", oracleVersion: ORACLE_VERSION },
    ] as const satisfies readonly PayloadAssessment["verdict"][]) {
      await storeAssessment({ decisionId, assessment: defective });
      expect(await storedVerdict(decisionId)).toMatchObject({
        retainedRatio: 0.5,
        defect: "text_loss_suspected",
        missingSampleHash: "e".repeat(64),
      });
      await storeAssessment({
        decisionId,
        assessment: assessmentWith(terminal),
      });
      expect(await storedVerdict(decisionId)).toMatchObject({
        status: terminal.status,
        retainedRatio: null,
        defect: null,
        missingSampleHash: null,
        reason: terminal.status === "unavailable" ? terminal.reason : null,
      });
      await storeAssessment({ decisionId, assessment: validAssessment() });
      expect(await storedVerdict(decisionId)).toMatchObject({
        status: "assessed",
        retainedRatio: 1,
        defect: null,
        reason: null,
        missingSampleHash: null,
      });
    }
  },
  DB_TEST_TIMEOUT_MS,
);
