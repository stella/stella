import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  legalListClaims,
  legalListVerificationBlocks,
  legalListVerificationRuns,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { VerificationBlock } from "@/api/lib/lists/verification/document-text";

type CompleteVerificationRunArgs = {
  tx: Transaction;
  runId: SafeId<"legalListVerificationRun">;
  workspaceId: SafeId<"workspace">;
  blocks: readonly VerificationBlock[];
  claims: readonly (typeof legalListClaims.$inferInsert)[];
};

/** Store the exact source text and claims only while the run is still active. */
export const completeVerificationRun = async ({
  tx,
  runId,
  workspaceId,
  blocks,
  claims,
}: CompleteVerificationRunArgs): Promise<void> => {
  // audit: skip — lifecycle bookkeeping on a run audited at creation.
  const completed = await tx
    .update(legalListVerificationRuns)
    .set({ status: "completed", finishedAt: new Date() })
    .where(
      and(
        eq(legalListVerificationRuns.id, runId),
        eq(legalListVerificationRuns.workspaceId, workspaceId),
        eq(legalListVerificationRuns.status, "running"),
      ),
    )
    .returning({ id: legalListVerificationRuns.id });
  if (completed.length === 0) {
    return;
  }

  // audit: skip — engine output of a run audited at creation.
  await tx
    .insert(legalListVerificationBlocks)
    .values(
      blocks.map((block, ordinal) => ({
        runId,
        workspaceId,
        ordinal,
        blockId: block.id,
        kind: block.source.type,
        pageNumber:
          block.source.type === "pdf-page" ? block.source.pageNumber : null,
        text: block.text,
      })),
    )
    .onConflictDoNothing({
      target: [
        legalListVerificationBlocks.runId,
        legalListVerificationBlocks.ordinal,
      ],
    });

  if (claims.length > 0) {
    // audit: skip — engine output of a run audited at creation.
    await tx
      .insert(legalListClaims)
      .values([...claims])
      .onConflictDoNothing({
        target: [legalListClaims.runId, legalListClaims.position],
      });
  }
};
