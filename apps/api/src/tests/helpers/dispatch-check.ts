import type { DispatchCheck } from "@/api/lib/tanstack-ai-generate";

/**
 * What a generation does with its caller's check before a provider request:
 * run it and stop when it refuses. A stand-in model calls this first, as the
 * real generation does, so a test sees what reaches the provider.
 */
export const runDispatchCheck = async (check: DispatchCheck | undefined) => {
  const verdict = await check?.();
  if (verdict?.isErr() === true) {
    throw verdict.error;
  }
};
