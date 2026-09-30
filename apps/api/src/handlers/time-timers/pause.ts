import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  timerParams,
  timerStateTransition,
} from "@/api/lib/billing/time-timers";

const config = {
  description:
    "Pause your timer without creating a time entry. Pausing an already paused timer leaves its elapsed time unchanged.",
  permissions: { timeEntry: ["update"] },
  mcp: { type: "capability", reason: "billing_admin" },
  params: timerParams,
} satisfies HandlerConfig;

const pauseTimer = createSafeRootHandler(
  config,
  timerStateTransition("paused"),
);
export default pauseTimer;
