import { panic } from "better-result";

import { UPDATE_CHECK_ENABLED } from "./env.js";
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
      if (outcome.cacheWarning !== undefined) {
        warn(outcome.cacheWarning);
      }
      // An unsupported version always warns; an optional update only when
      // background update checks are enabled.
      if (
        outcome.nudge !== undefined &&
        (outcome.unsupported === true || UPDATE_CHECK_ENABLED)
      ) {
        warn(outcome.nudge);
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
