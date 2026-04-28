import { Result } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";

export const ensureAllowedWorkspaceIds = ({
  allowedWorkspaceIds,
  workspaceIds,
}: {
  allowedWorkspaceIds: SafeId<"workspace">[];
  workspaceIds: SafeId<"workspace">[];
}) => {
  const allowedWorkspaceIdSet = new Set(allowedWorkspaceIds);
  const scopedWorkspaceIds = workspaceIds.filter((id) =>
    allowedWorkspaceIdSet.has(id),
  );

  if (scopedWorkspaceIds.length === workspaceIds.length) {
    return Result.ok(scopedWorkspaceIds);
  }

  return Result.err(
    new ChatToolError({
      message: "One or more matter refs are not in the allowed set.",
    }),
  );
};
