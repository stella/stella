import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  timerParams,
  timerStateTransition,
} from "@/api/lib/billing/time-timers";

const config = {
  description:
    "Resume your paused timer and automatically pause your other running timer. Resuming an already running timer leaves its elapsed time unchanged.",
  permissions: { timeEntry: ["update"] },
  mcp: { type: "capability", reason: "billing_admin" },
  params: timerParams,
} satisfies HandlerConfig;

const resumeTimer = createSafeRootHandler(
  config,
  timerStateTransition("running"),
);
export default resumeTimer;
