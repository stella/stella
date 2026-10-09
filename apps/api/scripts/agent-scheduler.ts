import { panic } from "better-result";

import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { openMaintenanceDb } from "@/api/lib/db/maintenance-db";
import {
  assertAgentSchedulerPaused,
  resumeAgentScheduler,
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
    const { sealAgentSchedulerStack } =
      await import("@/api/lib/scheduler/runner");
    const result = await sealAgentSchedulerStack({
      sealPath,
      registry: createSchedulerTaskRegistry(
        createReapOwnerlessChatTurnsTask(reapOwnerlessChatTurnOnTx),
      ),
    });
    if (result.isErr()) {
      console.error(result.error.message);
      process.exit(1);
    }
    break;
  }
  case "check": {
    const result = await withAggregateTransaction(
      db,
      assertAgentSchedulerPaused,
    );
    if (result.isErr()) {
      console.error(result.error.message);
      process.exit(1);
    }
    break;
  }
  case "resume": {
    await withAggregateTransaction(db, resumeAgentScheduler);
    break;
  }
}
process.exit(0);
