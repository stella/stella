import { expect, test } from "bun:test";

import { readRecoveryScanState } from "./recovery-scan-cursor";
import {
  RECOVERY_SCAN_IDENTITIES,
  RECOVERY_SCAN_PHASES,
} from "./recovery-scan-identity";

test.each(Object.values(RECOVERY_SCAN_IDENTITIES))(
  "recovery phases persist for $task",
  (identity) => {
    const job = { id: identity.jobId, task: identity.task };
    const initial = readRecoveryScanState(job, null);
    expect(initial.value).toEqual({
      phase: RECOVERY_SCAN_PHASES.census,
      census: null,
      dispatch: null,
    });
    for (const phase of Object.values(RECOVERY_SCAN_PHASES)) {
      const value = { phase, census: null, dispatch: null };
      expect(readRecoveryScanState(job, { recoveryScan: value }).value).toEqual(
        value,
      );
    }
    for (const value of [
      { census: null, dispatch: null },
      { phase: "unknown", census: null, dispatch: null },
    ]) {
      expect(() => readRecoveryScanState(job, { recoveryScan: value })).toThrow(
        /cursor payload is invalid/u,
      );
    }
  },
);
