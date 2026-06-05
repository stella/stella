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
