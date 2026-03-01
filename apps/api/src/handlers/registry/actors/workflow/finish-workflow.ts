import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";
import type { ActionContextOf } from "rivetkit";

import { parseWorkflowActorKey } from "@stella/rivet/actors/workflow-actor-config";

import { db } from "@/api/db";
import { properties } from "@/api/db/schema";
import type { workflowActor } from "@/api/handlers/registry/actors/workflow/actor";
import { defaultWorkflowState } from "@/api/handlers/registry/actors/workflow/schema";
import { broadcastEvent, resetActorState } from "@/api/handlers/registry/utils";

export const finishWorkflowAction = (
  c: ActionContextOf<typeof workflowActor>,
) =>
  Result.tryPromise(async () => {
    if (!c.state.isRunning) {
      panic("Workflow is not running");
    }

    const { workspaceId } = parseWorkflowActorKey(c.key);

    await db
      .update(properties)
      .set({ status: "fresh" })
      .where(eq(properties.workspaceId, workspaceId));

    resetActorState(c, defaultWorkflowState());

    broadcastEvent(c, {
      name: "workflow-status",
      data: { running: false },
    });
  });
