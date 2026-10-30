import { panic } from "better-result";
import { expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import type { ProcessResult } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { applyStoredDecisionBackfill } from "@/api/handlers/case-law/ingestion/pipeline/stored-decision-backfill";
import { createSafeId } from "@/api/lib/branded-types";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { EMPTY_AST } from "@/api/lib/legal-search/document-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";

const BACKFILL_OUTCOMES = [
  {
    name: "persisted output",
    outcome: { status: "complete", inserted: true, searchVectorFailed: false },
    expected: { applied: 6, deferred: 7 },
  },
  {
    name: "a terminal superseded row",
    outcome: { status: "complete", inserted: false, searchVectorFailed: false },
    expected: { applied: 5, deferred: 7 },
  },
  {
    name: "a retryable raw write",
    outcome: {
      status: "retryable",
      inserted: false,
      reason: "source-raw-write",
    },
    expected: { applied: 5, deferred: 8 },
  },
  {
    name: "a retryable corpus settlement",
    outcome: { status: "retryable", inserted: true, reason: "corpus-write" },
    expected: { applied: 5, deferred: 8 },
  },
] as const satisfies readonly {
  name: string;
  outcome: ProcessResult;
  expected: { applied: number; deferred: number };
}[];

test.each(BACKFILL_OUTCOMES)(
  "backfill reports $name without losing its leased input identity",
  async ({ outcome, expected }) => {
    for (const sourceHash of [null, "stored-crawl-hash"]) {
      const events: string[] = [];
      const report = { applied: 5, deferred: 7 };
      const source = caseLawSourceRow();
      const row = {
        id: createSafeId<"caseLawDecision">(),
        sourceHash,
        sourceRawS3Key: "raw/captured-input",
      };
      const scopedDb = (async () =>
        panic(
          "The injected backfill boundaries own database access",
        )) satisfies ScopedDb;
      const sourceLease = {
        source,
        purpose: "ingestion",
        leaseToken: createSafeId<"caseLawSourceIngestionLease">(),
        beforeDatabaseMark: async () => {
          events.push("lease");
        },
        beforeRemoteEffect: async (effect) => await effect(),
        release: async () => undefined,
      } satisfies CaseLawSourceIngestionLease;
      const result = plainTextIngestionResult({
        caseNumber: "1 C 1/2026",
        court: "Test court",
        country: "CZE",
        language: "cs",
        fulltext: "Stored decision.",
        documentAst: EMPTY_AST,
        metadata: {},
        textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
        rawHash: "reparsed-hash",
      });
      await applyStoredDecisionBackfill(
        { report, row, result, sourceId: source.id, scopedDb, sourceLease },
        {
          allocateObservationOrder: async (options) => {
            events.push("order");
            expect(options).toEqual({
              leaseToken: sourceLease.leaseToken,
              scopedDb,
              sourceId: source.id,
            });
            return 2n;
          },
          processDecision: async (options) => {
            events.push("persist");
            expect(options).toMatchObject({
              decisionId: row.id,
              sourceId: source.id,
              sourceRawS3Key: row.sourceRawS3Key,
              observationOrder: 2n,
              input: { rawHash: sourceHash ?? result.rawHash },
            });
            return outcome;
          },
        },
      );
      expect(events).toEqual(["lease", "order", "persist"]);
      expect(report).toEqual(expected);
    }
  },
);
