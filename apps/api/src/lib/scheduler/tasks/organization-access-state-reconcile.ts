import { panic } from "better-result";

import { recordMissingOrganizationAccessStatesWhileUnenforced } from "@/api/lib/organization-access-state";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const RECORD_MISSING_ORGANIZATION_ACCESS_STATES_TASK =
  "organizations.recordMissingAccessStates" as const;

/**
 * Record the access state of organizations created without one, while the
 * state is not enforced (see recordMissingOrganizationAccessStates).
 */
export const recordMissingOrganizationAccessStatesTask: SchedulerTask = async ({
  db,
  signal,
}) => {
  if (signal.aborted) {
    panic("SchedulerAborted");
  }
  await recordMissingOrganizationAccessStatesWhileUnenforced(db);
};
