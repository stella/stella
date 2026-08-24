/**
 * Durable typed-identifier rollout.
 *
 * Deploy the checkpoint migration and the exact-writing ingestion release
 * first. Then run `db:backfill-decision-identifiers`; restarts resume from the
 * last committed page. Run `db:verify-decision-identifiers` after the citation
 * resolver drains. Only a `ready-for-cutover` receipt permits removal of the
 * legacy resolver bridge, in a later release.
 */

import { panic } from "better-result";

import {
  runDecisionIdentifierBackfill,
  verifyDecisionIdentifierBackfill,
} from "@/api/handlers/case-law/ingestion/decision-identifier-backfill";
import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";

const APPLY_MODE = "--apply";
const VERIFY_MODE = "--verify";
const BATCH_PREFIX = "--batch=";

const args = process.argv.slice(2);
const modeArgs = args.filter(
  (argument) => argument === APPLY_MODE || argument === VERIFY_MODE,
);
if (modeArgs.length !== 1) {
  panic("Pass exactly one of --apply or --verify");
}
const unsupported = args.filter(
  (argument) =>
    argument !== APPLY_MODE &&
    argument !== VERIFY_MODE &&
    !argument.startsWith(BATCH_PREFIX),
);
if (unsupported.length > 0) {
  panic(`Unsupported argument: ${unsupported.at(0)}`);
}
const batchArgs = args.filter((argument) => argument.startsWith(BATCH_PREFIX));
if (batchArgs.length > 1) {
  panic("Pass at most one --batch=<size> argument");
}
const batchArg = batchArgs.at(0);
const batchSize = batchArg?.slice(BATCH_PREFIX.length);
const requestedBatchSize =
  batchSize === undefined ? undefined : Number(batchSize);

if (modeArgs.at(0) === APPLY_MODE) {
  const { release, rootDb } = await enterCaseLawMaintenanceLane();
  const result = await runDecisionIdentifierBackfill(rootDb, {
    ...(requestedBatchSize === undefined
      ? {}
      : { batchSize: requestedBatchSize }),
    onProgress: (progress) => console.log(JSON.stringify(progress)),
  });
  console.log(JSON.stringify(result, null, 2));
  await release();
  process.exit(0);
}

const { rootDb } = await openCaseLawReadOnlySession();
const verification = await verifyDecisionIdentifierBackfill(
  rootDb,
  requestedBatchSize,
);
console.log(JSON.stringify(verification, null, 2));
process.exit(verification.status === "ready-for-cutover" ? 0 : 2);
