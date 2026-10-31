import { rootDb } from "@/api/db/root";
import { flushWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-flush";
import {
  executeAuthorizedWorkspaceDeletion,
  type WorkspaceDeletionDependencies,
} from "@/api/lib/workspace-deletion";

export const ROOT_WORKSPACE_DELETION_DEPENDENCIES = {
  database: rootDb,
  flushWorkspaceSearchRepairs,
} satisfies WorkspaceDeletionDependencies;

export const executeAuthorizedWorkspaceDeletionWithRoot = async (
  options: Parameters<typeof executeAuthorizedWorkspaceDeletion>[0],
) =>
  await executeAuthorizedWorkspaceDeletion(
    options,
    ROOT_WORKSPACE_DELETION_DEPENDENCIES,
  );
