/**
 * `startWorkflow` must not answer an exception while still holding the run
 * lock it just claimed.
 *
 * The claim is a `SET NX`, so a throw between claiming and the start path's
 * own error handling leaves a lock nobody owns. The caller then sees a thrown
 * error, and its retry is answered `already-running` by the very claim it
 * orphaned, which every caller reads as a run in flight: a review that never
 * started reported as one that did. The window is small (the lock's TTL and
 * `reconcileOrphanedWorkflows` both close it eventually) but it is exactly the
 * window a retryable error invites a caller into.
 *
 * Its own file because the mocks below replace the run-state store and the
 * queue module process-wide.
 */

import { describe, expect, mock, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

const tryClaimMock = mock(async () => true);
const setRequestIdMock = mock(async () => {
  await Promise.resolve();
  throw new Error("valkey unreachable");
});
const clearMock = mock(async () => undefined);

// Only the three members this path reaches. Spreading the real store here
// would recurse: inside the factory, the module specifier resolves to this
// mock, so the getter would call itself.
void mock.module("@/api/lib/workflow/root-run-state-store", () => ({
  getRootWorkflowRunStateStore: () => ({
    tryClaim: tryClaimMock,
    setRequestId: setRequestIdMock,
    clear: clearMock,
  }),
}));

const { startWorkflow } = await import("@/api/lib/workflow-queue");

const WORKSPACE_ID = toSafeId<"workspace">(
  "01931f4a-0000-7000-8000-000000000101",
);
const ORGANIZATION_ID = toSafeId<"organization">(
  "01931f4a-0000-7000-8000-000000000102",
);
const USER_ID = toSafeId<"user">("01931f4a-0000-7000-8000-000000000103");

describe("startWorkflow when the run state write fails after the claim", () => {
  test("releases the claim and reports the failure in band", async () => {
    const result = await startWorkflow({
      workspaceId: WORKSPACE_ID,
      organizationId: ORGANIZATION_ID,
      userId: USER_ID,
      scopedDb: (() => {
        throw new Error("the plan must not be read after a failed claim");
      }) as never,
    });

    // In band, so the callers that now distinguish `failed` from `started`
    // surface it instead of receiving an exception they can only guess at.
    expect(result.status).toBe("failed");
    // Released, so the caller's retry is answered by a fresh claim rather than
    // by the orphan of the attempt that just failed.
    expect(clearMock).toHaveBeenCalledWith(WORKSPACE_ID);
  });
});
