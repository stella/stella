import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { folioCollabRooms } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { decideFolioSnapshotRecoveryState } from "@/api/lib/files/folio-collab-snapshot-loader";

type RetireFolioCollabSnapshotOptions = {
  snapshotFileId: SafeId<"userFile"> | SQL;
  state: ReturnType<typeof decideFolioSnapshotRecoveryState> | "pending-seed";
  now: Date;
};

/** Read the old row in the retiring UPDATE, before its snapshot cut and revision disappear. */
export const retireFolioCollabSnapshot = ({
  snapshotFileId,
  state,
  now,
}: RetireFolioCollabSnapshotOptions) => {
  const recoveredAt = sql`${now.toISOString()}::timestamptz`;
  const discardedAt = (() => {
    switch (state) {
      case "pending-seed":
        return sql`CASE WHEN
          (${folioCollabRooms.yjsSnapshotRevision} > 0 OR ${folioCollabRooms.yjsSnapshotUpdatedAt} IS NOT NULL)
          AND (${folioCollabRooms.savedSnapshotCut}->>'versionId') IS DISTINCT FROM ${folioCollabRooms.baseVersionId}::text
          THEN ${recoveredAt} ELSE NULL END`;
      case "unsaved":
        return recoveredAt;
      case "saved":
        return sql`NULL::timestamptz`;
      default:
        state satisfies never;
        return panic("Unhandled Folio snapshot retirement state");
    }
  })();
  return {
    savedSnapshotCut: null,
    snapshotRecoveredAt: sql`coalesce(${folioCollabRooms.snapshotRecoveredAt}, ${discardedAt})`,
    yjsSnapshotFileId: snapshotFileId,
    yjsSnapshotRevision: 0,
    yjsSnapshotSizeBytes: null,
    yjsSnapshotUpdatedAt: null,
  };
};
