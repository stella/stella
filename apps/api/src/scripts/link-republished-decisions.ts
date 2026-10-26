import { panic } from "better-result";

import { compareCodeUnit } from "@stll/collation";
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
 *   bun run src/scripts/link-republished-decisions.ts --apply --limit 5000 --until <iso-instant>
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
  selectRepublishedDecisionReport,
} from "@/api/scripts/link-republished-decisions-plan";
import { flagInteger } from "@/api/scripts/repair-flags";

await runScriptWithErrorOutput(async () => {
  const args = new Set(Bun.argv.slice(2));
  const apply = args.has("--apply");
  const reverse = args.has("--reverse");
  const dryRun = args.has("--dry-run") || (!apply && !reverse);
  const USAGE = `Usage: bun run src/scripts/link-republished-decisions.ts [--dry-run|--apply|--reverse] [--limit n] [--until ISO-8601]`;
  if (Number(apply) + Number(reverse) + Number(dryRun) !== 1) {
    panic(USAGE);
  }
  const limit = flagInteger({ fallback: 5000, name: "limit", usage: USAGE });
  const untilIndex = Bun.argv.indexOf("--until");
  const untilValue =
    untilIndex === -1 ? undefined : Bun.argv.at(untilIndex + 1);
  const until = untilValue === undefined ? undefined : new Date(untilValue);
  if (until !== undefined && Number.isNaN(until.getTime())) {
    panic(USAGE);
  }
  const { rootDb } = dryRun
    ? await openCaseLawReadOnlySession()
    : await enterCaseLawMaintenanceLane();

  const reconcile =
    (tx: Transaction) =>
    async (
      candidates: readonly RepublishedDecisionCandidate[],
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
      const reconciliations: Promise<void>[] = [];
      for (const candidate of candidates) {
        reconciliations.push(
          synchronize(candidate.canonical.id, false),
          synchronize(candidate.duplicate.id, direction === "apply"),
        );
      }
      await Promise.all(reconciliations);
    };

  if (reverse) {
    const outcomes = await withAggregateTransaction(
      rootDb,
      async (tx) =>
        await reverseRepublishedDecisionBatch(tx, limit, reconcile(tx)),
    );
    const reversed = outcomes.filter(({ type }) => type === "reversed").length;
    const refusedErased = outcomes.filter(
      ({ type }) => type === "refused_erased",
    ).length;
    const refusedUnrestorable = outcomes.filter(
      ({ type }) => type === "refused_unrestorable",
    ).length;
    console.info(`reversed=${String(reversed)}`);
    console.info(`refused_erased=${String(refusedErased)}`);
    console.info(`refused_unrestorable=${String(refusedUnrestorable)}`);
    return;
  }

  const candidates = await selectRepublishedDecisionCandidates(
    rootDb,
    limit,
    until,
  );
  const before = await selectRepublishedDecisionReport(rootDb);
  console.info("outcome linked", before.outcomes.linked);
  console.info(
    "outcome separate_alias_group_survivor",
    before.outcomes.separateAliasGroupSurvivor,
  );
  console.info(
    "outcome separate_already_retired",
    before.outcomes.separateAlreadyRetired,
  );
  console.info(
    "outcome separate_partial/date_absent",
    before.outcomes.separatePartial.dateAbsent,
  );
  console.info(
    "outcome separate_partial/type_absent",
    before.outcomes.separatePartial.typeAbsent,
  );
  console.info(
    "outcome separate_partial/signature_absent",
    before.outcomes.separatePartial.signatureAbsent,
  );
  console.info(
    "outcome separate_partial/date_differs",
    before.outcomes.separatePartial.dateDiffers,
  );
  console.info(
    "outcome separate_partial/type_differs",
    before.outcomes.separatePartial.typeDiffers,
  );
  console.info("outcome separate_ambiguous", before.outcomes.separateAmbiguous);
  if (dryRun) {
    for (const [source, count] of [...before.bySource].toSorted(
      ([left], [right]) => compareCodeUnit(left, right),
    )) {
      console.info(
        `source ${source} before=${String(count)} after=${String(count)}`,
      );
    }
    return;
  }
  const outcomes = await withAggregateTransaction(
    rootDb,
    async (tx) =>
      await applyRepublishedDecisionBatch(tx, candidates, reconcile(tx)),
  );
  const after = await selectRepublishedDecisionReport(rootDb);
  const sources = new Set([
    ...before.bySource.keys(),
    ...after.bySource.keys(),
  ]);
  for (const source of [...sources].toSorted()) {
    console.info(
      `source ${source} before=${String(before.bySource.get(source) ?? 0)} after=${String(after.bySource.get(source) ?? 0)}`,
    );
  }
  console.info(
    `linked=${String(outcomes.filter(({ type }) => type === "linked").length)}`,
  );
  console.info(
    `separate_alias_group_survivor=${String(outcomes.filter(({ type }) => type === "separate_alias_group_survivor").length)}`,
  );
  console.info(
    `separate_already_retired=${String(outcomes.filter(({ type }) => type === "separate_already_retired").length)}`,
  );
});
