import { cleanupFlowDefinitions as cleanupFlowDefinitionsOwned } from "@/api/lib/flows/reset-cleanup-owner";
import type { ResetFlowCleanupOptions } from "@/api/lib/flows/reset-cleanup-owner";

export const cleanupFlowDefinitions = async (
  options: ResetFlowCleanupOptions,
): Promise<void> => {
  await cleanupFlowDefinitionsOwned(options);
};
