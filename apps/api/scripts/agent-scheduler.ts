import { panic } from "better-result";

import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import {
  assertAgentSchedulerPaused,
  resumeAgentScheduler,
  sealAgentStack,
} from "@/api/lib/scheduler/agent-stack";
import { requireLocalDevOpen } from "@/api/runtime-mode";

const [mode, sealPath] = process.argv.slice(2);
if (mode !== "settle" && mode !== "check" && mode !== "resume") {
  panic("Usage: agent-scheduler.ts <settle seal.json|check|resume>");
}
requireLocalDevOpen("Managing the agent stack scheduler");
const db = openMaintenanceDb({ readOnly: mode === "check" });
switch (mode) {
  case "settle": {
    if (sealPath === undefined) {
      panic("Settling requires a seal path");
    }
    const { reapOwnerlessChatTurnOnTx } =
      await import("@/api/handlers/chat/chat-turn-persistence");
    const { createSchedulerTaskRegistry } =
      await import("@/api/lib/scheduler/registry");
    const { createReapOwnerlessChatTurnsTask } =
      await import("@/api/lib/scheduler/tasks/chat-turn-reaper");
    await sealAgentStack({
      sealPath,
      registry: createSchedulerTaskRegistry(
        createReapOwnerlessChatTurnsTask(reapOwnerlessChatTurnOnTx),
      ),
    });
    break;
  }
  case "check": {
    await withAggregateTransaction(db, assertAgentSchedulerPaused);
    break;
  }
  case "resume": {
    await withAggregateTransaction(db, resumeAgentScheduler);
    break;
  }
}
process.exit(0);
