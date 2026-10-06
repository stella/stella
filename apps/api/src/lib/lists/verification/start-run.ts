import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { legalListVerificationRuns } from "@/api/db/schema";
import {
  VERIFICATION_PIPELINE_VERSION,
  VERIFICATION_RUN_ACTIVE_STATUSES,
} from "@/api/lib/lists/verification/contract";
import type { VerificationRunCaps } from "@/api/lib/lists/verification/run-cap-config";
import {
  getVerificationRunCaps,
  verificationCapErrorFromDatabase,
} from "@/api/lib/lists/verification/run-caps";

type StartVerificationRunArgs = {
  safeDb: SafeDb;
  recordAuditEvent: (tx: Transaction) => Promise<void>;
  run: Pick<
    typeof legalListVerificationRuns.$inferInsert,
    | "id"
    | "organizationId"
    | "workspaceId"
    | "entityId"
    | "fileFieldId"
    | "entityVersionId"
    | "contentSha256"
    | "evidence"
    | "requestedBy"
  >;
  caps?: VerificationRunCaps;
};

/** The insert trigger locks and charges the org row after the run row;
 * terminal transitions use the same lock order. Refusals roll back both. */
export const startVerificationRun = async ({
  safeDb,
  recordAuditEvent,
  run,
  caps = getVerificationRunCaps(),
}: StartVerificationRunArgs) => {
  const inserted = await safeDb(async (tx) => {
    await tx.execute(sql`SELECT
      set_config('app.list_verification_active_limit', ${String(caps.active)}, true),
      set_config('app.list_verification_daily_limit', ${String(caps.startsPerDay)}, true)`);
    const created = await tx
      .insert(legalListVerificationRuns)
      .values({
        ...run,
        status: "queued",
        pipelineVersion: VERIFICATION_PIPELINE_VERSION,
      })
      .onConflictDoNothing({
        target: [
          legalListVerificationRuns.workspaceId,
          legalListVerificationRuns.entityId,
          legalListVerificationRuns.fileFieldId,
        ],
        where: sql`${legalListVerificationRuns.status} IN (${sql.join(
          VERIFICATION_RUN_ACTIVE_STATUSES.map((status) =>
            sql.raw(`'${status}'`),
          ),
          sql`, `,
        )})`,
      })
      .returning({ id: legalListVerificationRuns.id });
    if (created.length === 0) {
      return false;
    }
    await recordAuditEvent(tx);
    return true;
  });
  return inserted.mapError(
    (error) => verificationCapErrorFromDatabase(error) ?? error,
  );
};
