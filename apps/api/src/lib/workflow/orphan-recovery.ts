// Pure decision helpers for workflow orphan reconciliation. Kept free of
// Redis/DB/queue imports so the reconciler's logic is unit-testable and
// importing it never triggers a connection or worker side effect.

const RUNNING_LOCK_KEY = /^workflow-run:\{(?<workspaceId>[^{}]+)\}:running$/u;

/**
 * Extract the workspace id from a `workflow-run:{<workspaceId>}:running` lock
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
  { status: "reserve"; expectedRunningValue: string } | { status: "skip" };

export type PendingCellOwner = {
  ownerRunId: string | null;
  deadlineAt: Date | null;
  attempt: 0 | 1 | null;
};

export type PendingCellRecovery =
  | { type: "leave-owned" }
  | { type: "retry"; attempt: 1; delayMs: number }
  | { type: "error"; retry: "manual" };

/**
 * Decide one pending cell independently of every other cell in its workspace.
 * A live job for a different run cannot shelter this owner, and a live owner
 * cannot shelter a cell after its own deadline. Legacy unowned rows receive
 * the same single bounded retry as an owned attempt-zero cell.
 */
export const pendingCellRecovery = (
  cell: PendingCellOwner,
  currentRunId: string | null,
  now: Date,
): PendingCellRecovery => {
  const ownerIsCurrent =
    cell.ownerRunId !== null && cell.ownerRunId === currentRunId;
  const beforeDeadline = cell.deadlineAt !== null && cell.deadlineAt > now;
  if (ownerIsCurrent && beforeDeadline) {
    return { type: "leave-owned" };
  }
  if (
    (cell.ownerRunId !== null && cell.attempt === 0) ||
    (cell.ownerRunId === null && cell.attempt === null)
  ) {
    return { type: "retry", attempt: 1, delayMs: 1000 };
  }
  return { type: "error", retry: "manual" };
};

export type PendingCellCandidate = PendingCellOwner & {
  id: string;
  workspaceId: string;
};

type ReconcilePendingCellsOptions<T extends PendingCellCandidate> = {
  now: Date;
  pageSize: number;
  selectPage: (cursor: string | null, limit: number) => Promise<readonly T[]>;
  currentRunId: (workspaceKey: string) => Promise<string | null>;
  retry: (cell: T, attempt: 1, delayMs: number) => Promise<void>;
  error: (cell: T) => Promise<void>;
};

/**
 * Run the scheduled, per-cell recovery policy over bounded keyset pages.
 * Advancing the cursor from the selected page, rather than from mutations,
 * makes the scan stable when a retry immediately replaces a pending row.
 */
export const reconcilePendingCells = async <T extends PendingCellCandidate>({
  now,
  pageSize,
  selectPage,
  currentRunId,
  retry,
  error,
}: ReconcilePendingCellsOptions<T>): Promise<void> => {
  let cursor: string | null = null;
  const currentRuns = new Map<string, string | null>();
  while (true) {
    const page = await selectPage(cursor, pageSize);
    if (page.length === 0) {
      return;
    }
    for (const cell of page) {
      let runId = currentRuns.get(cell.workspaceId);
      if (runId === undefined) {
        runId = await currentRunId(cell.workspaceId);
        currentRuns.set(cell.workspaceId, runId);
      }
      const decision = pendingCellRecovery(cell, runId, now);
      if (decision.type === "retry") {
        await retry(cell, decision.attempt, decision.delayMs);
      } else if (decision.type === "error") {
        await error(cell);
      }
    }
    cursor = page.at(-1)?.id ?? null;
    if (page.length < pageSize) {
      return;
    }
  }
};

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
