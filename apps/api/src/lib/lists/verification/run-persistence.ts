import { and, eq } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  legalListClaims,
  legalListVerificationBlocks,
  legalListVerificationRuns,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { insertInChunks } from "@/api/lib/db/bulk-write";
import type { VerificationBlock } from "@/api/lib/lists/verification/document-text";

type CompleteVerificationRunArgs = {
  tx: Pick<PgAsyncDatabase<PgQueryResultHKT>, "update" | "insert">;
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

  const blockRows = blocks.map((block, ordinal) => ({
    runId,
    workspaceId,
    ordinal,
    blockId: block.id,
    kind: block.source.type,
    pageNumber:
      block.source.type === "pdf-page" ? block.source.pageNumber : null,
    text: block.text,
  }));
  await insertInChunks(
    blockRows,
    async (batch) =>
      // audit: skip — engine output of a run audited at creation.
      await tx
        .insert(legalListVerificationBlocks)
        .values(batch)
        .onConflictDoNothing({
          target: [
            legalListVerificationBlocks.runId,
            legalListVerificationBlocks.ordinal,
          ],
        }),
  );
  await insertInChunks(
    claims,
    async (batch) =>
      // audit: skip — engine output of a run audited at creation.
      await tx
        .insert(legalListClaims)
        .values(batch)
        .onConflictDoNothing({
          target: [legalListClaims.runId, legalListClaims.position],
        }),
  );
};
