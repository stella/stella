import { panic, Result, TaggedError } from "better-result";
import * as Y from "yjs";

import { FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME } from "@stll/api-contract/folio-collab";

import type { SafeId } from "@/api/lib/branded-types";
import type { FolioCollabSavedSnapshotCut } from "@/api/lib/folio-collab-room-contract";

export { FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME } from "@stll/api-contract/folio-collab";

/**
 * Why a stored room state cannot be loaded. `invalid_update`: the bytes are
 * not a Yjs update. `legacy_room`: the room edited a ProseMirror fragment, as
 * rooms did before they carried a canonical journal; it reopens from DOCX.
 */
export class FolioRoomSnapshotError extends TaggedError(
  "FolioRoomSnapshotError",
)<{
  code: "invalid_update" | "legacy_room";
  message: string;
  cause?: unknown;
}> {}

/** The shared type a room edited before it carried a canonical journal. */
const LEGACY_ROOM_FRAGMENT = "prosemirror";

type FolioSnapshotRecoveryStateOptions = {
  savedSnapshotCut: FolioCollabSavedSnapshotCut | null;
  savedVersionId: SafeId<"entityVersion">;
  snapshotSha256Hex: string;
  snapshotUpdatedAt: Date | null;
  savedVersionCreatedAt: Date | null;
  seededAt: Date | null;
  historicalBaseline: "initial-seed" | "publication";
};

/**
 * Exact hashes bound to the current saved version take precedence over
 * timestamps; a cut bound to another version is unknown. A historical
 * publication has no known snapshot cut: its checkpoint may predate edits
 * stored before the version was published. Otherwise only a snapshot strictly
 * older than the initial baseline is clean; ties, newer state and missing
 * timestamps conservatively report discarded changes.
 */
export const decideFolioSnapshotRecoveryState = ({
  savedSnapshotCut,
  savedVersionId,
  snapshotSha256Hex,
  snapshotUpdatedAt,
  savedVersionCreatedAt,
  seededAt,
  historicalBaseline,
}: FolioSnapshotRecoveryStateOptions): "saved" | "unsaved" => {
  if (savedSnapshotCut !== null) {
    return savedSnapshotCut.versionId === savedVersionId &&
      savedSnapshotCut.sha256Hex === snapshotSha256Hex
      ? "saved"
      : "unsaved";
  }
  if (
    historicalBaseline === "publication" ||
    snapshotUpdatedAt === null ||
    (savedVersionCreatedAt === null && seededAt === null)
  ) {
    return "unsaved";
  }
  const baseline = Math.max(
    savedVersionCreatedAt?.getTime() ?? -Infinity,
    seededAt?.getTime() ?? -Infinity,
  );
  return snapshotUpdatedAt.getTime() < baseline ? "saved" : "unsaved";
};

/** Whether `snapshotBytes` restore a room, and whether that room is legacy. */
const readRoomSnapshot = (
  snapshotBytes: Uint8Array,
): Result<"canonical" | "legacy", FolioRoomSnapshotError> =>
  Result.try({
    try: () => {
      const room = new Y.Doc();
      try {
        Y.applyUpdate(room, snapshotBytes);
        return room.share.has(LEGACY_ROOM_FRAGMENT) ? "legacy" : "canonical";
      } finally {
        room.destroy();
      }
    },
    catch: (cause) =>
      new FolioRoomSnapshotError({
        code: "invalid_update",
        message: "The stored collaboration state is not a Yjs update.",
        cause,
      }),
  });

type SnapshotRecoveryResult =
  | { status: "reset"; generation: number; resetGeneration: number }
  | { status: "replaced" };

type LoadPersistedFolioSnapshotOptions = {
  onRefused: (error: FolioRoomSnapshotError) => Promise<SnapshotRecoveryResult>;
  snapshotBytes: Uint8Array;
};

/**
 * The only boundary that opens persisted Folio room state. A canonical room
 * loads as stored; a legacy room requires a DOCX-backed reseed; callers never
 * inspect, patch, or partially apply refused state.
 */
export const loadPersistedFolioSnapshot = async ({
  onRefused,
  snapshotBytes,
}: LoadPersistedFolioSnapshotOptions) =>
  Result.gen(async function* () {
    const kind = yield* readRoomSnapshot(snapshotBytes);
    if (kind === "canonical") {
      return Result.ok({
        outcome: FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME.loaded,
        snapshotBytes,
      } as const);
    }

    const recovery = await onRefused(
      new FolioRoomSnapshotError({
        code: "legacy_room",
        message:
          "The stored collaboration state edits a ProseMirror fragment; the room reopens from its DOCX.",
      }),
    );
    switch (recovery.status) {
      case "reset":
        return Result.ok({
          outcome: FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME.rematerializeFromDocx,
          generation: recovery.generation,
          resetGeneration: recovery.resetGeneration,
          snapshotBytes: null,
        } as const);
      case "replaced":
        return Result.ok({ outcome: "reload-current" } as const);
      default: {
        recovery satisfies never;
        return panic("Unhandled snapshot recovery outcome");
      }
    }
  });
