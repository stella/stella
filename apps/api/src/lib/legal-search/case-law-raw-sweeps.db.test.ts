import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  liveLegacyReferenceQuery,
  sourceHasLiveLegacyReferences,
} from "@/api/lib/legal-search/case-law-raw-sweeps";
import {
  rawDocumentPrefix,
  RAW_SOURCE_FAMILY,
} from "@/api/lib/legal-search/raw-source-storage";
import { isRecord } from "@/api/lib/type-guards";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const DB_TEST_TIMEOUT_MS = 120_000;
const sourceId = createSafeId<"caseLawSource">();
const currentId = createSafeId<"caseLawDecision">();
const legacyId = createSafeId<"caseLawDecision">();
const redactedId = createSafeId<"caseLawDecision">();
const legacyKey = `${RAW_SOURCE_FAMILY.CASE_LAW}/raw/${sourceId}/${"a".repeat(64)}`;

let client: PGlite;
let db: ReturnType<typeof drizzle>;
type ReadTx = Parameters<typeof sourceHasLiveLegacyReferences>[0];
let readTx: ReadTx;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  // SAFETY: the probe uses the select surface provided by the embedded database.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- embedded database stands in for the root pool
  readTx = db as unknown as ReadTx;
  await db
    .insert(caseLawSources)
    .values(caseLawSourceRow({ id: sourceId, adapterKey: "raw-sweep-index" }));
  await db.insert(caseLawDecisions).values([
    {
      id: currentId,
      sourceId,
      caseNumber: "current",
      court: "Court",
      country: "CZE",
      language: "cs",
      sourceRawS3Key: `${rawDocumentPrefix({ family: RAW_SOURCE_FAMILY.CASE_LAW, sourceId, documentId: currentId })}payloads/${"b".repeat(64)}`,
    },
    {
      id: legacyId,
      sourceId,
      caseNumber: "legacy",
      court: "Court",
      country: "CZE",
      language: "cs",
      sourceRawS3Key: legacyKey,
    },
    {
      id: redactedId,
      sourceId,
      caseNumber: "redacted",
      court: "Court",
      country: "CZE",
      language: "cs",
      redactedAt: new Date("2026-09-28T00:00:00Z"),
      sourceRawS3Key: legacyKey,
    },
  ]);
}, DB_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
});

test(
  "source legacy probe seeks only live legacy pointers",
  async () => {
    expect(await sourceHasLiveLegacyReferences(readTx, { sourceId })).toBe(
      true,
    );
    expect(
      await sourceHasLiveLegacyReferences(readTx, {
        sourceId,
        exceptDecisionId: legacyId,
      }),
    ).toBe(false);

    await db
      .update(caseLawDecisions)
      .set({ sourceRawS3Key: null })
      .where(eq(caseLawDecisions.id, legacyId));
    expect(await sourceHasLiveLegacyReferences(readTx, { sourceId })).toBe(
      false,
    );

    const query = liveLegacyReferenceQuery(readTx, { sourceId }).toSQL();
    const plan = await client.transaction(async (tx) => {
      await tx.query("SET LOCAL enable_seqscan = off");
      await tx.query("SET LOCAL enable_bitmapscan = off");
      const explained = await tx.query(`EXPLAIN (COSTS OFF) ${query.sql}`, [
        ...query.params,
      ]);
      return explained.rows.map((row) => {
        const line = isRecord(row) ? row["QUERY PLAN"] : undefined;
        return typeof line === "string"
          ? line
          : panic("EXPLAIN row has no plan text");
      });
    });
    expect(plan.join("\n")).toContain(
      "case_law_decisions_live_legacy_raw_source_idx",
    );
  },
  DB_TEST_TIMEOUT_MS,
);
