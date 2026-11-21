import { sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { legalListVerificationRuns } from "@/api/db/schema";
import {
  VERIFICATION_PIPELINE_VERSION,
  VERIFICATION_RUN_ACTIVE_STATUSES,
} from "@/api/lib/lists/verification/contract";
import { startModelRun } from "@/api/lib/usage/model-run-caps/caps";
import type { ModelRunCaps } from "@/api/lib/usage/model-run-caps/config";

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
    | "scope"
    | "requestedBy"
  >;
  caps?: ModelRunCaps;
};

/** A verification is a `list-run`: the insert trigger locks and charges the
 *  organization's counter after the run row, and a refusal rolls back both.
 *  Answers `false` when the document already has a verification in flight. */
export const startVerificationRun = async ({
  safeDb,
  recordAuditEvent,
  run,
  caps,
}: StartVerificationRunArgs) =>
  await startModelRun({
    safeDb,
    kind: "list-run",
    operation: "lists.verifications.create",
    ...(caps === undefined ? {} : { caps }),
    start: async (tx) => {
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
    },
  });
