import { Result } from "better-result";

import type { AccessibleWorkspace } from "@/api/lib/auth";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type ResolveChatScopeProps = {
  getWorkspaceAccess: (
    workspaceId: SafeId<"workspace">,
  ) => Promise<AccessibleWorkspace | null>;
  workspaceId?: SafeId<"workspace"> | undefined;
};

export const resolveChatScope = async function* ({
  getWorkspaceAccess,
  workspaceId,
}: ResolveChatScopeProps) {
  if (!workspaceId) {
    return { scope: "global" } as const;
  }

  const workspace = yield* Result.await(
    Result.tryPromise(async () => await getWorkspaceAccess(workspaceId)),
  );

  if (!workspace || workspace.status === "deleting") {
    return yield* Result.err(
      new HandlerError({
        status: 404,
        message: "Workspace not found",
      }),
    );
  }

  return {
    scope: "workspace",
    workspaceId: workspace.id,
  } as const;
};
