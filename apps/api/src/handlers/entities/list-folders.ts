import { Result } from "better-result";
import { and, asc, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db";
import { entities } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";

// Returns every folder in the workspace, unpaginated. Folders are
// few (compared to files) and the workspace-wide entity cap of
// LIMITS.entitiesCount = 10 000 keeps the upper bound bounded.
// Used by the file organizer to build a complete parent → child
// hierarchy regardless of which page the filesystem view is on.

type ListFoldersHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
};

const listFoldersHandler = async function* ({
  safeDb,
  workspaceId,
}: ListFoldersHandlerProps) {
  const rows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          id: entities.id,
          name: entities.name,
          parentId: entities.parentId,
        })
        .from(entities)
        .where(
          and(
            eq(entities.workspaceId, workspaceId),
            eq(entities.kind, "folder"),
          ),
        )
        .orderBy(asc(entities.createdAt)),
    ),
  );

  return Result.ok({
    folders: rows,
  });
};

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

const listFolders = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId }) {
    return yield* listFoldersHandler({ safeDb, workspaceId });
  },
);

export default listFolders;
