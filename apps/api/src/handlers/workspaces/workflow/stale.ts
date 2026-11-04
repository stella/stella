import { Result } from "better-result";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { readStaleCellTargets } from "@/api/lib/workflow/stale-cells";

const config = {
  contract: "patch",
  description:
    "Report the AI cells of a matter whose document changed since a run " +
    "settled them: the ids of the documents and columns holding a stale " +
    "value. The values stay as they were until matters.workflow.start with " +
    "cells: stale re-runs them.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "workflow_orchestration",
    consumesServices: false,
  },
} satisfies WorkspaceHandlerConfig;

const readStaleCells = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId }) {
    const targets = yield* Result.await(
      safeDb((tx) => readStaleCellTargets({ tx, workspaceId })),
    );
    return Result.ok(targets);
  },
);

export default readStaleCells;
