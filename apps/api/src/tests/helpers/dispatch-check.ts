import { checkBeforeDispatch } from "@/api/lib/tanstack-ai-generate";
import type { DispatchCheck } from "@/api/lib/tanstack-ai-generate";

/**
 * What a generation does with its caller's check before a provider request:
 * run it and stop with a `DispatchRefusedError` when it refuses. A stand-in
 * model calls this first, as the real generation does.
 */
export const runDispatchCheck = async (check: DispatchCheck | undefined) => {
  await checkBeforeDispatch(check);
};
