// The armed heavy proof contract, kept free of dependencies so install-free
// CI checks can read it.

// The label the merge bar adds before it arms a pull request; with auto-merge
// it marks the pull request run that proves the queue-only suites.
export const ARMED_LABEL = "merge-armed";

// The ci-plan output every queue-only job gates on. It is true for an armed
// pull request run, for a merge group whose queued head lacks armed proof,
// and for manual and main runs.
export const HEAVY_PROOF_GATE = "needs.ci-plan.outputs.heavy_proof == 'true'";

// Queue-only suites a merge group runs even when every queued pull request
// carries armed proof: a combination of proven changes can still break them.
export const MERGE_GROUP_HEAVY_KEEP = {
  "migration-upgrade-rehearsal":
    "Two proven pull requests can add colliding or misordered migrations.",
  "e2e-report":
    "Reports the merge group's own production-shard failures, which still run.",
} as const;
