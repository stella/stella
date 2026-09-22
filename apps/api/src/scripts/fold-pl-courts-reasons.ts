/**
 * Fold the reasons documents SAOS publishes apart from their rulings, which
 * were stored as decisions of their own, into the judgments they belong to.
 *
 *   # one bounded pass
 *   bun run src/scripts/fold-pl-courts-reasons.ts --budget=500
 *
 *   # resume after the row an interrupted pass reported
 *   bun run src/scripts/fold-pl-courts-reasons.ts --budget=500 --after=<id>
 *
 * Each row's stored payload is re-parsed and placed by the path a crawl
 * takes: composed into its judgment, whose citations are then extracted over
 * the whole document, with the old row absorbed; or kept as standalone
 * reasons, retyped, while no stored ruling is its judgment. No publisher
 * request is made. A folded row leaves the selection, so passes resume by
 * running again; run until one visits nothing.
 *
 * Not a scheduled job and not a migration: it rewrites judgments, so it runs
 * under an operator who reads the report.
 */

import { Result } from "better-result";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  PL_COURTS_PRE_SUPPLEMENT_REASONS_DECISION_TYPE,
  plCourtsAdapter,
} from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { foldStoredSupplements } from "@/api/handlers/case-law/ingestion/supplement-fold";
import type { SupplementFoldReport } from "@/api/handlers/case-law/ingestion/supplement-fold";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import { runCaseLawSourceBackfill } from "@/api/scripts/case-law-source-backfill";

const AFTER_PREFIX = "--after=";
const DEFAULT_ROWS_PER_PASS = 200;
const PAGE_SIZE = 25;

const argv = process.argv.slice(2);
const afterArgument = argv
  .find((argument) => argument.startsWith(AFTER_PREFIX))
  ?.slice(AFTER_PREFIX.length);

await runCaseLawSourceBackfill<
  SupplementFoldReport,
  { message: string; report: SupplementFoldReport }
>({
  adapterKey: ADAPTER_KEYS.PL_COURTS,
  argv,
  run: async ({
    requestBudget,
    scopedDb,
    sourceId,
    sourceLease,
    readStoredRaw,
  }) => {
    const report = await foldStoredSupplements({
      scopedDb,
      sourceId,
      adapter: plCourtsAdapter,
      readStoredRaw,
      sourceLease,
      decisionTypes: [PL_COURTS_PRE_SUPPLEMENT_REASONS_DECISION_TYPE],
      limit: requestBudget ?? DEFAULT_ROWS_PER_PASS,
      pageSize: PAGE_SIZE,
      after:
        afterArgument === undefined
          ? null
          : brandPersistedCaseLawDecisionId(afterArgument),
    });
    return report.haltReason === null
      ? Result.ok(report)
      : Result.err({ message: report.haltReason, report });
  },
});
