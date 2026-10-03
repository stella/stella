import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS } from "@/api/lib/auth/demo-account-policy";
import {
  timerParams,
  timerStateTransition,
} from "@/api/lib/billing/time-timers";

const config = {
  description:
    "Resume your paused timer and automatically pause your other running timer. Resuming an already running timer leaves its elapsed time unchanged.",
  permissions: { timeEntry: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "capability", reason: "billing_admin", consumesServices: false },
  params: timerParams,
} satisfies HandlerConfig;

const resumeTimer = createSafeRootHandler(
  config,
  timerStateTransition("running"),
);
export default resumeTimer;
