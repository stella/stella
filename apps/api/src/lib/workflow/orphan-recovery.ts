// Pure decision helpers for workflow orphan reconciliation. Kept free of
// Redis/DB/queue imports so the reconciler's logic is unit-testable and
// importing it never triggers a connection or worker side effect.

const RUNNING_LOCK_KEY = /^workflow:(?<workspaceId>[^:]+):running$/u;

/**
 * Extract the workspace id from a `workflow:<workspaceId>:running` lock
 * key. Returns null for any other workflow key (e.g. `:completed-entities`,
 * `:request-id`) or a malformed key, so only genuine locks are ever
 * considered for reconciliation.
 */
export const parseRunningLockWorkspaceId = (key: string): string | null =>
  RUNNING_LOCK_KEY.exec(key)?.groups?.["workspaceId"] ?? null;

type OrphanSelectionInput = {
  candidateWorkspaceIds: readonly string[];
  liveWorkspaceIds: ReadonlySet<string>;
};

type RecoverableOrphanSelectionInput = OrphanSelectionInput & {
  currentRequestIds: ReadonlyMap<string, string | null>;
  initialRequestIds: ReadonlyMap<string, string | null>;
  pendingWorkspaceIds: ReadonlySet<string>;
  recoveryWorkspaceIds: ReadonlySet<string>;
};

type ExpiredStaleRunSelectionInput = {
  currentRequestIds: ReadonlyMap<string, string | null>;
  currentRunningValues: ReadonlyMap<string, string | null>;
  staleWorkspaceIds: readonly string[];
};

type CurrentWorkflowRequestStateInput = {
  currentRequestId: string | null;
  requestId: string;
  runningValue: string | null;
  transitionalRunningLockValue: string;
};

type RunningLockReservationInput = {
  expectedRequestId: string | null;
  recoveryLockValue: string;
  requestId: string | null;
  runningValue: string | null;
  transitionalRunningLockValue: string;
};

type RunningLockReservation =
  | { status: "reserve"; expectedRunningValue: string }
  | { status: "skip" };

/**
 * A candidate workspace (one holding a `running` lock or owning `pending`
 * cells) is orphaned when no in-flight queue job belongs to it: the
 * worker that set its state has died without clearing it. Returns the
 * deduplicated orphans in input order — the same workspace can surface
 * from both the lock scan and the pending-cell scan, but must be
 * recovered exactly once.
 */
export const selectOrphanWorkspaceIds = ({
  candidateWorkspaceIds,
  liveWorkspaceIds,
}: OrphanSelectionInput): string[] => {
  const orphans: string[] = [];
  const seen = new Set<string>();
  for (const workspaceId of candidateWorkspaceIds) {
    if (seen.has(workspaceId) || liveWorkspaceIds.has(workspaceId)) {
      continue;
    }
    seen.add(workspaceId);
    orphans.push(workspaceId);
  }
  return orphans;
};

/**
 * Final recovery gate after the settle window. A candidate is recoverable only
 * when it still has no live job, its request id did not change during the
 * window, and it is tied to pending cells or a recovery-owned lock. The
 * evidence requirement avoids reclaiming a healthy workflow that is still
 * planning before its first queue job exists.
 */
export const selectRecoverableOrphanWorkspaceIds = ({
  candidateWorkspaceIds,
  currentRequestIds,
  initialRequestIds,
  liveWorkspaceIds,
  pendingWorkspaceIds,
  recoveryWorkspaceIds,
}: RecoverableOrphanSelectionInput): string[] => {
  const recoverable: string[] = [];
  const seen = new Set<string>();

  for (const workspaceId of candidateWorkspaceIds) {
    if (seen.has(workspaceId) || liveWorkspaceIds.has(workspaceId)) {
      continue;
    }

    const initialRequestId = initialRequestIds.get(workspaceId) ?? null;
    const currentRequestId = currentRequestIds.get(workspaceId) ?? null;
    if (currentRequestId !== initialRequestId) {
      continue;
    }

    const hasPendingCells = pendingWorkspaceIds.has(workspaceId);
    const hasRecoveryLock = recoveryWorkspaceIds.has(workspaceId);
    if (!hasPendingCells && !hasRecoveryLock) {
      continue;
    }

    seen.add(workspaceId);
    recoverable.push(workspaceId);
  }

  return recoverable;
};

/**
 * A stale durable row is recovery evidence only after both Redis run-state
 * keys have actually expired. A large workflow can legitimately extend its
 * lock beyond the durable row's age before its first job is enqueued.
 */
export const selectExpiredStaleRunWorkspaceIds = ({
  currentRequestIds,
  currentRunningValues,
  staleWorkspaceIds,
}: ExpiredStaleRunSelectionInput): string[] => {
  const expired: string[] = [];
  const seen = new Set<string>();
  for (const workspaceId of staleWorkspaceIds) {
    if (seen.has(workspaceId)) {
      continue;
    }
    seen.add(workspaceId);
    const requestId = currentRequestIds.get(workspaceId) ?? null;
    const runningValue = currentRunningValues.get(workspaceId) ?? null;
    if (requestId === null && runningValue === null) {
      expired.push(workspaceId);
    }
  }
  return expired;
};

export const isCurrentWorkflowRequestState = ({
  currentRequestId,
  requestId,
  runningValue,
  transitionalRunningLockValue,
}: CurrentWorkflowRequestStateInput): boolean =>
  currentRequestId === requestId &&
  (runningValue === requestId || runningValue === transitionalRunningLockValue);

export const selectRunningLockReservation = ({
  expectedRequestId,
  recoveryLockValue,
  requestId,
  runningValue,
  transitionalRunningLockValue,
}: RunningLockReservationInput): RunningLockReservation => {
  if (runningValue === null || requestId !== expectedRequestId) {
    return { status: "skip" };
  }

  if (runningValue === recoveryLockValue) {
    return { status: "reserve", expectedRunningValue: recoveryLockValue };
  }

  if (
    expectedRequestId !== null &&
    runningValue === transitionalRunningLockValue
  ) {
    return {
      status: "reserve",
      expectedRunningValue: transitionalRunningLockValue,
    };
  }

  if (expectedRequestId === null || runningValue !== expectedRequestId) {
    return { status: "skip" };
  }

  return { status: "reserve", expectedRunningValue: runningValue };
};
