import { panic } from "better-result";

import { runScriptWithErrorOutput } from "@stll/errors/script-error";
/**
 * Link exact republished rulings already stored as separate decisions.
 *
 * This is never run by a pull request or deployment. Run it only with explicit
 * owner approval: first against a restored production snapshot, record counts
 * before and after per source and outcome, and prove `--reverse` there. Only
 * then may the same reviewed invocation run in production. Dry-run is the
 * default and writes nothing; apply and reverse use resumable bounded batches.
 *
 *   bun run src/scripts/link-republished-decisions.ts --dry-run
 *   bun run src/scripts/link-republished-decisions.ts --apply --limit 5000
 *   bun run src/scripts/link-republished-decisions.ts --reverse --limit 5000
 */

import type { Transaction } from "@/api/db/root";
import type { SafeId } from "@/api/lib/branded-types";
import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import {
  lockActiveCorpusProjectionSourceTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
  synchronizeRetiredCaseLawProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  applyRepublishedDecisionBatch,
  type RepublishedDecisionCandidate,
  reverseRepublishedDecisionBatch,
  selectRepublishedDecisionCandidates,
} from "@/api/scripts/link-republished-decisions-plan";
import { flagInteger } from "@/api/scripts/repair-flags";

await runScriptWithErrorOutput(async () => {
  const args = new Set(Bun.argv.slice(2));
  const apply = args.has("--apply");
  const reverse = args.has("--reverse");
  const dryRun = args.has("--dry-run") || (!apply && !reverse);
  const USAGE = `Usage: bun run src/scripts/link-republished-decisions.ts [--dry-run|--apply|--reverse] [--limit n]`;
  if (Number(apply) + Number(reverse) + Number(dryRun) !== 1) {
    panic(USAGE);
  }
  const limit = flagInteger({ fallback: 5000, name: "limit", usage: USAGE });
  const { rootDb } = dryRun
    ? await openCaseLawReadOnlySession()
    : await enterCaseLawMaintenanceLane();

  const reconcile =
    (tx: Transaction) =>
    async (
      candidate: RepublishedDecisionCandidate,
      direction: "apply" | "reverse",
    ): Promise<void> => {
      const synchronize = async (
        id: SafeId<"caseLawDecision">,
        retired: boolean,
      ): Promise<void> => {
        const subject = { family: "case_law", entityId: id } as const;
        const lock = await lockActiveCorpusProjectionSourceTx(tx, subject);
        if (lock === null) {
          return;
        }
        if (retired) {
          await synchronizeRetiredCaseLawProjectionDesiredStateTx(tx, {
            lock,
            subject,
          });
          return;
        }
        await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
          lock,
          subject,
        });
      };
      await synchronize(candidate.canonical.id, false);
      await synchronize(candidate.duplicate.id, direction === "apply");
    };

  if (reverse) {
    const reversed = await withAggregateTransaction(
      rootDb,
      async (tx) =>
        await reverseRepublishedDecisionBatch(tx, limit, reconcile(tx)),
    );
    console.info(`reversed=${String(reversed)}`);
    return;
  }

  const candidates = await selectRepublishedDecisionCandidates(rootDb, limit);
  const bySource = new Map<string, number>();
  for (const { duplicate } of candidates) {
    bySource.set(
      duplicate.adapterKey,
      (bySource.get(duplicate.adapterKey) ?? 0) + 1,
    );
  }
  console.info("outcome linked", candidates.length);
  console.info("outcome separate_partial/date_absent 0");
  console.info("outcome separate_partial/type_absent 0");
  console.info("outcome separate_partial/date_differs 0");
  console.info("outcome separate_partial/type_differs 0");
  console.info("outcome separate_ambiguous 0");
  for (const [source, count] of [...bySource].toSorted()) {
    console.info(
      `source ${source} before=${String(count)} after=${apply ? "0" : String(count)}`,
    );
  }
  if (dryRun) {
    return;
  }
  const linked = await withAggregateTransaction(
    rootDb,
    async (tx) =>
      await applyRepublishedDecisionBatch(tx, candidates, reconcile(tx)),
  );
  console.info(`linked=${String(linked)}`);
});
