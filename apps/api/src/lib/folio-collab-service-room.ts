import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { folioCollabRooms, workspaces } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { FolioCollabSnapshotTarget } from "@/api/lib/folio-collab-rooms";

const serviceScopedDb =
  (db: Pick<typeof rootDb, "transaction">): ScopedDb =>
  async (callback) =>
    // Service snapshot transport has no end-user identity. Its bearer credential
    // is the authorization boundary; every callback still predicates room writes
    // by the workspace resolved from PostgreSQL, never caller input.
    await db.transaction(callback);

/** Resolve the global service target before entering its tenant-scoped transaction. */
export const resolveFolioCollabServiceRoom = async (
  roomId: SafeId<"folioCollabRoom">,
  db: Pick<typeof rootDb, "select" | "transaction"> = rootDb,
): Promise<Result<FolioCollabSnapshotTarget, HandlerError<404>>> => {
  const rows = await db
    .select({
      organizationId: workspaces.organizationId,
      roomId: folioCollabRooms.id,
      workspaceId: folioCollabRooms.workspaceId,
    })
    .from(folioCollabRooms)
    .innerJoin(workspaces, eq(workspaces.id, folioCollabRooms.workspaceId))
    .where(eq(folioCollabRooms.id, roomId))
    .limit(1);
  const room = rows.at(0);
  if (room === undefined) {
    return Result.err(
      new HandlerError({
        status: 404,
        message: "Collaborative editing room not found.",
      }),
    );
  }

  return Result.ok({
    organizationId: room.organizationId,
    roomId: room.roomId,
    scopedDb: serviceScopedDb(db),
    workspaceId: room.workspaceId,
  });
};
