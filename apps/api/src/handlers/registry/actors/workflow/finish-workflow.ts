import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";
import type { ActionContextOf } from "rivetkit";

import { properties } from "@/api/db/schema";
import type { workflowActor } from "@/api/handlers/registry/actors/workflow/actor";
import { defaultWorkflowState } from "@/api/handlers/registry/actors/workflow/schema";
import {
  broadcastEvent,
  parseBrandedWorkflowActorKey,
  resetActorState,
} from "@/api/handlers/registry/utils";
import { createRootScopedDb } from "@/api/lib/root-scoped-db";

export const finishWorkflowAction = async (
  c: ActionContextOf<typeof workflowActor>,
) =>
  await Result.tryPromise(async () => {
    if (!c.state.isRunning) {
      panic("Workflow is not running");
    }

    const { organizationId, workspaceId } = parseBrandedWorkflowActorKey(c.key);
    const scopedDb = createRootScopedDb({
      organizationId,
      workspaceIds: [workspaceId],
    });

    await scopedDb((tx) =>
      tx
        .update(properties)
        .set({ status: "fresh" })
        .where(eq(properties.workspaceId, workspaceId)),
    );

    resetActorState(c, defaultWorkflowState());

    broadcastEvent(c, {
      name: "workflow-status",
      data: { running: false },
    });
  });
