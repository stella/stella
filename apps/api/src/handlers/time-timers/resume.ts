import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  timerParams,
  timerStateTransition,
} from "@/api/lib/billing/time-timers";

const config = {
  contract: "patch",
  description:
    "Resume your paused timer and automatically pause your other running timer. Resuming an already running timer leaves its elapsed time unchanged. A timer that runs on an existing time entry cannot resume once that entry is submitted or approved (timer_original_entry_changed); confirm or discard it instead.",
  permissions: { timeEntry: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
  params: timerParams,
} satisfies HandlerConfig;

const resumeTimer = createSafeRootHandler(
  config,
  timerStateTransition("running"),
);
export default resumeTimer;
