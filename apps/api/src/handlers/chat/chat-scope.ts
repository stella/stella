import { Result } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type ResolveChatScopeProps = {
  accessibleWorkspaceIds: SafeId<"workspace">[];
  workspaceId?: string | undefined;
};

type ResolveChatScopeResult = Result<
  | {
      scope: "global";
    }
  | {
      scope: "workspace";
      workspaceId: SafeId<"workspace">;
    },
  HandlerError<404>
>;

export const resolveChatScope = ({
  accessibleWorkspaceIds,
  workspaceId,
}: ResolveChatScopeProps): ResolveChatScopeResult => {
  if (!workspaceId) {
    return Result.ok({ scope: "global" });
  }

  const matchedWorkspaceId = accessibleWorkspaceIds.find(
    (accessibleWorkspaceId) => accessibleWorkspaceId === workspaceId,
  );

  if (!matchedWorkspaceId) {
    return Result.err(
      new HandlerError({
        status: 404,
        message: "Workspace not found",
      }),
    );
  }

  return Result.ok({
    scope: "workspace",
    workspaceId: matchedWorkspaceId,
  });
};
