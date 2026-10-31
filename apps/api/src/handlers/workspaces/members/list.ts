import { Result } from "better-result";

import { readWorkspaceMembersHandler } from "@/api/handlers/workspaces/workspace-members-read";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";

/** `GET /v1/workspaces/:workspaceId/members`: the matter's members. */
const readWorkspaceMembers = createSafeHandler(
  {
    contract: "patch",
    description:
      "List a matter's members, each with their user's id, name, email and " +
      "image, as the people its tasks can be assigned to. Add one with " +
      "matters.members.add.",
    access: "read",
    permissions: { workspace: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    mcp: { type: "covered", by: "list_matters" },
  } satisfies WorkspaceHandlerConfig,
  async function* ({ scopedDb, workspaceId }) {
    const response = yield* Result.await(
      Result.tryPromise(
        async () =>
          await readWorkspaceMembersHandler({
            workspaceId,
            scopedDb,
          }),
      ),
    );

    return Result.ok(response);
  },
);

export default readWorkspaceMembers;
