import { and, eq, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { properties } from "@/api/db/schema";
import type { AIRequestServiceTier } from "@/api/lib/ai-config";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";

/**
 * The starter the catch-up drives, narrowed to what it passes. Structural
 * rather than imported from the queue: the queue owns this module, not the
 * other way round, and the narrower type is also the test seam.
 */
export type StragglerRunStarter = (args: {
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  scopedDb: ScopedDb;
  serviceTier: AIRequestServiceTier;
}) => Promise<unknown>;

type StragglerCatchUpArgs = {
  workspaceId: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  scopedDb: ScopedDb;
  serviceTier: AIRequestServiceTier;
  startWorkflow: StragglerRunStarter;
};

/**
 * Start a follow-up run for whatever the workspace still owes once a run
 * finishes.
 *
 * Two things leave a stale ai-model column behind a finished run: a column
 * created mid-run, which was never in that run's plan, and a start answered
 * `already-running`, whose caller materialized its columns and left the enqueue
 * to the run in flight. The playbook surfaces classify that answer as benign on
 * exactly this promise (see `playbookRunStartOutcome`), so the catch-up reads
 * durable state instead of anything the finished run remembers, and every
 * finished run performs it: the run a deferred start raced is as likely to be a
 * cell-scoped retry as a workspace-wide sweep.
 *
 * The filter on `tool.type = 'ai-model'` is what keeps this from looping.
 * Manual columns may legitimately sit stale (e.g. after a type edit) and the
 * planner skips them, so an unfiltered query would fire no-op workflows
 * forever.
 */
export const startStragglerCatchUp = async ({
  workspaceId,
  organizationId,
  userId,
  scopedDb,
  serviceTier,
  startWorkflow,
}: StragglerCatchUpArgs): Promise<void> => {
  try {
    const stragglers = await scopedDb((tx) =>
      tx
        .select({ id: properties.id })
        .from(properties)
        .where(
          and(
            eq(properties.workspaceId, workspaceId),
            eq(properties.status, "stale"),
            sql`${properties.tool}->>'type' = 'ai-model'`,
          ),
        )
        .limit(1),
    );
    if (stragglers.length === 0) {
      return;
    }
    // Not awaited: the follow-up run plans and enqueues on its own, and a
    // finished run must not be held open (or failed) by the next one starting.
    startWorkflow({
      workspaceId,
      organizationId,
      userId,
      scopedDb,
      serviceTier,
    }).catch((error: unknown) => captureError(error, { workspaceId }));
  } catch (error: unknown) {
    captureError(error, { workspaceId });
  }
};
