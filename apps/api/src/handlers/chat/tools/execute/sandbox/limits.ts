export type SandboxLimits = {
  maxDurationMs: number;
  maxMemoryBytes: number;
  maxStackBytes: number;
  maxHostCalls: number;
  maxReturnBytes: number;
};

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  maxDurationMs: 10_000,
  maxMemoryBytes: 128 * 1024 * 1024,
  // QuickJS starts failing eval with blank runtime errors above ~4 MiB here.
  maxStackBytes: 1024 * 1024,
  maxHostCalls: 50,
  maxReturnBytes: 64 * 1024,
};
