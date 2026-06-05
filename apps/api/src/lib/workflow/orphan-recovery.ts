// Pure decision helpers for workflow orphan reconciliation. Kept free of
// Redis/DB/queue imports so the reconciler's logic is unit-testable and
// importing it never triggers a connection or worker side effect.

const RUNNING_LOCK_KEY = /^workflow:([^:]+):running$/u;

/**
 * Extract the workspace id from a `workflow:<workspaceId>:running` lock
 * key. Returns null for any other workflow key (e.g. `:completed`,
 * `:request-id`) or a malformed key, so only genuine locks are ever
 * considered for reconciliation.
 */
export const parseRunningLockWorkspaceId = (key: string): string | null =>
  RUNNING_LOCK_KEY.exec(key)?.[1] ?? null;

type OrphanSelectionInput = {
  candidateWorkspaceIds: readonly string[];
  liveWorkspaceIds: ReadonlySet<string>;
};

type RecoverableOrphanSelectionInput = OrphanSelectionInput & {
  currentRequestIds: ReadonlyMap<string, string | null>;
  initialRequestIds: ReadonlyMap<string, string | null>;
  pendingWorkspaceIds: ReadonlySet<string>;
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
 * window, and it is either tied to pending cells or has no request id at all.
 * The last condition avoids reclaiming a healthy workflow that is still
 * planning before its first queue job exists.
 */
export const selectRecoverableOrphanWorkspaceIds = ({
  candidateWorkspaceIds,
  currentRequestIds,
  initialRequestIds,
  liveWorkspaceIds,
  pendingWorkspaceIds,
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
    if (!hasPendingCells && currentRequestId !== null) {
      continue;
    }

    seen.add(workspaceId);
    recoverable.push(workspaceId);
  }

  return recoverable;
};
