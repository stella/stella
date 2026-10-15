import { panic, Result } from "better-result";

import { FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME } from "@stll/api-contract/folio-collab";
import type { FolioYjsSnapshotMigrationError } from "@stll/folio-core/server";
import { migrateFolioYjsSnapshot } from "@stll/folio-core/server";

export { FOLIO_COLLAB_SNAPSHOT_LOAD_OUTCOME } from "@stll/api-contract/folio-collab";

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
