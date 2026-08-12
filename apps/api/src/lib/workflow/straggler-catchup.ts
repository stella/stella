import { TaggedError } from "better-result";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import { properties } from "@/api/db/schema";
import type { AIRequestServiceTier } from "@/api/lib/ai-config";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import type { WorkflowStartStatus } from "@/api/lib/workflow-queue";
import { COMPUTED_PROPERTY_TOOL_TYPES } from "@/api/lib/workflow/get-execution-plan";

/** The one start status that means nothing was queued. */
const WORKFLOW_START_FAILED = "failed" satisfies WorkflowStartStatus;

/** The follow-up run this workspace was owed did not get queued. */
class StragglerCatchUpError extends TaggedError("StragglerCatchUpError")<{
  message: string;
  workspaceId: SafeId<"workspace">;
}> {}

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

/**
 * The starter reports an enqueue failure in band rather than by rejecting, so
 * a lone `.catch()` would drop exactly the case worth knowing about: the
 * follow-up this workspace was owed never got queued, and nothing retries it
 * until some later run finishes.
 */
const startReportedFailure = (result: unknown): boolean =>
  typeof result === "object" &&
  result !== null &&
  "status" in result &&
  result.status === WORKFLOW_START_FAILED;

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
 * Two things leave a computed column stale behind a finished run: a column
 * created mid-run, which was never in that run's plan, and a start answered
 * `already-running`, whose caller materialized its columns and left the enqueue
 * to the run in flight. The playbook surfaces classify that answer as benign on
 * exactly this promise (see `playbookRunStartOutcome`), so the catch-up reads
 * durable state instead of anything the finished run remembers, and every
 * finished run performs it: the run a deferred start raced is as likely to be a
 * cell-scoped retry as a workspace-wide sweep.
 *
 * The tool-type filter is what keeps this from looping, and it asks the planner
 * which types those are. Manual columns may legitimately sit stale (e.g. after
 * a type edit) and no run computes them, so an unfiltered query would fire
 * no-op workflows forever; a hand-listed filter would instead miss a computed
 * type, which is how a graded playbook position with a manual ASK could
 * materialize a stale verdict column nothing came back for.
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
            inArray(sql`${properties.tool}->>'type'`, [
              ...COMPUTED_PROPERTY_TOOL_TYPES,
            ]),
          ),
        )
        .limit(1),
    );
    if (stragglers.length === 0) {
      return;
    }
    // Not awaited: the follow-up run plans and enqueues on its own, and a
    // finished run must not be held open (or failed) by the next one starting.
    // Both outcomes are still read: a rejection and an in-band `failed` mean
    // the same thing here, work this workspace is owed that no longer has a
    // successor coming.
    startWorkflow({
      workspaceId,
      organizationId,
      userId,
      scopedDb,
      serviceTier,
    })
      .then((result) => {
        if (startReportedFailure(result)) {
          captureError(
            new StragglerCatchUpError({
              message: "Straggler catch-up could not start its follow-up run",
              workspaceId,
            }),
            { workspaceId },
          );
        }
        return result;
      })
      .catch((error: unknown) => captureError(error, { workspaceId }));
  } catch (error: unknown) {
    captureError(error, { workspaceId });
  }
};
