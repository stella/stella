export type SandboxLimits = {
  /**
   * Budget for the script's OWN wall clock: everything except the time it
   * spends awaiting a host call. A host call suspends this budget when it
   * starts and resumes it when it settles, so a script that searches and then
   * reads a few documents is bounded by its own work, not by how long the
   * tools took. It exists to bound a CPU loop or a hang in generated code;
   * each host call carries its own timeout and `maxHostCalls` bounds how many
   * may run.
   */
  maxDurationMs: number;
  /**
   * Hard wall-clock ceiling for the whole run, host-call time included.
   * Nothing suspends it: it bounds a script that would otherwise live on
   * through many slow host calls, each within its own timeout.
   */
  maxTotalDurationMs: number;
  maxMemoryBytes: number;
  maxStackBytes: number;
  maxHostCalls: number;
  maxReturnBytes: number;
};

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  maxDurationMs: 10_000,
  maxTotalDurationMs: 120_000,
  maxMemoryBytes: 128 * 1024 * 1024,
  // QuickJS starts failing eval with blank runtime errors above ~4 MiB here.
  maxStackBytes: 1024 * 1024,
  maxHostCalls: 50,
  maxReturnBytes: 64 * 1024,
};
