import { Result } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";

export const getScopedWorkspaceIds = (
  allowedWorkspaceIds: SafeId<"workspace">[],
  workspaceIds: string[],
) => {
  const scopedWorkspaceIds = [];

  for (const workspaceId of workspaceIds) {
    const allowedWorkspaceId = allowedWorkspaceIds.find(
      (id) => id === workspaceId,
    );
    if (!allowedWorkspaceId) {
      return Result.err(
        new ChatToolError({
          message: `Matter "${workspaceId}" is not in the allowed set.`,
        }),
      );
    }

    scopedWorkspaceIds.push(allowedWorkspaceId);
  }

  return Result.ok(scopedWorkspaceIds);
};
