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

import type { ScopedDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import { startWorkflow } from "@/api/lib/workflow-queue";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const claimedRequestIds: string[] = [];
const releasedClaims: { requestId: string; workspaceId: string }[] = [];

const tryClaimMock = mock(async ({ requestId }: { requestId: string }) => {
  claimedRequestIds.push(requestId);
  return await Promise.resolve(true);
});
const setRequestIdMock = mock(async () => {
  await Promise.resolve();
  throw new Error("valkey unreachable");
});
const releaseClaimMock = mock(
  async (release: { requestId: string; workspaceId: string }) => {
    releasedClaims.push(release);
    return await Promise.resolve(true);
  },
);
const clearMock = mock(async () => undefined);

const runStateStore = asTestRaw<
  NonNullable<Parameters<typeof startWorkflow>[0]["runStateStore"]>
>({
  tryClaim: tryClaimMock,
  setRequestId: setRequestIdMock,
  releaseClaim: releaseClaimMock,
  clear: clearMock,
});

const WORKSPACE_ID = toSafeId<"workspace">(
  "01931f4a-0000-7000-8000-000000000101",
);
const ORGANIZATION_ID = toSafeId<"organization">(
  "01931f4a-0000-7000-8000-000000000102",
);
const USER_ID = toSafeId<"user">("01931f4a-0000-7000-8000-000000000103");

const startAfterFailedClaimWrite = async () =>
  await startWorkflow({
    workspaceId: WORKSPACE_ID,
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    scopedDb: asTestRaw<ScopedDb>(() => {
      throw new Error("the plan must not be read after a failed claim");
    }),
    runStateStore,
  });

describe("startWorkflow when the run state write fails after the claim", () => {
  test("releases the claim and reports the failure in band", async () => {
    const result = await startAfterFailedClaimWrite();

    // In band, so the callers that now distinguish `failed` from `started`
    // surface it instead of receiving an exception they can only guess at.
    expect(result.status).toBe("failed");
    // Released, so the caller's retry is answered by a fresh claim rather than
    // by the orphan of the attempt that just failed.
    expect(releaseClaimMock).toHaveBeenCalledTimes(1);
    expect(releasedClaims.at(0)?.workspaceId).toBe(WORKSPACE_ID);
    // Never the blanket delete: it would take whatever holds the workspace at
    // the time, not what this attempt claimed.
    expect(clearMock).not.toHaveBeenCalled();
  });

  test("releases only the claim it made, never a replacement's", async () => {
    // Two attempts, each with its own request id. The release runs after a
    // Valkey failure, so a slow one can land after its lock's TTL lapsed and a
    // later run claimed the workspace: what makes that harmless is that a
    // release names the id it claimed with, and the store's compare-and-delete
    // drops nothing when the ids differ.
    await startAfterFailedClaimWrite();
    await startAfterFailedClaimWrite();

    expect(new Set(claimedRequestIds).size).toBe(claimedRequestIds.length);
    expect(releasedClaims.map((release) => release.requestId)).toEqual(
      claimedRequestIds,
    );
  });
});
