import {
  cleanupScoutRuns as cleanupScoutRunsOwned,
  cleanupSignalEvents as cleanupSignalEventsOwned,
  cleanupSignals as cleanupSignalsOwned,
} from "@/api/lib/signals/reset-cleanup-owner";
import type { ResetSignalCleanupOptions } from "@/api/lib/signals/reset-cleanup-owner";

export const cleanupScoutRuns = async (
  options: ResetSignalCleanupOptions,
): Promise<void> => {
  await cleanupScoutRunsOwned(options);
};
export const cleanupSignalEvents = async (
  options: ResetSignalCleanupOptions,
): Promise<void> => {
  await cleanupSignalEventsOwned(options);
};
export const cleanupSignals = async (
  options: ResetSignalCleanupOptions,
): Promise<void> => {
  await cleanupSignalsOwned(options);
};
