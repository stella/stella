import { Result } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db";
import { entities, fields } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";

// Returns every file-bearing entity in the workspace, unpaginated and
// trimmed to just the columns the organizer needs (entityId,
// parentId, fileName, mimeType). The workspace cap of
// LIMITS.entitiesCount = 10 000 keeps the upper bound bounded.
//
// The organizer is the only consumer today; the FilesystemView still
// uses the paginated read endpoint for its UI rows. Adding a
// dedicated lightweight endpoint avoids loading every entity's full
// field set when the dialog only needs the file's name + mime type.

type ListFilesHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
};

const listFilesHandler = async function* ({
  safeDb,
  workspaceId,
}: ListFilesHandlerProps) {
  const rows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select({
          entityId: entities.id,
          name: entities.name,
          parentId: entities.parentId,
          fieldContent: fields.content,
        })
        .from(entities)
        .innerJoin(
          fields,
          and(
            eq(fields.entityVersionId, entities.currentVersionId),
            eq(fields.workspaceId, workspaceId),
            sql`${fields.content}->>'type' = 'file'`,
          ),
        )
        .where(
          and(
            eq(entities.workspaceId, workspaceId),
            eq(entities.kind, "document"),
          ),
        )
        .orderBy(asc(entities.createdAt)),
    ),
  );

  type FileRow = {
    entityId: SafeId<"entity">;
    name: string | null;
    parentId: SafeId<"entity"> | null;
    fileName: string;
    mimeType: string;
  };

  const files: FileRow[] = [];
  for (const row of rows) {
    const content = row.fieldContent;
    if (content.type !== "file") {
      continue;
    }
    files.push({
      entityId: row.entityId,
      name: row.name,
      parentId: row.parentId,
      fileName: content.fileName,
      mimeType: content.mimeType,
    });
  }

  return Result.ok({ files });
};

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

const listFiles = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId }) {
    return yield* listFilesHandler({ safeDb, workspaceId });
  },
);

export default listFiles;
