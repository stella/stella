import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  ADAPTER_KEYS,
  IMPORT_SOURCE_KEYS,
} from "@/api/lib/legal-search/ingestion-constants";
import { isRecord } from "@/api/lib/type-guards";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { ABSORBED_INTO_METADATA_KEY } from "./decision-absorption";
import {
  caseLawFulltextHealthQuery,
  decisionTextHealthBreached,
  readCaseLawFulltextHealthTx,
} from "./fulltext-health";
import { fulltextPolicyForSource } from "./fulltext-source-policy";
import { failedDecisionText } from "./fulltext-state";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
const sourceId = createSafeId<"caseLawSource">();
const excludedSourceId = createSafeId<"caseLawSource">();
const importedSourceId = createSafeId<"caseLawSource">();
const now = new Date("2026-10-28T12:00:00.000Z");
const failure = failedDecisionText({
  now,
  attemptCount: 1,
  cause: { kind: "http", status: 503 },
  retryFloorMs: 0,
});
const read = async () =>
  await db.transaction(
    async (tx) => await readCaseLawFulltextHealthTx(asTestRaw<Transaction>(tx)),
  );
const findHealth = async (source: string) =>
  (await read()).find((health) => health.source === source) ??
  panic("Missing source health");

// timeout: constructing the isolated PGlite schema is a bounded local fixture operation.
beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(caseLawSources).values([
    {
      id: sourceId,
      adapterKey: ADAPTER_KEYS.CZ_NS,
      name: "Scheduled health source",
    },
    {
      id: excludedSourceId,
      adapterKey: ADAPTER_KEYS.CZ_NSS,
      name: "Disabled held source",
      enabled: false,
    },
    {
      id: importedSourceId,
      adapterKey: IMPORT_SOURCE_KEYS.COURTLISTENER,
      name: "Imported held source",
    },
  ]);
  // Untouched legacy nulls predate the new-write guard. This database belongs to this file.
  await db.execute(
    sql`ALTER TABLE case_law_decisions DISABLE TRIGGER case_law_decisions_text_state_guard`,
  );
  await db.execute(
    sql`ALTER TABLE case_law_decisions DROP CONSTRAINT case_law_decisions_text_state_valid`,
  );
}, 120_000);
afterAll(async () => {
  await client.close();
});

const insertFailures = async (count: number) =>
  await db.execute(sql`
  INSERT INTO ${caseLawDecisions} (id,source_id,country,court,language,case_number,source_hash,text_state)
  SELECT gen_random_uuid(), ${sourceId}, 'CZE','Court','cs', 'health-' || gen_random_uuid()::text, ${"a".repeat(64)}, ${JSON.stringify(failure)}::text::jsonb
  FROM generate_series(1, ${count})
`);

const indexRowsFromPlan = (value: unknown): number => {
  if (Array.isArray(value)) {
    return value.reduce((total, part) => total + indexRowsFromPlan(part), 0);
  }
  if (!isRecord(value)) {
    return 0;
  }
  let ownRows = 0;
  if (typeof value["Index Name"] === "string") {
    if (
      typeof value["Actual Rows"] !== "number" ||
      typeof value["Actual Loops"] !== "number"
    ) {
      return panic("Index plan lacks measured row counts");
    }
    ownRows = value["Actual Rows"] * value["Actual Loops"];
  }
  for (const part of Object.values(value)) {
    ownRows += indexRowsFromPlan(part);
  }
  return ownRows;
};
const measuredHealthIndexRows = async () =>
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_seqscan=off`);
    const query = caseLawFulltextHealthQuery([
      {
        id: sourceId,
        source: ADAPTER_KEYS.CZ_NS,
        failedThreshold: fulltextPolicyForSource(ADAPTER_KEYS.CZ_NS)
          .failedThreshold,
      },
    ]);
    return indexRowsFromPlan(
      executedRows(
        await tx.execute(sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`),
      ),
    );
  });

describe.serial(
  "bounded full-text health reads the actual eligible corpus",
  () => {
    test("empty scheduled, disabled and imported held corpora are healthy", async () => {
      const report = await read();
      expect(report).toHaveLength(3);
      expect(decisionTextHealthBreached(report)).toBe(false);
      expect(report.map(({ source }) => source).toSorted()).toEqual(
        [
          ADAPTER_KEYS.CZ_NS,
          ADAPTER_KEYS.CZ_NSS,
          IMPORT_SOURCE_KEYS.COURTLISTENER,
        ].toSorted(),
      );
    });
    test("erased and absorbed rows are excluded from missing and failed state probes", async () => {
      await db.insert(caseLawDecisions).values([
        {
          sourceId: excludedSourceId,
          country: "CZE",
          court: "Court",
          language: "cs",
          caseNumber: "erased",
          sourceHash: "a".repeat(64),
          redactedAt: now,
          textState: null,
        },
        {
          sourceId: excludedSourceId,
          country: "CZE",
          court: "Court",
          language: "cs",
          caseNumber: "absorbed-missing",
          sourceHash: "a".repeat(64),
          metadata: { [ABSORBED_INTO_METADATA_KEY]: "other-decision" },
          textState: null,
        },
        {
          sourceId: excludedSourceId,
          country: "CZE",
          court: "Court",
          language: "cs",
          caseNumber: "absorbed-failed",
          sourceHash: "a".repeat(64),
          metadata: { [ABSORBED_INTO_METADATA_KEY]: "other-decision" },
          textState: failure,
        },
      ]);
      expect(await findHealth(ADAPTER_KEYS.CZ_NSS)).toMatchObject({
        missingState: false,
        failed: { type: "exact", count: 0 },
      });
    });
    test("one untouched held state fails health even when the source is disabled or imported", async () => {
      await db.insert(caseLawDecisions).values([
        {
          sourceId: excludedSourceId,
          country: "CZE",
          court: "Court",
          language: "cs",
          caseNumber: "legacy",
          sourceHash: "a".repeat(64),
          textState: null,
        },
        {
          sourceId: importedSourceId,
          country: "CZE",
          court: "Court",
          language: "en",
          caseNumber: "legacy-import",
          sourceHash: "a".repeat(64),
          textState: null,
        },
      ]);
      expect(await findHealth(ADAPTER_KEYS.CZ_NSS)).toMatchObject({
        missingState: true,
      });
      expect(await findHealth(IMPORT_SOURCE_KEYS.COURTLISTENER)).toMatchObject({
        missingState: true,
      });
      expect(decisionTextHealthBreached(await read())).toBe(true);
    });
    test("failed growth is bounded at threshold plus one, with an explicit lower bound", async () => {
      const threshold = fulltextPolicyForSource(
        ADAPTER_KEYS.CZ_NS,
      ).failedThreshold;
      await insertFailures(threshold);
      expect(await findHealth(ADAPTER_KEYS.CZ_NS)).toMatchObject({
        failedThreshold: threshold,
        failed: { type: "exact", count: threshold },
      });
      await insertFailures(threshold);
      const atN = await findHealth(ADAPTER_KEYS.CZ_NS);
      expect(atN.failed).toEqual({ type: "at-least", count: threshold + 1 });
      const readsAtN = await measuredHealthIndexRows();
      expect(readsAtN).toBe(threshold + 1);
      await insertFailures(threshold * 18);
      expect(await findHealth(ADAPTER_KEYS.CZ_NS)).toEqual(atN);
      expect(await measuredHealthIndexRows()).toBe(readsAtN);
    });
    test("the actual catalog contains eligible partial indexes and EXPLAIN uses them under both probes", async () => {
      const indexes = executedRows(
        await db.execute(
          sql`SELECT indexname, indexdef FROM pg_indexes WHERE tablename='case_law_decisions' AND indexname IN ('case_law_decisions_text_state_missing_idx','case_law_decisions_text_state_failed_idx')`,
        ),
      );
      expect(indexes).toHaveLength(2);
      for (const index of indexes) {
        expect(index).toMatchObject({
          indexdef: expect.stringContaining("_stellaAbsorbedInto"),
        });
      }
      const query = caseLawFulltextHealthQuery([
        {
          id: sourceId,
          source: ADAPTER_KEYS.CZ_NS,
          failedThreshold: fulltextPolicyForSource(ADAPTER_KEYS.CZ_NS)
            .failedThreshold,
        },
      ]);
      const plans = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        return executedRows(
          await tx.execute(sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`),
        );
      });
      const plan = JSON.stringify(plans);
      expect(plan).toContain("case_law_decisions_text_state_missing_idx");
      expect(plan).toContain("case_law_decisions_text_state_failed_idx");
      expect(plan).not.toContain('"Node Type":"Seq Scan"');
    });
    test("unregistered source catalog entries fail loudly instead of disappearing", async () => {
      await db.insert(caseLawSources).values({
        adapterKey: "unregistered-health-fixture",
        name: "Unknown source",
      });
      expect(await rejectionOf(read())).toMatchObject({
        message: expect.stringContaining(
          "Unregistered full-text source policy",
        ),
      });
    });
  },
);
