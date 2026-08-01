import { Result, panic } from "better-result";

import { rootDb } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { reconcileCaseLawCorpusUploadIntents } from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const RECONCILE_CASE_LAW_CORPUS_UPLOAD_INTENTS_TASK =
  "caseLaw.reconcileCorpusUploadIntents" as const;

const CLEANUP_LIMIT = 50;

const rootSafeDb: SafeDb = async (run) =>
  await Result.tryPromise(async () => await rootDb.transaction(run));

/** Drain exact corpus-object cleanup work left by cancelled uploads. */
export const reconcileCaseLawCorpusUploadIntentsTask: SchedulerTask = async ({
  logger,
  signal,
}) => {
  if (signal.aborted) {
    return panic("SchedulerAborted");
  }
  const result = await reconcileCaseLawCorpusUploadIntents({
    limit: CLEANUP_LIMIT,
    safeDb: rootSafeDb,
    signal,
  });
  logger.info("scheduler.case_law_corpus_upload_intents_reconciled", {
    "caseLawCorpusUploadIntents.claimed": result.claimed,
    "caseLawCorpusUploadIntents.cleaned": result.cleaned,
  });
};
