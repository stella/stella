import {
  ONLINE_WORK_NAMES,
  type OnlineWorkName,
} from "../../db/online-migrations";
import {
  FINALIZED,
  ONLINE_WORK_LIFECYCLE,
  type OnlineWorkLifecycle,
} from "../../db/online-work-lifecycle";

/**
 * Every registered unit finalized. Tests start from this rather than from
 * `ONLINE_WORK_LIFECYCLE`, so the work production still has pending never
 * becomes part of a test's runner or walk: a test names its own pending work.
 */
export const allFinalizedOnlineWork = (): Record<
  OnlineWorkName,
  OnlineWorkLifecycle
> => {
  const lifecycle: Record<OnlineWorkName, OnlineWorkLifecycle> = {
    ...ONLINE_WORK_LIFECYCLE,
  };
  for (const name of ONLINE_WORK_NAMES) {
    lifecycle[name] = FINALIZED;
  }
  return lifecycle;
};
