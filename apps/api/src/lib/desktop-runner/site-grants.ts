import { Result } from "better-result";

import { detached } from "@/api/lib/analytics/capture";
import { getDesktopRunnerControl } from "@/api/lib/desktop-runner/runtime";
import type { RunOwner } from "@/api/lib/desktop-runner/store";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";

/** The member's website approvals could not be queued for their runs. */
const SITE_GRANTS_PUSH_SINK = failureSink({
  event: "desktop_runner.site_grants_push_failed",
  expected: [],
});

/**
 * After a change to the member's website approvals committed: their runs
 * still going on their computers take the set as it stands now
 * (`pushSiteGrants`). The change itself is already stored, so a failure here
 * never undoes it; it is reported, and the next change sends the whole set
 * again.
 */
export const pushSiteGrantsToRuns = (owner: RunOwner): void => {
  detached(async () => {
    const pushed = await getDesktopRunnerControl().control.pushSiteGrants({
      owner,
    });
    if (Result.isError(pushed)) {
      observeFailure(pushed.error, { sink: SITE_GRANTS_PUSH_SINK });
    }
  }, "desktop-runner.site-grants");
};
