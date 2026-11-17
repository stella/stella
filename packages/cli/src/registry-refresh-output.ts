import { panic } from "better-result";

import {
  type RefreshOutcome,
  refreshRegistryCache,
} from "./registry-refresh.js";

/** Startup and post-login refreshes share the same non-fatal diagnostic policy. */
export const refreshRegistryWithDiagnostics = async (
  options: Parameters<typeof refreshRegistryCache>[0],
  warn: (message: string) => void = (message) => {
    process.stderr.write(`${message}\n`);
  },
): Promise<RefreshOutcome> => {
  const outcome = await refreshRegistryCache(options);
  switch (outcome.status) {
    case "refreshed":
      for (const message of [outcome.cacheWarning, outcome.nudge]) {
        if (message !== undefined) {
          warn(message);
        }
      }
      return outcome;
    case "failed":
      warn(outcome.warning);
      return outcome;
    case "skipped":
    case "incompatible":
    case "admission-refused":
      return outcome;
    default:
      outcome satisfies never;
      return panic("Unexpected registry refresh outcome");
  }
};
