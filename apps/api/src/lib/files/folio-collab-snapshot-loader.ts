import { panic, Result } from "better-result";

import { FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME } from "@stll/api-contract/folio-collab";
import type { FolioYjsSnapshotMigrationError } from "@stll/folio-core/server";
import { migrateFolioYjsSnapshot } from "@stll/folio-core/server";

import type { SafeId } from "@/api/lib/branded-types";
import type { FolioCollabSavedSnapshotCut } from "@/api/lib/folio-collab-room-contract";

export { FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME } from "@stll/api-contract/folio-collab";

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

type SnapshotRecoveryResult =
  | { status: "reset"; generation: number; resetGeneration: number }
  | { status: "replaced" };

type LoadPersistedFolioSnapshotOptions = {
  onRefused: (
    error: FolioYjsSnapshotMigrationError,
  ) => Promise<SnapshotRecoveryResult>;
  snapshotBytes: Uint8Array;
};

/**
 * The only boundary that opens persisted Folio Yjs state. Folio migrations
 * either return a safe update or explicitly require a DOCX-backed reseed;
 * callers never inspect, patch, or partially apply refused state.
 */
export const loadPersistedFolioSnapshot = async ({
  onRefused,
  snapshotBytes,
}: LoadPersistedFolioSnapshotOptions) =>
  Result.gen(async function* () {
    const migrated = migrateFolioYjsSnapshot(snapshotBytes);
    if (Result.isOk(migrated)) {
      return Result.ok({
        outcome: FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME.loaded,
        snapshotBytes: migrated.value.update,
      } as const);
    }

    if (migrated.error.code !== "unsupported_version") {
      return yield* Result.err(migrated.error);
    }

    const recovery = await onRefused(migrated.error);
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
